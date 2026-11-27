import { readJson, validateFilter, validateMutation } from "./validation.ts";
import { isActiveMember } from "./firestore-identity.ts";

const ADMIN_ROLES = new Set(["master", "super_admin"]);
const ROUTES = new Set(["/api/admin/session", "/api/member/session", "/api/admin/schedules", "/api/member/schedules", "/api/admin/audit", "/api/admin/drafts", "/api/admin/publish", "/api/admin/cancel"]);
const ACTION: Record<string, string> = { "/api/admin/drafts": "save", "/api/admin/publish": "publish", "/api/admin/cancel": "cancel" };
function reply(status: number, code: string, data?: unknown) { return Response.json(data === undefined ? { ok: false, code, error: "Permintaan tidak dapat diproses." } : { ok: true, data }, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }); }
function cors(response: Response, origin: string | null) {
  if (origin) { response.headers.set("Access-Control-Allow-Origin", origin); response.headers.set("Vary", "Origin"); }
  return response;
}
function apiPath(url: URL) { const prefix = "/functions/v1/jadwal-pelayanan"; return url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) || "/" : url.pathname; }

export function createHandler({ verifier, identityReader, repository, masterUid, corsOrigins = [] }: any) {
  if (!Array.isArray(corsOrigins) || corsOrigins.some((value) => {
    try { const parsed = new URL(value); return parsed.origin !== value || parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["127.0.0.1", "localhost"].includes(parsed.hostname)); }
    catch { return true; }
  })) throw new Error("cors_origin_configuration_denied");
  const identity = identityReader;
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get("origin");
    if (request.method === "OPTIONS") {
      if (!origin || !corsOrigins.includes(origin)) return reply(403, "origin_denied");
      return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "authorization,content-type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Vary": "Origin" } });
    }
    if (origin && !corsOrigins.includes(origin)) return reply(403, "origin_denied");
    const url = new URL(request.url), path = apiPath(url);
    if (!ROUTES.has(path)) return cors(reply(404, "not_found"), origin);
    if (ACTION[path] ? request.method !== "POST" : request.method !== "GET") return cors(reply(405, "method_not_allowed"), origin);
    const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") || "");
    if (!match) return cors(reply(401, "missing_token"), origin);
    let claims: { uid: string; emailVerified?: boolean };
    try { claims = await verifier(match[1]); } catch { return cors(reply(401, "invalid_token"), origin); }
    const uid = claims.uid;
    try {
      let actor: { uid: string; role: string };
      if (path.startsWith("/api/admin/")) {
        const admin = await identity.admin(uid, match[1]);
        const role = String(admin?.role || "").trim().toLowerCase();
        if (!admin?.found || admin.status !== "active" || !ADMIN_ROLES.has(role) || uid === masterUid && (role !== "master" || admin.protected !== true)) return cors(reply(403, "administrator_denied"), origin);
        actor = { uid, role };
      } else {
        const member = await identity.member(uid, match[1]);
        const auditId = typeof member?.activation?.auditId === "string" ? member.activation.auditId : "";
        const audit = member?.activation?.method === "admin-override" && /^[A-Za-z0-9_-]{1,128}$/.test(auditId) ? await identity.readActivationAudit(auditId, match[1]) : null;
        const emailVerified = claims.emailVerified === true;
        if (!isActiveMember(member, emailVerified, audit)) return cors(reply(403, "member_access_denied"), origin);
        actor = { uid, role: "member" };
      }
      if (path.endsWith("/session")) return cors(reply(200, "ok", actor), origin);
      if (path === "/api/member/schedules") return cors(reply(200, "ok", await repository.execute("api_member_list", validateFilter(url.searchParams))), origin);
      if (path === "/api/admin/schedules") return cors(reply(200, "ok", await repository.writerRequest("api_admin_list", {}, actor, "admin_read")), origin);
      if (path === "/api/admin/audit") {
        const scheduleId = url.searchParams.get("scheduleId") || "";
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(scheduleId)) return cors(reply(400, "invalid_schedule_id"), origin);
        return cors(reply(200, "ok", await repository.writerRequest("api_audit_list", { scheduleId }, actor, "audit_read")), origin);
      }
      const body = await readJson(request);
      validateMutation(path, body);
      const action = ACTION[path];
      const rpc = path.endsWith("/drafts") ? "api_save_draft" : path.endsWith("/publish") ? "api_publish" : "api_cancel";
      return cors(reply(200, "ok", await repository.writerRequest(rpc, body, actor, action)), origin);
    } catch (error) {
      const code = (error as any)?.code || "schedule_store_unavailable";
      const status = Number.isInteger((error as any)?.status) ? (error as any).status : code === "schedule_conflict" || code === "revision_or_state_conflict" ? 409 : code.startsWith("invalid_") ? 400 : 503;
      return cors(reply(status, code), origin);
    }
  };
}
