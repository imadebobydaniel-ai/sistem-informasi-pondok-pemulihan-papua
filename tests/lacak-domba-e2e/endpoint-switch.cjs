// Browser test for the DEV LOCAL / ONLINE backend switch of lacak-domba.html.
// Same local stack as e2e.cjs (fake-firebase.ts, serve-edge.ts, PostgREST +
// PostgreSQL), synthetic users only. Every request to *.supabase.co is
// answered here (503) and recorded, so nothing reaches the online backend.
//   LD_SWITCH_PHASE=up    (default) the local Edge Function runs on 54341
//   LD_SWITCH_PHASE=down  serve-edge.ts is stopped: DEV must say so and
//                         must not fall back to the online backend
// Needs: LD_PSQL, LD_TEST_DB_URL (local), playwright-core on NODE_PATH, and
// the page served from this repository on 127.0.0.1:5500.
// Run: node tests/lacak-domba-e2e/endpoint-switch.cjs
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright-core");

const ROOT = path.resolve(__dirname, "..", "..");
const SHIM = fs.readFileSync(path.join(__dirname, "firebase-shim.js"), "utf8");
const PAGE_FILE = path.join(ROOT, "lacak-domba.html");
const FIREBASE = "http://127.0.0.1:54340";
const DEV = "http://127.0.0.1:54341/";
const PROD_ENDPOINT = "https://cfnimvrxrnmefmxtzqks.supabase.co/functions/v1/lacak-domba-nearby";
const PAGE = "http://127.0.0.1:5500/lacak-domba.html";
const PHASE = process.env.LD_SWITCH_PHASE || "up";
const KEY = "lacak-domba-endpoint";

const DB_URL = process.env.LD_TEST_DB_URL || "";
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(DB_URL)) throw new Error("LD_TEST_DB_URL must be a LOCAL database");
const sql = (query) => execFileSync(process.env.LD_PSQL, [DB_URL, "-tA", "-v", "ON_ERROR_STOP=1", "-c", query], { encoding: "utf8" }).trim();

const A = "test-ld-sw-a", B = "test-ld-sw-b";
const POINT = { latitude: -1.0, longitude: 131.0 };
const NEAR = { latitude: -1.0009, longitude: 131.0 };

const results = [];
async function step(name, fn) {
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
async function admin(body) {
    const response = await fetch(FIREBASE + "/admin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return response.json();
}

// Every request a context makes, by target.
function recorder() {
    const log = [];
    return {
        log,
        dev: () => log.filter((url) => url.startsWith("http://127.0.0.1:54341")).length,
        online: () => log.filter((url) => url.includes(".supabase.co")).length,
        mark: () => log.length,
        devSince: (mark) => log.slice(mark).filter((url) => url.startsWith("http://127.0.0.1:54341")).length,
        onlineSince: (mark) => log.slice(mark).filter((url) => url.includes(".supabase.co")).length,
    };
}

// A browser context whose login is localStorage["ld-e2e-uid"], set once
// here (not on every load), so a sign-out stays signed out until login().
async function newContext(browser, uid, options = {}) {
    const context = await browser.newContext({
        geolocation: options.geo || POINT,
        permissions: ["geolocation"],
    });
    const rec = recorder();
    context.on("request", (request) => rec.log.push(request.url()));
    await context.route(/gstatic\.com\/firebasejs\/8\.10\.1\/firebase-(app|auth|firestore)\.js/, (route) =>
        route.fulfill({ contentType: "text/javascript", body: route.request().url().includes("firebase-app") ? SHIM : "" }));
    // The online backend is never contacted from this test.
    await context.route(/\.supabase\.co\//, (route) => route.fulfill({
        status: 503,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "online_blocked_by_test" }),
    }));
    if (options.serveAs) {
        // The repository page under another host name.
        await context.route((url) => url.href.split("?")[0] === options.serveAs.split("?")[0], (route) =>
            route.fulfill({ contentType: "text/html; charset=utf-8", body: fs.readFileSync(PAGE_FILE, "utf8") }));
    }
    if (options.initScript) await context.addInitScript(options.initScript);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => dialog.dismiss());
    await page.goto(options.serveAs || options.url || PAGE);
    await page.evaluate((id) => localStorage.setItem("ld-e2e-uid", id), uid);
    await page.reload();
    return { context, page, rec, errors };
}
const statusText = (page) => page.textContent("#statusScan");
async function waitFor(page, fn, arg, what, timeout = 45000) {
    try {
        await page.waitForFunction(fn, arg, { timeout });
    } catch (_) {
        throw new Error("timed out waiting for " + what + "; status: " + (await statusText(page).catch(() => "?")).trim());
    }
}
const loggedIn = (page) => waitFor(page, () => !document.getElementById("discoverableToggle").disabled, null, "login");
const loggedOut = (page) => waitFor(page, () => /Login Firebase diperlukan/.test(document.getElementById("statusScan").textContent), null, "signed-out state");
async function login(page, uid) {
    await page.evaluate((id) => localStorage.setItem("ld-e2e-uid", id), uid);
    await page.reload();
    await loggedIn(page);
    await page.waitForTimeout(1000);
}
async function choose(page, value, confirm) {
    await page.selectOption("#endpointSelect", value);
    await page.waitForSelector(".swal2-popup", { timeout: 15000 });
    if (confirm) {
        await Promise.all([page.waitForEvent("load", { timeout: 30000 }), page.click(".swal2-confirm")]);
    } else {
        await page.click(".swal2-cancel");
        await page.waitForTimeout(500);
    }
}
const mode = (page) => page.evaluate((key) => ({
    stored: sessionStorage.getItem(key),
    select: document.getElementById("endpointSelect")?.value || null,
    switchShown: !!document.getElementById("endpointSwitch") && !document.getElementById("endpointSwitch").hidden,
    status: document.getElementById("endpointStatus")?.textContent || "",
}), KEY);
function sessionRow(uid) {
    return sql(`select coalesce(discovery_session_id::text, '') from public.lacak_domba_presence where firebase_uid = '${uid}'`);
}
async function scanNames(page, uid) {
    sql(`delete from public.lacak_domba_scan_limits where firebase_uid = '${uid}'`);
    await page.click("#scanButton");
    await page.waitForFunction(() => !document.getElementById("scanButton").disabled, null, { timeout: 15000 });
    return page.$$eval("#nearbyResults .member-card strong", (items) => items.map((item) => item.textContent));
}

(async () => {
    const own = fs.readFileSync(PAGE_FILE);
    const served = Buffer.from(await (await fetch(PAGE, { cache: "no-store" })).arrayBuffer());
    if (!served.equals(own)) throw new Error("127.0.0.1:5500 does not serve this repository's lacak-domba.html");
    for (const uid of [A, B]) {
        sql(`delete from public.lacak_domba_presence where firebase_uid = '${uid}'`);
        sql(`delete from public.lacak_domba_scan_limits where firebase_uid = '${uid}'`);
    }
    await admin({ op: "reset" });
    for (const uid of [A, B]) await admin({ op: "set", path: `users/${uid}`, data: { status_akun: "Aktif", nama: "Sintetis " + uid.slice(8) } });

    const browser = await chromium.launch({ channel: "chrome", headless: true });
    // Pages under other host names are routed copies; Chrome's Local Network
    // Access would block their loopback requests on its own. It is off here
    // so that only the page code decides whether 127.0.0.1:54341 is used.
    const openBrowser = await chromium.launch({ channel: "chrome", headless: true, args: ["--disable-features=LocalNetworkAccessChecks"] });

    if (PHASE === "up") {
        let a, b;
        await step("S1. 127.0.0.1: switch shown, default ONLINE, requests go online only", async () => {
            a = await newContext(browser, A);
            await loggedIn(a.page);
            await a.page.waitForTimeout(1500);
            const m = await mode(a.page);
            check(m.switchShown && m.select === "online" && m.stored === null, "mode " + JSON.stringify(m));
            check(a.rec.online() > 0 && a.rec.dev() === 0, `online ${a.rec.online()} dev ${a.rec.dev()}`);
        });
        await step("S2. localhost: switch shown too, default ONLINE", async () => {
            const l = await newContext(browser, B, { url: "http://localhost:5500/lacak-domba.html" });
            await loggedIn(l.page);
            const m = await mode(l.page);
            check(m.switchShown && m.select === "online", "mode " + JSON.stringify(m));
            check(l.rec.dev() === 0, "dev requests " + l.rec.dev());
            await l.context.close();
        });
        await step("S3. cancel keeps ONLINE, no reload, nothing stored", async () => {
            await a.page.evaluate(() => { window.__marker = 1; });
            await choose(a.page, "dev", false);
            const m = await mode(a.page);
            check(m.select === "online" && m.stored === null, "mode " + JSON.stringify(m));
            check(await a.page.evaluate(() => window.__marker === 1), "page was reloaded");
        });
        await step("S4. switch to DEV: signed out, DEV stored in sessionStorage only, re-login uses 127.0.0.1:54341 only", async () => {
            await choose(a.page, "dev", true);
            await loggedOut(a.page);
            const m = await mode(a.page);
            check(m.stored === "dev" && m.select === "dev", "mode " + JSON.stringify(m));
            await waitFor(a.page, () => /DEV LOCAL aktif/.test(document.getElementById("endpointStatus").textContent), null, "DEV status");
            check(await a.page.evaluate((key) => localStorage.getItem(key) === null, KEY), "choice leaked to localStorage");
            const mark = a.rec.mark();
            await login(a.page, A);
            check(a.rec.devSince(mark) > 0 && a.rec.onlineSince(mark) === 0, `after switch: dev ${a.rec.devSince(mark)} online ${a.rec.onlineSince(mark)}`);
        });
        await step("S5. DEV: A turns on Bisa Ditemukan, session stored in the local database", async () => {
            await a.page.click("#discoverableToggle");
            await waitFor(a.page, () => /aktif paling lambat sampai pukul/.test(document.getElementById("discoveryNotice").textContent), null, "session notice");
            check(/^[0-9a-f-]{36}$/.test(sessionRow(A)), "no session row for A");
        });
        await step("S6. DEV: B (DEV tab) scans and finds A; no request goes online", async () => {
            b = await newContext(browser, B, { geo: NEAR, initScript: () => sessionStorage.setItem("lacak-domba-endpoint", "dev") });
            await loggedIn(b.page);
            const names = await scanNames(b.page, B);
            check(names.some((name) => /sw-a/i.test(name)), "B saw " + JSON.stringify(names));
            check(b.rec.online() === 0 && b.rec.dev() > 0, `B online ${b.rec.online()} dev ${b.rec.dev()}`);
        });
        await step("S7. switch back to ONLINE while active: DEV session ended first, results cleared, signed out, then online only", async () => {
            await choose(a.page, "online", true);
            check(sessionRow(A) === "", "A's DEV session still stored: " + sessionRow(A));
            const location = await admin({ op: "get", path: `presence_locations/${A}` });
            const presence = await admin({ op: "get", path: `presence/${A}` });
            check(!location.exists, "A's private location copy left behind");
            check(presence.data?.discoverable === false, "A still marked discoverable: " + JSON.stringify(presence.data?.discoverable));
            await loggedOut(a.page);
            const m = await mode(a.page);
            check(m.stored === null && m.select === "online", "mode " + JSON.stringify(m));
            check(!(await a.page.isChecked("#discoverableToggle")), "toggle still on");
            check((await a.page.$$("#nearbyResults .member-card")).length === 0, "old results shown");
            const mark = a.rec.mark();
            await login(a.page, A);
            await a.page.waitForTimeout(1000);
            check(a.rec.devSince(mark) === 0 && a.rec.onlineSince(mark) > 0, `after switch back: dev ${a.rec.devSince(mark)} online ${a.rec.onlineSince(mark)}`);
            const names = await scanNames(b.page, B);
            check(!names.some((name) => /sw-a/i.test(name)), "B still finds A: " + JSON.stringify(names));
        });
        await a?.context.close();
        await b?.context.close();

        const hostile = [
            "https://imadebobydaniel-ai.github.io/lacak-domba.html?endpoint=dev&direct=1",
            "http://127.0.0.1.nip.io:5500/lacak-domba.html?endpoint=dev",
            "http://localhost.example.test:5500/lacak-domba.html",
            "http://[::1]:5500/lacak-domba.html",
        ];
        for (const url of hostile) {
            await step(`S8. ${new URL(url).host}: no switch; DEV choice in sessionStorage/localStorage/URL ignored; never calls 127.0.0.1:54341`, async () => {
                const h = await newContext(openBrowser, A, {
                    serveAs: url,
                    initScript: () => {
                        sessionStorage.setItem("lacak-domba-endpoint", "dev");
                        localStorage.setItem("lacak-domba-endpoint", "dev");
                    },
                });
                await loggedIn(h.page);
                await h.page.waitForTimeout(1500);
                const m = await mode(h.page);
                check(!m.switchShown && m.select === null, "switch present: " + JSON.stringify(m));
                await h.page.click("#scanButton");
                await h.page.waitForFunction(() => !document.getElementById("scanButton").disabled, null, { timeout: 15000 });
                check(h.rec.dev() === 0, "requests to 127.0.0.1:54341: " + h.rec.dev());
                check(h.rec.log.some((u) => u === PROD_ENDPOINT), "the online endpoint was not used");
                await h.context.close();
            });
        }
    } else {
        await step("D1. DEV with the local backend stopped: 'Backend pengujian lokal tidak aktif', nothing goes online", async () => {
            const d = await newContext(browser, A, { initScript: () => sessionStorage.setItem("lacak-domba-endpoint", "dev") });
            await waitFor(d.page, () => /Backend pengujian lokal tidak aktif/.test(document.getElementById("endpointStatus").textContent), null, "offline status");
            await loggedIn(d.page);
            await d.page.click("#scanButton");
            await d.page.waitForFunction(() => !document.getElementById("scanButton").disabled, null, { timeout: 30000 });
            const status = await statusText(d.page);
            check(/Backend pengujian lokal tidak aktif/.test(status), "scan status: " + status.trim());
            await d.page.click("#discoverableToggle");
            await waitFor(d.page, () => /Backend pengujian lokal tidak aktif/.test(document.getElementById("discoveryNotice").textContent), null, "start refused");
            check(d.rec.online() === 0, "requests to the online backend: " + d.rec.online());
            check(d.rec.dev() > 0, "DEV was not even tried");
            await d.context.close();
        });
    }

    await browser.close();
    await openBrowser.close();
    for (const [status, name, ms] of results) console.log(`${status}  ${name}  (${ms} ms)`);
    const failed = results.filter(([status]) => status === "FAIL").length;
    console.log(failed ? `${failed} FAILED of ${results.length}` : `ALL ${results.length} PASSED`);
    process.exit(failed ? 1 : 0);
})().catch((error) => {
    console.error(error);
    process.exit(2);
});
