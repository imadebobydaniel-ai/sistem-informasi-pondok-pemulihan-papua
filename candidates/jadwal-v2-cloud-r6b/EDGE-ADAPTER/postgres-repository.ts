import postgres from "npm:postgres@3.4.7";

const RPC = new Set(["api_save_draft", "api_publish", "api_cancel", "api_admin_list", "api_audit_list", "api_member_list"]);
export async function createScheduleRepository({ databaseUrl, runtimeRole, projectRef, hmacSecret }: { databaseUrl: string; runtimeRole: string; projectRef: string; hmacSecret: string }) {
  const url = new URL(databaseUrl);
  const username = decodeURIComponent(url.username);
  const allowedUsername = username === runtimeRole || username === `${runtimeRole}.${projectRef}`;
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username || !url.password || runtimeRole !== "schedule_runtime" || !/^[a-z0-9]{8,30}$/.test(projectRef) || !allowedUsername || username.toLowerCase().startsWith("postgres") || !/^[0-9a-f]{64}$/i.test(hmacSecret)) throw new Error("database_configuration_denied");
  if (!url.hostname.includes("127.0.0.1") && !url.hostname.includes("localhost") && url.searchParams.get("sslmode") !== "require") throw new Error("database_tls_required");
  const sql = postgres(databaseUrl, { max: 1, prepare: false, idle_timeout: 10, connect_timeout: 5, ssl: url.hostname === "127.0.0.1" || url.hostname === "localhost" ? false : "require" });
  async function execute(name: string, payload: Record<string, unknown>) {
    if (!RPC.has(name)) throw new Error("rpc_denied");
    // Fixed function identifiers only; user input is JSON data, never SQL syntax.
    try {
      const result = await sql`select sipapua_schedule.${sql(name)}(${JSON.stringify(payload)}::jsonb) as result`;
      return result[0]?.result;
    } catch (error) {
      const state = (error as any)?.code;
      const mapped: Record<string, [number, string]> = { "23P01": [409, "schedule_conflict"], "23505": [409, "schedule_conflict"], "P0001": [409, "revision_or_state_conflict"], "22023": [400, "invalid_schedule"], "22P02": [400, "invalid_schedule"], "42501": [403, "writer_denied"] };
      const [status, code] = mapped[state] || [503, "schedule_store_unavailable"];
      throw Object.assign(new Error(code), { status, code });
    }
  }
  return {
    execute,
    async writerRequest(name: string, payload: Record<string, unknown>, actor: { uid: string; role: string }, action: string) {
      const op = String(payload.operationId || "");
      const mac = await crypto.subtle.importKey("raw", Uint8Array.from(hmacSecret.match(/../g) || [], (x) => parseInt(x, 16)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
        .then((key) => crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${actor.uid}\n${actor.role}\n${op.toLowerCase()}\n${action}`)))
        .then((buf) => btoa(String.fromCharCode(...new Uint8Array(buf))));
      return execute(name, { ...payload, actorUid: actor.uid, actorRole: actor.role, actorMac: mac, action });
    },
    close: () => sql.end({ timeout: 3 }),
  };
}
