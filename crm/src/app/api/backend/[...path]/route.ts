import { NextRequest, NextResponse } from "next/server";
import { can, getActor, type Actor, type Action, type Section } from "@/lib/authz";
import { getAuthUser, getSelfEmployee } from "@/lib/identity";
import { getBackendRecordAccess } from "@/lib/backend-record-access";
import type { UserRole } from "@/types";

// Proxy to the FastAPI bot backend (amoCRM / OpenAI / Telegram integration).
// Server-side only: the admin API key never reaches the browser.
const BACKEND_API_URL = process.env.BOT_BACKEND_API_URL || "http://localhost:8000";
const BACKEND_ADMIN_API_KEY = process.env.BOT_BACKEND_ADMIN_API_KEY || "";

type RouteContext = {
  params: Promise<{ path: string[] }>;
};

// ─── Политика доступа ────────────────────────────────────────────────────────
// Роль проверялась только в nav.ts, то есть решала, рисовать ли пункт меню.
// Сам маршрут пускал любого, кто вошёл в систему, поэтому менеджер с ролью 'mp'
// мог послать PATCH /api/backend/admin/bot-prompt и подменить промпт бота в проде.
//
// Правила ниже — allow-list. Всё, что не совпало ни с одним, доступно только
// owner: новый эндпоинт бота по умолчанию закрыт, а не открыт.

// Бухгалтер работает только с финансами (middleware уводит его на /dashboard/finance)
// и к боту отношения не имеет.
const STAFF: UserRole[] = ["owner", "rop", "mp", "lmai"];
const HEADS: UserRole[] = ["owner", "rop"];

type Rule = {
  methods: string[];
  pattern: RegExp;
  roles: UserRole[];
  resources: Section[];
  action: Action;
};

// Both screens use the same chat endpoints. View and mutation must be granted
// on the SAME resource; a view-only inbox cannot borrow chat's edit permission.
const CHAT: Section[] = ["inbox", "consultation_chat"];

const RULES: Rule[] = [
  // Диалоги: менеджер обязан видеть переписку и отвечать в ней.
  // Сюда же ходит /chat/[leadId] — страница, которую открывают по ссылке из Telegram.
  { methods: ["GET"], pattern: /^admin\/conversations$/, roles: STAFF, resources: ["inbox"], action: "view" },
  { methods: ["GET"], pattern: /^admin\/conversations\/by-lead\/[^/]+$/, roles: STAFF, resources: ["inbox"], action: "view" },
  { methods: ["GET"], pattern: /^admin\/clients(\/\d+)?$/, roles: STAFF, resources: ["clients"], action: "view" },
  { methods: ["POST"], pattern: /^admin\/clients\/\d+\/merge$/, roles: HEADS, resources: ["clients"], action: "edit" },
  { methods: ["GET"], pattern: /^admin\/chat\/[^/]+$/, roles: STAFF, resources: CHAT, action: "view" },
  // Голосовые/фото вложения клиента — тот же экран /chat/[leadId].
  { methods: ["GET"], pattern: /^admin\/attachment\/\d+$/, roles: STAFF, resources: CHAT, action: "view" },
  { methods: ["PATCH"], pattern: /^admin\/leads\/\d+\/ai$/, roles: STAFF, resources: CHAT, action: "edit" },
  { methods: ["PATCH"], pattern: /^admin\/leads\/\d+\/inbox$/, roles: STAFF, resources: ["inbox"], action: "edit" },
  { methods: ["POST"], pattern: /^admin\/leads\/\d+\/messages$/, roles: STAFF, resources: CHAT, action: "create" },
  { methods: ["POST"], pattern: /^admin\/leads\/\d+\/(generate-reply|reply-options)$/, roles: STAFF, resources: CHAT, action: "edit" },
  { methods: ["POST"], pattern: /^admin\/transcribe$/, roles: STAFF, resources: CHAT, action: "create" },
  { methods: ["POST"], pattern: /^admin\/leads\/\d+\/media$/, roles: STAFF, resources: CHAT, action: "create" },
  { methods: ["GET"], pattern: /^admin\/approvals$/, roles: STAFF, resources: ["approvals"], action: "view" },
  { methods: ["PATCH"], pattern: /^admin\/approvals\/\d+$/, roles: STAFF, resources: ["approvals"], action: "edit" },
  { methods: ["POST"], pattern: /^admin\/approvals\/\d+\/(approve|reject|ai-edit)$/, roles: STAFF, resources: ["approvals"], action: "edit" },
  { methods: ["POST"], pattern: /^admin\/approvals\/\d+\/edit-preview$/, roles: STAFF, resources: ["approvals"], action: "edit" },
  { methods: ["POST"], pattern: /^admin\/approvals\/\d+\/edit-preview\/[a-f0-9]{24}\/(accept|discard)$/, roles: STAFF, resources: ["approvals"], action: "edit" },

  // Рейтинг баллов отображается на общем дашборде. Это только агрегированные
  // счётчики действий сотрудников, без диалогов, токенов и настроек бота.
  { methods: ["GET"], pattern: /^admin\/analytics\/managers$/, roles: STAFF, resources: ["dashboard"], action: "view" },

  // Аналитика и отчёты — руководителю отдела они нужны, менять он ничего не может.
  { methods: ["GET"], pattern: /^admin\/analytics(\/(tokens|funnel))?$/, roles: HEADS, resources: ["bot_analytics"], action: "view" },
  { methods: ["GET"], pattern: /^admin\/reports\/daily$/, roles: HEADS, resources: ["bot_reports"], action: "view" },
  { methods: ["GET"], pattern: /^admin\/action-logs$/, roles: HEADS, resources: ["laboratory"], action: "view" },

  // Чёрный список и стоп-слова: правит и РОП тоже — это ежедневная работа отдела.
  { methods: ["GET"], pattern: /^admin\/blacklist(\/\d+)?$/, roles: HEADS, resources: ["bot_settings"], action: "view" },
  { methods: ["POST"], pattern: /^admin\/blacklist(\/\d+)?$/, roles: HEADS, resources: ["bot_settings"], action: "create" },
  { methods: ["DELETE"], pattern: /^admin\/blacklist(\/\d+)?$/, roles: HEADS, resources: ["bot_settings"], action: "delete" },
  { methods: ["GET"], pattern: /^admin\/stop-words$/, roles: HEADS, resources: ["bot_settings"], action: "view" },
  { methods: ["PUT"], pattern: /^admin\/stop-words$/, roles: HEADS, resources: ["bot_settings"], action: "edit" },
];

async function allowedResources(method: string, path: string, actor: Actor): Promise<Section[] | null> {
  if (actor.role === "owner") return [];
  // Copilot retains its existing role ceiling; its backend checks tool access.
  if (/^copilot\/.+/.test(path)) {
    return ["GET", "POST", "PATCH", "DELETE"].includes(method) && STAFF.includes(actor.role as UserRole) ? [] : null;
  }
  const rule = RULES.find(
    (rule) => rule.methods.includes(method) && rule.pattern.test(path)
  );
  if (!rule || !rule.roles.includes(actor.role as UserRole)) return null;
  const resources: Section[] = [];
  for (const resource of rule.resources) {
    if (await can(actor, resource, "view")
      && (rule.action === "view" || await can(actor, resource, rule.action))) resources.push(resource);
  }
  return resources.length ? resources : null;
}

function backendUrl(path: string[], search: string) {
  const cleanBase = BACKEND_API_URL.replace(/\/$/, "");
  const cleanPath = path.map((segment) => encodeURIComponent(segment)).join("/");
  return `${cleanBase}/${cleanPath}${search}`;
}

async function proxy(request: NextRequest, context: RouteContext) {
  const { path } = await context.params;
  // Validate decoded segments before authorization, including residual escapes
  // that another parser could decode again. Fetch must see the same route.
  if (path.length === 0 || path.some((segment) =>
    segment === "" || segment === "." || segment === ".." || /[/\\%?#\u0000-\u001f\u007f-\u009f]/u.test(segment))) {
    return NextResponse.json({ detail: "Bad path" }, { status: 400 });
  }

  const user = await getAuthUser();
  if (!user) {
    return NextResponse.json({ detail: "Unauthorized" }, { status: 401 });
  }
  const actor = await getActor();
  if (!actor) {
    return NextResponse.json({ detail: "Forbidden" }, { status: 403 });
  }

  const cleanPath = path.join("/");
  const resources = await allowedResources(request.method, cleanPath, actor);
  if (resources === null) {
    return NextResponse.json({ detail: "Forbidden" }, { status: 403 });
  }
  const employee = await getSelfEmployee();
  const { role, employeeId } = actor;
  const name = employee?.name || user.id;

  // Заголовки собираем с нуля, а не копируем из запроса: иначе браузерные cookie
  // с сессией Supabase уезжают в бэкенд бота, а подставленный клиентом
  // X-Admin-API-Key прошёл бы насквозь, если серверный ключ не задан.
  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  if (BACKEND_ADMIN_API_KEY) headers.set("X-Admin-API-Key", BACKEND_ADMIN_API_KEY);
  // Only the Copilot backend reads these — 'owner' maps to its binary
  // is_admin gate (backend/app/core/copilot_auth.py in the bot repo).
  // encodeURIComponent: Headers требует ASCII/Latin1, а имя сотрудника часто
  // кириллица — без кодирования .set() кидает TypeError (ByteString) и весь
  // прокси-запрос падает. Бэкенд декодирует обратно (copilot_auth.py).
  headers.set("X-User-Name", encodeURIComponent(name));
  if (employeeId) headers.set("X-Employee-ID", employeeId);
  headers.set("X-User-Is-Admin", role === "owner" ? "true" : "false");

  const recordRoute = /^admin\/(conversations|chat|attachment|leads|clients|approvals)(\/|$)/.test(cleanPath);
  const recordAccess = role !== "owner" && recordRoute ? await getBackendRecordAccess(resources) : null;
  const read = async (metadataPath: string[], search = ""): Promise<unknown> => {
    try {
      const metadata = await fetch(backendUrl(metadataPath, search), { method: "GET", headers, cache: "no-store" });
      return metadata.ok ? await metadata.json() : null;
    } catch { return null; }
  };
  if (role !== "owner" && recordRoute) {
    if (!recordAccess || !await recordAccess.authorize(request, path, read)) {
      return NextResponse.json({ detail: "Forbidden" }, { status: 403 });
    }
    if (request.method === "GET" && path.length === 2 && ["conversations", "clients", "approvals"].includes(path[1])) {
      const data = await recordAccess.list(request, path, read);
      return data === null
        ? NextResponse.json({ detail: "Forbidden" }, { status: 403 })
        : NextResponse.json(data);
    }
  }

  // arrayBuffer keeps binary bodies (file uploads) intact
  const response = await fetch(backendUrl(path, request.nextUrl.search), {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
    cache: "no-store",
  });

  if (recordAccess && request.method === "GET" && path[1] !== "attachment") {
    if (!response.ok) return NextResponse.json({ detail: "Backend record unavailable" }, { status: response.status });
    let data: unknown;
    try { data = await response.json(); } catch { data = null; }
    const filtered = await recordAccess.filter(path, data, read);
    if (filtered === null) return NextResponse.json({ detail: "Forbidden" }, { status: 403 });
    return NextResponse.json(filtered, { status: response.status });
  }

  const responseType = response.headers.get("content-type") || "application/json";
  return new NextResponse(await response.arrayBuffer(), {
    status: response.status,
    headers: { "content-type": responseType },
  });
}

export async function GET(request: NextRequest, context: RouteContext) { return proxy(request, context); }
export async function POST(request: NextRequest, context: RouteContext) { return proxy(request, context); }
export async function PATCH(request: NextRequest, context: RouteContext) { return proxy(request, context); }
export async function PUT(request: NextRequest, context: RouteContext) { return proxy(request, context); }
export async function DELETE(request: NextRequest, context: RouteContext) { return proxy(request, context); }
