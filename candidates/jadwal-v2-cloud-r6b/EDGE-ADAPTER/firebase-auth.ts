const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const B64URL = /^[A-Za-z0-9_-]+$/;

function decode(text: string): Uint8Array {
  if (!text || !B64URL.test(text)) throw new Error("invalid_token");
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - text.length % 4) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
function decodeJson(part: string): Record<string, unknown> {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decode(part)));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_token");
  return value;
}

export function createFirebaseVerifier(projectId: string, fetcher: typeof fetch = fetch) {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) throw new Error("invalid_project");
  let keys = new Map<string, JsonWebKey>();
  let expiresAt = 0;
  let unknownKidRefreshAt = 0;
  let inFlight: Promise<void> | undefined;
  async function refresh() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      try {
        const response = await fetcher(JWKS_URL, { redirect: "error", credentials: "omit", cache: "no-store", signal: controller.signal });
        if (!response.ok || response.url && new URL(response.url).href !== JWKS_URL || !/^application\/(?:jwk-set\+)?json(?:\s*;|$)/i.test(response.headers.get("content-type") || "")) throw new Error("key_unavailable");
        const contentLength = Number(response.headers.get("content-length") || 0);
        if (contentLength > 262144) throw new Error("key_unavailable");
        const text = await response.text();
        if (new TextEncoder().encode(text).length > 262144) throw new Error("key_unavailable");
        const body = JSON.parse(text);
        if (!Array.isArray(body?.keys) || body.keys.length > 32) throw new Error("key_unavailable");
        const next = new Map<string, JsonWebKey>();
        for (const key of body.keys) if (key?.kty === "RSA" && typeof key.kid === "string" && (!key.use || key.use === "sig") && (!key.alg || key.alg === "RS256")) next.set(key.kid, key);
        if (!next.size) throw new Error("key_unavailable");
        keys = next;
        const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(response.headers.get("cache-control") || "");
        expiresAt = Date.now() + Math.min(21600, Math.max(5, Number(maxAge?.[1] || 3600))) * 1000;
        unknownKidRefreshAt = Date.now() + 30000;
      } finally { clearTimeout(timer); inFlight = undefined; }
    })();
    return inFlight;
  }
  return async (token: string): Promise<{ uid: string }> => {
    if (typeof token !== "string" || token.length > 16384) throw new Error("invalid_token");
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("invalid_token");
    const [h, p, s] = parts;
    const header = decodeJson(h), claims = decodeJson(p);
    if (header.alg !== "RS256" || typeof header.kid !== "string" || !B64URL.test(header.kid) || header.crit !== undefined || header.jku !== undefined || header.x5u !== undefined) throw new Error("invalid_token");
    if (Date.now() >= expiresAt) await refresh();
    else if (!keys.has(header.kid) && Date.now() >= unknownKidRefreshAt) await refresh();
    const jwk = keys.get(header.kid);
    if (!jwk || jwk.kty !== "RSA" || (jwk as JsonWebKey & { kid?: string }).kid && (jwk as JsonWebKey & { kid?: string }).kid !== header.kid) throw new Error("invalid_token");
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decode(s), new TextEncoder().encode(`${h}.${p}`));
    const now = Math.floor(Date.now() / 1000), uid = claims.sub;
    if (!valid || claims.iss !== `https://securetoken.google.com/${projectId}` || claims.aud !== projectId || typeof uid !== "string" || !uid.trim() || uid.trim() !== uid || uid.length > 128 ||
      !Number.isSafeInteger(claims.exp) || (claims.exp as number) <= now || !Number.isSafeInteger(claims.iat) || (claims.iat as number) > now + 60 ||
      !Number.isSafeInteger(claims.auth_time) || (claims.auth_time as number) > now + 60 || (claims.auth_time as number) > (claims.iat as number) + 60 ||
      claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || (claims.nbf as number) > now + 60)) throw new Error("invalid_token");
    return { uid, emailVerified: claims.email_verified === true };
  };
}
