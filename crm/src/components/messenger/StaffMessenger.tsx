"use client";

import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import {
  CheckCheck,
  ClipboardCheck,
  ChevronLeft,
  FileText,
  Megaphone,
  MessageCircle,
  Mic,
  Paperclip,
  Pencil,
  Plus,
  Reply,
  Search,
  Send,
  Square,
  Trash2,
  Users,
  X,
} from "lucide-react";
import {
  createDirectChat,
  createAnnouncementChannel,
  createGroupChat,
  createTaskFromStaffMessage,
  deleteStaffMessage,
  editStaffMessage,
  getMessengerData,
  getStaffMessages,
  markStaffChatRead,
  sendStaffMessage,
  toggleStaffReaction,
  touchMessengerPresence,
  uploadStaffAttachment,
  type StaffChat,
  type StaffMessage,
  type StaffPerson,
} from "@/actions/messenger";
import { createClient } from "@/lib/supabase/client";

type Data = { me: StaffPerson; people: StaffPerson[]; chats: StaffChat[] };
const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((x) => x[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
const time = (value: string) =>
  new Intl.DateTimeFormat("ru", { hour: "2-digit", minute: "2-digit" }).format(
    new Date(value),
  );

function Avatar({
  person,
  small = false,
}: {
  person: StaffPerson;
  small?: boolean;
}) {
  return (
    <div
      className={`${small ? "h-8 w-8 text-xs" : "h-10 w-10 text-sm"} grid shrink-0 place-items-center rounded-full bg-gradient-to-br from-cyan-500 to-blue-700 font-bold text-white`}
    >
      {initials(person.name)}
    </div>
  );
}

export default function StaffMessenger({ initialData }: { initialData: Data }) {
  const [data, setData] = useState(initialData);
  const [activeId, setActiveId] = useState(initialData.chats[0]?.id ?? "");
  const [messages, setMessages] = useState<StaffMessage[]>([]);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [newChat, setNewChat] = useState(false);
  const [newChatMode, setNewChatMode] = useState<
    "direct" | "group" | "channel"
  >("direct");
  const [groupName, setGroupName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [replyTo, setReplyTo] = useState<StaffMessage | null>(null);
  const [editing, setEditing] = useState<StaffMessage | null>(null);
  const [recording, setRecording] = useState(false);
  const [errorText, setErrorText] = useState("");
  const [taskSource, setTaskSource] = useState<StaffMessage | null>(null);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskAssignee, setTaskAssignee] = useState(initialData.me.id);
  const [taskDue, setTaskDue] = useState("");
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const activeIdRef = useRef(activeId);
  const fileRef = useRef<HTMLInputElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const realtimeRefreshRef = useRef<number | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [pending, startTransition] = useTransition();
  const supabase = useMemo(() => createClient(), []);
  const active = data.chats.find((c) => c.id === activeId);
  const myMembership = active?.members.find(
    (member) => member.employee_id === data.me.id,
  );
  const canPost =
    active?.kind !== "channel" ||
    ["owner", "admin"].includes(myMembership?.role ?? "");

  const title = useCallback(
    (chat: StaffChat) =>
      chat.kind === "direct"
        ? (chat.members.find((m) => m.employee_id !== data.me.id)?.employee
            ?.name ?? "Личный диалог")
        : (chat.name ?? "Группа"),
    [data.me.id],
  );

  const refresh = useCallback(
    async (chatId = activeId) => {
      const next = await getMessengerData();
      if (next.me) setData(next as Data);
      if (chatId) {
        const loaded = await getStaffMessages(chatId);
        if (chatId === activeIdRef.current) setMessages(loaded);
      }
    },
    [activeId],
  );

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    if (!activeId) return;
    let current = true;
    getStaffMessages(activeId).then((loaded) => {
      if (current && activeIdRef.current === activeId) setMessages(loaded);
    });
    void markStaffChatRead(activeId);
    return () => {
      current = false;
    };
  }, [activeId]);

  useEffect(() => {
    const queueRefresh = () => {
      if (realtimeRefreshRef.current)
        window.clearTimeout(realtimeRefreshRef.current);
      realtimeRefreshRef.current = window.setTimeout(() => void refresh(), 120);
    };
    const channel = supabase
      .channel(`staff-messenger-${data.me.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "crm_staff_messages" },
        queueRefresh,
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "crm_staff_message_reactions",
        },
        queueRefresh,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "crm_staff_chats" },
        queueRefresh,
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "crm_staff_chat_members",
        },
        queueRefresh,
      )
      .on("system", {}, (payload) => {
        if (payload.extension === "postgres_changes" && payload.status === "ok")
          queueRefresh();
      })
      .subscribe();
    const timer = window.setInterval(refresh, 30000);
    return () => {
      window.clearInterval(timer);
      if (realtimeRefreshRef.current)
        window.clearTimeout(realtimeRefreshRef.current);
      void supabase.removeChannel(channel);
    };
  }, [data.me.id, refresh, supabase]);

  useEffect(() => {
    touchMessengerPresence();
    const timer = window.setInterval(touchMessengerPresence, 30000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const messagesScroll = messagesScrollRef.current;
    if (messagesScroll) {
      messagesScroll.scrollTo({
        top: messagesScroll.scrollHeight,
        behavior: "smooth",
      });
    }
    if (activeId) void markStaffChatRead(activeId);
  }, [activeId, messages.length]);

  const filtered = useMemo(
    () =>
      data.chats.filter((c) =>
        `${title(c)} ${c.lastMessage?.body ?? ""}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    [data.chats, query, title],
  );

  function submit(event: FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!activeId || !body || pending) return;
    const optimisticId = `pending-${crypto.randomUUID()}`;
    if (!editing) {
      setMessages((current) => [
        ...current,
        {
          id: optimisticId,
          chat_id: activeId,
          sender_id: data.me.id,
          body,
          created_at: new Date().toISOString(),
          edited_at: null,
          deleted_at: null,
          reply_to_id: replyTo?.id ?? null,
          attachments: [],
          reactions: [],
          sender: data.me,
        },
      ]);
    }
    setDraft("");
    startTransition(async () => {
      const result = editing
        ? await editStaffMessage(editing.id, body)
        : await sendStaffMessage(activeId, body, replyTo?.id);
      if (!result.success) {
        setMessages((current) =>
          current.filter((message) => message.id !== optimisticId),
        );
        setDraft(body);
        setErrorText(result.error ?? "Не удалось отправить сообщение");
      } else {
        setErrorText("");
        setEditing(null);
        setReplyTo(null);
      }
      await refresh();
    });
  }

  function chooseFile(file?: File) {
    if (!file || !activeId) return;
    const form = new FormData();
    form.set("chatId", activeId);
    if (replyTo) form.set("replyToId", replyTo.id);
    form.set("file", file);
    startTransition(async () => {
      const result = await uploadStaffAttachment(form);
      if (result.success) {
        setErrorText("");
        setReplyTo(null);
      } else {
        setErrorText(result.error ?? "Файл не отправлен");
      }
      await refresh();
    });
  }

  async function toggleRecording() {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksRef.current = [];
      const mimeType = [
        "audio/mp4",
        "audio/webm;codecs=opus",
        "audio/ogg;codecs=opus",
      ].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        const recordedType = (recorder.mimeType || "audio/webm").split(";")[0];
        const extension = recordedType === "audio/mp4" ? "m4a" : recordedType === "audio/ogg" ? "ogg" : "webm";
        const blob = new Blob(chunksRef.current, { type: recordedType });
        chooseFile(
          new File([blob], `voice-${Date.now()}.${extension}`, { type: blob.type }),
        );
      };
      recorder.start();
      setRecording(true);
    } catch {
      setRecording(false);
      setErrorText(
        "Не удалось включить микрофон. Разрешите доступ в настройках браузера.",
      );
    }
  }

  function beginEdit(message: StaffMessage) {
    setEditing(message);
    setReplyTo(null);
    setDraft(message.body);
  }

  function openTask(message: StaffMessage) {
    setTaskSource(message);
    setTaskTitle(message.body.slice(0, 180));
    setTaskAssignee(data.me.id);
    setTaskDue("");
  }

  function createTask() {
    if (!taskSource) return;
    startTransition(async () => {
      const result = await createTaskFromStaffMessage({
        messageId: taskSource.id,
        title: taskTitle,
        assigneeId: taskAssignee,
        dueDate: taskDue || null,
      });
      if (result.success) {
        setTaskSource(null);
        await refresh();
      } else {
        setErrorText(result.error ?? "Задача не создана");
      }
    });
  }

  function openDirect(personId: string) {
    startTransition(async () => {
      const result = await createDirectChat(personId);
      if (result.success) {
        activeIdRef.current = result.chatId;
        setActiveId(result.chatId);
        setMobileChatOpen(true);
        setNewChat(false);
        await refresh(result.chatId);
      }
    });
  }

  function createGroup() {
    startTransition(async () => {
      const result = await createGroupChat({
        name: groupName,
        memberIds: selected,
      });
      if (result.success) {
        activeIdRef.current = result.chatId;
        setActiveId(result.chatId);
        setMobileChatOpen(true);
        setNewChat(false);
        setGroupName("");
        setSelected([]);
        await refresh(result.chatId);
      }
    });
  }

  function createChannel() {
    startTransition(async () => {
      const result = await createAnnouncementChannel(groupName);
      if (result.success) {
        activeIdRef.current = result.chatId;
        setActiveId(result.chatId);
        setMobileChatOpen(true);
        setNewChat(false);
        setGroupName("");
        await refresh(result.chatId);
      } else {
        setErrorText(result.error ?? "Канал не создан");
      }
    });
  }

  return (
    <div className="h-[calc(100dvh-52px)] min-h-0 overflow-hidden rounded-[24px] border border-sky-200/70 bg-[#eef8fc] shadow-[0_24px_70px_rgba(12,77,108,.12)] dark:border-sky-900 dark:bg-[#071d2d] sm:rounded-[28px]">
      <div className="grid h-full min-h-0 grid-cols-1 overflow-hidden md:grid-cols-[280px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)_260px]">
        <aside
          className={`${mobileChatOpen ? "hidden md:flex" : "flex"} min-h-0 flex-col border-r border-sky-200/70 bg-[#e4f3f9] dark:border-sky-900 dark:bg-[#0b263a]`}
        >
          <div className="border-b border-sky-200/70 p-5 dark:border-sky-900">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h1 className="text-xl font-bold text-[#0c2136] dark:text-white">
                  Мессенджер
                </h1>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Команда Demi Results
                </p>
              </div>
              <button
                onClick={() => {
                  setErrorText("");
                  setNewChat(true);
                }}
                className="grid h-10 w-10 place-items-center rounded-xl bg-[#0c4d6c] text-white hover:bg-[#0a3e58]"
                aria-label="Новый чат"
              >
                <Plus size={19} />
              </button>
            </div>
            <label className="flex items-center gap-2 rounded-xl border border-sky-200 bg-white/80 px-3 py-2.5 dark:border-sky-800 dark:bg-[#102d43]">
              <Search size={16} className="text-slate-400" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Поиск по чатам"
                className="min-w-0 flex-1 bg-transparent text-sm text-[#0c2136] outline-none placeholder:text-slate-400 dark:text-white"
              />
            </label>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {filtered.map((chat) => {
              const other = chat.members.find(
                (m) => m.employee_id !== data.me.id,
              )?.employee;
              const unread =
                chat.lastMessage &&
                chat.members.find((m) => m.employee_id === data.me.id)
                  ?.last_read_at &&
                new Date(chat.lastMessage.created_at) >
                  new Date(
                    chat.members.find(
                      (m) => m.employee_id === data.me.id,
                    )!.last_read_at!,
                  );
              return (
                <button
                  key={chat.id}
                  onClick={() => {
                    activeIdRef.current = chat.id;
                    setActiveId(chat.id);
                    setMobileChatOpen(true);
                  }}
                  className={`mb-1 flex w-full gap-3 rounded-2xl p-3 text-left transition ${activeId === chat.id ? "bg-white shadow-sm dark:bg-[#173a54]" : "hover:bg-white/60 dark:hover:bg-[#12334a]"}`}
                >
                  {other ? (
                    <Avatar person={other} />
                  ) : chat.kind === "channel" ? (
                    <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
                      <Megaphone size={18} />
                    </div>
                  ) : (
                    <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-cyan-100 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300">
                      <Users size={18} />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex justify-between gap-2">
                      <strong className="truncate text-sm text-[#0c2136] dark:text-white">
                        {title(chat)}
                      </strong>
                      <span className="text-[11px] text-slate-400">
                        {chat.lastMessage
                          ? time(chat.lastMessage.created_at)
                          : ""}
                      </span>
                    </div>
                    <p
                      className={`truncate text-xs ${unread ? "font-semibold text-[#0c4d6c] dark:text-cyan-300" : "text-slate-500 dark:text-slate-400"}`}
                    >
                      {chat.lastMessage?.body ?? "Начните общение"}
                    </p>
                  </div>
                  {unread && (
                    <span className="mt-6 h-2.5 w-2.5 shrink-0 rounded-full bg-cyan-500 ring-4 ring-cyan-100 dark:ring-cyan-950" />
                  )}
                </button>
              );
            })}
            {!filtered.length && (
              <div className="p-7 text-center text-sm text-slate-400">
                <MessageCircle className="mx-auto mb-2" />
                Чатов пока нет
              </div>
            )}
          </div>
        </aside>

        <main
          className={`${mobileChatOpen ? "flex" : "hidden md:flex"} min-h-0 min-w-0 flex-col overflow-hidden bg-[#eaf5f8] dark:bg-[#081f31]`}
        >
          {active ? (
            <>
              <header className="flex h-[72px] shrink-0 items-center gap-3 border-b border-sky-200/70 bg-[#eff9fc]/95 px-3 backdrop-blur dark:border-sky-900 dark:bg-[#0b263a]/95 sm:px-6">
                <button
                  type="button"
                  onClick={() => setMobileChatOpen(false)}
                  className="grid h-9 w-9 place-items-center rounded-xl text-slate-500 hover:bg-sky-100 md:hidden dark:hover:bg-[#173a54]"
                  aria-label="Вернуться к чатам"
                >
                  <ChevronLeft size={20} />
                </button>
                <div className="grid h-10 w-10 place-items-center rounded-full bg-cyan-100 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300">
                  {active.kind === "direct" ? (
                    <MessageCircle size={18} />
                  ) : active.kind === "channel" ? (
                    <Megaphone size={18} />
                  ) : (
                    <Users size={18} />
                  )}
                </div>
                <div>
                  <h2 className="font-bold text-[#0c2136] dark:text-white">
                    {title(active)}
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {active.kind === "direct"
                      ? (() => {
                          const other = active.members.find(
                            (member) => member.employee_id !== data.me.id,
                          );
                          return other?.last_seen_at &&
                            Date.now() -
                              new Date(other.last_seen_at).getTime() <
                              90000
                            ? "В сети"
                            : "Личный диалог";
                        })()
                      : active.kind === "channel"
                        ? `Канал · ${active.members.length} участников`
                        : `${active.members.length} участников`}
                  </p>
                </div>
              </header>
              <div
                ref={messagesScrollRef}
                className="relative min-h-0 flex-1 overscroll-contain overflow-y-auto bg-[url('/images/demi-chat-pattern.png')] bg-[length:520px_520px] bg-repeat px-3 py-5 [scrollbar-gutter:stable] sm:px-6 dark:bg-[length:560px_560px]"
              >
                <div className="pointer-events-none absolute inset-0 bg-[#eaf5f8]/88 dark:bg-[#081f31]/76" />
                <div className="relative mx-auto flex max-w-3xl flex-col gap-3">
                  {messages.map((message) => {
                    const mine = message.sender_id === data.me.id;
                    const quoted = messages.find(
                      (item) => item.id === message.reply_to_id,
                    );
                    return (
                      <div
                        key={message.id}
                        className={`group flex gap-2 ${mine ? "justify-end" : ""}`}
                      >
                        {!mine && message.sender && (
                          <Avatar person={message.sender} small />
                        )}
                        <div className="relative max-w-[75%]">
                          <div
                            className={`rounded-2xl px-4 py-3 shadow-sm ${mine ? "rounded-br-md bg-[#0c5b7c] text-white" : "rounded-bl-md border border-sky-100 bg-white text-[#0c2136] dark:border-sky-900 dark:bg-[#15364e] dark:text-white"}`}
                          >
                            <div className={`mb-1 text-xs font-semibold ${mine ? "text-cyan-100" : "text-cyan-700 dark:text-cyan-300"}`}>
                              {message.sender?.name ?? (mine ? data.me.name : "Сотрудник")}
                            </div>
                            {quoted && (
                              <div
                                className={`mb-2 rounded-lg border-l-2 px-2 py-1 text-xs ${mine ? "border-cyan-200 bg-black/10" : "border-cyan-600 bg-sky-50 dark:bg-black/15"}`}
                              >
                                {quoted.body.slice(0, 100)}
                              </div>
                            )}
                            {message.attachments?.map((file) =>
                              file.kind === "task" ? (
                                <a
                                  key={file.id}
                                  href={file.href}
                                  className="mb-2 flex items-center gap-2 rounded-xl border border-white/25 bg-black/10 p-3 text-sm font-semibold"
                                >
                                  <ClipboardCheck size={18} />
                                  <span>Задача: {file.title}</span>
                                </a>
                              ) : file.type?.startsWith("image/") &&
                                file.url ? (
                                <a
                                  key={file.path}
                                  href={file.url}
                                  target="_blank"
                                >
                                  <img
                                    src={file.url}
                                    alt={file.name}
                                    className="mb-2 max-h-72 rounded-xl object-contain"
                                  />
                                </a>
                              ) : file.type?.startsWith("audio/") &&
                                file.url ? (
                                <audio
                                  key={file.path}
                                  controls
                                  src={file.url}
                                  className="mb-2 max-w-full"
                                />
                              ) : (
                                <a
                                  key={file.path}
                                  href={file.url}
                                  target="_blank"
                                  className="mb-2 flex items-center gap-2 rounded-lg bg-black/10 p-2 text-xs"
                                >
                                  <FileText size={15} />
                                  {file.name}
                                </a>
                              ),
                            )}
                            <p
                              className={`whitespace-pre-wrap break-words text-sm ${message.deleted_at ? "italic opacity-70" : ""}`}
                            >
                              {message.deleted_at
                                ? "Сообщение удалено"
                                : message.body}
                            </p>
                            <div
                              className={`mt-1 flex items-center justify-end gap-1 text-[10px] ${mine ? "text-cyan-100" : "text-slate-400"}`}
                            >
                              {time(message.created_at)}
                              {message.edited_at && " · изменено"}
                              {mine && <CheckCheck size={13} />}
                            </div>
                          </div>
                          {!message.deleted_at && (
                            <div
                              className={`mt-1 flex flex-wrap gap-1 ${mine ? "justify-end" : ""}`}
                            >
                              {message.reactions?.map((reaction) => (
                                <button
                                  key={`${reaction.employee_id}-${reaction.emoji}`}
                                  onClick={() =>
                                    startTransition(async () => {
                                      await toggleStaffReaction(
                                        message.id,
                                        reaction.emoji,
                                      );
                                      await refresh();
                                    })
                                  }
                                  className="rounded-full border border-sky-200 bg-white/80 px-2 py-0.5 text-xs dark:border-sky-800 dark:bg-[#102d43]"
                                >
                                  {reaction.emoji}
                                </button>
                              ))}
                            </div>
                          )}
                          <div
                            className={`absolute -top-8 hidden items-center gap-1 rounded-lg border border-sky-200 bg-white p-1 shadow-lg group-hover:flex dark:border-sky-800 dark:bg-[#102d43] ${mine ? "right-0" : "left-0"}`}
                          >
                            <button
                              onClick={() => setReplyTo(message)}
                              title="Ответить"
                              className="p-1 text-slate-500 hover:text-cyan-600"
                            >
                              <Reply size={14} />
                            </button>
                            {!message.deleted_at && (
                              <button
                                onClick={() => openTask(message)}
                                title="Создать задачу"
                                className="p-1 text-slate-500 hover:text-cyan-600"
                              >
                                <ClipboardCheck size={14} />
                              </button>
                            )}
                            {["👍", "❤️", "✅"].map((emoji) => (
                              <button
                                key={emoji}
                                onClick={() =>
                                  startTransition(async () => {
                                    await toggleStaffReaction(
                                      message.id,
                                      emoji,
                                    );
                                    await refresh();
                                  })
                                }
                                className="text-xs"
                              >
                                {emoji}
                              </button>
                            ))}
                            {mine && !message.deleted_at && (
                              <>
                                <button
                                  onClick={() => beginEdit(message)}
                                  title="Изменить"
                                  className="p-1 text-slate-500"
                                >
                                  <Pencil size={14} />
                                </button>
                                <button
                                  onClick={() =>
                                    startTransition(async () => {
                                      await deleteStaffMessage(message.id);
                                      await refresh();
                                    })
                                  }
                                  title="Удалить"
                                  className="p-1 text-red-500"
                                >
                                  <Trash2 size={14} />
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                        {mine && <Avatar person={message.sender ?? data.me} small />}
                      </div>
                    );
                  })}
                  {!messages.length && (
                    <div className="mx-auto my-20 rounded-2xl border border-sky-200/70 bg-white/85 px-5 py-3 text-center text-sm text-slate-500 shadow-sm backdrop-blur dark:border-sky-900 dark:bg-[#102d43]/90 dark:text-slate-300">
                      {active.kind === "channel"
                        ? "Здесь появятся объявления команды"
                        : "Напишите первое сообщение"}
                    </div>
                  )}
                  <div ref={messageEndRef} />
                </div>
              </div>
              <form
                onSubmit={submit}
                className="shrink-0 border-t border-sky-200/70 bg-[#eff9fc]/95 p-2.5 backdrop-blur dark:border-sky-900 dark:bg-[#0b263a]/95 sm:p-4"
              >
                {errorText && (
                  <div className="mx-auto mb-2 max-w-3xl rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-xs font-medium text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
                    {errorText}
                  </div>
                )}
                {(replyTo || editing) && (
                  <div className="mx-auto mb-2 flex max-w-3xl items-center justify-between rounded-xl bg-sky-100 px-3 py-2 text-xs text-[#0c4d6c] dark:bg-[#15364e] dark:text-cyan-200">
                    <span>
                      {editing
                        ? "Редактирование"
                        : `Ответ: ${replyTo?.body.slice(0, 90)}`}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setReplyTo(null);
                        setEditing(null);
                        setDraft("");
                      }}
                    >
                      <X size={15} />
                    </button>
                  </div>
                )}
                {!canPost && (
                  <div className="mx-auto max-w-3xl rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-center text-sm text-slate-500 dark:border-sky-800 dark:bg-[#102d43] dark:text-slate-300">
                    Это канал объявлений. Публиковать могут администраторы.
                  </div>
                )}
                {canPost && (
                  <div className="mx-auto flex max-w-3xl items-end gap-1 rounded-2xl border border-sky-200 bg-white p-1.5 shadow-sm dark:border-sky-800 dark:bg-[#102d43] sm:gap-2 sm:p-2">
                    <input
                      ref={fileRef}
                      type="file"
                      className="hidden"
                      accept="image/*,audio/*,video/*,.pdf,.txt"
                      onChange={(event) => {
                        chooseFile(event.target.files?.[0]);
                        event.currentTarget.value = "";
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => fileRef.current?.click()}
                      disabled={pending}
                      title="Прикрепить файл"
                      className="grid h-10 w-10 place-items-center rounded-xl text-slate-500 hover:bg-sky-50 dark:hover:bg-[#173a54]"
                    >
                      <Paperclip size={18} />
                    </button>
                    <button
                      type="button"
                      onClick={toggleRecording}
                      title={
                        recording ? "Остановить запись" : "Записать голосовое"
                      }
                      className={`grid h-10 w-10 place-items-center rounded-xl ${recording ? "animate-pulse bg-red-100 text-red-600" : "text-slate-500 hover:bg-sky-50 dark:hover:bg-[#173a54]"}`}
                    >
                      {recording ? <Square size={16} /> : <Mic size={18} />}
                    </button>
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          e.currentTarget.form?.requestSubmit();
                        }
                      }}
                      rows={1}
                      placeholder={
                        recording
                          ? "Записывается голосовое…"
                          : "Сообщение команде…"
                      }
                      className="max-h-36 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-[#0c2136] outline-none dark:text-white"
                    />
                    <button
                      disabled={!draft.trim() || pending || !canPost}
                      className="grid h-11 w-11 place-items-center rounded-xl bg-[#0c4d6c] text-white disabled:opacity-40"
                    >
                      <Send size={18} />
                    </button>
                  </div>
                )}
              </form>
            </>
          ) : (
            <div className="grid h-full place-items-center text-center text-slate-400">
              <div>
                <MessageCircle className="mx-auto mb-3" size={38} />
                <p>Выберите чат или начните новый</p>
              </div>
            </div>
          )}
        </main>

        <aside className="border-l border-sky-200/70 bg-[#e8f5fa] p-5 dark:border-sky-900 dark:bg-[#0b263a] max-xl:hidden">
          <h3 className="mb-4 font-bold text-[#0c2136] dark:text-white">
            Участники
          </h3>
          {active?.members.map(
            (member) =>
              member.employee && (
                <div
                  key={member.employee_id}
                  className="mb-3 flex items-center gap-3"
                >
                  <Avatar person={member.employee} small />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-[#0c2136] dark:text-white">
                      {member.employee.name}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {member.role === "owner"
                        ? "Владелец чата"
                        : member.employee.role}
                    </div>
                  </div>
                </div>
              ),
          )}
        </aside>
      </div>

      {taskSource && (
        <div className="fixed inset-0 z-[125] grid place-items-center bg-[#04131f]/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-3xl border border-sky-200 bg-[#eef8fc] p-6 shadow-2xl dark:border-sky-800 dark:bg-[#102d43]">
            <div className="mb-5 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-[#0c2136] dark:text-white">
                  Задача из сообщения
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Исполнитель увидит её только в своих задачах
                </p>
              </div>
              <button
                onClick={() => setTaskSource(null)}
                className="rounded-lg p-2 text-slate-500"
              >
                <X size={19} />
              </button>
            </div>
            <label className="mb-3 block text-xs font-semibold text-slate-500">
              Название
            </label>
            <input
              value={taskTitle}
              onChange={(event) => setTaskTitle(event.target.value)}
              className="mb-4 w-full rounded-xl border border-sky-200 bg-white px-4 py-3 text-sm text-[#0c2136] outline-none dark:border-sky-800 dark:bg-[#0b263a] dark:text-white"
            />
            <label className="mb-3 block text-xs font-semibold text-slate-500">
              Исполнитель
            </label>
            <select
              value={taskAssignee}
              onChange={(event) => setTaskAssignee(event.target.value)}
              className="mb-4 w-full rounded-xl border border-sky-200 bg-white px-4 py-3 text-sm text-[#0c2136] dark:border-sky-800 dark:bg-[#0b263a] dark:text-white"
            >
              {data.people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
            <label className="mb-3 block text-xs font-semibold text-slate-500">
              Дедлайн
            </label>
            <input
              type="date"
              value={taskDue}
              onChange={(event) => setTaskDue(event.target.value)}
              className="mb-5 w-full rounded-xl border border-sky-200 bg-white px-4 py-3 text-sm text-[#0c2136] dark:border-sky-800 dark:bg-[#0b263a] dark:text-white"
            />
            <button
              onClick={createTask}
              disabled={!taskTitle.trim() || pending}
              className="w-full rounded-xl bg-[#0c4d6c] py-3 text-sm font-bold text-white disabled:opacity-40"
            >
              Создать задачу
            </button>
          </div>
        </div>
      )}

      {newChat && (
        <div className="fixed inset-0 z-[120] grid place-items-center bg-[#04131f]/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-3xl border border-sky-200 bg-[#eef8fc] p-6 shadow-2xl dark:border-sky-800 dark:bg-[#102d43]">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-lg font-bold text-[#0c2136] dark:text-white">
                Новый чат
              </h2>
              <button
                onClick={() => {
                  setNewChat(false);
                  setErrorText("");
                }}
                className="rounded-lg p-2 text-slate-500 hover:bg-slate-200/50"
              >
                <X size={19} />
              </button>
            </div>
            {errorText && (
              <div className="mb-3 rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-xs font-medium text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
                {errorText}
              </div>
            )}
            <div className="mb-4 grid grid-cols-3 rounded-xl bg-sky-100 p-1 dark:bg-[#0b263a]">
              <button
                onClick={() => setNewChatMode("direct")}
                className={`rounded-lg py-2 text-sm ${newChatMode === "direct" ? "bg-white font-semibold shadow-sm dark:bg-[#173a54]" : ""}`}
              >
                Личный
              </button>
              <button
                onClick={() => setNewChatMode("group")}
                className={`rounded-lg py-2 text-sm ${newChatMode === "group" ? "bg-white font-semibold shadow-sm dark:bg-[#173a54]" : ""}`}
              >
                Группа
              </button>
              <button
                onClick={() => setNewChatMode("channel")}
                className={`rounded-lg py-2 text-sm ${newChatMode === "channel" ? "bg-white font-semibold shadow-sm dark:bg-[#173a54]" : ""}`}
              >
                Канал
              </button>
            </div>
            {newChatMode !== "direct" && (
              <input
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder={
                  newChatMode === "channel"
                    ? "Название канала"
                    : "Название группы"
                }
                className="mb-3 w-full rounded-xl border border-sky-200 bg-white px-4 py-3 text-sm outline-none dark:border-sky-800 dark:bg-[#0b263a] dark:text-white"
              />
            )}
            {newChatMode === "channel" && (
              <p className="mb-3 rounded-xl bg-indigo-50 px-3 py-2 text-xs text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-200">
                Канал увидит вся команда. Публиковать смогут только его
                администраторы.
              </p>
            )}
            {newChatMode !== "channel" && (
              <div className="max-h-72 overflow-y-auto">
                {data.people
                  .filter((p) => p.id !== data.me.id)
                  .map((person) => (
                    <button
                      key={person.id}
                      onClick={() =>
                        newChatMode === "group"
                          ? setSelected((ids) =>
                              ids.includes(person.id)
                                ? ids.filter((id) => id !== person.id)
                                : [...ids, person.id],
                            )
                          : openDirect(person.id)
                      }
                      className="flex w-full items-center gap-3 rounded-xl p-2.5 text-left hover:bg-white dark:hover:bg-[#173a54]"
                    >
                      <Avatar person={person} small />
                      <div className="flex-1">
                        <div className="text-sm font-semibold text-[#0c2136] dark:text-white">
                          {person.name}
                        </div>
                        <div className="text-xs text-slate-400">
                          {person.role}
                        </div>
                      </div>
                      {newChatMode === "group" && (
                        <div
                          className={`h-5 w-5 rounded-md border ${selected.includes(person.id) ? "border-cyan-600 bg-cyan-600" : "border-slate-300"}`}
                        />
                      )}
                    </button>
                  ))}
              </div>
            )}
            {newChatMode === "group" && (
              <button
                onClick={createGroup}
                disabled={groupName.trim().length < 2 || pending}
                className="mt-4 w-full rounded-xl bg-[#0c4d6c] py-3 text-sm font-bold text-white disabled:opacity-40"
              >
                Создать группу
              </button>
            )}
            {newChatMode === "channel" && (
              <button
                onClick={createChannel}
                disabled={groupName.trim().length < 2 || pending}
                className="mt-2 w-full rounded-xl bg-[#0c4d6c] py-3 text-sm font-bold text-white disabled:opacity-40"
              >
                Создать канал
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
