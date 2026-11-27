type AdminRecord = { found: boolean; role?: string; status?: string; protected?: boolean };
type MemberRecord = { found: boolean; status?: string; uid?: string; emailVerified?: boolean; activation?: Record<string, unknown>; profileId?: string };

function decodeFields(fields: Record<string, any>) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (value && typeof value === "object") {
      if ("stringValue" in value) out[key] = value.stringValue;
      else if ("booleanValue" in value) out[key] = value.booleanValue;
      else if ("timestampValue" in value) out[key] = value.timestampValue;
      else if ("mapValue" in value) out[key] = decodeFields(value.mapValue.fields || {});
    }
  }
  return out;
}

export function createFirestoreIdentityReader({ projectId, apiOrigin, fetcher = fetch }: { projectId: string; apiOrigin: string; fetcher?: typeof fetch }) {
  const origin = new URL(apiOrigin);
  if (origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) throw new Error("firestore_origin_denied");
  const isEmulator = origin.protocol === "http:" && origin.hostname === "127.0.0.1" && origin.port === "8080" && /^demo-[a-z0-9-]+$/.test(projectId);
  if (origin.origin !== "https://firestore.googleapis.com" && !isEmulator) throw new Error("firestore_origin_denied");
  async function readDocument(collection: string, id: string, token: string) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("invalid_identity");
    const url = new URL(`/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${collection}/${encodeURIComponent(id)}`, origin);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetcher(url, { method: "GET", redirect: "error", credentials: "omit", cache: "no-store", headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
      if (response.status === 404) return null;
      if (!response.ok || response.url && new URL(response.url).href !== url.href) throw new Error("identity_lookup_failed");
      const body = await response.json();
      return { name: body.name, ...decodeFields(body.fields || {}) };
    } finally { clearTimeout(timer); }
  }
  async function legacyMember(uid: string, token: string) {
    const url = new URL(`/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents:runQuery`, origin);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetcher(url, { method: "POST", redirect: "error", credentials: "omit", cache: "no-store", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "users" }], where: { fieldFilter: { field: { fieldPath: "uid" }, op: "EQUAL", value: { stringValue: uid } } }, limit: 2 } }) });
      if (!response.ok || response.url && new URL(response.url).href !== url.href) throw new Error("identity_lookup_failed");
      const rows = (await response.json()).filter((item: any) => item.document);
      if (rows.length !== 1) return null;
      const document = rows[0].document;
      const prefix = `projects/${projectId}/databases/(default)/documents/users/`;
      const name = String(document.name || "");
      if (!name.startsWith(prefix)) throw new Error("identity_lookup_failed");
      return { pathId: decodeURIComponent(name.slice(prefix.length)), ...decodeFields(document.fields || {}) };
    } finally { clearTimeout(timer); }
  }
  return { readDocument, legacyMember };
}

export function createIdentityReader(source: ReturnType<typeof createFirestoreIdentityReader>) {
  const { readDocument, legacyMember } = source;
  return {
    readActivationAudit: (id: string, token: string) => readDocument("registration_audit", id, token),
    async admin(uid: string, token: string): Promise<AdminRecord | null> {
      const value = await readDocument("admin_users", uid, token);
      return value ? { found: true, role: typeof value.role === "string" ? value.role : undefined, status: typeof value.status === "string" ? value.status : undefined, protected: value.protected === true } : null;
    },
    async member(uid: string, token: string): Promise<MemberRecord | null> {
      // Current helper first resolves users/{uid}, then permits exactly one
      // legacy users document where uid == Auth UID. Never scans the collection.
      const value = await readDocument("users", uid, token);
      const resolved = value || await legacyMember(uid, token);
      if (!resolved) return null;
      const documentUid = typeof resolved.uid === "string" ? resolved.uid : uid;
      if (documentUid !== uid) return { found: true, uid: documentUid, status: "identity_mismatch" };
      return { found: true, uid, status: resolved.status_akun, emailVerified: undefined, activation: resolved.activation as Record<string, unknown>, profileId: typeof resolved.pathId === "string" ? resolved.pathId : uid };
    },
  };
}

export function isActiveMember(record: MemberRecord | null, tokenEmailVerified: boolean, audit: Record<string, unknown> | null): boolean {
  if (!record || record.found !== true || record.status !== "Aktif") return false;
  if (tokenEmailVerified) return true;
  const activation = record.activation || {};
  const at = activation.at, auditAt = audit?.createdAt;
  return activation.method === "admin-override" && typeof activation.auditId === "string" && !!audit &&
    audit.uid === record.uid && audit.targetUid === record.uid && audit.profileId === record.profileId &&
    audit.action === "activate-admin-override" && audit.activationPath === "admin-override" && audit.identityVerificationAttested === true &&
    audit.newStatus === "Aktif" && ["Pending", "Menunggu Verifikasi", "Aktif"].includes(String(audit.previousStatus)) &&
    typeof audit.actorUid === "string" && !!audit.actorUid && typeof at === "string" && at === auditAt;
}
