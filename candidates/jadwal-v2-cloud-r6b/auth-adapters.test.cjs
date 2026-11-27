"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync, sign } = require("node:crypto");
const { createFirebaseIdTokenVerifier, createGoogleFirebaseJwkResolver, GOOGLE_FIREBASE_JWKS } = require("./firebase-jwt-verifier.cjs");
const { createFirestoreEmulatorAdminReader } = require("./firestore-emulator-admin-reader.cjs");

const PROJECT = "demo-sipapua-schedule";
const NOW = 1_800_000_000;
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "synthetic-kid", use: "sig", alg: "RS256", key_ops: ["verify"] };

function makeToken(claims = {}, key = pair.privateKey, header = {}) {
  const h = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "synthetic-kid", ...header })).toString("base64url");
  const p = Buffer.from(JSON.stringify({ iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT,
    sub: "synthetic-admin-uid", iat: NOW - 20, auth_time: NOW - 30, exp: NOW + 3500, ...claims })).toString("base64url");
  const body = `${h}.${p}`;
  return `${body}.${sign("RSA-SHA256", Buffer.from(body), key).toString("base64url")}`;
}

test("01 Firebase ID token verifies issuer, audience, signature, UID and time claims with synthetic JWK", async () => {
  const verifier = createFirebaseIdTokenVerifier({ projectId: PROJECT, getTrustedKey: async kid => kid === jwk.kid ? jwk : null, clock: () => NOW });
  assert.deepEqual(await verifier(makeToken()), { uid: "synthetic-admin-uid" });
});

test("02 invalid signature, issuer, audience, expiry, nbf and key id fail closed", async () => {
  const verifier = createFirebaseIdTokenVerifier({ projectId: PROJECT, getTrustedKey: async kid => kid === jwk.kid ? jwk : null, clock: () => NOW });
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  for (const token of [
    makeToken({}, other.privateKey), makeToken({ iss: "https://invalid.example" }), makeToken({ aud: "boby-apps-project" }),
    makeToken({ exp: NOW }), makeToken({ nbf: NOW + 500 }), makeToken({}, pair.privateKey, { kid: "unknown" })
  ]) await assert.rejects(verifier(token));
});

test("03 invalid verifier configuration and weak/non-signing JWK are rejected", async () => {
  assert.throws(() => createFirebaseIdTokenVerifier({ projectId: "bad_id", getTrustedKey: async () => jwk }));
  const weak = { ...jwk, n: Buffer.alloc(64, 1).toString("base64url") };
  const verifier = createFirebaseIdTokenVerifier({ projectId: PROJECT, getTrustedKey: async () => weak, clock: () => NOW });
  await assert.rejects(verifier(makeToken()));
});

test("04 Google JWK resolver is fixed-origin, bounded, cached and sends no credentials", async () => {
  let calls = 0;
  const resolver = createGoogleFirebaseJwkResolver({ now: () => NOW * 1000, timeoutMs: 3000, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, GOOGLE_FIREBASE_JWKS);
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    return { ok: true, url: GOOGLE_FIREBASE_JWKS, headers: { get: name => name === "cache-control" ? "public, max-age=3600" : name === "content-type" ? "application/json" : null }, text: async () => JSON.stringify({ keys: [jwk] }) };
  } });
  assert.equal((await resolver(jwk.kid)).kid, jwk.kid);
  assert.equal((await resolver(jwk.kid)).kid, jwk.kid);
  assert.equal(calls, 1);
  assert.equal(await resolver("missing-key"), null);
  assert.equal(calls, 1);
});

test("05 Firestore role lookup allows only a demo project and explicit loopback emulator", async () => {
  assert.throws(() => createFirestoreEmulatorAdminReader({ projectId: "boby-apps-project", emulatorHost: "127.0.0.1:8080" }));
  assert.throws(() => createFirestoreEmulatorAdminReader({ projectId: PROJECT, emulatorHost: "firestore.googleapis.com:443" }));
  let observed;
  const readAdminRecord = createFirestoreEmulatorAdminReader({ projectId: PROJECT, emulatorHost: "127.0.0.1:8080", fetchImpl: async (url, options) => {
    observed = { url, options };
    return { ok: true, status: 200, url, json: async () => ({ fields: { role: { stringValue: "super_admin" }, status: { stringValue: "active" }, email: { stringValue: "must-not-escape" } } }) };
  } });
  assert.deepEqual(await readAdminRecord("synthetic-admin-uid", "synthetic-token"), { found: true, role: "super_admin", status: "active" });
  assert.match(observed.url, /^http:\/\/127\.0\.0\.1:8080\/v1\/projects\/demo-sipapua-schedule\/databases\/\(default\)\/documents\/admin_users\//);
  assert.equal(observed.options.headers.Authorization, "Bearer synthetic-token");
  assert.equal("email" in await readAdminRecord("synthetic-admin-uid", "synthetic-token"), false);
});

test("06 missing emulator admin document returns only not-found status", async () => {
  const readAdminRecord = createFirestoreEmulatorAdminReader({ projectId: PROJECT, emulatorHost: "127.0.0.1:8080", fetchImpl: async () => ({ ok: false, status: 404 }) });
  assert.deepEqual(await readAdminRecord("unknown-synthetic-uid", "synthetic-token"), { found: false });
});
