"use strict";

const crypto = require("node:crypto");
const { PROJECT_ID, AUTH_ORIGIN, FIRESTORE_ORIGIN, decodeEmulatorToken, localRequest } = require("./firebase-emulator-adapters.cjs");

const HUB_ORIGIN = "http://127.0.0.1:4400";
const projectRoot = `projects/${PROJECT_ID}/databases/(default)/documents`;
const accountPrefix = `${AUTH_ORIGIN}/identitytoolkit.googleapis.com/v1`;

async function getJson(url, expectedStatus) {
  const response = await localRequest(url, { method: "GET" });
  if (response.url !== url || response.status !== expectedStatus) throw new Error(`local_emulator_preflight_failed_${response.status}`);
  return response.json().catch(() => ({}));
}

async function assertEmulatorsReady() {
  const hubUrl = `${HUB_ORIGIN}/emulators`;
  const hub = await getJson(hubUrl, 200);
  const listener = (name, port) => hub?.[name]?.host === "127.0.0.1" && Number(hub[name].port) === port &&
    Array.isArray(hub[name].listen) && hub[name].listen.some(item => item.address === "127.0.0.1" && Number(item.port) === port);
  if (!listener("auth", 9199) || !listener("firestore", 8080) || !listener("hub", 4400)) {
    throw new Error("expected_auth_firestore_and_hub_loopback_ports_not_reported");
  }
  const authConfigUrl = `${AUTH_ORIGIN}/emulator/v1/projects/${PROJECT_ID}/config`;
  const authConfig = await getJson(authConfigUrl, 200);
  if (!authConfig || typeof authConfig !== "object") throw new Error("auth_emulator_project_preflight_failed");
  const firestoreProbe = `${FIRESTORE_ORIGIN}/v1/projects/${PROJECT_ID}/databases/(default)/documents/r5-probe/not-created`;
  const response = await localRequest(firestoreProbe, { method: "GET" });
  const probe = await response.json().catch(() => ({}));
  if (response.url !== firestoreProbe || response.status !== 403 || probe?.error?.status !== "PERMISSION_DENIED") {
    throw new Error("firestore_emulator_project_preflight_failed");
  }
  return Object.freeze({ projectId: PROJECT_ID, authPort: 9199, firestorePort: 8080, hubPort: 4400,
    authProjectRoute: "PASS", firestoreProjectRoute: "PASS" });
}

async function ownerWriteDocument(collection, uid, values) {
  if (!["admin_users", "users"].includes(collection) || !/^[A-Za-z0-9_-]{1,128}$/.test(uid)) throw new Error("invalid_synthetic_document_path");
  const fields = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string") fields[key] = { stringValue: value };
    else if (typeof value === "boolean") fields[key] = { booleanValue: value };
    else throw new Error("invalid_synthetic_document_field");
  }
  const url = `${FIRESTORE_ORIGIN}/v1/projects/${PROJECT_ID}/databases/(default)/documents:commit`;
  const response = await localRequest(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer owner" },
    body: JSON.stringify({ writes: [{ update: { name: `${projectRoot}/${collection}/${uid}`, fields } }] }) });
  if (!response.ok || response.url !== url) throw new Error(`synthetic_firestore_fixture_failed_${response.status}`);
  await response.body?.cancel();
}

async function ownerDeleteDocument(collection, uid) {
  const url = `${FIRESTORE_ORIGIN}/v1/projects/${PROJECT_ID}/databases/(default)/documents/${collection}/${encodeURIComponent(uid)}`;
  const response = await localRequest(url, { method: "DELETE", headers: { Authorization: "Bearer owner" } });
  const status = response.status;
  await response.body?.cancel();
  if (![200, 404].includes(status) || response.url !== url) throw new Error(`synthetic_firestore_cleanup_failed_${status}`);
}

async function createSyntheticAccount(role, roleRecord, onCreated = () => {}) {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const uid = `r5-${role}-${nonce.slice(0, 20)}`;
  const email = `${uid}@example.test`;
  const password = `R5-${crypto.randomBytes(24).toString("base64url")}`;
  const createdUrl = `${accountPrefix}/projects/${PROJECT_ID}/accounts`;
  const created = await localRequest(createdUrl, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer owner" },
    body: JSON.stringify({ localId: uid, email, password, emailVerified: true, displayName: `Synthetic ${role}` }) });
  if (!created.ok || created.url !== createdUrl) throw new Error(`synthetic_auth_fixture_failed_${created.status}`);
  const createdBody = await created.json();
  if (createdBody.localId !== uid) throw new Error("synthetic_auth_uid_mismatch");
  const identity = { uid, email, password, token: null, role, roleRecord: roleRecord || null };
  onCreated(identity);
  const signInUrl = `${accountPrefix}/accounts:signInWithPassword?key=demo-key`;
  const signed = await localRequest(signInUrl, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }) });
  if (!signed.ok || signed.url !== signInUrl) throw new Error(`synthetic_auth_signin_failed_${signed.status}`);
  const session = await signed.json();
  if (session.localId !== uid || typeof session.idToken !== "string") throw new Error("synthetic_auth_session_invalid");
  const claims = decodeEmulatorToken(session.idToken);
  if (claims.sub !== uid || claims.aud !== PROJECT_ID) throw new Error("synthetic_auth_project_mismatch");
  identity.token = session.idToken;
  if (roleRecord) await ownerWriteDocument("admin_users", uid, roleRecord);
  if (role === "member") await ownerWriteDocument("users", uid, { uid, status_akun: "Aktif", nama: "Synthetic Member" });
  return identity;
}

async function cleanupSyntheticAccounts(accounts) {
  const errors = [];
  for (const account of [...accounts].reverse()) {
    try {
      if (account.roleRecord) await ownerDeleteDocument("admin_users", account.uid);
      if (account.role === "member") await ownerDeleteDocument("users", account.uid);
    } catch (error) { errors.push(error.message); }
    try {
      let token = account.token;
      if (!token) {
        const signInUrl = `${accountPrefix}/accounts:signInWithPassword?key=demo-key`;
        const signed = await localRequest(signInUrl, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: account.email, password: account.password, returnSecureToken: true }) });
        if (!signed.ok || signed.url !== signInUrl) throw new Error("synthetic_auth_cleanup_signin_failed");
        token = (await signed.json()).idToken;
      }
      const url = `${accountPrefix}/accounts:delete?key=demo-key`;
      const response = await localRequest(url, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken: token }) });
      const status = response.status;
      await response.body?.cancel();
      if (!response.ok || response.url !== url) throw new Error(`synthetic_auth_cleanup_failed_${status}`);
    } catch (error) { errors.push(error.message); }
  }
  if (errors.length) throw new Error(`synthetic_fixture_cleanup_failed:${errors.join(",")}`);
}

module.exports = { PROJECT_ID, AUTH_ORIGIN, FIRESTORE_ORIGIN, assertEmulatorsReady, createSyntheticAccount,
  cleanupSyntheticAccounts, ownerWriteDocument, ownerDeleteDocument };
