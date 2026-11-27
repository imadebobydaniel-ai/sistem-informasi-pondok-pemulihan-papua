"use strict";

// R5-only identity adapters. They accept only the local Auth/Firestore
// Emulators and the synthetic demo project; never use these in production.
const PROJECT_ID = "demo-sipapua-jadwal";
const AUTH_ORIGIN = "http://127.0.0.1:9199";
const FIRESTORE_ORIGIN = "http://127.0.0.1:8080";
const HUB_ORIGIN = "http://127.0.0.1:4400";
const ISSUER = `https://securetoken.google.com/${PROJECT_ID}`;

function assertConfiguration(projectId = PROJECT_ID) {
  if (projectId !== PROJECT_ID) throw new Error("r5_demo_project_only");
}

function decodeEmulatorToken(token) {
  if (typeof token !== "string" || token.length < 32 || token.length > 16384) throw new Error("invalid_emulator_token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid_emulator_token");
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch { throw new Error("invalid_emulator_token"); }
  const now = Math.floor(Date.now() / 1000);
  if (header?.alg !== "none" || claims?.aud !== PROJECT_ID || claims?.iss !== ISSUER ||
      typeof claims?.sub !== "string" || !claims.sub || claims.sub.length > 128 ||
      !Number.isSafeInteger(claims.exp) || claims.exp <= now) throw new Error("invalid_emulator_token");
  return claims;
}

function localRequest(url, options = {}, timeoutMs = 3000) {
  const parsed = new URL(url);
  if (![AUTH_ORIGIN, FIRESTORE_ORIGIN, HUB_ORIGIN].includes(parsed.origin) || parsed.username || parsed.password) {
    throw new Error("non_loopback_identity_target_denied");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, redirect: "error", credentials: "omit", cache: "no-store", signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

function createFirebaseEmulatorVerifier({ projectId = PROJECT_ID } = {}) {
  assertConfiguration(projectId);
  return async function verifyFirebaseIdToken(token) {
    const claims = decodeEmulatorToken(token);
    const url = `${AUTH_ORIGIN}/identitytoolkit.googleapis.com/v1/accounts:lookup?key=demo-key`;
    const response = await localRequest(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: token }) });
    if (!response.ok || response.url !== url) throw new Error("auth_emulator_token_lookup_failed");
    const result = await response.json();
    const account = Array.isArray(result?.users) ? result.users[0] : null;
    if (!account || account.localId !== claims.sub) throw new Error("auth_emulator_token_lookup_failed");
    return { uid: claims.sub, emailVerified: account.emailVerified === true };
  };
}

function stringField(document, name) {
  const value = document?.fields?.[name]?.stringValue;
  return typeof value === "string" ? value : null;
}

function createFirestoreEmulatorIdentityReaders({ projectId = PROJECT_ID } = {}) {
  assertConfiguration(projectId);
  async function readDocument(collection, uid, token) {
    if (!new Set(["admin_users", "users"]).has(collection) || typeof uid !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(uid)) throw new Error("invalid_firestore_identity_path");
    decodeEmulatorToken(token);
    const url = `${FIRESTORE_ORIGIN}/v1/projects/${PROJECT_ID}/databases/(default)/documents/${collection}/${encodeURIComponent(uid)}`;
    const response = await localRequest(url, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
    if (response.status === 404) return null;
    if (!response.ok || response.url !== url) throw new Error("firestore_emulator_identity_lookup_failed");
    return response.json();
  }

  return Object.freeze({
    async readAdminRecord(uid, token) {
      const document = await readDocument("admin_users", uid, token);
      if (!document) return { found: false };
      return { found: true, role: stringField(document, "role"), status: stringField(document, "status") };
    },
    async readMemberAccount(uid, token) {
      const claims = decodeEmulatorToken(token);
      if (claims.sub !== uid) return { found: false };
      const document = await readDocument("users", uid, token);
      if (!document || stringField(document, "uid") !== uid || stringField(document, "status_akun") !== "Aktif") {
        return { found: false };
      }
      const identity = await createFirebaseEmulatorVerifier({ projectId })(token);
      if (identity.uid !== uid || !identity.emailVerified) return { found: false };
      // The users/{uid} document is the existing SIPAPUA member profile path.
      return { found: true, role: "member", status: "active" };
    }
  });
}

module.exports = { PROJECT_ID, AUTH_ORIGIN, FIRESTORE_ORIGIN, createFirebaseEmulatorVerifier,
  createFirestoreEmulatorIdentityReaders, decodeEmulatorToken, localRequest };
