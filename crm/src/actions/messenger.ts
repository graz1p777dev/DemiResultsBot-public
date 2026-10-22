"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { can, getActor, getScope, inScope } from "@/lib/authz";
import { createAdminClient } from "@/lib/supabase/admin";

const COMPANY_ID = "00000000-0000-0000-0000-000000000001";

export type StaffPerson = {
  id: string;
  name: string;
  role: string;
  avatar_url: string | null;
  status: string;
};
export type StaffMessage = {
  id: string;
  chat_id: string;
  sender_id: string;
  body: string;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  reply_to_id: string | null;
  attachments: Array<{
    name?: string;
    path?: string;
    type?: string;
    size?: number;
    url?: string;
    kind?: string;
    id?: string;
    href?: string;
    title?: string;
  }>;
  reactions: Array<{ emoji: string; employee_id: string }>;
  sender: StaffPerson | null;
};
export type StaffChat = {
  id: string;
  kind: "direct" | "group" | "channel";
  name: string | null;
  description: string | null;
  created_by: string | null;
  last_message_at: string | null;
  members: Array<{
    employee_id: string;
    role: string;
    last_read_at: string | null;
    last_seen_at: string | null;
    employee: StaffPerson | null;
  }>;
  lastMessage: Pick<
    StaffMessage,
    "id" | "body" | "sender_id" | "created_at"
  > | null;
};

async function actorWithAccess(action: "view" | "create" | "edit") {
  const actor = await getActor();
  if (!actor || !(await can(actor, "messenger", action))) return null;
  return actor;
}

async function isMember(chatId: string, employeeId: string) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("crm_staff_chat_members")
    .select("chat_id")
    .eq("chat_id", chatId)
    .eq("employee_id", employeeId)
    .maybeSingle();
  return Boolean(data);
}

async function canPost(chatId: string, employeeId: string) {
  const admin = createAdminClient();
  const [chat, membership] = await Promise.all([
    admin.from("crm_staff_chats").select("kind").eq("id", chatId).maybeSingle(),
    admin
      .from("crm_staff_chat_members")
      .select("role")
      .eq("chat_id", chatId)
      .eq("employee_id", employeeId)
      .maybeSingle(),
  ]);
  if (chat.error || membership.error || !chat.data || !membership.data)
    return false;
  return (
    chat.data.kind === "direct" ||
    chat.data.kind === "group" ||
    (chat.data.kind === "channel" &&
      ["owner", "admin"].includes(membership.data.role))
  );
}

function isChatAttachmentPath(path: unknown, chatId: string): path is string {
  if (typeof path !== "string" || !path.startsWith(`${chatId}/`)) return false;
  const name = path.slice(chatId.length + 1);
  return /^[a-zA-Zа-яА-Я0-9._-]+$/.test(name) && name !== "." && name !== "..";
}

export async function getMessengerData(): Promise<{
  me: StaffPerson | null;
  people: StaffPerson[];
  chats: StaffChat[];
}> {
  const actor = await actorWithAccess("view");
  if (!actor) return { me: null, people: [], chats: [] };
  const admin = createAdminClient();
  const [{ data: people }, { data: memberships }] = await Promise.all([
    admin
      .from("employees")
      .select("id,name,role,avatar_url,status")
      .is("deleted_at", null)
      .in("status", ["active", "probation"])
      .order("name"),
    admin
      .from("crm_staff_chat_members")
      .select("chat_id")
      .eq("employee_id", actor.employeeId),
  ]);
  const chatIds = (memberships ?? []).map((row) => row.chat_id);
  if (!chatIds.length) {
    return {
      me:
        ((people ?? []).find(
          (p) => p.id === actor.employeeId,
        ) as StaffPerson) ?? null,
      people: (people ?? []) as StaffPerson[],
      chats: [],
    };
  }
  const [{ data: chats }, { data: members }, { data: messages }] =
    await Promise.all([
      admin
        .from("crm_staff_chats")
        .select("id,kind,name,description,created_by,last_message_at")
        .in("id", chatIds)
        .order("last_message_at", { ascending: false, nullsFirst: false }),
      admin
        .from("crm_staff_chat_members")
        .select(
          "chat_id,employee_id,role,last_read_at,last_seen_at,employee:employees(id,name,role,avatar_url,status)",
        )
        .in("chat_id", chatIds),
      admin
        .from("crm_staff_messages")
        .select("id,chat_id,sender_id,body,created_at")
        .in("chat_id", chatIds)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(Math.max(100, chatIds.length * 3)),
    ]);
  const allPeople = (people ?? []) as StaffPerson[];
  return {
    me: allPeople.find((p) => p.id === actor.employeeId) ?? null,
    people: allPeople,
    chats: ((chats ?? []) as Omit<StaffChat, "members" | "lastMessage">[]).map(
      (chat) => ({
        ...chat,
        members: (members ?? []).filter(
          (m) => m.chat_id === chat.id,
        ) as unknown as StaffChat["members"],
        lastMessage:
          ((messages ?? []).find(
            (m) => m.chat_id === chat.id,
          ) as StaffChat["lastMessage"]) ?? null,
      }),
    ),
  };
}

export async function getStaffMessages(
  chatId: string,
): Promise<StaffMessage[]> {
  const parsed = z.string().uuid().safeParse(chatId);
  const actor = await actorWithAccess("view");
  if (!parsed.success || !actor || !(await isMember(chatId, actor.employeeId)))
    return [];
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("crm_staff_messages")
    .select(
      "id,chat_id,sender_id,body,created_at,edited_at,deleted_at,reply_to_id,attachments,sender:employees!crm_staff_messages_sender_id_fkey(id,name,role,avatar_url,status)",
    )
    .eq("chat_id", chatId)
    .order("created_at")
    .limit(500);
  if (error) {
    console.error("[messenger] load messages:", error.message);
    return [];
  }
  const rows = (data ?? []) as unknown as StaffMessage[];
  const ids = rows.map((row) => row.id);
  const { data: reactions } = ids.length
    ? await admin
        .from("crm_staff_message_reactions")
        .select("message_id,emoji,employee_id")
        .in("message_id", ids)
    : { data: [] };
  for (const message of rows) {
    message.attachments = message.attachments ?? [];
    message.reactions = (reactions ?? [])
      .filter((reaction) => reaction.message_id === message.id)
      .map(({ emoji, employee_id }) => ({ emoji, employee_id }));
    for (const file of message.attachments ?? []) {
      delete file.url;
      if (isChatAttachmentPath(file.path, chatId)) {
        const signed = await admin.storage
          .from("messenger-files")
          .createSignedUrl(file.path, 3600);
        file.url = signed.data?.signedUrl;
      }
    }
  }
  return rows;
}

export async function getUnreadStaffMessageCount(): Promise<number> {
  const actor = await actorWithAccess("view");
  if (!actor) return 0;
  const admin = createAdminClient();
  const { data: memberships } = await admin
    .from("crm_staff_chat_members")
    .select("chat_id,last_read_at")
    .eq("employee_id", actor.employeeId);
  if (!memberships?.length) return 0;

  const { data: messages } = await admin
    .from("crm_staff_messages")
    .select("chat_id,sender_id,created_at")
    .in(
      "chat_id",
      memberships.map((membership) => membership.chat_id),
    )
    .neq("sender_id", actor.employeeId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(2000);

  const readAt = new Map(
    memberships.map((membership) => [
      membership.chat_id,
      membership.last_read_at
        ? new Date(membership.last_read_at).getTime()
        : Number.NEGATIVE_INFINITY,
    ]),
  );
  return (messages ?? []).filter(
    (message) =>
      new Date(message.created_at).getTime() >
      (readAt.get(message.chat_id) ?? Number.NEGATIVE_INFINITY),
  ).length;
}

export async function createDirectChat(otherEmployeeId: string) {
  const actor = await actorWithAccess("create");
  const parsed = z.string().uuid().safeParse(otherEmployeeId);
  if (!actor || !parsed.success || otherEmployeeId === actor.employeeId)
    return { success: false, error: "Неверный сотрудник" };
  const admin = createAdminClient();
  const { data: other } = await admin
    .from("employees")
    .select("id")
    .eq("id", otherEmployeeId)
    .is("deleted_at", null)
    .in("status", ["active", "probation"])
    .maybeSingle();
  if (!other) return { success: false, error: "Сотрудник не найден" };
  const directKey = [actor.employeeId, otherEmployeeId].sort().join(":");
  let { data: chat } = await admin
    .from("crm_staff_chats")
    .select("id")
    .eq("direct_key", directKey)
    .maybeSingle();
  if (!chat) {
    const created = await admin
      .from("crm_staff_chats")
      .insert({
        company_id: COMPANY_ID,
        kind: "direct",
        is_group: false,
        direct_key: directKey,
        created_by: actor.employeeId,
      })
      .select("id")
      .single();
    if (created.error || !created.data)
      return { success: false, error: "Не удалось создать диалог" };
    chat = created.data;
    const { error } = await admin.from("crm_staff_chat_members").insert([
      { chat_id: chat.id, employee_id: actor.employeeId, role: "owner" },
      { chat_id: chat.id, employee_id: otherEmployeeId, role: "member" },
    ]);
    if (error)
      return { success: false, error: "Не удалось добавить участников" };
  }
  revalidatePath("/dashboard/messenger");
  return { success: true, chatId: chat.id };
}

export async function createGroupChat(input: {
  name: string;
  memberIds: string[];
}) {
  const actor = await actorWithAccess("create");
  const parsed = z
    .object({
      name: z.string().trim().min(2).max(80),
      memberIds: z.array(z.string().uuid()).max(100),
    })
    .safeParse(input);
  if (!actor || !parsed.success)
    return { success: false, error: "Проверьте название и участников" };
  const memberIds = [...new Set([actor.employeeId, ...parsed.data.memberIds])];
  const admin = createAdminClient();
  const { data: valid } = await admin
    .from("employees")
    .select("id")
    .in("id", memberIds)
    .is("deleted_at", null);
  if ((valid ?? []).length !== memberIds.length)
    return { success: false, error: "Один из сотрудников недоступен" };
  const { data: chat, error } = await admin
    .from("crm_staff_chats")
    .insert({
      company_id: COMPANY_ID,
      kind: "group",
      is_group: true,
      name: parsed.data.name,
      created_by: actor.employeeId,
    })
    .select("id")
    .single();
  if (error || !chat)
    return { success: false, error: "Не удалось создать группу" };
  const rows = memberIds.map((employee_id) => ({
    chat_id: chat.id,
    employee_id,
    role: employee_id === actor.employeeId ? "owner" : "member",
  }));
  const joined = await admin.from("crm_staff_chat_members").insert(rows);
  if (joined.error)
    return { success: false, error: "Не удалось добавить участников" };
  revalidatePath("/dashboard/messenger");
  return { success: true, chatId: chat.id };
}

export async function createAnnouncementChannel(name: string) {
  const actor = await getActor();
  const parsed = z.string().trim().min(2).max(80).safeParse(name);
  // messenger.delete используется как отдельное административное permission.
  if (!actor || !(await can(actor, "messenger", "delete")) || !parsed.success)
    return { success: false, error: "Создавать каналы может только владелец" };
  const admin = createAdminClient();
  const { data: employees } = await admin
    .from("employees")
    .select("id")
    .is("deleted_at", null)
    .in("status", ["active", "probation"]);
  const { data: channel, error } = await admin
    .from("crm_staff_chats")
    .insert({
      company_id: COMPANY_ID,
      kind: "channel",
      is_group: true,
      name: parsed.data,
      created_by: actor.employeeId,
    })
    .select("id")
    .single();
  if (error || !channel) return { success: false, error: "Канал не создан" };
  const memberIds = [
    ...new Set([actor.employeeId, ...(employees ?? []).map((row) => row.id)]),
  ];
  const joined = await admin.from("crm_staff_chat_members").insert(
    memberIds.map((employee_id) => ({
      chat_id: channel.id,
      employee_id,
      role: employee_id === actor.employeeId ? "owner" : "member",
    })),
  );
  if (joined.error) return { success: false, error: "Участники не добавлены" };
  await admin.from("audit_logs").insert({
    employee_id: actor.employeeId,
    action: "create_channel",
    resource_type: "crm_staff_chat",
    resource_id: channel.id,
    new_data: { name: parsed.data, members: memberIds.length },
  });
  revalidatePath("/dashboard/messenger");
  return { success: true, chatId: channel.id };
}

export async function sendStaffMessage(
  chatId: string,
  body: string,
  replyToId?: string | null,
) {
  const actor = await actorWithAccess("create");
  const parsed = z
    .object({
      chatId: z.string().uuid(),
      body: z.string().trim().min(1).max(8000),
      replyToId: z.string().uuid().nullable().optional(),
    })
    .safeParse({ chatId, body, replyToId });
  if (!actor || !parsed.success)
    return { success: false, error: "Нет доступа к чату" };
  if (!(await canPost(chatId, actor.employeeId)))
    return {
      success: false,
      error: "В канале публикуют только администраторы",
    };
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("crm_staff_messages")
    .insert({
      company_id: COMPANY_ID,
      chat_id: chatId,
      sender_id: actor.employeeId,
      body: parsed.data.body,
      ciphertext: "",
      nonce: "",
      message_type: "text",
      reply_to_id: parsed.data.replyToId ?? null,
    })
    .select("id")
    .single();
  if (error || !data)
    return { success: false, error: "Сообщение не отправлено" };
  await admin
    .from("crm_staff_chat_members")
    .update({ last_read_at: new Date().toISOString() })
    .eq("chat_id", chatId)
    .eq("employee_id", actor.employeeId);
  const { data: recipients } = await admin
    .from("crm_staff_chat_members")
    .select("employee_id")
    .eq("chat_id", chatId)
    .neq("employee_id", actor.employeeId);
  if (recipients?.length)
    await admin.from("notifications").insert(
      recipients.map((row) => ({
        employee_id: row.employee_id,
        type: "staff_message",
        title: "Новое сообщение команды",
        body: parsed.data.body.slice(0, 180),
        action_url: `/dashboard/messenger?chat=${chatId}`,
        source_type: "crm_staff_message",
        source_id: data.id,
      })),
    );
  revalidatePath("/dashboard/messenger");
  return { success: true, messageId: data.id };
}

export async function uploadStaffAttachment(formData: FormData) {
  const actor = await actorWithAccess("create");
  const chatId = String(formData.get("chatId") ?? "");
  const replyToId = String(formData.get("replyToId") ?? "") || null;
  const file = formData.get("file");
  if (
    !actor ||
    !z.string().uuid().safeParse(chatId).success ||
    !(file instanceof File) ||
    !(await canPost(chatId, actor.employeeId))
  ) {
    return { success: false, error: "Не удалось загрузить файл" };
  }
  if (file.size <= 0 || file.size > 25 * 1024 * 1024)
    return { success: false, error: "Максимальный размер файла — 25 МБ" };
  const allowed = /^(image\/|audio\/|video\/|application\/pdf$|text\/plain$)/;
  if (!allowed.test(file.type))
    return { success: false, error: "Этот формат файла не поддерживается" };
  const admin = createAdminClient();
  const bucket = await admin.storage.getBucket("messenger-files");
  if (bucket.error) {
    const created = await admin.storage.createBucket("messenger-files", {
      public: false,
      fileSizeLimit: 26214400,
    });
    if (created.error)
      return { success: false, error: "Хранилище файлов недоступно" };
  }
  const safeName = file.name.replace(/[^a-zA-Zа-яА-Я0-9._-]/g, "_").slice(-120);
  const path = `${chatId}/${crypto.randomUUID()}-${safeName}`;
  const uploaded = await admin.storage
    .from("messenger-files")
    .upload(path, file, { contentType: file.type, upsert: false });
  if (uploaded.error) return { success: false, error: "Файл не загрузился" };
  const type = file.type.startsWith("audio/")
    ? "audio"
    : file.type.startsWith("image/")
      ? "image"
      : "file";
  const inserted = await admin
    .from("crm_staff_messages")
    .insert({
      company_id: COMPANY_ID,
      chat_id: chatId,
      sender_id: actor.employeeId,
      body: type === "audio" ? "Голосовое сообщение" : file.name,
      ciphertext: "",
      nonce: "",
      message_type: "text",
      reply_to_id: replyToId,
      attachments: [
        { name: file.name, path, type: file.type, size: file.size },
      ],
    })
    .select("id")
    .single();
  if (inserted.error || !inserted.data) {
    await admin.storage.from("messenger-files").remove([path]);
    return { success: false, error: "Сообщение с файлом не создано" };
  }
  revalidatePath("/dashboard/messenger");
  return { success: true, messageId: inserted.data.id };
}

export async function editStaffMessage(messageId: string, body: string) {
  const actor = await actorWithAccess("edit");
  const parsed = z
    .object({
      messageId: z.string().uuid(),
      body: z.string().trim().min(1).max(8000),
    })
    .safeParse({ messageId, body });
  if (!actor || !parsed.success)
    return { success: false, error: "Проверьте сообщение" };
  const admin = createAdminClient();
  const { data: message } = await admin
    .from("crm_staff_messages")
    .select("chat_id,sender_id")
    .eq("id", messageId)
    .maybeSingle();
  if (
    !message ||
    message.sender_id !== actor.employeeId ||
    !(await isMember(message.chat_id, actor.employeeId))
  )
    return { success: false, error: "Можно изменить только своё сообщение" };
  const { error } = await admin
    .from("crm_staff_messages")
    .update({ body: parsed.data.body, edited_at: new Date().toISOString() })
    .eq("id", messageId);
  return error
    ? { success: false, error: "Не удалось изменить сообщение" }
    : { success: true };
}

export async function deleteStaffMessage(messageId: string) {
  const actor = await actorWithAccess("edit");
  if (!actor || !z.string().uuid().safeParse(messageId).success)
    return { success: false, error: "Неверное сообщение" };
  const admin = createAdminClient();
  const { data: message } = await admin
    .from("crm_staff_messages")
    .select("chat_id,sender_id")
    .eq("id", messageId)
    .maybeSingle();
  if (
    !message ||
    message.sender_id !== actor.employeeId ||
    !(await isMember(message.chat_id, actor.employeeId))
  )
    return { success: false, error: "Можно удалить только своё сообщение" };
  const { error } = await admin
    .from("crm_staff_messages")
    .update({ body: "", deleted_at: new Date().toISOString() })
    .eq("id", messageId);
  return error
    ? { success: false, error: "Не удалось удалить сообщение" }
    : { success: true };
}

export async function toggleStaffReaction(messageId: string, emoji: string) {
  const actor = await actorWithAccess("edit");
  const parsed = z
    .object({
      messageId: z.string().uuid(),
      emoji: z.enum(["👍", "❤️", "✅", "🔥", "👀"]),
    })
    .safeParse({ messageId, emoji });
  if (!actor || !parsed.success)
    return { success: false, error: "Неверная реакция" };
  const admin = createAdminClient();
  const { data: message } = await admin
    .from("crm_staff_messages")
    .select("chat_id")
    .eq("id", messageId)
    .maybeSingle();
  if (!message || !(await isMember(message.chat_id, actor.employeeId)))
    return { success: false, error: "Нет доступа" };
  const key = { message_id: messageId, employee_id: actor.employeeId, emoji };
  const { data: exists } = await admin
    .from("crm_staff_message_reactions")
    .select("message_id")
    .match(key)
    .maybeSingle();
  const result = exists
    ? await admin.from("crm_staff_message_reactions").delete().match(key)
    : await admin.from("crm_staff_message_reactions").insert(key);
  return result.error
    ? { success: false, error: "Реакция не сохранилась" }
    : { success: true };
}

export async function createTaskFromStaffMessage(input: {
  messageId: string;
  title: string;
  assigneeId: string;
  dueDate?: string | null;
}) {
  const actor = await getActor();
  const parsed = z
    .object({
      messageId: z.string().uuid(),
      title: z.string().trim().min(1).max(300),
      assigneeId: z.string().uuid(),
      dueDate: z.string().date().nullable().optional(),
    })
    .safeParse(input);
  if (
    !actor ||
    !(await can(actor, "messenger", "view")) ||
    !(await can(actor, "tasks", "create")) ||
    !parsed.success
  ) {
    return { success: false, error: "Недостаточно прав или неверные данные" };
  }
  const admin = createAdminClient();
  const [{ data: message }, { data: assignee }] = await Promise.all([
    admin
      .from("crm_staff_messages")
      .select("id,chat_id,body")
      .eq("id", parsed.data.messageId)
      .maybeSingle(),
    admin
      .from("employees")
      .select("id,department_id,status")
      .eq("id", parsed.data.assigneeId)
      .is("deleted_at", null)
      .maybeSingle(),
  ]);
  if (
    !message ||
    !assignee ||
    !(await isMember(message.chat_id, actor.employeeId))
  )
    return { success: false, error: "Сообщение или сотрудник недоступны" };
  const taskScope = await getScope(actor, "tasks");
  if (!taskScope || assignee.status === "archived" || !inScope(actor, taskScope, assignee.id, assignee.department_id))
    return { success: false, error: "Нельзя назначить задачу выбранному сотруднику" };
  const { data: last } = await admin
    .from("tasks")
    .select("position")
    .eq("status", "todo")
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { data: task, error } = await admin
    .from("tasks")
    .insert({
      company_id: COMPANY_ID,
      title: parsed.data.title,
      description: `Создано из сообщения:\n${message.body ?? ""}`,
      status: "todo",
      priority: "medium",
      visibility: "private",
      assignee_id: parsed.data.assigneeId,
      created_by: actor.employeeId,
      due_date: parsed.data.dueDate ?? null,
      position: ((last?.position as number | undefined) ?? -1) + 1,
    })
    .select("id")
    .single();
  if (error || !task) return { success: false, error: "Задача не создана" };
  if (
    (await can(actor, "messenger", "create")) &&
    (await canPost(message.chat_id, actor.employeeId))
  ) {
    await admin.from("crm_staff_messages").insert({
      company_id: COMPANY_ID,
      chat_id: message.chat_id,
      sender_id: actor.employeeId,
      body: `Создана задача: ${parsed.data.title}`,
      ciphertext: "",
      nonce: "",
      message_type: "system",
      attachments: [
        {
          kind: "task",
          id: task.id,
          href: "/dashboard/tasks/kanban",
          title: parsed.data.title,
          name: parsed.data.title,
          type: "application/x-crm-task",
        },
      ],
    });
  }
  await admin.from("notifications").insert({
    employee_id: parsed.data.assigneeId,
    type: "task_assigned",
    title: "Новая задача из мессенджера",
    body: parsed.data.title,
    action_url: "/dashboard/tasks/kanban",
    source_type: "task",
    source_id: task.id,
    is_important: true,
  });
  await admin.from("audit_logs").insert({
    employee_id: actor.employeeId,
    action: "create_from_message",
    resource_type: "task",
    resource_id: task.id,
    new_data: {
      chat_id: message.chat_id,
      message_id: message.id,
      assignee_id: parsed.data.assigneeId,
    },
  });
  revalidatePath("/dashboard/messenger");
  revalidatePath("/dashboard/tasks/kanban");
  return { success: true, taskId: task.id };
}

export async function touchMessengerPresence() {
  const actor = await actorWithAccess("view");
  if (!actor) return;
  await createAdminClient()
    .from("crm_staff_chat_members")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("employee_id", actor.employeeId);
}

export async function markStaffChatRead(chatId: string) {
  const actor = await actorWithAccess("view");
  if (
    !actor ||
    !z.string().uuid().safeParse(chatId).success ||
    !(await isMember(chatId, actor.employeeId))
  )
    return;
  await createAdminClient()
    .from("crm_staff_chat_members")
    .update({ last_read_at: new Date().toISOString() })
    .eq("chat_id", chatId)
    .eq("employee_id", actor.employeeId);
}
