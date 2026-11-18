"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync, spawn } = require("node:child_process");

const pages = new Set(["index.html", "menu.html", "laporan-pelayanan.html", "baca-alkitab.html",
    "kehadiran.html", "rapor.html", "admin-bigdata.html"]);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(test, label) {
    for (let i = 0; i < 120; i++) {
        if (await test()) return;
        await wait(150);
    }
    throw Error("Timed out: " + label);
}

function connect(url) {
    const ws = new WebSocket(url);
    const pending = new Map();
    const events = new Map();
    let id = 0;
    ws.addEventListener("close", () => {
        for (const item of pending.values()) item.reject(Error("Chrome DevTools disconnected"));
        pending.clear();
    });
    ws.addEventListener("message", event => {
        const response = JSON.parse(event.data);
        if (response.method) {
            events.get(response.method)?.(response.params, response.sessionId);
            return;
        }
        const item = pending.get(response.id);
        if (!item) return;
        pending.delete(response.id);
        if (response.error) item.reject(Error(response.error.message));
        else item.resolve(response.result);
    });
    return new Promise((resolve, reject) => {
        ws.addEventListener("error", () => reject(Error("Chrome DevTools connection failed")), { once: true });
        ws.addEventListener("open", () => resolve({
            close: () => ws.close(),
            on: (name, handler) => events.set(name, handler),
            send: (method, params = {}, sessionId) => new Promise((resolve, reject) => {
                if (ws.readyState !== WebSocket.OPEN) { reject(Error("Chrome DevTools is closed")); return; }
                const request = ++id;
                const limit = setTimeout(() => {
                    pending.delete(request);
                    reject(Error("Chrome DevTools timed out: " + method));
                }, 12000);
                pending.set(request, {
                    resolve: value => { clearTimeout(limit); resolve(value); },
                    reject: error => { clearTimeout(limit); reject(error); }
                });
                ws.send(JSON.stringify({ id: request, method, params, sessionId }));
            })
        }), { once: true });
    });
}

module.exports = async ({ check, root, readStage, authHost, firestorePort, functionsPort, db, projectId, local }) => {
    const browser = process.env.SIPAPUA_PHASE5_BROWSER;
    if (!fs.existsSync(browser)) { console.log("NOT TESTED browser executable unavailable"); return; }
    const origin = "http://127.0.0.1:" + functionsPort;
    const config = JSON.stringify({ projectId, apiKey: "demo-key", authDomain: "127.0.0.1" });
    const source = new Set(execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0"));
    const sdkLibs = /^(app|auth|firestore|functions|app-check|storage|database)-compat\.js$/;
    const browserLibraries = process.env.SIPAPUA_PHASE5_BROWSER_LIBS;
    const libraries = new Map([
        ["https://cdn.jsdelivr.net/npm/chart.js", "chart.umd.js"],
        ["https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js", "jspdf.umd.min.js"],
        ["https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.23/jspdf.plugin.autotable.min.js", "jspdf.plugin.autotable.min.js"],
        ["https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js", "html2canvas.min.js"],
        ["https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js", "html2pdf.bundle.min.js"]
    ]);
    if (browserLibraries) {
        for (const filename of libraries.values()) assert.ok(fs.existsSync(path.join(browserLibraries, filename)), filename);
        local.get("/_phase5/lib/:file", (req, res) => {
            if (![...libraries.values()].includes(req.params.file)) { res.sendStatus(404); return; }
            res.sendFile(path.resolve(browserLibraries, req.params.file));
        });
    }
    local.get("/_phase5/sdk/:file", (req, res) => {
        if (!sdkLibs.test(req.params.file)) { res.sendStatus(404); return; }
        res.sendFile(path.join(root, "node_modules/firebase/firebase-" + req.params.file));
    });
    local.get("/_phase5/appcheck.js", (_req, res) =>
        res.type("js").send("window.SIPAPUA_APP_CHECK = { prepare: () => async () => {} };"));
    local.use((req, res) => {
        const name = req.path.slice(1);
        if (pages.has(name)) {
            let html = readStage(name);
            html = html.replace(/<meta[^>]+Content-Security-Policy[^>]*>/gi, "");
            html = html.replace(/https:\/\/www\.gstatic\.com\/firebasejs\/[^/]+\/firebase-([a-z-]+?)(?:-compat)?\.js/g,
                "/_phase5/sdk/$1-compat.js");
            html = html.replace(/<script\s+src=["']sipapua-app-check\.js["']\s*>\s*<\/script>/gi,
                '<script src="/_phase5/appcheck.js"></script>');
            if (browserLibraries) {
                for (const [remote, filename] of libraries) html = html.replaceAll(remote, "/_phase5/lib/" + filename);
            }
            const init = `(() => {
                const app = firebase.initializeApp(${config});
                firebase.auth().useEmulator("http://${authHost}", { disableWarnings: true });
                firebase.firestore().settings({ experimentalForceLongPolling: true });
                firebase.firestore().useEmulator("127.0.0.1", ${firestorePort});
                if (typeof app.functions === "function") app.functions("asia-southeast2").useEmulator("127.0.0.1", ${functionsPort});
                return app;
            })()`;
            html = html.replace(/firebase\.initializeApp\(firebaseConfig\)/g, init);
            res.set("Content-Security-Policy", `default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://${authHost} http://127.0.0.1:${firestorePort} ws://127.0.0.1:${firestorePort}; img-src 'self' data: blob:`);
            res.type("html").send(html);
            return;
        }
        if (source.has(name) && !name.startsWith("docs/") && !name.startsWith("candidates/") &&
            /\.(?:js|css|svg|png|woff2|jpe?g)$/i.test(name)) {
            let staged;
            if (name === "sipapua-member-session.js" || name === "sipapua-login.js") staged = readStage(name);
            if (staged) res.type("js").send(staged);
            else res.sendFile(path.join(root, name));
            return;
        }
        res.sendStatus(404);
    });
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "sipapua-phase5-browser-"));
    const child = spawn(browser, ["--headless=new", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
        "--user-data-dir=" + profile, "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
        "--disable-component-update", "--disable-sync", "--disable-gpu", "--no-proxy-server",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", "about:blank"],
    { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let spawnError, cdp, browserLog = "";
    child.stderr.on("data", data => { browserLog = (browserLog + data).slice(-8000); });
    child.on("exit", code => { if (code) console.log("Browser exited " + code + "\n" + browserLog); });
    child.on("error", error => { spawnError = error; });
    const devtools = path.join(profile, "DevToolsActivePort");
    try {
        await check("headless browser starts with loopback-only origin", async () => {
            await until(() => {
                if (spawnError) throw spawnError;
                if (child.exitCode !== null) throw Error("Browser exited " + child.exitCode);
                return fs.existsSync(devtools);
            }, "Chrome local debugging socket");
            const [port, url] = fs.readFileSync(devtools, "utf8").trim().split(/\r?\n/);
            assert.match(url, /^\/devtools\/browser\//);
            cdp = await connect("ws://127.0.0.1:" + Number(port) + url);
        });
        if (!cdp) return;
        const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
        const send = (method, params) => cdp.send(method, params, sessionId);
        cdp.on("Page.javascriptDialogOpening", ({ message }) => {
            console.log("Browser dialog: " + message);
            send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
        });
        await send("Page.enable");
        cdp.on("Runtime.consoleAPICalled", ({ type, args }) => {
            if (type === "error" && String(args[0]?.value).includes("Admin Big Data authorization failed")) {
                console.log("Browser dashboard diagnostic: " + (args[1]?.description || args[1]?.value));
            }
        });
        await send("Runtime.enable");
        const firewallRequests = new Set();
        cdp.on("Network.requestWillBeSent", ({ requestId, request }) => {
            if (request.url.startsWith("http://127.0.0.1:" + firestorePort + "/")) firewallRequests.add(requestId);
        });
        cdp.on("Network.loadingFailed", ({ requestId, errorText, blockedReason }) => {
            if (firewallRequests.delete(requestId) && errorText !== "net::ERR_ABORTED") {
                console.log("Browser Firestore connection: " + (blockedReason || errorText));
            }
        });
        cdp.on("Network.loadingFinished", ({ requestId }) => firewallRequests.delete(requestId));
        await send("Network.enable");
        async function evalJs(expression) {
            const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, returnByValue: true,
                awaitPromise: true, userGesture: true });
            if (exceptionDetails) throw Error(exceptionDetails.exception?.description || exceptionDetails.text);
            return result.value;
        }
        async function open(page, redirect = page) {
            await send("Page.navigate", { url: origin + "/" + page });
            await until(() => evalJs(`["/${page}", "/${redirect}"].includes(location.pathname) && document.readyState === "complete"`), page);
        }
        const field = (id, value) => `document.getElementById(${JSON.stringify(id)}).value = ${JSON.stringify(value)};`;
        const selectTab = name => evalJs(`Array.from(document.querySelectorAll(".tab-btn")).find(button =>
            button.getAttribute("onclick")?.startsWith(${JSON.stringify("switchTab('" + name + "'")})).click(); true`);
        async function login(email) {
            await open("index.html");
            await evalJs(field("user_email", email) + field("user_pass", "Synthetic-only-42!") +
                'document.getElementById("userLoginForm").requestSubmit(); true');
        }
        await cdp.send("Browser.grantPermissions", { origin, permissions: ["geolocation"] });
        await send("Emulation.setGeolocationOverride", { latitude: -2.5, longitude: 140.7, accuracy: 10 });
        const downloads = path.join(profile, "downloads");
        fs.mkdirSync(downloads);
        await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
        await check("browser restores synthetic member Auth and opens report menu", async () => {
            await login("browser-member@example.test");
            await until(() => evalJs('location.pathname === "/menu.html" && window.firebase?.apps?.length && firebase.auth().currentUser?.uid === "browser-member"'), "member menu");
            await evalJs('localStorage.removeItem("userUid"); localStorage.removeItem("userEmail"); true');
            await open("index.html", "menu.html");
            await until(() => evalJs('location.pathname === "/menu.html" && !!document.querySelector(\'a[href="laporan-pelayanan.html"]\')'), "restored report menu");
            await evalJs('document.querySelector(\'a[href="laporan-pelayanan.html"]\').click(); true');
            await until(() => evalJs('location.pathname === "/laporan-pelayanan.html" && !!document.getElementById("pelayananForm")'), "report opened");
        });
        await check("browser submits service form, persists own record and suppresses duplicate/failed success", async () => {
            await open("laporan-pelayanan.html");
            await until(() => evalJs('firebase.auth().currentUser?.uid === "browser-member"'), "service Auth");
            const fields = { kategori_kegiatan: "WL", nama_kegiatan: "Browser synthetic service", lokasi_kegiatan: "Browser synthetic place",
                tanggal_kegiatan: "2026-11-18" };
            const submit = "document.getElementById('pelayananForm').requestSubmit(); true";
            await evalJs(Object.entries(fields).map(([id, value]) => field(id, value)).join("") + submit);
            await until(() => evalJs('document.getElementById("status-msg").className === "success-box"'), "service success display");
            const records = () => db.collection("laporan_pelayanan").where("uid", "==", "browser-member").get();
            assert.equal((await records()).size, 1);
            await open("laporan-pelayanan.html");
            await until(() => evalJs('firebase.auth().currentUser?.uid === "browser-member"'), "service retry Auth");
            await evalJs(Object.entries(fields).map(([id, value]) => field(id, value)).join("") + submit);
            await until(() => evalJs('!document.getElementById("btnKirim").disabled'), "service duplicate completion");
            assert.equal((await records()).size, 1);
            assert.equal(await evalJs('document.getElementById("status-msg").className === "success-box"'), false);
            await db.doc("users/browser-member").update({ status_akun: "Pending" });
            try {
                await evalJs(field("nama_kegiatan", "Denied synthetic service") + submit);
                await until(() => evalJs('document.getElementById("status-msg").className === "error-box"'), "service denial display");
                assert.equal((await records()).size, 1);
            } finally {
                await db.doc("users/browser-member").update({ status_akun: "Aktif" });
            }
        });
        await check("browser Bible reading submission and own Rapor output", async () => {
            await open("baca-alkitab.html");
            await until(() => evalJs('document.getElementById("kitab-utama").options.length > 1'), "Bible form options");
            await evalJs('document.getElementById("check1").click(); document.getElementById("check2").click(); true');
            if (await evalJs('document.getElementById("btnKirim").disabled')) throw Error("Bible form disabled during current WIT time");
            await evalJs('document.getElementById("btnKirim").click(); true');
            await until(() => evalJs('document.getElementById("block-title").innerText === "BERHASIL"'), "Bible success display");
            assert.equal((await db.collection("laporan_bacaan").where("uid", "==", "browser-member").get()).size, 1);
            await open("rapor.html");
            await until(() => evalJs('document.getElementById("display-nama").innerText === "Browser Member"'), "own Rapor identity");
            assert.equal(await evalJs('document.getElementById("display-nij").innerText'), "SYN-BROWSER");
            await until(() => evalJs('state.records.some(record => record.collection === "laporan_bacaan" && record.data.uid === "browser-member")'), "own Reading in Rapor data");
            await until(() => evalJs('document.getElementById("excel-table-body-poin").children.length > 0'), "Rapor row output");
        });
        await check("browser Latihan PW persists and failed write shows error", async () => {
            async function submitTraining() {
                await open("kehadiran.html");
                await until(() => evalJs('firebase.auth().currentUser?.uid === "browser-member"'), "attendance Auth");
                await evalJs(field("jenis-kegiatan", "Absen Latihan PW") +
                    'document.getElementById("jenis-kegiatan").dispatchEvent(new Event("change")); true');
                await until(() => evalJs('!document.getElementById("btn-hadir").disabled'), "attendance submit enabled");
                await evalJs('document.getElementById("btn-hadir").click(); true');
            }
            await submitTraining();
            const trainingRecords = () => db.collection("kehadiran_jemaat").where("uid", "==", "browser-member").get();
            await until(async () => (await trainingRecords()).size === 1, "training persisted");
            await until(() => evalJs('document.getElementById("lock-title").innerText === "Terimakasih"'), "training success display");
            await db.doc("users/browser-member").update({ status_akun: "Pending" });
            try {
                await submitTraining();
                await until(() => evalJs('document.getElementById("lock-title").innerText === "Gagal Simpan"'), "training denial display");
                assert.equal((await trainingRecords()).size, 1);
            } finally {
                await db.doc("users/browser-member").update({ status_akun: "Aktif" });
            }
        });
        await check("browser active Viewer Big Data displays member reports, KD and JC", async () => {
            await evalJs('firebase.auth().signInWithEmailAndPassword("viewer@example.test", "Synthetic-only-42!").catch(error => window.phase5SigninError = error.message); true');
            await until(() => evalJs('firebase.auth().currentUser?.uid === "viewer"'), "Viewer sign-in");
            await open("admin-bigdata.html");
            await until(() => evalJs('document.getElementById("bdSession")?.innerText === "VIEWER SESSION"'), "Viewer Auth");
            await selectTab("pelayanan");
            await until(() => evalJs('document.getElementById("data-list").innerText.includes("Browser synthetic service")'), "Big Data service row");
            await selectTab("bacaan");
            await until(() => evalJs('document.getElementById("data-list").innerText.includes("Browser Member")'), "Big Data reading row");
            await selectTab("latihan_pw");
            await until(() => evalJs('document.getElementById("data-list").innerText.includes("Browser Member")'), "Big Data training row");
            await selectTab("absen_kd");
            await until(() => evalJs('document.getElementById("data-list").innerText.includes("Synthetic current KD") && document.getElementById("data-list").innerText.includes("Synthetic legacy KD")'), "both Big Data KD sources");
            await selectTab("peringkat_jc");
            await until(() => evalJs('document.getElementById("data-list").innerText.includes("Synthetic JC")'), "Big Data ranking row");
        });
        if (browserLibraries) {
            await check("browser Big Data chart and PDF output use selected training tab", async () => {
                await selectTab("latihan_pw");
                await until(() => evalJs('window.Chart?.getChart("pieChart")?.data?.datasets[0]?.data[0] === 2'),
                    "training chart counts both saved attendance reports");
                assert.equal(await evalJs('document.querySelectorAll("#data-list tr").length'), 2);
                await evalJs('exportPDF("single")');
                const pdf = () => fs.readdirSync(downloads).find(file => file.startsWith("Laporan_Pondok_Pemulihan_") && file.endsWith(".pdf"));
                await until(pdf, "Big Data PDF download");
                const content = fs.readFileSync(path.join(downloads, pdf()));
                assert.equal(content.subarray(0, 5).toString(), "%PDF-");
                assert.ok(content.includes(Buffer.from("Latihan PW", "ascii")));
            });
        } else {
            console.log("NOT TESTED browser chart and PDF export without local browser libraries");
        }
    } finally {
        if (cdp) {
            await cdp.send("Browser.close").catch(() => {});
            cdp.close();
        }
        if (!spawnError && child.exitCode === null && child.signalCode === null) child.kill();
    }
};
