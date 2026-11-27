import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createFirebaseVerifier } from "../firebase-auth.ts";
import { createIdentityReader, isActiveMember } from "../firestore-identity.ts";
import { validateFilter, validateMutation } from "../validation.ts";
import { detectPosterType, validatePoster } from "../poster-validation.ts";
import { createHandler } from "../router.ts";

const project = "demo-sipapua-jadwal";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "synthetic-key-1", use: "sig", alg: "RS256" };
function token(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const enc = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const header = enc({ alg: "RS256", typ: "JWT", kid: jwk.kid });
  const payload = enc({ iss: `https://securetoken.google.com/${project}`, aud: project, sub: "synthetic-user", iat: now, auth_time: now, exp: now + 3600, email_verified: true, ...overrides });
  const input = `${header}.${payload}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
}

test("Firebase verifier checks cryptographic signature and Firebase claims", async () => {
  const verify = createFirebaseVerifier(project, async (url) => new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { "content-type": "application/json", "cache-control": "max-age=3600" } }));
  assert.deepEqual(await verify(token()), { uid: "synthetic-user", emailVerified: true });
  await assert.rejects(() => verify(token({ aud: "wrong-project" })));
  await assert.rejects(() => verify(token({ exp: 1 })));
  const signed = token().split(".");
  signed[2] = `${signed[2][0] === "A" ? "B" : "A"}${signed[2].slice(1)}`;
  const badSignature = signed.join(".");
  await assert.rejects(() => verify(badSignature));
  const unavailable = createFirebaseVerifier(project, async () => new Response("", { status: 503 }));
  await assert.rejects(() => unavailable(token()));
});

test("Firestore role and member adapter use only exact identity contracts", async () => {
  const read = async (collection, id) => collection === "admin_users" ? ({ role: "super_admin", status: "active" }) : collection === "users" ? ({ uid: id, status_akun: "Aktif" }) : null;
  const identity = createIdentityReader({ readDocument: read, legacyMember: async () => null });
  assert.deepEqual(await identity.admin("synthetic-user", "token"), { found: true, role: "super_admin", status: "active", protected: false });
  const member = await identity.member("synthetic-user", "token");
  assert.equal(isActiveMember(member, true, null), true);
  assert.equal(isActiveMember(member, false, null), false);
  assert.equal(isActiveMember({ ...member, status: "Pending" }, true, null), false);
  assert.equal(isActiveMember({ ...member, status: "identity_mismatch" }, true, null), false);
});

test("manual activation needs the bound audit contract", () => {
  const member = { found: true, uid: "u1", profileId: "p1", status: "Aktif", activation: { method: "admin-override", auditId: "a1", at: "2026-11-27T00:00:00Z" } };
  const audit = { uid: "u1", targetUid: "u1", profileId: "p1", action: "activate-admin-override", activationPath: "admin-override", identityVerificationAttested: true, newStatus: "Aktif", previousStatus: "Pending", actorUid: "admin", createdAt: "2026-11-27T00:00:00Z" };
  assert.equal(isActiveMember(member, false, audit), true);
  assert.equal(isActiveMember(member, false, { ...audit, profileId: "wrong" }), false);
  assert.equal(isActiveMember(member, false, { ...audit, createdAt: "wrong" }), false);
});

test("schedule query and mutation validators fail closed", () => {
  assert.deepEqual(validateFilter(new URLSearchParams("area=abepura&category=sunday-worship")), { area: "abepura", category: "sunday-worship", from: "", to: "" });
  assert.throws(() => validateFilter(new URLSearchParams("area=all")));
  assert.throws(() => validateFilter(new URLSearchParams("from=2026-02-30")));
  const body = { expectedRevision: 0, operationId: "40000000-0000-4000-8000-000000000001", schedule: { id: "30000000-0000-4000-8000-000000000001", area: "ABE", category: "sunday-worship", title: "Synthetic", theme: "Hope", date: "2026-12-06", startTime: "09:00", endTime: "10:00", venueId: "10000000-0000-4000-8000-000000000001", leaderId: "20000000-0000-4000-8000-000000000001" } };
  assert.doesNotThrow(() => validateMutation("/api/admin/drafts", body));
  assert.throws(() => validateMutation("/api/admin/drafts", { ...body, schedule: { ...body.schedule, theme: " " } }));
  assert.throws(() => validateMutation("/api/admin/drafts", { ...body, actorUid: "forged" }));
  assert.throws(() => validateMutation("/api/admin/drafts", { ...body, schedule: { ...body.schedule, area: "UNKNOWN" } }));
  assert.throws(() => validateMutation("/api/admin/drafts", { ...body, schedule: { ...body.schedule, date: "2026-02-30" } }));
});

test("poster validation checks actual signatures, size and random object key", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  assert.equal(detectPosterType(png), "image/png");
  const first = validatePoster(png, "image/png");
  const second = validatePoster(png, "image/png");
  assert.notEqual(first.objectKey, second.objectKey);
  assert.match(first.objectKey, /^[0-9a-f-]{36}\.png$/);
  assert.throws(() => validatePoster(png, "image/jpeg"));
  assert.throws(() => validatePoster(new Uint8Array(2 * 1024 * 1024 + 1), "image/png"));
  assert.equal(detectPosterType(new TextEncoder().encode("<svg>")), null);
});

test("HTTP router authorizes from verified UID and denies viewer, inactive, forged role and missing token", async () => {
  let dbCalls = 0;
  const admins = {
    admin: { found: true, role: "super_admin", status: "active" },
    master: { found: true, role: "master", status: "active", protected: true },
    viewer: { found: true, role: "viewer", status: "active" },
    inactive: { found: true, role: "super_admin", status: "inactive" },
    nonCanonicalStatus: { found: true, role: "super_admin", status: "ACTIVE" },
  };
  const handler = createHandler({
    verifier: async (credential) => { if (credential === "bad") throw new Error(); return { uid: credential, emailVerified: true }; },
    identityReader: {
      admin: async (uid) => admins[uid] || null,
      member: async (uid) => ({ found: true, uid, profileId: uid, status: "Aktif" }),
      readActivationAudit: async () => null,
    },
    repository: {
      execute: async () => { dbCalls++; return []; },
      writerRequest: async () => { dbCalls++; return []; },
    },
    masterUid: "master",
    corsOrigins: ["https://sipapua.example"],
  });
  const get = (credential, url = "https://edge.invalid/api/admin/session") => handler(new Request(url, { headers: credential ? { authorization: `Bearer ${credential}`, origin: "https://sipapua.example" } : { origin: "https://sipapua.example" } }));
  assert.equal((await get("admin")).status, 200);
  assert.equal((await get("viewer")).status, 403);
  assert.equal((await get("inactive")).status, 403);
  assert.equal((await get("nonCanonicalStatus")).status, 403);
  assert.equal((await get("bad")).status, 401);
  assert.equal((await get(null)).status, 401);
  assert.equal((await handler(new Request("https://edge.invalid/api/admin/drafts", { method: "POST", headers: { authorization: "Bearer admin", origin: "https://sipapua.example", "content-type": "application/json" }, body: JSON.stringify({ actorUid: "master", actorRole: "master" }) }))).status, 400);
  assert.equal(dbCalls, 0);
  assert.equal((await get("admin")).headers.get("access-control-allow-origin"), "https://sipapua.example");
});

test("HTTP route maps authorized operations to fixed RPC names and member to public projection only", async () => {
  const calls = [];
  const schedule = { id: "30000000-0000-4000-8000-000000000001", area: "ABE", category: "sunday-worship", title: "Synthetic", theme: "Hope", date: "2026-12-06", startTime: "09:00", endTime: "10:00", venueId: "10000000-0000-4000-8000-000000000001", leaderId: "20000000-0000-4000-8000-000000000001" };
  const handler = createHandler({
    verifier: async (token) => ({ uid: token, emailVerified: true }),
    identityReader: {
      admin: async (uid) => ({ found: true, role: uid === "master" ? "master" : "super_admin", status: "active", protected: true }),
      member: async (uid) => ({ found: true, uid, profileId: uid, status: "Aktif" }),
      readActivationAudit: async () => null,
    },
    repository: {
      execute: async (name, payload) => { calls.push([name, payload]); return [{ id: schedule.id, title: schedule.title, theme: schedule.theme, status: "published" }]; },
      writerRequest: async (name, payload, actor, action) => { calls.push([name, payload, actor, action]); return { id: schedule.id, status: "draft" }; },
    },
    masterUid: "master", corsOrigins: [],
  });
  const draftRequest = () => handler(new Request("https://edge.invalid/api/admin/drafts", { method: "POST", headers: { authorization: "Bearer master", "content-type": "application/json" }, body: JSON.stringify({ schedule, expectedRevision: 0, operationId: "40000000-0000-4000-8000-000000000001" }) }));
  assert.equal((await draftRequest()).status, 200);
  assert.equal(calls[0][0], "api_save_draft");
  assert.deepEqual(calls[0][2], { uid: "master", role: "master" });
  const memberResponse = await handler(new Request("https://edge.invalid/api/member/schedules", { headers: { authorization: "Bearer member" } }));
  assert.equal(memberResponse.status, 200);
  assert.equal(calls[1][0], "api_member_list");
  assert.equal(JSON.parse(await memberResponse.text()).data[0].status, "published");
});
