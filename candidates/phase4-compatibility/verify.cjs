"use strict";

process.env.METADATA_SERVER_DETECTION = "none";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { spawn, execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const projectId = "demo-sipapua-phase4";
const requireBackend = createRequire(path.join(root, "functions/package.json"));
const { initializeTestEnvironment, assertFails, assertSucceeds } = require("@firebase/rules-unit-testing");
const firestore = require("firebase/firestore");
firestore.setLogLevel("silent");
const rules = fs.readFileSync(path.join(__dirname, "firestore.phase4.rules"), "utf8");

function stage() {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "sipapua-phase4-"));
    const patch = path.join(__dirname, "compatibility.patch");
    for (const [, file] of fs.readFileSync(patch, "utf8").matchAll(/^--- a\/(.+)$/gm)) {
        const to = path.join(folder, file);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(path.join(root, file), to);
    }
    execFileSync("git", ["apply", "--ignore-space-change", patch], { cwd: folder });
    fs.copyFileSync(path.join(__dirname, "member-reports.js"), path.join(folder, "functions/member-reports.js"));
    return folder;
}

async function loopbackPort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address();
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function run() {
    const stageRoot = stage();
    const readStage = file => fs.readFileSync(path.join(stageRoot, file), "utf8");
    let passed = 0;
    let failed = 0;
    async function check(name, fn) {
        try { await fn(); passed++; console.log("PASS " + name); }
        catch (error) { failed++; console.error("FAIL " + name + " | " + (error.stack || error)); }
    }
    await check("candidate patch applies and every patched page inline script parses", () => {
        for (const page of fs.readdirSync(stageRoot).filter(file => file.endsWith(".html"))) {
            const html = readStage(page);
            for (const [, attrs, source] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
                if (!/\bsrc=|type=["'](?:module|application\/)/i.test(attrs)) new vm.Script(source, { filename: page });
            }
        }
        for (const file of fs.readdirSync(path.join(stageRoot, "functions"))) {
            new vm.Script(readStage("functions/" + file), { filename: file });
        }
    });
    await check("restored Auth user reaches backend with empty localStorage", async () => {
        const user = { uid: "member", reload: async () => {}, getIdToken: async () => {} };
        const auth = { currentUser: user };
        let calls = 0;
        const app = { functions: region => {
            assert.equal(region, "asia-southeast2");
            return { httpsCallable: name => async () => {
                assert.equal(name, "memberLoginStatus");
                calls++;
                return { data: { active: true } };
            } };
        } };
        const firebase = { app: () => app, auth: () => auth };
        const box = vm.createContext({ SIPAPUA_APP_CHECK: { prepare: () => async () => {} } });
        vm.runInContext(readStage("sipapua-member-session.js"), box);
        vm.runInContext(readStage("sipapua-login.js"), box);
        box.auth = auth;
        box.memberLogin = box.SIPAPUA_LOGIN.create(auth, box.SIPAPUA_MEMBER_SESSION.create(firebase));
        let observer, redirected;
        auth.onAuthStateChanged = listener => { observer = listener; };
        const local = new Map();
        box.localStorage = { getItem: key => local.get(key), setItem: (key, value) => local.set(key, value),
            removeItem: key => local.delete(key) };
        box.showBlockNotif = message => assert.match(message, /berhasil/);
        box.location = { replace: url => { redirected = url; } };
        box.window = box;
        const index = readStage("index.html");
        const start = index.indexOf("        let loginSubmitting");
        const end = index.indexOf("        // FUNGSI TAMPIL", start);
        vm.runInContext(index.slice(start, end), box);
        await observer(user);
        assert.equal(calls, 1);
        assert.equal(redirected, "menu.html");
        assert.equal(local.get("userUid"), "member");
    });
    await check("Rapor score functions and targets match baseline", () => {
        const base = fs.readFileSync(path.join(root, "rapor.html"), "utf8");
        const candidate = readStage("rapor.html");
        const from = "const WEIGHT_EXACT";
        const to = "function addCollectionListener";
        const scoreCode = html => html.slice(html.indexOf(from), html.indexOf(to)).replaceAll("\r\n", "\n");
        assert.match(scoreCode(base), /function calculatePercentage/);
        assert.match(scoreCode(base), /function buildMetrics/);
        assert.equal(scoreCode(candidate), scoreCode(base));
    });
    await check("Big Data date and activity filters use legacy dates and service created_at", () => {
        const page = readStage("admin-bigdata.html");
        const from = page.indexOf("    function getPeriodBounds()");
        const to = page.indexOf("function refreshDashboardFilterOptions", from);
        const fields = { monthSelect: { value: "10" }, yearSelect: { value: "2026" },
            bdRegionFilter: { value: "Abepura" }, bdJcFilter: { value: "JC A" } };
        const context = vm.createContext({ document: { getElementById: id => fields[id] },
            Date });
        vm.runInContext(page.slice(from, to), context);
        const row = data => ({ data: () => data });
        const data = { timestamp: new Date(2026, 10, 18), kegiatan: "Absen Latihan PW", wilayah: "Abepura", jc: "JC A" };
        const match = row(data);
        const records = [row({ ...data, kegiatan: "Absen KD" }), row({ ...data, wilayah: "Doyo" }),
            row({ ...data, jc: "JC B" }), row({ ...data, timestamp: new Date(2026, 9, 18) }), match];
        const filtered = context.filterAndSortSnapshot({ docs: records }, { kegiatan: "Absen Latihan PW" });
        assert.equal(filtered.length, 1);
        assert.equal(filtered[0], match);
        const service = row({ wilayah: "Abepura", jc: "JC A", created_at: { toDate: () => new Date(2026, 10, 18) } });
        const legacy = row({ wilayah: "Abepura", jc: "JC A", tanggal: "18/11/2026" });
        assert.equal(context.filterAndSortSnapshot({ docs: [service, legacy] }, { timeField: "created_at" }).length, 2);
        assert.match(page, /const snapshot = filterAndSortSnapshot\(source, cfg, null\)/);
    });

    const jar = process.env.SIPAPUA_FIRESTORE_JAR ||
        path.join(os.homedir(), ".cache/firebase/emulators/cloud-firestore-emulator-v1.22.0.jar");
    if (!fs.existsSync(jar)) throw new Error("BLOCKED Firestore emulator JAR unavailable");
    const port = await loopbackPort();
    const child = spawn("java", ["-jar", jar, "--host", "127.0.0.1", "--port", String(port),
        "--websocket_port", "0", "--webchannel_port", "0", "--project_id", projectId],
    { cwd: stageRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let logs = "", startupError, env, db, app, authServer;
    child.on("error", error => { startupError = error; });
    for (const output of [child.stdout, child.stderr]) output.on("data", data => { logs += data; });
    try {
        let ready = false;
        for (let tries = 0; tries < 100 && !ready; tries++) {
            if (startupError || child.exitCode !== null) throw startupError || new Error(logs);
            try {
                const response = await fetch(`http://127.0.0.1:${port}`, { redirect: "error", signal: AbortSignal.timeout(500) });
                ready = [200, 404].includes(response.status);
                await response.body?.cancel();
            } catch {}
            if (!ready) await new Promise(resolve => setTimeout(resolve, 200));
        }
        assert.ok(ready, logs);
        env = await initializeTestEnvironment({ projectId, firestore: { host: "127.0.0.1", port, rules } });
        process.env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:${port}`;
        process.env.FUNCTIONS_EMULATOR = "true";
        process.env.XDG_CONFIG_HOME = path.join(stageRoot, "config");
        process.env.CI = "true";
        const authModule = process.env.SIPAPUA_AUTH_EMULATOR_MODULE ||
            path.join(os.homedir(), "AppData/Roaming/npm/node_modules/firebase-tools/lib/emulator/auth/server.js");
        if (!fs.existsSync(authModule)) throw new Error("BLOCKED Local Firebase Auth emulator implementation unavailable");
        const authApp = await require(authModule).createApp(projectId, 2);
        authServer = await new Promise((resolve, reject) => {
            const server = authApp.listen(0, "127.0.0.1", () => resolve(server));
            server.once("error", reject);
        });
        const authHost = `127.0.0.1:${authServer.address().port}`;
        process.env.FIREBASE_AUTH_EMULATOR_HOST = authHost;
        const admin = requireBackend("firebase-admin/app");
        const sdk = requireBackend("firebase-admin/firestore");
        const credential = { getAccessToken: async () => ({ access_token: "owner", expires_in: 3600 }) };
        app = admin.initializeApp({ projectId, credential }, projectId);
        db = new sdk.Firestore({ projectId, host: `127.0.0.1:${port}`, ssl: false });
        const authSdk = requireBackend("firebase-admin/auth");
        const authDirectory = authSdk.getAuth(app);

        // Invoke handler code directly. Its Auth directory and database use loopback emulators.
        const accounts = new Map();
        const roles = { master: "master", super: "super_admin", admin: "admin", viewer: "viewer", inactive: "super_admin" };
        for (const uid of ["member", "other", "pending", "ambiguous", "verified", ...Object.keys(roles)]) {
            accounts.set(uid, await authDirectory.createUser({ uid, email: uid + "@example.test",
                emailVerified: uid !== "pending", password: "Synthetic-only-42!" }));
        }
        await check("synthetic Firebase Auth sign-in and refreshed token stay on loopback", async () => {
            const clientApp = require("firebase/app");
            const clientAuth = require("firebase/auth");
            const authClient = clientApp.initializeApp({ projectId, apiKey: "demo-key" }, "phase4-auth");
            try {
                const auth = clientAuth.getAuth(authClient);
                clientAuth.connectAuthEmulator(auth, "http://" + authHost, { disableWarnings: true });
                const { user } = await clientAuth.signInWithEmailAndPassword(auth, "member@example.test", "Synthetic-only-42!");
                await user.reload();
                const token = await authDirectory.verifyIdToken(await user.getIdToken(true));
                assert.equal(auth.currentUser.uid, "member");
                assert.equal(token.uid, "member");
            } finally {
                await clientApp.deleteApp(authClient);
            }
        });
        const localDb = { doc: key => db.doc(key), collection: key => db.collection(key),
            runTransaction: callback => db.runTransaction(async tx => callback(tx)) };
        const deps = {
            "firebase-functions/v2/https": { onCall: (_options, run) => run,
                HttpsError: requireBackend("firebase-functions/v2/https").HttpsError },
            "firebase-admin/firestore": { getFirestore: () => localDb, FieldValue: sdk.FieldValue },
            "firebase-admin/auth": { getAuth: () => authDirectory },
            "node:crypto": require("node:crypto")
        };
        const modules = new Map();
        function load(name) {
            if (modules.has(name)) return modules.get(name);
            const context = { exports: {}, Buffer, process: { env: { FUNCTIONS_EMULATOR: "true" } },
                require: dependency => deps[dependency] || load(dependency.replace(/^\.\//, "") + ".js") };
            vm.runInNewContext(readStage("functions/" + name), context, { filename: name });
            modules.set(name, context.exports);
            return context.exports;
        }
        const lifecycle = load("member-lifecycle.js");
        const registration = load("registration-paket-a.js");
        const reports = load("member-reports.js");
        const request = (uid, data = {}) => ({ auth: { uid }, data });
        const put = (key, data) => db.doc(key).set(data);
        const read = async key => (await db.doc(key).get()).data();
        const reject = (promise, code) => assert.rejects(promise, error => error.code === code);
        await Promise.all(Object.entries(roles).map(([uid, role]) => put("admin_users/" + uid,
            { role, status: uid === "inactive" ? "inactive" : "active", permissions: { canActivateMembers: true } })));
        for (const uid of ["member", "other", "pending", "viewer"]) {
            await put("users/" + uid, { uid, email: accounts.get(uid).email, nama: "Synthetic " + uid,
                status_akun: uid === "pending" ? "Pending" : "Aktif", wilayah: "Abepura", komsel: "Synthetic JC", total_poin: 20 });
        }
        await put("jemaat/family", { nama: "Synthetic Family" });
        await put("registration_control/state", { enabled: false, maintenance: true, version: "original-spark-v1" });
        await put("users/ambiguous-a", { email: accounts.get("ambiguous").email, status_akun: "Pending" });
        await put("users/ambiguous-b", { email: accounts.get("ambiguous").email, status_akun: "Pending" });
        const nij = { uid: "verified", nij: "NIJ-PPP-ABE-001-2026", nij_number: 1, lokasi: "ABE", wilayah: "Abepura" };
        const verifiedEmail = accounts.get("verified").email;
        await put("nij_allocations/verified", nij);
        await put("users/verified", { ...nij, email: verifiedEmail, email_normalized: verifiedEmail,
            whatsapp: "081234567890", whatsapp_normalized: "6281234567890", status_akun: "Menunggu Verifikasi" });
        await put("registration_unique/email_" + verifiedEmail, { uid: "verified" });
        await put("registration_unique/phone_6281234567890", { uid: "verified" });
        await put("users/wrong-profile", { uid: "verified", email: verifiedEmail, status_akun: "Pending" });

        await check("verified activation, audit and NIJ integrity", async () => {
            await reject(registration.adminActivateSIPAPUAProfile(request("master",
                { targetUid: "wrong-profile", identityVerified: true })), "failed-precondition");
            for (let i = 0; i < 2; i++) assert.equal((await registration.memberLoginStatus(request("verified"))).active, true);
            const audit = await db.collection("registration_audit").where("targetUid", "==", "verified").get();
            assert.equal(audit.size, 1);
            assert.equal(audit.docs[0].get("action"), "activate-verified-email");
            assert.deepEqual(await read("nij_allocations/verified"), nij);
        });
        await check("activation role denials, audited Super Admin override, and ambiguous legacy denial", async () => {
            const data = { targetUid: "pending", identityVerified: true };
            for (const uid of ["admin", "viewer", "inactive", "member"]) {
                await reject(registration.adminActivateSIPAPUAProfile(request(uid, data)), "permission-denied");
            }
            assert.equal((await registration.adminActivateSIPAPUAProfile(request("super", data))).active, true);
            assert.equal((await registration.memberLoginStatus(request("pending"))).emailVerified, false);
            const audit = await db.collection("registration_audit").where("targetUid", "==", "pending").get();
            assert.equal(audit.size, 1);
            assert.equal(audit.docs[0].get("actorUid"), "super");
            assert.equal((await authDirectory.getUser("pending")).emailVerified, false);
            await reject(registration.adminActivateSIPAPUAProfile(request("master",
                { targetUid: "ambiguous-a", identityVerified: true })), "failed-precondition");
            await reject(registration.memberLoginStatus(request("ambiguous")), "failed-precondition");
        });

        const client = uid => env.authenticatedContext(uid).firestore();
        const col = (clientDb, name) => firestore.collection(clientDb, name);
        const doc = (uid, key) => firestore.doc(client(uid), key);
        await check("role matrix, member editing, family and regional queries, and identity integrity", async () => {
            for (const uid of ["master", "super", "admin", "viewer"]) {
                await assertSucceeds(firestore.getDoc(doc(uid, "jemaat/family")));
                const query = firestore.query(col(client(uid), "users"), firestore.where("wilayah", "==", "Abepura"));
                assert.ok((await assertSucceeds(firestore.getDocs(query))).size > 0);
            }
            await assertFails(firestore.getDoc(doc("inactive", "jemaat/family")));
            await assertFails(firestore.getDocs(col(client("inactive"), "users")));
            for (const uid of ["admin", "viewer", "inactive", "other"]) {
                await reject(lifecycle.updateSIPAPUAProfile(request(uid, { docId: "member", changes: { nama: "Denied" } })), "permission-denied");
            }
            for (const uid of ["member", "master", "super"]) {
                assert.equal((await lifecycle.updateSIPAPUAProfile(request(uid, { docId: "member",
                    changes: { nama: "Synthetic " + uid } }))).updated, true);
            }
            for (const changes of [{ uid: "other" }, { nij: "replacement" }]) {
                await reject(lifecycle.updateSIPAPUAProfile(request("master", { docId: "member", changes })), "invalid-argument");
                await assertFails(firestore.updateDoc(doc("master", "users/member"), changes));
            }
        });
        await check("bulk-delete authorization and partial failure on synthetic profiles", async () => {
            for (const id of ["disposable-1", "disposable-2"]) await put("users/" + id, { uid: id });
            const remove = (uid, id) => lifecycle.deleteSIPAPUAProfiles(request(uid, { docIds: [id] }));
            for (const uid of ["viewer", "admin", "inactive", "member"]) await reject(remove(uid, "disposable-1"), "permission-denied");
            assert.equal((await remove("master", "disposable-1")).deleted, true);
            await put("admin_users/master", { role: "master", status: "inactive" });
            await reject(remove("master", "disposable-2"), "permission-denied");
            assert.equal(await read("users/disposable-1"), undefined);
            assert.ok(await read("users/disposable-2"));
            await put("admin_users/master", { role: "master", status: "active", permissions: { canActivateMembers: true } });
            assert.equal((await remove("super", "disposable-2")).deleted, true);
        });
        const now = new Date("2026-11-17T20:00:00Z");
        const tanggal = "2026-11-18";
        let readingId, serviceId;
        await check("reading submission, dates, ownership and concurrent duplicate handling", async () => {
            const reading = { tanggal, amsal: 18, utama: { kitab: "Yohanes", dari: 1, sampai: 3 } };
            const submit = data => reports.submit(request("member", data), "reading", now);
            await reject(submit({ ...reading, uid: "other" }), "invalid-argument");
            await reject(submit({ ...reading, utama: { ...reading.utama, sampai: 150 } }), "invalid-argument");
            await reject(submit({ ...reading, tanggal: "2026-11-17" }), "failed-precondition");
            await reject(reports.submit(request("viewer", reading), "reading", now), "permission-denied");
            const results = await Promise.all([submit(reading), submit(reading)]);
            assert.equal(results.filter(result => result.duplicate).length, 1);
            readingId = results[0].id;
            const record = await read("laporan_bacaan/" + readingId);
            assert.equal(record.uid, "member");
            assert.equal(record.email, "member@example.test");
            assert.equal(record.nama, "Synthetic super");
            assert.equal(record.tanggal_str, tanggal);
            assert.equal(record.pasal_utama_full, "Yohanes 1-3");
            await assertSucceeds(firestore.getDoc(doc("member", "laporan_bacaan/" + readingId)));
            await assertFails(firestore.getDoc(doc("other", "laporan_bacaan/" + readingId)));
            await assertFails(firestore.setDoc(doc("member", "laporan_bacaan/client"), { uid: "member" }));
            await put("laporan_bacaan/legacy-reading", { uid: "pending", tanggal: tanggal });
            const previous = await reports.submit(request("pending", reading), "reading", now);
            assert.equal(previous.duplicate, true);
            assert.equal(previous.id, "legacy-reading");
        });
        await check("service points and record commit together and only once", async () => {
            const service = { tanggal, nama_kegiatan: "Synthetic event", lokasi: "Synthetic place", kategori: "WL" };
            const submit = data => reports.submit(request("member", data), "service", now);
            await reject(submit({ ...service, tanggal: "2026-02-30" }), "invalid-argument");
            const results = await Promise.all([submit(service), submit(service)]);
            serviceId = results[0].id;
            assert.equal(results.filter(result => result.duplicate).length, 1);
            assert.equal((await read("users/member")).total_poin, 30);
            assert.equal((await read("laporan_pelayanan/" + serviceId)).poin, 10);
            await put("users/other", { uid: "other", email: "other@example.test", status_akun: "Aktif", total_poin: "legacy-invalid" });
            await reject(reports.submit(request("other", service), "service", now), "failed-precondition");
            assert.equal((await db.collection("laporan_pelayanan").where("uid", "==", "other").get()).size, 0);
        });
        await check("Latihan PW transaction writes original collection and statistics mirror", async () => {
            const attendance = { tanggal, kegiatan: "Absen Latihan PW", status: "HADIR", keterangan: "Ignored",
                lokasi_koordinat: "-2.5, 140.7", alamat_fisik: "Synthetic place", attempt: "fca4d5a1-2276-4e53-9ab1-b5874026f020" };
            const response = await reports.submitAttendance(request("member", attendance), now);
            await reject(reports.submitAttendance(request("member", { ...attendance, lokasi_koordinat: "120, 0" }), now), "invalid-argument");
            assert.equal((await reports.submitAttendance(request("member", attendance), now)).duplicate, true);
            const report = await read("kehadiran_jemaat/" + response.id);
            const mirror = await read("statistik_jemaat_pusat/" + response.id);
            assert.equal(report.uid, "member");
            assert.equal(report.kegiatan, attendance.kegiatan);
            assert.deepEqual(mirror, { ...report, type: "Umum_Entry" });
        });
        await check("Big Data reads for active roles, private aggregation and read-only reports", async () => {
            for (const uid of ["master", "super", "admin", "viewer"]) {
                for (const collection of ["users", "laporan_bacaan", "laporan_pelayanan", "kehadiran_jemaat",
                    "laporan_doa", "laporan_komsel_umum", "statistik_jemaat_pusat"]) {
                    await assertSucceeds(firestore.getDocs(col(client(uid), collection)));
                }
            }
            for (const uid of ["member", "inactive"]) {
                await assertFails(firestore.getDocs(col(client(uid), "statistik_jemaat_pusat")));
                await assertFails(firestore.getDocs(col(client(uid), "laporan_bacaan")));
            }
            for (const uid of ["viewer", "admin", "inactive"]) {
                await assertFails(firestore.updateDoc(doc(uid, "laporan_bacaan/" + readingId), { pasal_hikmat: "Changed" }));
                await assertFails(firestore.deleteDoc(doc(uid, "laporan_pelayanan/" + serviceId)));
            }
            await assertSucceeds(firestore.updateDoc(doc("super", "laporan_bacaan/" + readingId), { pasal_hikmat: "Amsal 18" }));
            await assertFails(firestore.updateDoc(doc("master", "laporan_bacaan/" + readingId), { uid: "other" }));
            for (const name of ["kehadiran_kd", "peringkat_jc"]) {
                await assertFails(firestore.getDocs(col(client("master"), name)));
            }
        });
        await check("registration control and private NIJ guard remain closed", async () => {
            assert.deepEqual(await read("registration_control/state"),
                { enabled: false, maintenance: true, version: "original-spark-v1" });
            await put("nij_counters/Abepura", { last: 1 });
            await reject(registration.registrationReadiness(request("member", { code: "ABE" })), "failed-precondition");
            await assertFails(firestore.setDoc(doc("member", "nij_allocations/member"), { uid: "member" }));
            assert.match(fs.readFileSync(path.join(root, "sipapua-maintenance.js"), "utf8"),
                /registration: true, memberCard: true/);
        });
        await check("QR and chat boundary regression against isolated rules", async () => {
            assert.match(fs.readFileSync(path.join(root, "qrcode.html"), "utf8"), /isPaused\("memberCard"\)/);
            await put("chats/private-demo", { uid: "member" });
            await assertFails(firestore.getDoc(doc("member", "chats/private-demo")));
            await assertFails(firestore.setDoc(doc("member", "chats/client-demo"), { uid: "member" }));
        });
        await check("Rapor indicator grouping and counts use the existing calculator", async () => {
            const { buildRaporStatistics } = require(path.join(root, "functions/rapor-stats"));
            const result = await buildRaporStatistics(db, "member");
            for (const mode of ["WEEK", "MONTH", "YEAR"]) {
                const [period] = Object.values(result[mode]);
                assert.deepEqual(period.alkitab, { count: 1, target: 1, percentage: 100 });
                assert.equal(Object.hasOwn(period, "latihan_pw"), false);
                assert.equal(Object.hasOwn(period, "pelayanan"), false);
            }
        });
    } finally {
        try {
            if (db) await db.terminate();
            if (app) await requireBackend("firebase-admin/app").deleteApp(app);
            if (env) await env.cleanup();
        } finally {
            if (authServer) await new Promise((resolve, reject) =>
                authServer.close(error => error ? reject(error) : resolve()));
            if (child.exitCode === null && child.signalCode === null) {
                const closed = new Promise(resolve => child.once("close", resolve));
                child.kill();
                await closed;
            }
        }
    }
    console.log(`SUMMARY ${passed} PASS, ${failed} FAIL`);
    if (failed) process.exitCode = 1;
}

run().catch(error => { console.error(error); process.exitCode = 1; });
