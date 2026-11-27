const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const areas = new Set(["ABE", "STN", "DYO", "ARS1", "ARS2"]);
const categories = new Set(["sunday-worship", "other-ministry"]);
function validDate(value: string) { const parsed = new Date(`${value}T00:00:00.000Z`); return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value; }
export function validateFilter(params: URLSearchParams) {
  const area = params.get("area") || "", category = params.get("category") || "", from = params.get("from") || "", to = params.get("to") || "";
  if (area && !["abepura", "sentani", "doyo", "arso-1", "arso-2"].includes(area) || category && !categories.has(category) ||
    from && (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !validDate(from)) || to && (!/^\d{4}-\d{2}-\d{2}$/.test(to) || !validDate(to)) || from && to && from > to) throw Object.assign(new Error("invalid_filter"), { status: 400, code: "invalid_filter" });
  return { area, category, from, to };
}
export async function readJson(request: Request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) throw Object.assign(new Error("content_type"), { status: 415, code: "content_type" });
  if (!request.body) throw Object.assign(new Error("invalid_json"), { status: 400, code: "invalid_json" });
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) { await reader.cancel(); throw Object.assign(new Error("payload_too_large"), { status: 413, code: "payload_too_large" }); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value; }
  catch { throw Object.assign(new Error("invalid_json"), { status: 400, code: "invalid_json" }); }
}
export function validateMutation(path: string, body: Record<string, unknown>) {
  const allowed = path.endsWith("/drafts") ? ["schedule", "expectedRevision", "operationId"] : ["scheduleId", "expectedRevision", "operationId"];
  if (Object.keys(body).some((key) => !allowed.includes(key)) || Object.hasOwn(body, "actorUid") || Object.hasOwn(body, "actorRole") || !uuid.test(String(body.operationId || "")) || !Number.isSafeInteger(body.expectedRevision)) throw Object.assign(new Error("invalid_request"), { status: 400, code: "invalid_request" });
  if (path.endsWith("/drafts")) {
    if ((body.expectedRevision as number) < 0 || !body.schedule || typeof body.schedule !== "object") throw Object.assign(new Error("invalid_request"), { status: 400, code: "invalid_request" });
    const s = body.schedule as Record<string, unknown>;
    if (!uuid.test(String(s.id || "")) || !areas.has(String(s.area || "")) || !categories.has(String(s.category || "")) ||
      typeof s.title !== "string" || !s.title.trim() || typeof s.theme !== "string" || !s.theme.trim() || s.theme.length > 150 ||
      typeof s.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s.date) || !validDate(s.date) || typeof s.startTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.startTime) ||
      typeof s.endTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.endTime) || s.startTime >= s.endTime ||
      typeof s.venueId !== "string" || !uuid.test(s.venueId) || typeof s.leaderId !== "string" || !uuid.test(s.leaderId)) throw Object.assign(new Error("invalid_schedule"), { status: 400, code: "invalid_schedule" });
  } else if (!uuid.test(String(body.scheduleId || "")) || (body.expectedRevision as number) < 1) throw Object.assign(new Error("invalid_request"), { status: 400, code: "invalid_request" });
}
