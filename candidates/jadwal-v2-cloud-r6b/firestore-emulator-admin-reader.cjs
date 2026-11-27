"use strict";

// Read-only admin identity adapter for a future isolated Firestore Emulator
// run. It deliberately rejects hosted Firebase projects and all non-loopback
// endpoints; production role lookups use the existing hosted Edge pattern.

function createFirestoreEmulatorAdminReader({ projectId, emulatorHost, fetchImpl = globalThis.fetch, timeoutMs = 3000 } = {}) {
  if (typeof projectId !== "string" || !/^demo-[a-z0-9-]{1,24}$/.test(projectId) ||
      typeof emulatorHost !== "string" || !/^127\.0\.0\.1:\d{1,5}$/.test(emulatorHost) ||
      Number(emulatorHost.split(":")[1]) < 1 || Number(emulatorHost.split(":")[1]) > 65535 ||
      typeof fetchImpl !== "function" || !Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 10000) {
    throw new Error("firestore_emulator_only_configuration_required");
  }

  return async function readAdminRecord(uid, firebaseIdToken) {
    if (typeof uid !== "string" || uid.trim() !== uid || uid.length < 1 || uid.length > 128 ||
        typeof firebaseIdToken !== "string" || !firebaseIdToken || firebaseIdToken.length > 16384) throw new Error("invalid_identity_request");
    const url = `http://${emulatorHost}/v1/projects/${projectId}/databases/(default)/documents/admin_users/${encodeURIComponent(uid)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { method: "GET", redirect: "error", credentials: "omit", cache: "no-store",
        headers: { Authorization: `Bearer ${firebaseIdToken}` }, signal: controller.signal });
      if (response.status === 404) return { found: false };
      if (!response.ok || response.url && response.url !== url) throw new Error("firestore_emulator_lookup_failed");
      const document = await response.json();
      if (!document || typeof document.fields !== "object" || !document.fields) throw new Error("firestore_emulator_lookup_failed");
      return {
        found: true,
        role: typeof document.fields.role?.stringValue === "string" ? document.fields.role.stringValue : null,
        status: typeof document.fields.status?.stringValue === "string" ? document.fields.status.stringValue : null
      };
    } finally { clearTimeout(timer); }
  };
}

module.exports = { createFirestoreEmulatorAdminReader };
