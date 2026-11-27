"use strict";

// Copied unchanged from the previously reviewed schedule authorization
// contract so the R5 candidate does not depend on a sibling candidate path.
const ROLES = new Set(["master", "super_admin"]);
function deny(status, code) { return { ok: false, status, code, error: "Permintaan tidak dapat diproses." }; }
function getBearer(headers) {
  const value = typeof headers?.authorization === "string" ? headers.authorization : "";
  const match = /^Bearer\s+(\S+)$/i.exec(value);
  return match ? match[1] : null;
}
async function authorizeSchedule(request, dependencies) {
  if (typeof dependencies?.verifyFirebaseIdToken !== "function" || typeof dependencies?.readAdminRecord !== "function") {
    return deny(503, "authorization_unavailable");
  }
  const token = getBearer(request?.headers);
  if (!token) return deny(401, "missing_token");
  let identity;
  try { identity = await dependencies.verifyFirebaseIdToken(token); }
  catch { return deny(401, "invalid_token"); }
  const uid = identity?.uid;
  if (typeof uid !== "string" || uid.trim() !== uid || !uid || uid.length > 128) return deny(401, "invalid_token");
  let admin;
  try { admin = await dependencies.readAdminRecord(uid, token); }
  catch { return deny(503, "role_lookup_failed"); }
  if (!admin || admin.found !== true) return deny(403, "not_administrator");
  const status = typeof admin.status === "string" ? admin.status.trim().toLowerCase() : "";
  if (status !== "active") return deny(403, "inactive_administrator");
  const rawRole = typeof admin.role === "string" ? admin.role.trim().toLowerCase() : "";
  const role = rawRole === "superadmin" ? "super_admin" : rawRole;
  if (!ROLES.has(role)) return deny(403, "role_not_allowed");
  return { ok: true, status: 200, actor: { uid, role } };
}
module.exports = { authorizeSchedule };
