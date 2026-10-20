// LOCAL stand-in for the Firebase services Lacak Domba uses, for the browser
// E2E test only. Synthetic data, in memory, 127.0.0.1 only. It is NOT
// Firebase: tokens are signed with a key generated at start-up, and the
// "Firestore" here only checks document ownership, not firestore.rules.
//   GET  /jwks                              keys for the Edge Function
//   GET  /v1/projects/<id>/databases/(default)/documents/<path>
//                                           Firestore REST reads (Edge Function)
//   POST /mint      {uid}                   ID token for a synthetic user
//   POST /fs        {op, ...}               browser shim reads and writes
//   POST /admin     {op, ...}               test control (inspect, change)
// Run: deno run --no-lock --no-config --allow-net --allow-env tests/lacak-domba-e2e/fake-firebase.ts
import { exportJWK, generateKeyPair, jwtVerify, SignJWT, createLocalJWKSet } from "npm:jose@5.9.6";

const PROJECT_ID = "boby-apps-project";
const PORT = Number(Deno.env.get("LD_E2E_FIREBASE_PORT") || 54340);
const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
const jwk = { ...(await exportJWK(publicKey)), kid: "e2e-kid", alg: "RS256", use: "sig" };
const localJwks = createLocalJWKSet({ keys: [jwk] });

type Value = unknown;
type Doc = Record<string, Value>;
const store = new Map<string, Doc>();
const log: Array<{ at: string; op: string; path: string; uid: string }> = [];

const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function mint(uid: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return await new SignJWT({ email_verified: true })
        .setProtectedHeader({ alg: "RS256", kid: "e2e-kid" })
        .setIssuer(`https://securetoken.google.com/${PROJECT_ID}`)
        .setAudience(PROJECT_ID)
        .setSubject(uid)
        .setIssuedAt(now)
        .setExpirationTime(now + 3600)
        .sign(privateKey);
}

async function callerUid(request: Request): Promise<string | null> {
    const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    try {
        const { payload } = await jwtVerify(token, localJwks, {
            issuer: `https://securetoken.google.com/${PROJECT_ID}`,
            audience: PROJECT_ID,
        });
        return typeof payload.sub === "string" ? payload.sub : null;
    } catch {
        return null;
    }
}

// Owner of a path, for the collections whose documents are private.
function ownerOf(path: string): string | null {
    const [collection, id] = path.split("/");
    if (["users", "presence", "presence_locations", "user_blocks", "contacts"].includes(collection)) return id;
    return null;
}

// Reads: users, presence_locations, user_blocks and contacts are owner-only;
// presence and friend_requests are readable by signed-in users.
function canRead(uid: string, path: string): boolean {
    const [collection] = path.split("/");
    if (["presence", "friend_requests"].includes(collection)) return true;
    return ownerOf(path) === uid;
}

function canWrite(uid: string, path: string): boolean {
    const [collection] = path.split("/");
    if (collection === "friend_requests") return true;
    if (collection === "contacts") return true; // blocking removes both sides
    if (collection === "users") return false;
    return ownerOf(path) === uid;
}

// {"__ts": true} = server timestamp, {"__date": iso} = a timestamp.
function decode(value: Value): Value {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        const object = value as Record<string, Value>;
        if (object.__ts === true) return new Date();
        if (typeof object.__date === "string") return new Date(object.__date);
        return Object.fromEntries(Object.entries(object).map(([k, v]) => [k, decode(v)]));
    }
    return value;
}

function encode(doc: Doc): Doc {
    return Object.fromEntries(Object.entries(doc).map(([k, v]) =>
        [k, v instanceof Date ? { __date: v.toISOString() } : v]));
}

function firestoreFields(doc: Doc) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(doc)) {
        if (typeof value === "boolean") out[key] = { booleanValue: value };
        else if (typeof value === "number") out[key] = { doubleValue: value };
        else if (value instanceof Date) out[key] = { timestampValue: value.toISOString() };
        else if (value === null) out[key] = { nullValue: null };
        else out[key] = { stringValue: String(value) };
    }
    return out;
}

function children(collectionPath: string): Array<[string, Doc]> {
    const depth = collectionPath.split("/").length + 1;
    return [...store.entries()].filter(([path]) =>
        path.startsWith(collectionPath + "/") && path.split("/").length === depth);
}

async function firestoreRest(request: Request, url: URL): Promise<Response> {
    const prefix = `/v1/projects/${PROJECT_ID}/databases/(default)/documents/`;
    const path = decodeURIComponent(url.pathname.slice(prefix.length));
    const uid = await callerUid(request);
    if (!uid) return reply({ error: { code: 401 } }, 401);
    if (!canRead(uid, path)) return reply({ error: { code: 403 } }, 403);
    const name = (p: string) => `projects/${PROJECT_ID}/databases/(default)/documents/${p}`;
    if (path.split("/").length % 2 === 1) {
        const documents = children(path).map(([p, doc]) => ({ name: name(p), fields: firestoreFields(doc) }));
        return reply({ documents });
    }
    const doc = store.get(path);
    if (!doc) return reply({ error: { code: 404 } }, 404);
    return reply({ name: name(path), fields: firestoreFields(doc) });
}

async function browserFirestore(request: Request): Promise<Response> {
    const uid = await callerUid(request);
    if (!uid) return reply({ error: "unauthenticated" }, 401);
    const body = await request.json();
    const ops = body.op === "batch" ? body.ops : [body];
    for (const op of ops) {
        const allowed = op.op === "get" || op.op === "list" || op.op === "query"
            ? canRead(uid, op.path)
            : canWrite(uid, op.path);
        if (!allowed) return reply({ error: "permission-denied", path: op.path }, 403);
    }
    if (body.op === "get") {
        const doc = store.get(body.path);
        return reply({ exists: !!doc, data: doc ? encode(doc) : null });
    }
    if (body.op === "list" || body.op === "query") {
        let docs = children(body.path);
        for (const [field, , value] of body.where || []) {
            docs = docs.filter(([, doc]) => doc[field] === value);
        }
        return reply({ docs: docs.map(([p, doc]) => ({ id: p.split("/").pop(), data: encode(doc) })) });
    }
    for (const op of ops) {
        log.push({ at: new Date().toISOString(), op: op.op, path: op.path, uid });
        if (op.op === "delete") store.delete(op.path);
        else if (op.op === "set" && !op.merge) store.set(op.path, decode(op.data) as Doc);
        else if (op.op === "set" || op.op === "update") {
            if (op.op === "update" && !store.has(op.path)) return reply({ error: "not-found" }, 404);
            store.set(op.path, { ...(store.get(op.path) || {}), ...(decode(op.data) as Doc) });
        } else return reply({ error: "bad op" }, 400);
    }
    return reply({ ok: true });
}

function admin(body: Record<string, any>): Response {
    switch (body.op) {
        case "set":
            store.set(body.path, decode(body.data) as Doc);
            return reply({ ok: true });
        case "get": {
            const doc = store.get(body.path);
            return reply({ exists: !!doc, data: doc ? encode(doc) : null });
        }
        case "delete":
            store.delete(body.path);
            return reply({ ok: true });
        case "shift": // as if body.ms had passed for every stored timestamp
            for (const doc of store.values()) {
                for (const [key, value] of Object.entries(doc)) {
                    if (value instanceof Date) doc[key] = new Date(value.getTime() - body.ms);
                }
            }
            return reply({ ok: true });
        case "log":
            return reply({ log });
        case "reset":
            store.clear();
            log.length = 0;
            return reply({ ok: true });
        default:
            return reply({ error: "unknown admin op" }, 400);
    }
}

Deno.serve({ hostname: "127.0.0.1", port: PORT, onListen: () => console.log(`fake-firebase on ${PORT}`) }, async (request) => {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (url.pathname === "/jwks") return reply({ keys: [jwk] });
    if (url.pathname.startsWith("/v1/projects/")) return await firestoreRest(request, url);
    if (url.pathname === "/mint" && request.method === "POST") {
        const { uid } = await request.json();
        if (typeof uid !== "string" || !uid.startsWith("test-ld-")) return reply({ error: "synthetic uids only" }, 400);
        return reply({ token: await mint(uid) });
    }
    if (url.pathname === "/fs" && request.method === "POST") return await browserFirestore(request);
    if (url.pathname === "/admin" && request.method === "POST") return admin(await request.json());
    return reply({ error: "not found" }, 404);
});
