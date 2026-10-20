// Browser E2E test for lacak-domba.html with synthetic users only.
//   real Chrome (playwright-core, channel "chrome")
//   -> real lacak-domba.html served from this repository on 127.0.0.1:5500
//   -> real Edge Function code over HTTP (serve-edge.ts, 127.0.0.1:54341)
//   -> real PostgREST + PostgreSQL 17 (local, migrations applied)
// Firebase is replaced by fake-firebase.ts + firebase-shim.js (synthetic,
// local): no Firebase project, no production data, no real location.
// Needs: LD_PSQL (psql.exe), LD_TEST_DB_URL (local), playwright-core on
// NODE_PATH, and fake-firebase.ts / serve-edge.ts already running.
// Run: node tests/lacak-domba-e2e/e2e.cjs
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright-core");

const ROOT = path.resolve(__dirname, "..", "..");
const SHIM = fs.readFileSync(path.join(__dirname, "firebase-shim.js"), "utf8");
const FIREBASE = "http://127.0.0.1:54340";
const EDGE = "http://127.0.0.1:54341/";
const PROD_ENDPOINT = "https://cfnimvrxrnmefmxtzqks.supabase.co/functions/v1/lacak-domba-nearby";
const PAGE = "http://127.0.0.1:5500/lacak-domba.html";
const OUT = process.env.LD_E2E_OUT || path.join(require("os").tmpdir(), "ld-e2e");
fs.mkdirSync(OUT, { recursive: true });

const DB_URL = process.env.LD_TEST_DB_URL || "";
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(DB_URL)) throw new Error("LD_TEST_DB_URL must be a LOCAL database");

// Synthetic users and made-up coordinates.
const ALICE = "test-ld-alice", BOB = "test-ld-bob", CAROL = "test-ld-carol", DAVE = "test-ld-dave", EVE = "test-ld-eve";
const POINT = { latitude: -1.0, longitude: 131.0 };
const NEAR = { latitude: -1.0009, longitude: 131.0 }; // ~0.1 km

function sql(query) {
    return execFileSync(process.env.LD_PSQL, [DB_URL, "-tA", "-v", "ON_ERROR_STOP=1", "-c", query], { encoding: "utf8" }).trim();
}

async function admin(body) {
    const response = await fetch(FIREBASE + "/admin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return response.json();
}

// Test-only copy of a page whose requests go straight to the local Edge
// Function, without Playwright routing (which drops requests sent while a
// page unloads). "gate" goes through gateProxy.
const ENDPOINT_LINE = 'const LACAK_DOMBA_ENDPOINT = SUPABASE_URL + "/functions/v1/lacak-domba-nearby";';
function directHtml(file, direct) {
    const html = fs.readFileSync(file, "utf8");
    if (!html.includes(ENDPOINT_LINE)) throw new Error("endpoint line not found in " + file);
    return html.replace(ENDPOINT_LINE, `const LACAK_DOMBA_ENDPOINT = "${direct === "gate" ? GATE : EDGE}";`);
}
const isDirect = (direct) => direct === "1" || direct === "gate";

// The developer's own server on 127.0.0.1:5500 is used when one is running,
// provided it serves this repository's lacak-domba.html byte for byte; the
// ?direct= copies are then made by routing (see newUser). Otherwise this
// script serves the repository itself.
let externalServer = false;
async function staticServer() {
    let served = null;
    try {
        served = Buffer.from(await (await fetch(PAGE, { cache: "no-store" })).arrayBuffer());
    } catch (_) {
        // Nothing listens on 5500: serve the repository below.
    }
    if (served) {
        if (!served.equals(fs.readFileSync(path.join(ROOT, "lacak-domba.html")))) {
            throw new Error("the server on 127.0.0.1:5500 does not serve this repository's lacak-domba.html");
        }
        externalServer = true;
        console.log("page served by the existing server on 127.0.0.1:5500");
        return { close() {} };
    }
    const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" };
    const server = http.createServer((request, response) => {
        const url = new URL(request.url, "http://127.0.0.1:5500");
        const file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
        if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            response.writeHead(404);
            response.end("not found");
            return;
        }
        response.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
        const direct = url.searchParams.get("direct");
        if (isDirect(direct) && file.endsWith(".html")) {
            response.end(directHtml(file, direct));
            return;
        }
        fs.createReadStream(file).pipe(response);
    });
    return new Promise((resolve) => server.listen(5500, "127.0.0.1", () => resolve(server)));
}

// A switchable network path to the Edge Function. Chrome sends a keepalive
// request from the browser process, past setOffline() and page routing, so
// a network failure at page close is made here: while the gate is closed
// every connection is dropped.
const GATE = "http://127.0.0.1:54342/";
const gate = { closed: false, dropped: 0 };
function gateProxy() {
    const server = http.createServer((request, response) => {
        if (gate.closed) {
            gate.dropped++;
            request.socket.destroy();
            return;
        }
        const upstream = http.request(EDGE, { method: request.method, headers: { ...request.headers, host: "127.0.0.1:54341" } }, (reply) => {
            response.writeHead(reply.statusCode, reply.headers);
            reply.pipe(response);
        });
        upstream.on("error", () => request.socket.destroy());
        request.pipe(upstream);
    });
    return new Promise((resolve) => server.listen(54342, "127.0.0.1", () => resolve(server)));
}

const results = [];
const traffic = [];
const offline = new Set();
// LD_E2E_ONLY=22,23 runs only those steps (each later step prepares what it
// needs); unset runs all of them.
const ONLY = (process.env.LD_E2E_ONLY || "").split(",").filter(Boolean).map(Number);
async function step(name, fn) {
    if (ONLY.length && !ONLY.includes(parseInt(name, 10))) return;
    const started = Date.now();
    try {
        await fn();
        results.push(["PASS", name, Date.now() - started]);
    } catch (error) {
        results.push(["FAIL", name + " -> " + (error && error.message ? error.message.split("\n")[0] : error), Date.now() - started]);
    }
}
function check(condition, message) {
    if (!condition) throw new Error(message);
}

async function newUser(browser, uid, options = {}) {
    const context = await browser.newContext({
        geolocation: options.geo || POINT,
        permissions: options.denyGeo ? [] : ["geolocation"],
        viewport: options.viewport || { width: 1280, height: 900 },
        isMobile: !!options.mobile,
        hasTouch: !!options.mobile,
        deviceScaleFactor: options.mobile ? 2 : 1,
    });
    await context.addInitScript((id) => {
        localStorage.setItem("ld-e2e-uid", id);
    }, uid);
    if (externalServer) {
        await context.route((url) => url.origin === "http://127.0.0.1:5500" && url.pathname === "/lacak-domba.html"
            && isDirect(url.searchParams.get("direct")), (route) => route.fulfill({
            contentType: "text/html; charset=utf-8",
            body: directHtml(path.join(ROOT, "lacak-domba.html"), new URL(route.request().url()).searchParams.get("direct")),
        }));
    }
    await context.route(/gstatic\.com\/firebasejs\/8\.10\.1\/firebase-(app|auth|firestore)\.js/, (route) =>
        route.fulfill({ contentType: "text/javascript", body: route.request().url().includes("firebase-app") ? SHIM : "" }));
    await context.route(PROD_ENDPOINT, async (route) => {
        const request = route.request();
        // Routed requests bypass context.setOffline, so "offline" for the
        // backend is simulated here.
        if (offline.has(uid)) {
            traffic.push({ uid, method: request.method(), request: request.postData() || "", status: -1, body: "offline" });
            await route.abort("internetdisconnected");
            return;
        }
        // A page that is closing or reloading may drop the request mid-way
        // (e.g. the pagehide keepalive); that is recorded, not fatal.
        try {
            // An invalid token for the backend only (the Firestore stand-in
            // keeps working), like an ID token the server no longer accepts.
            const headers = { ...request.headers() };
            if (options.badToken) headers.authorization = "Bearer invalid.e2e.token";
            const response = await route.fetch({ url: EDGE, headers });
            const body = await response.text();
            traffic.push({ uid, method: request.method(), request: request.postData() || "", status: response.status(), body });
            await route.fulfill({ response, body });
        } catch (error) {
            traffic.push({ uid, method: request.method(), request: request.postData() || "", status: 0, body: "dropped: " + error.message });
        }
    });
    return context;
}

async function openPage(context, url = PAGE) {
    const page = await context.newPage();
    page.on("request", (request) => traffic.push({ url: request.url(), method: request.method(), kind: "request" }));
    page.on("console", (message) => {
        if (["error", "warning"].includes(message.type())) traffic.push({ kind: "console", text: message.text() });
    });
    page.on("pageerror", (error) => traffic.push({ kind: "pageerror", text: error.message }));
    await page.goto(url);
    // The page loads its libraries from public CDNs; a cold, slow network
    // (observed 3-7 s per file) needs more than 15 s before login is ready.
    await page.waitForFunction(() => !document.getElementById("discoverableToggle").disabled, null, { timeout: 45000 });
    // The first sync after login has returned.
    await page.waitForTimeout(800);
    return page;
}

const notice = (page) => page.textContent("#discoveryNotice");
const statusText = (page) => page.textContent("#statusScan");
async function waitText(page, selector, pattern, timeout) {
    try {
        await page.waitForFunction(([sel, source]) => new RegExp(source).test(document.querySelector(sel).textContent),
            [selector, pattern.source], { timeout });
    } catch (_) {
        throw new Error(`waited for ${pattern} in ${selector}, saw: "${(await page.textContent(selector)).trim()}"`);
    }
}
const waitNotice = (page, pattern, timeout = 15000) => waitText(page, "#discoveryNotice", pattern, timeout);
const waitStatus = (page, pattern, timeout = 15000) => waitText(page, "#statusScan", pattern, timeout);
function sessionRow(uid) {
    const row = sql(`select coalesce(discovery_session_id::text,'') || '|' || coalesce(extract(epoch from discoverable_until)::text,'') from public.lacak_domba_presence where firebase_uid = '${uid}'`);
    if (!row) return null;
    const [id, until] = row.split("|");
    return { id, until: Number(until) };
}
async function scan(page, uid) {
    sql(`delete from public.lacak_domba_scan_limits where firebase_uid = '${uid}'`);
    await page.click("#scanButton");
    await page.waitForFunction(() => !document.getElementById("scanButton").disabled, null, { timeout: 15000 });
    return page.$$eval("#nearbyResults .member-card strong", (items) => items.map((item) => item.textContent));
}
async function turnOn(page) {
    await page.click("#discoverableToggle");
    await waitNotice(page, /aktif paling lambat sampai pukul/);
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lists = (names, who) => names.some((name) => new RegExp(who, "i").test(name));
function lastSeenEpoch(uid) {
    return Number(sql(`select extract(epoch from last_seen) from public.lacak_domba_presence where firebase_uid = '${uid}'`));
}
// True when the "paling lambat ... pukul HH.MM" clock in `text` is not
// earlier than `epochSeconds` (the real server end).
function latestClockCovers(text, epochSeconds) {
    return latestClockLateBy(text, epochSeconds) >= 0;
}
// Seconds by which the shown "paling lambat ... pukul HH.MM" lies after
// `epochSeconds` (negative: the shown clock is too early).
function latestClockLateBy(text, epochSeconds) {
    const match = text.match(/paling lambat (?:sampai )?pukul (\d{1,2})[.:](\d{2})/);
    if (!match) throw new Error("no 'paling lambat' clock in: " + text);
    const end = new Date(epochSeconds * 1000);
    const shown = new Date(end);
    shown.setHours(Number(match[1]), Number(match[2]), 0, 0);
    if (shown.getTime() < end.getTime() - 12 * 3600e3) shown.setDate(shown.getDate() + 1);
    if (shown.getTime() > end.getTime() + 12 * 3600e3) shown.setDate(shown.getDate() - 1);
    return Math.round((shown.getTime() - end.getTime()) / 1000);
}

(async () => {
    for (const command of [
        "delete from public.lacak_domba_presence where firebase_uid like 'test-ld-%'",
        "delete from public.lacak_domba_blocks where blocker_uid like 'test-ld-%'",
        "delete from public.lacak_domba_scan_limits where firebase_uid like 'test-ld-%'",
    ]) sql(command);
    await admin({ op: "reset" });
    for (const uid of [ALICE, BOB, DAVE, EVE]) {
        await admin({ op: "set", path: `users/${uid}`, data: { status_akun: "Aktif", nama: "Sintetis " + uid.slice(8) } });
    }
    await admin({ op: "set", path: `users/${CAROL}`, data: { status_akun: "Nonaktif", nama: "Sintetis carol" } });

    const server = await staticServer();
    const gateServer = await gateProxy();
    // A routed (fulfilled) document has no remote address, so Chrome's Local
    // Network Access treats the ?direct= copies as public pages and blocks
    // their requests to 127.0.0.1. Only this test browser, and only when the
    // copies are routed, has that check off; served pages are loopback anyway.
    const browser = await chromium.launch({
        channel: "chrome",
        headless: true,
        args: externalServer ? ["--disable-features=LocalNetworkAccessChecks"] : [],
    });
    const alice = await newUser(browser, ALICE);
    const bob = await newUser(browser, BOB, { geo: NEAR });
    let aliceTab1, aliceTab2, bobPage;

    await step("1. login: page talks to lacak-domba-nearby; toggle off, no session", async () => {
        aliceTab1 = await openPage(alice);
        check(!(await aliceTab1.isChecked("#discoverableToggle")), "toggle must start off");
        check(sessionRow(ALICE) === null, "no session before an explicit start");
    });

    await step("2. Bisa Ditemukan: explicit start opens a 15:00 session in PostgreSQL", async () => {
        await turnOn(aliceTab1);
        check(await aliceTab1.isChecked("#discoverableToggle"), "toggle on");
        const remaining = await aliceTab1.textContent("#discoveryRemaining");
        check(/^1[45]:\d\d$/.test(remaining), "countdown shows ~15:00, got " + remaining);
        const row = sessionRow(ALICE);
        check(row && /^[0-9a-f-]{36}$/.test(row.id), "session row with id");
        const left = row.until - Date.now() / 1000;
        check(left > 14 * 60 && left <= 15 * 60 + 2, "server end 15 minutes ahead, got " + left);
    });

    await step("3. second account (Bob, ~0.1 km) finds Alice with a range, no coordinates", async () => {
        bobPage = await openPage(bob);
        const names = await scan(bobPage, BOB);
        check(names.some((name) => /alice/i.test(name)), "Alice listed, got " + JSON.stringify(names));
        const meta = await bobPage.textContent("#nearbyResults .member-meta");
        check(meta.includes("< 1 KM"), "range shown: " + meta);
        const scans = traffic.filter((t) => t.uid === BOB && t.request.includes('"scan"'));
        check(scans.length && scans.every((t) => !/latitude|longitude|-1\.000|131\.0/.test(t.body)), "no coordinates in scan responses");
    });

    await step("4. heartbeat syncs do not extend the session", async () => {
        const before = sessionRow(ALICE);
        for (let i = 0; i < 3; i++) await aliceTab1.evaluate(() => syncBackend());
        const after = sessionRow(ALICE);
        check(after.id === before.id && Math.abs(after.until - before.until) < 0.001, "end unchanged");
    });

    await step("5. second tab adopts the running session from the backend", async () => {
        aliceTab2 = await openPage(alice);
        await aliceTab2.waitForFunction(() => document.getElementById("discoverableToggle").checked, null, { timeout: 10000 });
        const ids = await Promise.all([aliceTab1, aliceTab2].map((p) => p.evaluate(() => discoverySessionId)));
        check(ids[0] && ids[0] === ids[1] && ids[0] === sessionRow(ALICE).id, "both tabs show the server session");
    });

    await step("6. LD16-01: extend in tab 2, then tab 1's stale countdown ends -> session survives, tab 1 adopts", async () => {
        sql(`update public.lacak_domba_presence set discoverable_until = discoverable_until - interval '5 minutes', session_started_at = session_started_at - interval '5 minutes', updated_at = updated_at - interval '5 minutes' where firebase_uid = '${ALICE}'`);
        const before = sessionRow(ALICE);
        await aliceTab2.click("#extendDiscoveryButton");
        await waitNotice(aliceTab2, /diperpanjang paling lambat sampai pukul/);
        const extended = sessionRow(ALICE);
        check(extended.id === before.id && extended.until > before.until + 250, "server end moved forward");
        // Tab 1 heard the broadcast; make it stale on purpose (as if it had
        // missed it) and let its countdown reach zero.
        await aliceTab1.evaluate(() => { discoveryExpiresAt = monoNow() - 1000; tickDiscoverySession(); });
        await waitNotice(aliceTab1, /masih aktif dari tab atau perangkat lain/);
        const after = sessionRow(ALICE);
        check(after && after.id === before.id && Math.abs(after.until - extended.until) < 0.001, "stale tab did not end or change the session");
        check(await aliceTab1.isChecked("#discoverableToggle"), "tab 1 shows the session again");
        const presence = await admin({ op: "get", path: `presence/${ALICE}` });
        const location = await admin({ op: "get", path: `presence_locations/${ALICE}` });
        check(presence.data.discoverable === true && location.exists, "stale tab kept Firestore discoverable and the location");
        check((await scan(bobPage, BOB)).some((name) => /alice/i.test(name)), "Bob still finds Alice");
    });

    await step("7. closing one of two tabs does not end the session", async () => {
        await aliceTab2.close({ runBeforeUnload: true });
        await aliceTab1.waitForTimeout(1500);
        check(sessionRow(ALICE) !== null, "session still stored after closing tab 2");
    });

    await step("8. reload of the last tab: leaving ends discovery (current semantics), page and server agree, nothing restarts", async () => {
        const before = sessionRow(ALICE);
        check(before, "session before reload");
        await aliceTab1.reload();
        await aliceTab1.waitForFunction(() => !document.getElementById("discoverableToggle").disabled, null, { timeout: 15000 });
        await aliceTab1.waitForTimeout(2500);
        const after = sessionRow(ALICE);
        const shown = await aliceTab1.isChecked("#discoverableToggle");
        // Either the "leave" request got out (session ended, page off) or
        // it did not (session kept, page adopts it). Both are consistent;
        // a NEW or LONGER session would be a failure.
        if (after) {
            check(after.id === before.id && Math.abs(after.until - before.until) < 0.001, "no new or longer session");
            check(shown, "page adopts the kept session");
        } else {
            check(!shown, "page shows off when the session ended");
        }
        console.log("   reload outcome: " + (after ? "session kept and adopted" : "session ended by pagehide (leave)"));
        if (!after) await turnOn(aliceTab1);
    });

    await step("9. server-side expiry: countdown ends, Firestore copies removed, not listed", async () => {
        sql(`update public.lacak_domba_presence set discoverable_until = now() + interval '4 seconds' where firebase_uid = '${ALICE}'`);
        await aliceTab1.evaluate(() => syncBackend());
        await waitNotice(aliceTab1, /telah berakhir/, 20000);
        await aliceTab1.waitForTimeout(1500);
        check(!(await aliceTab1.isChecked("#discoverableToggle")), "toggle off");
        check(sessionRow(ALICE) === null, "row removed");
        const presence = await admin({ op: "get", path: `presence/${ALICE}` });
        const location = await admin({ op: "get", path: `presence_locations/${ALICE}` });
        check(presence.data.discoverable === false, "Firestore discoverable false");
        check(!location.exists, "Firestore location removed");
        check(!(await scan(bobPage, BOB)).some((name) => /alice/i.test(name)), "Bob no longer finds Alice");
    });

    await step("10. Matikan ends the session before 15 minutes in every tab", async () => {
        await turnOn(aliceTab1);
        aliceTab2 = await openPage(alice);
        await aliceTab2.waitForFunction(() => document.getElementById("discoverableToggle").checked, null, { timeout: 10000 });
        await aliceTab1.click("#stopDiscoveryButton");
        await waitNotice(aliceTab1, /dimatikan/);
        check(sessionRow(ALICE) === null, "row removed at once");
        await aliceTab2.waitForFunction(() => !document.getElementById("discoverableToggle").checked, null, { timeout: 5000 });
        await aliceTab2.close();
    });

    await step("11. Matikan while offline: honest message, retried for that session once online", async () => {
        await turnOn(aliceTab1);
        await alice.setOffline(true);
        offline.add(ALICE);
        try {
            await aliceTab1.click("#stopDiscoveryButton");
            await waitNotice(aliceTab1, /server belum dapat dihubungi/);
            check(!(await aliceTab1.isChecked("#discoverableToggle")), "off in the UI at once");
            check(sessionRow(ALICE) !== null, "server not reached while offline");
            check(await aliceTab1.evaluate(() => pendingStopSessionId) === sessionRow(ALICE).id, "retry pending for that session");
        } finally {
            offline.delete(ALICE);
            await alice.setOffline(false);
        }
        await aliceTab1.evaluate(() => syncBackend());
        await aliceTab1.waitForTimeout(1500);
        check(sessionRow(ALICE) === null, "retry removed the session");
        check(traffic.some((t) => t.uid === ALICE && t.request.includes('"stop_retry"') && t.status === 200), "stop_retry sent");
    });

    await step("12. blocking hides both users from each other", async () => {
        await turnOn(aliceTab1);
        await turnOn(bobPage);
        check((await scan(bobPage, BOB)).some((name) => /alice/i.test(name)), "visible before blocking");
        await bobPage.click('#nearbyResults button[data-action="block"]');
        await bobPage.click(".swal2-confirm");
        await bobPage.waitForFunction(() => /Sintetis/.test(document.getElementById("blockedResults").textContent), null, { timeout: 10000 });
        await bobPage.waitForTimeout(1500);
        check(!(await scan(bobPage, BOB)).some((name) => /alice/i.test(name)), "Bob does not see Alice");
        check(!(await scan(aliceTab1, ALICE)).some((name) => /bob/i.test(name)), "Alice does not see Bob");
    });

    await step("13. radius select is enforced (1/5/10 km only) and scans are rate limited (429)", async () => {
        await bobPage.selectOption("#radiusSelect", "1");
        await scan(bobPage, BOB);
        await bobPage.click("#scanButton");
        await waitStatus(bobPage, /Tunggu 15 detik/);
        const radii = traffic.filter((t) => t.uid === BOB && t.request.includes('"scan"')).map((t) => JSON.parse(t.request).radiusKm);
        check(radii.every((r) => [1, 5, 10].includes(r)), "radii sent: " + radii);
        check(traffic.some((t) => t.uid === BOB && t.status === 429), "a 429 was answered");
    });

    await step("14. GPS denied: no session, clear message", async () => {
        const dave = await newUser(browser, DAVE, { denyGeo: true });
        const page = await openPage(dave);
        await page.click("#discoverableToggle");
        await waitNotice(page, /Izin lokasi ditolak/);
        check(!(await page.isChecked("#discoverableToggle")), "toggle back off");
        check(sessionRow(DAVE) === null, "no session");
        await dave.close();
    });

    await step("15. deactivated account and invalid token are refused (403/401)", async () => {
        const carol = await newUser(browser, CAROL);
        const page = await openPage(carol);
        await page.click("#discoverableToggle");
        await waitNotice(page, /belum aktif/);
        check(sessionRow(CAROL) === null, "no session for a deactivated account");
        check(traffic.some((t) => t.uid === CAROL && t.status === 403), "403 answered");
        await carol.close();
        const eve = await newUser(browser, EVE, { badToken: true });
        const evePage = await openPage(eve);
        await evePage.click("#scanButton");
        await waitStatus(evePage, /Sesi login berakhir/);
        check(traffic.some((t) => t.uid === EVE && t.status === 401), "401 answered");
        await eve.close();
    });

    await step("16. phone layout (360 px): no horizontal scroll, controls visible", async () => {
        const phone = await newUser(browser, DAVE, { mobile: true, viewport: { width: 360, height: 740 } });
        const page = await openPage(phone);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        check(overflow <= 0, "horizontal overflow " + overflow + " px");
        for (const selector of ["#discoverableToggle", "#radiusSelect", "#scanButton"]) {
            check(await page.isVisible(selector), selector + " visible");
        }
        await page.screenshot({ path: path.join(OUT, "lacak-domba-360.png"), fullPage: true });
        await phone.close();
    });

    await step("17. no request goes to the old Firebase findNearbyMembers", async () => {
        const urls = traffic.filter((t) => t.kind === "request").map((t) => t.url);
        check(!urls.some((url) => /findNearbyMembers|cloudfunctions\.net/.test(url)), "old endpoint called");
        check(urls.some((url) => url === PROD_ENDPOINT), "the Supabase function endpoint is used");
    });

    await step("18. closing the last tab: leave request (best effort) or server expiry ends it", async () => {
        // Alice is on (step 12). Close her last tab.
        check(sessionRow(ALICE) !== null, "session before closing");
        await aliceTab1.close({ runBeforeUnload: true });
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const left = sessionRow(ALICE);
        console.log("   close outcome: " + (left ? "leave request did not get out; server expiry ends it at the stored end" : "session removed by leave"));
        if (left) check(left.until - Date.now() / 1000 <= 15 * 60, "server end still at most 15 minutes away");
    });

    await step("19. pagehide 'leave' over the real network: closing the only tab ends the session", async () => {
        const frank = await newUser(browser, EVE);
        const page = await openPage(frank, PAGE + "?direct=1");
        await turnOn(page);
        check(sessionRow(EVE) !== null, "session before closing");
        await page.close({ runBeforeUnload: true });
        await new Promise((resolve) => setTimeout(resolve, 3000));
        check(sessionRow(EVE) === null, "the keepalive leave request did not end the session");
        await frank.close();
    });

    await step("20. pagehide with a second tab open keeps the session (real network)", async () => {
        const context = await newUser(browser, EVE);
        const first = await openPage(context, PAGE + "?direct=1");
        await turnOn(first);
        const second = await openPage(context, PAGE + "?direct=1");
        await second.waitForFunction(() => document.getElementById("discoverableToggle").checked, null, { timeout: 10000 });
        await first.close({ runBeforeUnload: true });
        await new Promise((resolve) => setTimeout(resolve, 3000));
        check(sessionRow(EVE) !== null, "closing one of two tabs ended the session");
        await second.close({ runBeforeUnload: true });
        await new Promise((resolve) => setTimeout(resolve, 3000));
        check(sessionRow(EVE) === null, "closing the last tab did not end the session");
        await context.close();
    });

    // --- LD-16/R2 privacy: when "leave" never reaches the server -------------
    // Dave is a non-discoverable scanner next to Alice (Bob blocked her in
    // step 12). Alice's pages below use ?direct=1, i.e. the real network.
    let davePage;
    const daveScan = async () => {
        if (!davePage) davePage = await openPage(await newUser(browser, DAVE, { geo: NEAR }));
        return await scan(davePage, DAVE);
    };
    const resetAlice = () => sql(`delete from public.lacak_domba_presence where firebase_uid = '${ALICE}'`);

    await step("21. browser crash (no pagehide): listed at most 3 minutes after the last heartbeat, then hidden (real time)", async () => {
        resetAlice();
        const context = await newUser(browser, ALICE);
        const page = await openPage(context, PAGE + "?direct=1");
        await turnOn(page);
        await page.evaluate(() => updatePresence(auth.currentUser).then(syncBackend)); // one heartbeat
        await wait(800);
        const lastSync = lastSeenEpoch(ALICE);
        const cdp = await context.newCDPSession(page);
        cdp.send("Page.crash").catch(() => {});
        const crashedAt = Date.now() / 1000;
        await wait(2000);
        check(sessionRow(ALICE) !== null, "a crashed page sends no leave (reproduced)");
        let lastListed = 0;
        let firstHidden = 0;
        while (Date.now() / 1000 < lastSync + 180 + 45) {
            const now = Date.now() / 1000;
            if (lists(await daveScan(), "alice")) lastListed = now;
            else if (!firstHidden) firstHidden = now;
            if (firstHidden && now > lastSync + 185) break;
            await wait(10000);
        }
        console.log(`   crash window: listed until +${Math.round(lastListed - crashedAt)} s after the crash, `
            + `hidden from +${Math.round(firstHidden - crashedAt)} s; last heartbeat ${Math.round(crashedAt - lastSync)} s before the crash`);
        check(lastListed > 0, "listed right after the crash: the window exists and is measured");
        check(lastListed <= lastSync + 181, "listed more than 180 s after the last heartbeat");
        check(firstHidden && firstHidden <= lastSync + 180 + 15, "still listed well after the 3-minute presence limit");
        await context.close().catch(() => {});
    });

    await step("22. tab closed while offline: the keepalive leave fails, the 3-minute presence limit still hides the user", async () => {
        resetAlice();
        const context = await newUser(browser, ALICE);
        const page = await openPage(context, PAGE + "?direct=gate");
        await turnOn(page);
        check(lists(await daveScan(), "alice"), "Dave finds Alice");
        // context.setOffline() and page routing do not stop a keepalive
        // request sent while the page closes (observed: it still arrived),
        // so the network fails in gateProxy instead.
        gate.closed = true;
        const droppedBefore = gate.dropped;
        try {
            await page.close({ runBeforeUnload: true });
            await wait(3000);
        } finally {
            gate.closed = false;
        }
        check(gate.dropped > droppedBefore, "no leave request was attempted");
        check(sessionRow(ALICE) !== null, "the leave request could not get out (reproduced)");
        // As if 181 s had passed without a heartbeat (same rule as step 21).
        sql(`update public.lacak_domba_presence set last_seen = now() - interval '181 seconds' where firebase_uid = '${ALICE}'`);
        check(!lists(await daveScan(), "alice"), "listed although no heartbeat for over 3 minutes");
        await context.close();
    });

    await step("23. offline during a session: no false 'no longer listed' claim; 'paling lambat' clocks never before the real end", async () => {
        resetAlice();
        const context = await newUser(browser, ALICE);
        const page = await openPage(context, PAGE + "?direct=1");
        await turnOn(page);
        const serverEnd = sessionRow(ALICE).until;
        // Page times are monotonic; converted to wall time for the comparison.
        const [localEnd, bound] = await page.evaluate(() =>
            [discoveryExpiresAt, discoveryEndBound].map((t) => Date.now() + (t - monoNow())));
        check(localEnd / 1000 <= serverEnd + 0.001, "the countdown never runs past the server end");
        check(bound / 1000 >= serverEnd - 0.001, "the shown bound is before the server end");
        check(latestClockCovers(await notice(page), serverEnd), "start message clock before the server end: " + await notice(page));
        check(/\(waktu server\)\.$/.test(await notice(page)), "start message not labelled as server time: " + await notice(page));
        const late = latestClockLateBy(await notice(page), serverEnd);
        check(late <= 60, `start message clock more than a minute after the server end (${late} s)`);

        // The countdown ends while the server cannot be reached and the
        // server session is in fact still running.
        await context.setOffline(true);
        try {
            await page.evaluate(() => { discoveryExpiresAt = monoNow() - 1000; tickDiscoverySession(); });
            await waitNotice(page, /server belum dapat dihubungi.*paling lambat pukul/, 30000);
            const text = await notice(page);
            check(!/tidak lagi muncul/.test(text), "claimed 'no longer listed' while the server session runs: " + text);
            check(sessionRow(ALICE) !== null, "server session still running");
            check(latestClockCovers(text, serverEnd), "expiry message clock before the server end: " + text);
        } finally {
            await context.setOffline(false);
        }
        await page.evaluate(() => syncBackend());
        await page.waitForFunction(() => document.getElementById("discoverableToggle").checked, null, { timeout: 15000 });

        // "Matikan" while offline: the promise is about the real end.
        await context.setOffline(true);
        try {
            await page.click("#stopDiscoveryButton");
            await waitNotice(page, /server belum dapat dihubungi/, 40000);
            const text = await notice(page);
            check(sessionRow(ALICE) !== null, "server not reached");
            check(latestClockCovers(text, sessionRow(ALICE).until), "Matikan message clock before the server end: " + text);
        } finally {
            await context.setOffline(false);
        }
        await page.evaluate(() => syncBackend());
        await wait(2000);
        check(sessionRow(ALICE) === null, "stop_retry ended it once online");
        await context.close();
    });

    await step("24. two devices: closing on device A ends the session; device B follows and never revives it", async () => {
        resetAlice();
        const deviceA = await newUser(browser, ALICE);
        const deviceB = await newUser(browser, ALICE);
        const pageA = await openPage(deviceA, PAGE + "?direct=1");
        await turnOn(pageA);
        const pageB = await openPage(deviceB, PAGE + "?direct=1");
        await pageB.waitForFunction(() => document.getElementById("discoverableToggle").checked, null, { timeout: 10000 });
        const session = sessionRow(ALICE).id;
        check(await pageB.evaluate(() => discoverySessionId) === session, "device B adopted the session");
        // Separate devices share no BroadcastChannel: A sees no other tab.
        await pageA.close({ runBeforeUnload: true });
        await wait(3000);
        check(sessionRow(ALICE) === null, "device A's leave ended the session");
        await pageB.click("#extendDiscoveryButton");
        await waitNotice(pageB, /berakhir/, 20000);
        await wait(1500);
        check(!(await pageB.isChecked("#discoverableToggle")), "device B shows off");
        check(sessionRow(ALICE) === null, "device B's extend did not revive or restart the session");
        check(!lists(await daveScan(), "alice"), "Dave does not find Alice");
        await deviceA.close();
        await deviceB.close();
    });

    await step("25. reload over the real network: the leave ends the session, the reloaded page shows off and restarts nothing", async () => {
        resetAlice();
        const context = await newUser(browser, ALICE);
        const page = await openPage(context, PAGE + "?direct=1");
        await turnOn(page);
        await page.reload();
        await page.waitForFunction(() => !document.getElementById("discoverableToggle").disabled, null, { timeout: 15000 });
        await wait(2500);
        check(sessionRow(ALICE) === null, "session survived the reload");
        check(!(await page.isChecked("#discoverableToggle")), "reloaded page shows on");
        await context.close();
    });

    // The server copy of Alice's blocks, read straight from PostgreSQL.
    const mirroredBlock = () => sql(`select count(*) from public.lacak_domba_blocks where blocker_uid = '${ALICE}' and blocked_uid = '${DAVE}'`) === "1";
    const kontakBlock = () => admin({ op: "set", path: `user_blocks/${ALICE}/blocked/${DAVE}`, data: { blockedUid: DAVE, displayName: "", photoURL: "" } });
    const kontakUnblock = () => admin({ op: "delete", path: `user_blocks/${ALICE}/blocked/${DAVE}` });

    await step("26. block made on another page (kontak.html): BEFORE vs AFTER Alice's next sync; unblock likewise", async () => {
        resetAlice();
        sql(`delete from public.lacak_domba_blocks where blocker_uid = '${ALICE}'`);
        const context = await newUser(browser, ALICE);
        const page = await openPage(context, PAGE + "?direct=1");
        await turnOn(page);
        check(lists(await daveScan(), "alice"), "Dave finds Alice before the block");
        await kontakBlock(); // what kontak.html writes; this page is not involved
        check(!mirroredBlock(), "BEFORE: block already mirrored");
        check(lists(await daveScan(), "alice"), "BEFORE: Dave should still find Alice (the window)");
        check(!mirroredBlock(), "Dave's scan applied Alice's block (side effect)");
        // The sync visibilitychange sends (syncBlocks false from the page).
        check(await page.evaluate(() => blocksSyncPending) === false, "the page would ask for a block sync anyway");
        await page.evaluate(() => syncBackend());
        await wait(1000);
        check(mirroredBlock(), "AFTER: not mirrored by Alice's sync");
        check(!lists(await daveScan(), "alice"), "AFTER: Dave still finds Alice");
        // Unblock: still hidden until the next sync (safe side), visible after the heartbeat.
        await kontakUnblock();
        check(!lists(await daveScan(), "alice"), "unblock applied before Alice's sync");
        await page.evaluate(() => updatePresence(auth.currentUser).then(refreshBackendPresence));
        await wait(1000);
        check(!mirroredBlock() && lists(await daveScan(), "alice"), "unblock not applied by the heartbeat");
        await page.click("#stopDiscoveryButton");
        await waitNotice(page, /dimatikan/);
        await context.close();
    });

    await step("26b. block from kontak.html while Alice's heartbeats FAIL: listed only until 180 s after her last successful sync", async () => {
        resetAlice();
        sql(`delete from public.lacak_domba_blocks where blocker_uid = '${ALICE}'`);
        const context = await newUser(browser, ALICE);
        const page = await openPage(context, PAGE + "?direct=gate");
        await turnOn(page);
        await kontakBlock();
        gate.closed = true;
        try {
            await page.evaluate(() => updatePresence(auth.currentUser).then(refreshBackendPresence));
            await wait(1500);
            check(await page.evaluate(() => backendSyncPending) === true, "the heartbeat sync did not fail");
            check(!mirroredBlock(), "block mirrored without a sync");
            check(lists(await daveScan(), "alice"), "inside the bound Dave should still find Alice");
            // As if 181 s had passed since the last successful sync.
            sql(`update public.lacak_domba_presence set last_seen = last_seen - interval '181 seconds' where firebase_uid = '${ALICE}'`);
            check(!mirroredBlock(), "still not mirrored");
            check(!lists(await daveScan(), "alice"), "listed more than 180 s after the last successful sync");
        } finally {
            gate.closed = false;
        }
        await page.evaluate(() => updatePresence(auth.currentUser).then(refreshBackendPresence));
        await wait(1500);
        check(mirroredBlock(), "the first successful sync mirrored the block");
        check(!lists(await daveScan(), "alice"), "hidden after reconnecting");
        await kontakUnblock();
        await page.click("#stopDiscoveryButton");
        await waitNotice(page, /dimatikan/);
        await context.close();
    });

    await step("27. no Edge Function reply in the whole run carried coordinates", async () => {
        const replies = traffic.filter((t) => t.uid && typeof t.body === "string");
        check(replies.length > 20, "replies recorded: " + replies.length);
        const leaking = replies.filter((t) => /"(latitude|longitude|lat|lng|lon)"/.test(t.body));
        check(leaking.length === 0, "coordinates in " + leaking.length + " replies");
    });

    await step("28. device clock changed by one hour: countdown, shown clocks and a second tab stay consistent with the server", async () => {
        resetAlice();
        const context = await newUser(browser, ALICE);
        const tab1 = await openPage(context, PAGE + "?direct=1");
        await turnOn(tab1);
        // The device clock is set back one hour while the session runs.
        await tab1.evaluate(() => { const real = Date.now.bind(Date); Date.now = () => real() - 3600e3; });
        await wait(1500);
        const remaining = () => tab1.textContent("#discoveryRemaining").then((text) => {
            const [m, s] = text.split(":").map(Number);
            return m * 60 + s;
        });
        const realLeft = sessionRow(ALICE).until - Date.now() / 1000;
        check(Math.abs((await remaining()) - realLeft) <= 3, `countdown ${await remaining()} s, server ${Math.round(realLeft)} s`);
        await tab1.click("#extendDiscoveryButton");
        await waitNotice(tab1, /diperpanjang paling lambat sampai pukul/);
        const extendedEnd = sessionRow(ALICE).until;
        // The shown time is the SERVER-verified end (not the wrong device
        // clock), labelled as such, with a note on the device clock offset.
        const extendText = await notice(tab1);
        const late = latestClockLateBy(extendText, extendedEnd);
        check(late >= 0 && late <= 60, `shown clock is not the server end (off by ${late} s): ` + extendText);
        check(/\(waktu server; jam perangkat Anda lebih lambat sekitar 60 menit\)/.test(extendText), "no server label / clock note: " + extendText);
        // Without a server end time the page says it is a device estimate.
        const estimate = await tab1.evaluate(() => endText(monoNow() + 60000, 0));
        check(/\(perkiraan dari jam perangkat\)$/.test(estimate), "estimate not labelled: " + estimate);

        // A tab whose clock origin is one hour later (opened after a clock
        // change) receives tab 1's next extension over BroadcastChannel.
        const tab2 = await context.newPage();
        await tab2.addInitScript(() => { const n = performance.now.bind(performance); performance.now = () => n() + 3600e3; });
        await tab2.goto(PAGE + "?direct=1");
        await tab2.waitForFunction(() => document.getElementById("discoverableToggle").checked, null, { timeout: 15000 });
        await tab1.click("#extendDiscoveryButton");
        await waitNotice(tab2, /diperbarui dari tab lain/);
        const tab2Left = await tab2.textContent("#discoveryRemaining").then((t) => t.split(":").map(Number)).then(([m, s]) => m * 60 + s);
        const serverLeft = sessionRow(ALICE).until - Date.now() / 1000;
        check(await tab2.isChecked("#discoverableToggle"), "tab 2 treated the broadcast as ended");
        check(Math.abs(tab2Left - serverLeft) <= 3, `tab 2 countdown ${tab2Left} s, server ${Math.round(serverLeft)} s`);
        await tab1.click("#stopDiscoveryButton");
        await waitNotice(tab1, /dimatikan/);
        await context.close();
    });

    await step("29. BroadcastChannel is only a hint: crafted messages can neither fake nor hide a session; values sanitised; bursts coalesced", async () => {
        resetAlice();
        const context = await newUser(browser, ALICE);
        const tab1 = await openPage(context, PAGE + "?direct=1");
        const tab2 = await openPage(context, PAGE + "?direct=1");
        const craft = (values) => tab1.evaluate(([uid, v]) => {
            new BroadcastChannel("lacak-domba-discovery").postMessage({ type: "state", tabId: "crafted", uid, ...v });
        }, [ALICE, values]);
        const tab2State = () => tab2.evaluate(() => ({
            on: document.getElementById("discoverableToggle").checked,
            sessionId: discoverySessionId,
            left: discoveryExpiresAt ? discoveryExpiresAt - monoNow() : 0,
            serverEnd: discoveryServerEnd,
            text: document.getElementById("discoveryNotice").textContent + " " + document.getElementById("discoveryRemaining").textContent,
        }));
        const fake = "00000000-0000-4000-8000-000000000001";

        // (A) No session on the server: an "active" message shows nothing.
        await craft({ sessionId: fake, expiresInMs: 14 * 60e3, endBoundInMs: 14 * 60e3, serverEnd: Date.now() + 14 * 60e3 });
        await wait(1500);
        let state = await tab2State();
        check(!state.on && state.sessionId === null, "crafted message showed a session: " + JSON.stringify(state));
        check(sessionRow(ALICE) === null, "a session exists on the server");

        // (B) Running session: an "ended" message does not hide it.
        await turnOn(tab1);
        await tab2.waitForFunction(() => document.getElementById("discoverableToggle").checked, null, { timeout: 15000 });
        await craft({ sessionId: null, expiresInMs: 0 });
        await wait(1500);
        state = await tab2State();
        check(state.on && state.sessionId === sessionRow(ALICE).id, "crafted end message hid the running session: " + JSON.stringify(state));
        check(!/dimatikan/.test(state.text), "false 'turned off' claim: " + state.text);

        // (C) Garbage values never reach the screen; the state stays the server's.
        for (const values of [
            { sessionId: fake, expiresInMs: 99 * 3600e3, endBoundInMs: Infinity, serverEnd: Infinity, clockSkewMs: NaN },
            { sessionId: "x", expiresInMs: "soon", endBoundInMs: null, serverEnd: "x", clockSkewMs: "y" },
            { sessionId: fake, expiresInMs: -5, serverEnd: -1 },
        ]) {
            await craft(values);
            await wait(1200);
            state = await tab2State();
            const row = sessionRow(ALICE);
            const serverLeft = (row.until - Date.now() / 1000) * 1000;
            check(state.sessionId === row.id, "session id taken from a message: " + state.sessionId);
            check(Math.abs(state.left - serverLeft) <= 3000, `countdown not the server's: ${Math.round(state.left)} vs ${Math.round(serverLeft)}`);
            check(Number.isFinite(state.serverEnd) && Math.abs(state.serverEnd - row.until * 1000) <= 1, "server end is not the database value: " + state.serverEnd);
            check(!/NaN|Infinity|Invalid/.test(state.text), "invalid value shown: " + state.text);
        }

        // (D) A burst of 50 messages causes at most a few server checks.
        await tab2.evaluate(() => {
            window.__syncs = 0;
            const original = window.fetch;
            window.fetch = (input, init) => {
                if (String(input).includes("54341") && String(init?.body || "").includes('"sync"')) window.__syncs++;
                return original(input, init);
            };
        });
        await tab1.evaluate((uid) => {
            const channel = new BroadcastChannel("lacak-domba-discovery");
            for (let i = 0; i < 50; i++) channel.postMessage({ type: "state", tabId: "burst", uid });
        }, ALICE);
        await wait(3000);
        const syncs = await tab2.evaluate(() => window.__syncs);
        check(syncs >= 1 && syncs <= 3, "server checks for 50 messages: " + syncs);

        await tab1.click("#stopDiscoveryButton");
        await waitNotice(tab1, /dimatikan/);
        await tab2.waitForFunction(() => !document.getElementById("discoverableToggle").checked, null, { timeout: 10000 });
        await context.close();
    });

    await browser.close();
    server.close();
    gateServer.close();
    fs.writeFileSync(path.join(OUT, "traffic.json"), JSON.stringify(traffic, null, 1));
    for (const [status, name, ms] of results) console.log(`${status}  ${name}  (${ms} ms)`);
    const failed = results.filter(([status]) => status === "FAIL").length;
    console.log(failed ? `${failed} FAILED of ${results.length}` : `ALL ${results.length} PASSED`);
    process.exit(failed ? 1 : 0);
})().catch((error) => {
    console.error(error);
    process.exit(2);
});
