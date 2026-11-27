"use strict";

// Local-testable Firebase JWT verifier. The key resolver is injectable so
// synthetic tests never call Google. The production resolver is fixed to the
// official Firebase Secure Token JWK endpoint and sends no credentials.
const { createPublicKey, verify } = require("node:crypto");

const GOOGLE_FIREBASE_JWKS = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

function decodePart(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid_token");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw new Error("invalid_token");
  return bytes;
}

function parseObject(value) {
  const result = JSON.parse(decodePart(value).toString("utf8"));
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("invalid_token");
  return result;
}

function safeJsonResponse(response, maxBytes = 256 * 1024) {
  if (!response || response.ok !== true || response.url && new URL(response.url).href !== GOOGLE_FIREBASE_JWKS) {
    throw new Error("firebase_key_unavailable");
  }
  const length = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(length) && length > maxBytes) throw new Error("firebase_key_unavailable");
  return response.text().then(text => {
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("firebase_key_unavailable");
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.keys) || parsed.keys.length > 32) throw new Error("firebase_key_unavailable");
    return parsed.keys;
  });
}

function createGoogleFirebaseJwkResolver({ fetchImpl = globalThis.fetch, timeoutMs = 4000, now = () => Date.now() } = {}) {
  if (typeof fetchImpl !== "function" || !Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 10000) throw new Error("invalid_key_resolver");
  let cache = new Map();
  let expiresAt = 0;
  let pending;
  let unknownKidRefreshAt = 0;
  async function refresh() {
    if (pending) return pending;
    pending = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(GOOGLE_FIREBASE_JWKS, { method: "GET", redirect: "error", credentials: "omit", cache: "no-store", signal: controller.signal });
        const contentType = response.headers?.get?.("content-type") || "";
        if (!/^application\/(?:jwk-set\+)?json(?:\s*;|$)/i.test(contentType)) throw new Error("firebase_key_unavailable");
        const keys = await safeJsonResponse(response);
        const next = new Map();
        for (const key of keys) {
          if (key?.kty === "RSA" && typeof key.kid === "string" &&
              (key.use === undefined || key.use === "sig") && (key.alg === undefined || key.alg === "RS256") &&
              (key.key_ops === undefined || Array.isArray(key.key_ops) && key.key_ops.includes("verify"))) next.set(key.kid, key);
        }
        if (!next.size) throw new Error("firebase_key_unavailable");
        const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(response.headers?.get?.("cache-control") || "");
        const ttl = Math.max(5, Math.min(21600, maxAge ? Number(maxAge[1]) : 3600));
        cache = next;
        expiresAt = now() + ttl * 1000;
        unknownKidRefreshAt = now() + 30_000;
      } finally { clearTimeout(timer); pending = undefined; }
    })();
    return pending;
  }
  return async function getTrustedKey(kid) {
    if (typeof kid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(kid)) return null;
    if (now() >= expiresAt || !cache.has(kid) && now() >= unknownKidRefreshAt) await refresh();
    return cache.get(kid) || null;
  };
}

function createFirebaseIdTokenVerifier({ projectId, getTrustedKey, clock = () => Math.floor(Date.now() / 1000), clockSkewSeconds = 60 } = {}) {
  if (typeof projectId !== "string" || !PROJECT_ID.test(projectId) || typeof getTrustedKey !== "function" ||
      !Number.isInteger(clockSkewSeconds) || clockSkewSeconds < 0 || clockSkewSeconds > 120) throw new Error("invalid_verifier_configuration");
  const issuer = `https://securetoken.google.com/${projectId}`;
  return async function verifyFirebaseIdToken(token) {
    if (typeof token !== "string" || token.length > 16384) throw new Error("invalid_token");
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("invalid_token");
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = parseObject(encodedHeader);
    const payload = parseObject(encodedPayload);
    if (header.alg !== "RS256" || typeof header.kid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(header.kid) ||
        header.typ !== undefined && header.typ !== "JWT" || header.crit !== undefined || header.jku !== undefined || header.x5u !== undefined) throw new Error("invalid_token");
    const jwk = await getTrustedKey(header.kid);
    if (!jwk || jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string" ||
        jwk.kid !== undefined && jwk.kid !== header.kid || jwk.use !== undefined && jwk.use !== "sig" ||
        jwk.alg !== undefined && jwk.alg !== "RS256" || jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes("verify"))) throw new Error("invalid_token");
    let key;
    try { key = createPublicKey({ key: jwk, format: "jwk" }); } catch { throw new Error("invalid_token"); }
    if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength || 0) < 2048) throw new Error("invalid_token");
    if (!verify("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedPayload}`, "ascii"), key, decodePart(encodedSignature))) throw new Error("invalid_token");
    const now = clock();
    const isTime = value => Number.isSafeInteger(value) && value >= 0;
    if (!Number.isSafeInteger(now) || payload.iss !== issuer || payload.aud !== projectId ||
        typeof payload.sub !== "string" || payload.sub.trim() !== payload.sub || payload.sub.length < 1 || payload.sub.length > 128 ||
        !isTime(payload.exp) || !isTime(payload.iat) || !isTime(payload.auth_time) ||
        payload.exp <= now || payload.iat > now + clockSkewSeconds ||
        payload.auth_time > now + clockSkewSeconds || payload.auth_time > payload.iat + clockSkewSeconds ||
        payload.nbf !== undefined && (!isTime(payload.nbf) || payload.nbf > now + clockSkewSeconds)) throw new Error("invalid_token");
    return { uid: payload.sub };
  };
}

module.exports = { createFirebaseIdTokenVerifier, createGoogleFirebaseJwkResolver, GOOGLE_FIREBASE_JWKS };
