// Integration tests for supabase/functions/lacak-domba-nearby/index.ts
// against a REAL local PostgREST + PostgreSQL with the Lacak Domba
// migrations applied. Synthetic users only. Google JWKS and Firestore REST
// are in-process fakes behind a stubbed fetch (no Firebase project is
// used); every PostgREST call is a real HTTP request. Deno.serve is
// captured instead of listening.
// Needs (LOCAL only, never production):
//   LD_TEST_SUPABASE_URL        e.g. http://127.0.0.1:54330 (gateway with /rest/v1)
//   LD_TEST_SERVICE_ROLE_KEY    a service_role JWT for that local PostgREST
//   LD_TEST_ANON_KEY            an anon JWT for it (direct-access checks)
//   LD_TEST_DB_URL              postgres://postgres@127.0.0.1:54329/lacak_test
// Run: deno test --no-lock --no-config --allow-env --allow-net --allow-read --allow-sys supabase/functions/tests/lacak-domba-nearby_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { exportJWK, generateKeyPair, SignJWT } from "npm:jose@5.9.6";
import postgres from "npm:postgres@3.4.5";

const PROJECT_ID = "boby-apps-project";
const FIRESTORE =
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/`;
const JWKS_URL =
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const SUPABASE_URL = Deno.env.get("LD_TEST_SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("LD_TEST_SERVICE_ROLE_KEY") || "";
const ANON_KEY = Deno.env.get("LD_TEST_ANON_KEY") || "";
const DB_URL = Deno.env.get("LD_TEST_DB_URL") || "";
const isLocal = (url: string) => /^(https?|postgres(ql)?):\/\/([^@/]*@)?(127\.0\.0\.1|localhost)[:/]/.test(url);
const ignore = !(isLocal(SUPABASE_URL) && isLocal(DB_URL) && SERVICE_KEY);
if (ignore) console.warn("Local PostgREST/PostgreSQL not configured: integration tests SKIPPED.");

const ORIGIN = "http://localhost:5500";
const MINUTE = 60 * 1000;

// Synthetic users. Coordinates are a made-up point, not a real person.
const ALICE = "test-ld-alice";
const BOB = "test-ld-bob";
const CAROL = "test-ld-carol";
const DAVE = "test-ld-dave";
const EVE = "test-ld-eve";
const BASE_LAT = -1.0;
const BASE_LON = 131.0;
// Latitude offsets for a given distance (1 degree of latitude ~ 110.574 km).
const km = (distance: number) => distance / 110.574;

// --- Firebase tokens ------------------------------------------------------
const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
const jwk = { ...(await exportJWK(publicKey)), kid: "test-kid", alg: "RS256", use: "sig" };
const other = await generateKeyPair("RS256", { extractable: true });

async function idToken(
    uid: string,
    options: { expired?: boolean; foreignKey?: boolean; audience?: string } = {},
): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return await new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
        .setIssuer(`https://securetoken.google.com/${PROJECT_ID}`)
        .setAudience(options.audience || PROJECT_ID)
        .setSubject(uid)
        .setIssuedAt(options.expired ? now - 7200 : now)
        .setExpirationTime(options.expired ? now - 3600 : now + 3600)
        .sign(options.foreignKey ? other.privateKey : privateKey);
}

function tokenUid(request: Request): string {
    const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const payload = token.split(".")[1] || "";
    const text = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(text).sub;
}

// --- Firestore fake (owner-only reads, like firestore.rules) --------------
type Fields = Record<string, unknown>;
const firestore = new Map<string, Fields>();
// Block lists cannot be read (Firestore outage) while true.
let failBlockLists = false;

function toFirestoreFields(fields: Fields) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
        if (typeof value === "boolean") out[key] = { booleanValue: value };
        else if (typeof value === "number") out[key] = { doubleValue: value };
        else if (value instanceof Date) out[key] = { timestampValue: value.toISOString() };
        else out[key] = { stringValue: String(value) };
    }
    return out;
}

function firestoreResponse(request: Request, url: URL): Response {
    const path = decodeURIComponent(url.href.slice(FIRESTORE.length).split("?")[0]);
    const caller = tokenUid(request);
    const segments = path.split("/");
    const owner = segments[1];
    const ownerOnly = ["presence_locations", "user_blocks"].includes(segments[0]);
    if ((ownerOnly || segments[0] === "presence") && owner !== caller) {
        return new Response("{}", { status: 403 });
    }
    if (segments[0] === "user_blocks") {
        if (failBlockLists) return new Response("{}", { status: 503 });
        const documents = [...firestore.keys()]
            .filter((key) => key.startsWith(`user_blocks/${owner}/blocked/`))
            .map((key) => ({ name: `projects/x/databases/(default)/documents/${key}` }));
        return Response.json({ documents });
    }
    const fields = firestore.get(path);
    if (!fields) return new Response("{}", { status: 404 });
    return Response.json({
        name: `projects/x/databases/(default)/documents/${path}`,
        fields: toFirestoreFields(fields),
    });
}

function setUser(uid: string, status: string) {
    firestore.set(`users/${uid}`, { status_akun: status });
}

function setPresence(uid: string, discoverable: boolean) {
    firestore.set(`presence/${uid}`, {
        discoverable,
        online: true,
        showOnline: true,
        lastSeen: new Date(),
        displayName: `Sintetis ${uid}`,
        photoURL: "",
        komsel: "Komsel Uji",
        wilayah: "Wilayah Uji",
    });
}

// What savePrivateLocation does in the browser: a fresh location now.
function saveLocation(uid: string, latOffset = 0) {
    firestore.set(`presence_locations/${uid}`, {
        latitude: BASE_LAT + latOffset,
        longitude: BASE_LON,
        updatedAt: new Date(),
    });
}

// What updatePresence does on every heartbeat.
function heartbeat(uid: string) {
    const presence = firestore.get(`presence/${uid}`);
    if (presence) presence.lastSeen = new Date();
}

// --- fetch stub: Google fakes, everything local passes through -------------
const realFetch = globalThis.fetch;
const unexpected: string[] = [];
let failPurges = false;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (request.url === JWKS_URL) return Response.json({ keys: [jwk] });
    if (request.url.startsWith(FIRESTORE)) return firestoreResponse(request, url);
    if (SUPABASE_URL && request.url.startsWith(SUPABASE_URL)) {
        if (failPurges && url.pathname.endsWith("/rpc/lacak_domba_purge_stale")) {
            return Response.json({ message: "simulated purge failure" }, { status: 500 });
        }
        return await realFetch(request);
    }
    unexpected.push(request.url);
    return new Response("blocked by test", { status: 599 });
};

// --- database (setup, inspection and elapsed time only) ---------------------
const sql = ignore ? null : postgres(DB_URL, { max: 2, onnotice: () => {} });

async function presenceRow(uid: string) {
    const [row] = await sql!`
        select discovery_session_id::text as session_id, discoverable_until, updated_at
        from public.lacak_domba_presence where firebase_uid = ${uid}`;
    return row;
}

// As if `ms` had passed: every stored time of the test users moves back,
// in the database and in the Firestore fake. The clocks themselves are real.
async function advance(ms: number) {
    const shift = `${Math.round(ms / 1000)} seconds`;
    await sql!`
        update public.lacak_domba_presence set
            discoverable_until = discoverable_until - ${shift}::interval,
            session_started_at = session_started_at - ${shift}::interval,
            updated_at = updated_at - ${shift}::interval,
            last_seen = last_seen - ${shift}::interval,
            location_updated_at = location_updated_at - ${shift}::interval
        where firebase_uid like 'test-ld-%'`;
    await sql!`
        update public.lacak_domba_scan_limits
        set last_scan_at = last_scan_at - ${shift}::interval
        where firebase_uid like 'test-ld-%'`;
    for (const fields of firestore.values()) {
        for (const [key, value] of Object.entries(fields)) {
            if (value instanceof Date) fields[key] = new Date(value.getTime() - ms);
        }
    }
}

// --- load the function without listening ------------------------------------
Deno.env.set("SUPABASE_URL", SUPABASE_URL || "http://127.0.0.1:1");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY || "unset");
let handler: ((request: Request) => Promise<Response>) | null = null;
Object.defineProperty(Deno, "serve", {
    configurable: true,
    writable: true,
    value: (callback: (request: Request) => Promise<Response>) => {
        handler = callback;
        return { finished: Promise.resolve(), shutdown: async () => {} };
    },
});
await import("../lacak-domba-nearby/index.ts");

async function call(
    uid: string | null,
    body: Record<string, unknown>,
    options: { origin?: string | null; token?: string } = {},
): Promise<{ status: number; data: Record<string, any>; text: string }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const origin = options.origin === undefined ? ORIGIN : options.origin;
    if (origin) headers.Origin = origin;
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    else if (uid) headers.Authorization = `Bearer ${await idToken(uid)}`;
    const response = await handler!(new Request("http://edge.test/lacak-domba-nearby", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
    }));
    const text = await response.text();
    return { status: response.status, data: JSON.parse(text), text };
}

const listed = (data: Record<string, any>, uid: string) =>
    (data.results || []).some((member: { uid: string }) => member.uid === uid);

async function reset() {
    firestore.clear();
    failPurges = false;
    failBlockLists = false;
    await sql!`delete from public.lacak_domba_presence where firebase_uid like 'test-ld-%'`;
    await sql!`delete from public.lacak_domba_blocks where blocker_uid like 'test-ld-%'`;
    await sql!`delete from public.lacak_domba_scan_limits where firebase_uid like 'test-ld-%'`;
    for (const uid of [ALICE, BOB, DAVE, EVE]) setUser(uid, "Aktif");
    setUser(CAROL, "Nonaktif");
    setPresence(ALICE, true);
    setPresence(BOB, false);
}

// Bob is a non-discoverable scanner standing next to Alice.
async function bobScan(radiusKm = 5) {
    heartbeat(BOB);
    saveLocation(BOB, 0.001);
    await sql!`delete from public.lacak_domba_scan_limits where firebase_uid = ${BOB}`;
    return await call(BOB, { action: "scan", radiusKm });
}

async function startAlice() {
    heartbeat(ALICE);
    saveLocation(ALICE);
    const start = await call(ALICE, { action: "discovery_start" });
    assertEquals(start.status, 200);
    return start.data.discovery as { active: boolean; expiresInMs: number; sessionId: string; expiresAt: string };
}

const near = (actual: number, expected: number, slack = 3000) =>
    assert(Math.abs(actual - expected) <= slack, `${actual} is not within ${slack} ms of ${expected}`);

const test = (name: string, fn: () => Promise<void>) =>
    Deno.test({ name, ignore, sanitizeOps: false, sanitizeResources: false, fn: async () => {
        await reset();
        await fn();
    } });

// --- tests -------------------------------------------------------------------

test("explicit start opens a 15-minute session with an id and makes the user discoverable", async () => {
    const discovery = await startAlice();
    assertEquals(discovery.active, true);
    near(discovery.expiresInMs, 15 * MINUTE);
    assert(/^[0-9a-f-]{36}$/.test(discovery.sessionId));
    const scan = await bobScan();
    assertEquals(scan.status, 200);
    assert(listed(scan.data, ALICE), "Alice must be listed during her session");
    assertEquals(scan.data.results[0].distanceRange, "< 1 KM");
});

test("heartbeat sync, scan and a repeated start never extend the session", async () => {
    const first = await startAlice();
    const untilBefore = (await presenceRow(ALICE)).discoverable_until.getTime();

    await advance(5 * MINUTE);
    heartbeat(ALICE);
    const sync = await call(ALICE, { action: "sync", syncBlocks: false });
    near(sync.data.discovery.expiresInMs, 10 * MINUTE);

    await advance(1 * MINUTE);
    saveLocation(ALICE); // a scan saves a fresh location first
    const scan = await call(ALICE, { action: "scan", radiusKm: 1 });
    assertEquals(scan.status, 200);
    near(scan.data.discovery.expiresInMs, 9 * MINUTE);

    const again = await call(ALICE, { action: "discovery_start" });
    near(again.data.discovery.expiresInMs, 9 * MINUTE);
    assertEquals(again.data.discovery.sessionId, first.sessionId);
    assertEquals((await presenceRow(ALICE)).discoverable_until.getTime(), untilBefore - 6 * MINUTE);
});

test("only discovery_extend for the shown session moves the end, to 15 minutes from the click", async () => {
    const first = await startAlice();
    await advance(10 * MINUTE);
    saveLocation(ALICE);
    const extend = await call(ALICE, { action: "discovery_extend", sessionId: first.sessionId });
    assertEquals(extend.status, 200);
    near(extend.data.discovery.expiresInMs, 15 * MINUTE);
    assertEquals(extend.data.discovery.sessionId, first.sessionId);
});

test("LD16-01: extend from a stale tab for another session is refused and reports the running one", async () => {
    const startedAt = Date.now();
    const first = await startAlice();
    const stale = "00000000-0000-4000-8000-000000000000";
    saveLocation(ALICE);
    const extend = await call(ALICE, { action: "discovery_extend", sessionId: stale });
    const elapsed = Date.now() - startedAt;
    assertEquals(extend.status, 409);
    assertEquals(extend.data.error, "discovery_session_changed");
    assertEquals(extend.data.discovery.sessionId, first.sessionId);
    // Not extended: the same end time, never more than the running session
    // had left. Measured against real elapsed time, so a slow machine cannot
    // fail it and a wrongful extend cannot pass it.
    assertEquals(extend.data.discovery.expiresAt, first.expiresAt);
    assert(extend.data.discovery.expiresInMs <= first.expiresInMs, "the stale extend extended the session");
    assert(extend.data.discovery.expiresInMs >= 15 * MINUTE - elapsed - 1000, "remaining time too short");
});

test("LD16-01: a stale tab's expiry clear, leave and stop_retry never end a session another tab extended or restarted", async () => {
    const s1 = await startAlice();
    // Tab B extended; tab A's countdown ended: "expired" changes nothing.
    const expired = await call(ALICE, { action: "clear", mode: "expired" });
    assertEquals(expired.status, 200);
    assertEquals(expired.data.discovery.sessionId, s1.sessionId);
    assert(await presenceRow(ALICE));

    // s1 ends, tab B starts s2; tab A's leave / stop retry for s1 arrive late.
    await advance(15 * MINUTE + 1000);
    const s2 = await startAlice();
    assert(s2.sessionId !== s1.sessionId);
    for (const mode of ["leave", "stop_retry"]) {
        const late = await call(ALICE, { action: "clear", mode, sessionId: s1.sessionId });
        assertEquals(late.status, 200);
        assertEquals(late.data.discovery.sessionId, s2.sessionId, mode);
    }
    assert(listed((await bobScan()).data, ALICE), "s2 is still listed");

    // An explicit Matikan always ends it.
    const stop = await call(ALICE, { action: "clear", mode: "stop" });
    assertEquals(stop.data.discovery, { active: false, expiresInMs: 0, sessionId: null, expiresAt: null });
    assert(!listed((await bobScan()).data, ALICE));
});

test("the server stops listing the user when the session ends, even with a fresh location", async () => {
    await startAlice();
    await advance(14 * MINUTE);
    heartbeat(ALICE);
    saveLocation(ALICE);
    await call(ALICE, { action: "sync", syncBlocks: false });

    await advance(1 * MINUTE + 1000); // session over, location only 1 minute old
    heartbeat(ALICE);
    const scan = await bobScan();
    assertEquals(scan.status, 200);
    assert(!listed(scan.data, ALICE), "an expired session must not be listed");
    assertEquals(await presenceRow(ALICE), undefined, "the expired row is purged");
});

test("the scan excludes an ended session even when the purge fails", async () => {
    await startAlice();
    await advance(15 * MINUTE + 1000);
    heartbeat(ALICE);
    failPurges = true;
    const scan = await bobScan();
    assertEquals(scan.status, 200, "a failed purge must not block the scan");
    assert(await presenceRow(ALICE), "the row is still stored");
    assert(!listed(scan.data, ALICE), "but it must not be listed");
});

test("after expiry: sync reports inactive, extend is refused, a new start works", async () => {
    const first = await startAlice();
    await advance(15 * MINUTE + 1000);
    heartbeat(ALICE);
    saveLocation(ALICE);

    const sync = await call(ALICE, { action: "sync", syncBlocks: false });
    assertEquals(sync.data.discovery, { active: false, expiresInMs: 0, sessionId: null, expiresAt: null });
    assertEquals(await presenceRow(ALICE), undefined);

    const extend = await call(ALICE, { action: "discovery_extend", sessionId: first.sessionId });
    assertEquals(extend.status, 409);
    assertEquals(extend.data.error, "discovery_expired");

    const start = await call(ALICE, { action: "discovery_start" });
    near(start.data.discovery.expiresInMs, 15 * MINUTE);
    assert(start.data.discovery.sessionId !== first.sessionId);
});

test("clear (Matikan) ends the session at once and a later sync does not revive it", async () => {
    await startAlice();
    await advance(2 * MINUTE);
    const clear = await call(ALICE, { action: "clear" });
    assertEquals(clear.data.discovery, { active: false, expiresInMs: 0, sessionId: null, expiresAt: null });
    assert(!listed((await bobScan()).data, ALICE));
    // Firestore still says discoverable (the browser write failed): no revival.
    heartbeat(ALICE);
    const sync = await call(ALICE, { action: "sync", syncBlocks: false });
    assertEquals(sync.data.discovery.active, false);
    assert(!listed((await bobScan()).data, ALICE));
});

test("withdrawn in Firestore: the next sync removes the server copy", async () => {
    await startAlice();
    setPresence(ALICE, false);
    const sync = await call(ALICE, { action: "sync", syncBlocks: false });
    assertEquals(sync.data.discovery.active, false);
    assertEquals(await presenceRow(ALICE), undefined);
});

test("a sync without an explicit start never creates a session", async () => {
    saveLocation(ALICE);
    const sync = await call(ALICE, { action: "sync" });
    assertEquals(sync.data.discovery, { active: false, expiresInMs: 0, sessionId: null, expiresAt: null });
    assertEquals(await presenceRow(ALICE), undefined);
    assert(!listed((await bobScan()).data, ALICE));
});

test("legacy rows without a session are never listed", async () => {
    await sql!`
        insert into public.lacak_domba_presence (firebase_uid, latitude, longitude,
            display_name, discoverable, show_online, online, last_seen, location_updated_at)
        values (${ALICE}, ${BASE_LAT}, ${BASE_LON}, 'Legacy', true, true, true, now(), now())`;
    failPurges = true; // even when it is not purged
    assert(!listed((await bobScan()).data, ALICE));
});

test("start needs a fresh location and an active account; a deactivated account is hidden", async () => {
    const noLocation = await call(ALICE, { action: "discovery_start" });
    assertEquals(noLocation.status, 412);
    assertEquals(noLocation.data.error, "discovery_not_ready");

    saveLocation(ALICE);
    await advance(16 * MINUTE); // location too old
    const stale = await call(ALICE, { action: "discovery_start" });
    assertEquals(stale.status, 412);

    setPresence(CAROL, true);
    saveLocation(CAROL);
    const inactive = await call(CAROL, { action: "discovery_start" });
    assertEquals(inactive.status, 403);
    assertEquals(inactive.data.error, "account_not_active");

    // Alice is deactivated during her session: her next request hides her.
    await startAlice();
    setUser(ALICE, "Nonaktif");
    const sync = await call(ALICE, { action: "sync", syncBlocks: false });
    assertEquals(sync.status, 403);
    assertEquals(await presenceRow(ALICE), undefined);
    // A deactivated account may still clear.
    assertEquals((await call(ALICE, { action: "clear" })).status, 200);
});

test("tokens: missing, forged, expired or for another project are refused (401)", async () => {
    assertEquals((await call(null, { action: "discovery_start" })).status, 401);
    for (const token of [
        await idToken(ALICE, { foreignKey: true }),
        await idToken(ALICE, { expired: true }),
        await idToken(ALICE, { audience: "another-project" }),
        "not-a-jwt",
    ]) {
        const response = await call(null, { action: "sync" }, { token });
        assertEquals(response.status, 401);
        assertEquals(response.data.error, "invalid_token");
    }
});

test("origin, method, action, radius, session id and mode are validated", async () => {
    assertEquals((await call(ALICE, { action: "sync" }, { origin: "https://evil.example" })).status, 403);
    const unknown = await call(ALICE, { action: "discovery_forever" });
    assertEquals(unknown.status, 400);
    assertEquals(unknown.data.error, "invalid_action");
    saveLocation(ALICE);
    assertEquals((await call(ALICE, { action: "scan", radiusKm: 2 })).data.error, "invalid_radius");
    assertEquals((await call(ALICE, { action: "discovery_extend" })).data.error, "invalid_session");
    assertEquals((await call(ALICE, { action: "discovery_extend", sessionId: "x" })).data.error, "invalid_session");
    assertEquals((await call(ALICE, { action: "clear", mode: "everyone" })).data.error, "invalid_mode");
    assertEquals((await call(ALICE, { action: "clear", mode: "leave" })).data.error, "invalid_session");
    const get = await handler!(new Request("http://edge.test/x", { method: "GET", headers: { Origin: ORIGIN } }));
    assertEquals(get.status, 405);
    await get.body?.cancel();
});

test("radius 1, 5 and 10 km with coarse ranges only", async () => {
    await startAlice();
    // Dave ~3 km and Eve ~8 km from Bob's scan point, both discoverable.
    for (const [uid, distance] of [[DAVE, 3], [EVE, 8]] as const) {
        setPresence(uid, true);
        saveLocation(uid, 0.001 + km(distance));
        assertEquals((await call(uid, { action: "discovery_start" })).status, 200);
    }
    const r1 = await bobScan(1);
    assertEquals(r1.data.results.map((m: { uid: string }) => m.uid), [ALICE]);
    const r5 = await bobScan(5);
    assertEquals(r5.data.results.map((m: { uid: string; distanceRange: string }) => [m.uid, m.distanceRange]),
        [[ALICE, "< 1 KM"], [DAVE, "1–5 KM"]]);
    const r10 = await bobScan(10);
    assertEquals(r10.data.results.map((m: { uid: string; distanceRange: string }) => [m.uid, m.distanceRange]),
        [[ALICE, "< 1 KM"], [DAVE, "1–5 KM"], [EVE, "5–10 KM"]]);
    for (const response of [r1, r5, r10]) {
        assert(!/latitude|longitude|lat"|lon"/.test(response.text), "no coordinates in the response");
        assert(!/firebase_uid|discoverable_until|session/.test(JSON.stringify(response.data.results)));
    }
});

test("blocks work in both directions", async () => {
    await startAlice();
    setPresence(BOB, true);
    saveLocation(BOB, 0.001);
    assertEquals((await call(BOB, { action: "discovery_start" })).status, 200);

    // Alice blocks Bob in Firestore; her next sync mirrors it.
    firestore.set(`user_blocks/${ALICE}/blocked/${BOB}`, { blockedUid: BOB });
    assertEquals((await call(ALICE, { action: "sync", syncBlocks: true })).status, 200);
    const bobView = await bobScan();
    assert(!listed(bobView.data, ALICE), "Bob does not see Alice");
    saveLocation(ALICE);
    const aliceView = await call(ALICE, { action: "scan", radiusKm: 5 });
    assertEquals(aliceView.status, 200);
    assert(!listed(aliceView.data, BOB), "Alice does not see Bob");

    // Unblocking restores both views.
    firestore.delete(`user_blocks/${ALICE}/blocked/${BOB}`);
    await sql!`delete from public.lacak_domba_scan_limits where firebase_uid = ${ALICE}`;
    saveLocation(ALICE);
    const again = await call(ALICE, { action: "scan", radiusKm: 5 });
    assert(listed(again.data, BOB));
});

test("replies carry the server-verified end (expiresAt) equal to discoverable_until in PostgreSQL", async () => {
    const started = await startAlice();
    const [stored] = await sql!`select discoverable_until from public.lacak_domba_presence where firebase_uid = ${ALICE}`;
    assertEquals(Date.parse(started.expiresAt), stored.discoverable_until.getTime(), "start");
    saveLocation(ALICE);
    const extended = await call(ALICE, { action: "discovery_extend", sessionId: started.sessionId });
    const [after] = await sql!`select discoverable_until from public.lacak_domba_presence where firebase_uid = ${ALICE}`;
    assertEquals(Date.parse(extended.data.discovery.expiresAt), after.discoverable_until.getTime(), "extend");
    const sync = await call(ALICE, { action: "sync" });
    assertEquals(sync.data.discovery.expiresAt, extended.data.discovery.expiresAt, "sync reports the same end");
    const stop = await call(ALICE, { action: "clear", mode: "stop" });
    assertEquals(stop.data.discovery.expiresAt, null, "no end without a session");
});

// Contract: every reply that reports a session carries exactly these four
// fields. Active: expiresAt is discoverable_until in PostgreSQL and
// expiresInMs is in (0, 15 min]. Inactive: zeros and nulls.
async function checkDiscoveryContract(label: string, discovery: Record<string, unknown>, uid = ALICE) {
    assertEquals(Object.keys(discovery).sort(), ["active", "expiresAt", "expiresInMs", "sessionId"], label);
    const [row] = await sql!`
        select discovery_session_id::text as session_id, discoverable_until
        from public.lacak_domba_presence where firebase_uid = ${uid} and discoverable_until > now()`;
    if (discovery.active) {
        assert(row, `${label}: active reply without a running session in PostgreSQL`);
        assertEquals(discovery.sessionId, row.session_id, label);
        assertEquals(Date.parse(discovery.expiresAt as string), row.discoverable_until.getTime(), `${label}: expiresAt`);
        const ms = discovery.expiresInMs as number;
        assert(Number.isInteger(ms) && ms > 0 && ms <= 15 * MINUTE, `${label}: expiresInMs ${ms}`);
    } else {
        assertEquals(discovery, { active: false, expiresInMs: 0, sessionId: null, expiresAt: null }, label);
    }
}

test("contract: start, sync, scan, extend, both 409s and every clear mode reply with the same four fields", async () => {
    heartbeat(ALICE);
    saveLocation(ALICE);
    const started = await call(ALICE, { action: "discovery_start" });
    assertEquals(started.status, 200);
    await checkDiscoveryContract("start", started.data.discovery);
    await checkDiscoveryContract("sync", (await call(ALICE, { action: "sync" })).data.discovery);
    saveLocation(ALICE);
    await checkDiscoveryContract("scan", (await call(ALICE, { action: "scan", radiusKm: 5 })).data.discovery);
    saveLocation(ALICE);
    const extended = await call(ALICE, { action: "discovery_extend", sessionId: started.data.discovery.sessionId });
    await checkDiscoveryContract("extend", extended.data.discovery);
    const changed = await call(ALICE, { action: "discovery_extend", sessionId: "00000000-0000-4000-8000-000000000000" });
    assertEquals([changed.status, changed.data.error], [409, "discovery_session_changed"]);
    await checkDiscoveryContract("409 session_changed", changed.data.discovery);
    await checkDiscoveryContract("clear expired (running)", (await call(ALICE, { action: "clear", mode: "expired" })).data.discovery);
    await checkDiscoveryContract("clear stop", (await call(ALICE, { action: "clear", mode: "stop" })).data.discovery);
    saveLocation(ALICE);
    const expired = await call(ALICE, { action: "discovery_extend", sessionId: started.data.discovery.sessionId });
    assertEquals([expired.status, expired.data.error], [409, "discovery_expired"]);
    await checkDiscoveryContract("409 expired", expired.data.discovery);
    await checkDiscoveryContract("sync without session", (await call(ALICE, { action: "sync" })).data.discovery);
    for (const mode of ["leave", "stop_retry"]) {
        const r = await call(ALICE, { action: "clear", mode, sessionId: started.data.discovery.sessionId });
        await checkDiscoveryContract(`clear ${mode}`, r.data.discovery);
    }
});

const mirroredBlocks = async (blocker: string) =>
    (await sql!`select blocked_uid from public.lacak_domba_blocks where blocker_uid = ${blocker} order by 1`)
        .map((row) => row.blocked_uid);

test("a block made elsewhere applies at the blocker's next sync, even one sent with syncBlocks:false", async () => {
    await startAlice();
    assert(listed((await bobScan()).data, ALICE), "visible before the block");
    // Written by another page (kontak.html); Lacak Domba is not involved.
    firestore.set(`user_blocks/${ALICE}/blocked/${BOB}`, { blockedUid: BOB });
    // BEFORE Alice syncs: the server cannot know (only Alice's token can
    // read her list), and Bob's own scan must not be what applies it.
    assertEquals(await mirroredBlocks(ALICE), [], "nothing mirrored before Alice's sync");
    assert(listed((await bobScan()).data, ALICE), "before Alice's sync Bob still finds her (the window)");
    assertEquals(await mirroredBlocks(ALICE), [], "Bob's scan did not touch Alice's mirror");
    // AFTER: a sync like visibilitychange sends (syncBlocks:false).
    assertEquals((await call(ALICE, { action: "sync", syncBlocks: false })).status, 200);
    assertEquals(await mirroredBlocks(ALICE), [BOB], "mirrored by Alice's sync");
    assert(!listed((await bobScan()).data, ALICE), "hidden after Alice's sync");
    // Unblock applies the same way.
    firestore.delete(`user_blocks/${ALICE}/blocked/${BOB}`);
    assert(!listed((await bobScan()).data, ALICE), "still hidden until Alice syncs");
    await call(ALICE, { action: "sync", syncBlocks: false });
    assertEquals(await mirroredBlocks(ALICE), []);
    assert(listed((await bobScan()).data, ALICE), "visible again after unblock + sync");
});

test("discovery_start and discovery_extend apply a block made elsewhere", async () => {
    const discovery = await startAlice();
    firestore.set(`user_blocks/${ALICE}/blocked/${BOB}`, { blockedUid: BOB });
    saveLocation(ALICE);
    assertEquals((await call(ALICE, { action: "discovery_extend", sessionId: discovery.sessionId })).status, 200);
    assertEquals(await mirroredBlocks(ALICE), [BOB], "extend synced the list");
    await call(ALICE, { action: "clear", mode: "stop" });
    await sql!`delete from public.lacak_domba_blocks where blocker_uid = ${ALICE}`;
    await startAlice();
    assertEquals(await mirroredBlocks(ALICE), [BOB], "start synced the list");
    assert(!listed((await bobScan()).data, ALICE));
});

test("block list unreadable: the sync fails and does NOT refresh the presence; 3 minutes later the user is hidden", async () => {
    await startAlice();
    const [before] = await sql!`select last_seen from public.lacak_domba_presence where firebase_uid = ${ALICE}`;
    firestore.set(`user_blocks/${ALICE}/blocked/${BOB}`, { blockedUid: BOB });
    failBlockLists = true;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    heartbeat(ALICE);
    const sync = await call(ALICE, { action: "sync" });
    assert(sync.status >= 400, `sync must fail, got ${sync.status}`);
    const [after] = await sql!`select last_seen from public.lacak_domba_presence where firebase_uid = ${ALICE}`;
    assertEquals(after.last_seen.getTime(), before.last_seen.getTime(), "presence refreshed without the block list");
    assertEquals(await mirroredBlocks(ALICE), [], "block not mirrored");
    failBlockLists = false; // Bob's own scan reads only his own list
    assert(listed((await bobScan()).data, ALICE), "inside the bound she is still listed (the window is real)");
    // With no successful sync the presence ages out (bound: 180 s after the last one).
    await advance(3 * MINUTE + 1000);
    assertEquals(await mirroredBlocks(ALICE), [], "still not mirrored: hidden by presence age alone");
    assert(!listed((await bobScan()).data, ALICE), "listed more than 3 minutes after the last successful sync");
});

test("scans are rate limited (429) and a non-discoverable user is never listed", async () => {
    saveLocation(BOB, 0.001);
    saveLocation(ALICE); // a location but no session: not listed
    const first = await call(BOB, { action: "scan", radiusKm: 5 });
    assertEquals(first.status, 200);
    assert(!listed(first.data, ALICE));
    const second = await call(BOB, { action: "scan", radiusKm: 5 });
    assertEquals(second.status, 429);
    assertEquals(second.data.error, "scan_too_soon");
});

test("a presence older than 3 minutes is not listed", async () => {
    await startAlice();
    await advance(3 * MINUTE + 1000);
    saveLocation(ALICE); // fresh location, stale presence (no heartbeat)
    const firestorePresence = firestore.get(`presence/${ALICE}`)!;
    firestorePresence.lastSeen = new Date(Date.now() - 3 * MINUTE - 1000);
    await call(ALICE, { action: "sync", syncBlocks: false });
    assert(!listed((await bobScan()).data, ALICE));
});

test("direct table and function access with the anon key is refused by PostgREST", async () => {
    if (!ANON_KEY) return;
    const headers = { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, "Content-Type": "application/json" };
    for (const table of ["lacak_domba_presence", "lacak_domba_blocks", "lacak_domba_scan_limits"]) {
        const response = await realFetch(`${SUPABASE_URL}/rest/v1/${table}?select=*`, { headers });
        await response.body?.cancel();
        assert([401, 403].includes(response.status), `${table}: ${response.status}`);
    }
    for (const [fn, body] of [
        ["lacak_domba_scan_candidates", { p_uid: BOB, p_min_lat: -90, p_max_lat: 90, p_presence_max_age_seconds: 180, p_location_max_age_seconds: 900, p_limit: 10 }],
        ["lacak_domba_discovery_end", { p_uid: ALICE, p_mode: "stop", p_session_id: null }],
        ["lacak_domba_take_scan_slot", { p_firebase_uid: BOB, p_min_interval_seconds: 15 }],
    ] as const) {
        const response = await realFetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers, body: JSON.stringify(body) });
        await response.body?.cancel();
        assert([401, 403, 404].includes(response.status), `${fn}: ${response.status}`);
    }
});

test("concurrent session calls of one user (tabs) never answer 500", async () => {
    heartbeat(ALICE);
    saveLocation(ALICE);
    const statuses: number[] = [];
    for (let round = 0; round < 8; round++) {
        await sql!`delete from public.lacak_domba_presence where firebase_uid = ${ALICE}`;
        // Several tabs press "Bisa Ditemukan" at the same moment.
        const starts = await Promise.all(Array.from({ length: 6 }, () => call(ALICE, { action: "discovery_start" })));
        statuses.push(...starts.map((r) => r.status));
        const ids = new Set(starts.filter((r) => r.status === 200).map((r) => r.data.discovery.sessionId));
        assertEquals(ids.size, 1);
        const sessionId = [...ids][0];
        // Start, extend, heartbeat and stop of the same user at once.
        const mixed = await Promise.all([
            call(ALICE, { action: "discovery_start" }),
            call(ALICE, { action: "discovery_extend", sessionId }),
            call(ALICE, { action: "sync" }),
            call(ALICE, { action: "discovery_extend", sessionId }),
            call(ALICE, { action: "clear", mode: "stop" }),
            call(ALICE, { action: "discovery_start" }),
        ]);
        statuses.push(...mixed.map((r) => r.status));
        const [bad] = await sql!`
            select count(*)::int as n from public.lacak_domba_presence
            where firebase_uid = ${ALICE}
                and (discoverable_until > updated_at + interval '15 minutes'
                     or discoverable_until > clock_timestamp() + interval '15 minutes'
                     or latitude is null or longitude is null or location_updated_at is null)`;
        assertEquals(bad.n, 0);
    }
    // 409 is the handled answer of an extend that lost to a stop or start.
    assertEquals(statuses.filter((s) => s !== 200 && s !== 409), []);
});

Deno.test({
    name: "nothing left the process except calls to the local PostgREST",
    ignore,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        assertEquals(unexpected, []);
        await sql!.end();
    },
});
