"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { createRequire } = require("node:module");
const vm = require("node:vm");

module.exports = async ({ check, root, readStage, authHost, firestorePort, db, projectId, reports, registration, lifecycle, authDirectory }) => {
    const requireBackend = createRequire(path.join(root, "functions/package.json"));
    const { onCall, HttpsError } = requireBackend("firebase-functions/v2/https");
    const { initializeApp, deleteApp } = require("firebase/app");
    const { getAuth, connectAuthEmulator, signInWithEmailAndPassword, signOut } = require("firebase/auth");
    const { getFunctions, connectFunctionsEmulator, httpsCallable } = require("firebase/functions");
    const express = requireBackend("express");
    const routes = {
        memberLoginStatus: registration.memberLoginStatus,
        getSIPAPUAOwnProfile: lifecycle.getSIPAPUAOwnProfile,
        submitSIPAPUAReading: reports.submitSIPAPUAReading,
        submitSIPAPUAServiceReport: reports.submitSIPAPUAServiceReport,
        submitSIPAPUAAttendance: reports.submitSIPAPUAAttendance
    };
    const endpoints = Object.fromEntries(Object.entries(routes).map(([name, handler]) =>
        [name, onCall({ region: "asia-southeast2", enforceAppCheck: false }, request => {
            if (!request.auth) throw new HttpsError("unauthenticated", "Login diperlukan.");
            return handler(request);
        })]));
    const local = express();
    local.use(express.json({ limit: "64kb" }));
    for (const [name, endpoint] of Object.entries(endpoints)) {
        local.all("/" + projectId + "/asia-southeast2/" + name, endpoint);
    }
    const server = require("node:http").createServer(local);
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const app = initializeApp({ apiKey: "demo-key", projectId }, "phase5-transport");
    const auth = getAuth(app);
    const functions = getFunctions(app, "asia-southeast2");
    connectAuthEmulator(auth, "http://" + authHost, { disableWarnings: true });
    connectFunctionsEmulator(functions, "127.0.0.1", server.address().port);
    const call = name => httpsCallable(functions, name);
    const wit = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jayapura",
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    try {
        if (process.env.SIPAPUA_PHASE5_BROWSER) {
            await authDirectory.createUser({ uid: "browser-member", email: "browser-member@example.test",
                emailVerified: true, password: "Synthetic-only-42!" });
            await db.doc("users/browser-member").set({ uid: "browser-member", email: "browser-member@example.test",
                nama: "Browser Member", nij: "SYN-BROWSER", status_akun: "Aktif", wilayah: "Abepura", komsel: "Synthetic JC" });
            await require("./browser.cjs")({ check, root, readStage, authHost, firestorePort, db, projectId,
                functionsPort: server.address().port, local });
        }
        await check("Firebase SDK callable HTTP authenticates emulator tokens and rejects signed-out requests", async () => {
            await assert.rejects(call("memberLoginStatus")({}), { code: "functions/unauthenticated" });
            await signInWithEmailAndPassword(auth, "member@example.test", "Synthetic-only-42!");
            assert.equal((await call("memberLoginStatus")({})).data.active, true);
        });
        await check("real service form submit callback reaches callable HTTP and stored report", async () => {
            const appCompat = { functions: () => ({ httpsCallable: call }) };
            const firebase = { app: () => appCompat, auth: () => auth };
            const nodes = new Map();
            const alerts = [];
            let submit;
            const document = { getElementById: id => {
                if (!nodes.has(id)) nodes.set(id, { value: "", style: {}, className: "",
                    addEventListener: (name, callback) => { if (id === "pelayananForm" && name === "submit") submit = callback; } });
                return nodes.get(id);
            } };
            const box = vm.createContext({ auth, firebase, document, console: { error() {} },
                SIPAPUA_APP_CHECK: { prepare: () => async () => {} },
                SIPAPUA: { notify: { warning: message => alerts.push(message) }, error: { normalize: value => value } } });
            box.window = box;
            vm.runInContext(readStage("sipapua-member-session.js"), box);
            const page = readStage("laporan-pelayanan.html");
            const form = page.indexOf('.getElementById("pelayananForm")');
            const start = page.lastIndexOf("\n        document", form);
            const end = page.indexOf("</script>", form);
            vm.runInContext(page.slice(start, end), box);
            for (const [id, value] of Object.entries({ kategori_kegiatan: "WL", nama_kegiatan: "HTTP synthetic service",
                lokasi_kegiatan: "Synthetic location", tanggal_kegiatan: "2026-11-18" })) document.getElementById(id).value = value;
            const event = { preventDefault() {}, stopPropagation() {} };
            await submit(event);
            assert.equal(document.getElementById("status-msg").className, "success-box");
            const saved = await db.collection("laporan_pelayanan").where("nama_kegiatan", "==", "HTTP synthetic service").get();
            assert.equal(saved.size, 1);
            assert.equal(saved.docs[0].get("uid"), "member");
            assert.equal(saved.docs[0].get("poin"), 10);
            await submit(event);
            assert.equal(alerts.length, 1);
            document.getElementById("tanggal_kegiatan").value = "2026-02-30";
            document.getElementById("status-msg").className = "";
            await submit(event);
            assert.notEqual(document.getElementById("status-msg").className, "success-box");
            assert.equal((await db.collection("laporan_pelayanan").where("nama_kegiatan", "==", "HTTP synthetic service").get()).size, 1);
        });
        const time = Object.fromEntries(wit.formatToParts(new Date()).map(part => [part.type, part.value]));
        const tanggal = `${time.year}-${time.month}-${time.day}`;
        const inWindow = +time.hour * 60 + +time.minute >= 1 && +time.hour < 22;
        if (!inWindow) {
            console.log("NOT TESTED realtime HTTP positive reading/attendance path outside WIT reporting window");
        } else {
            await check("reading and training traverse callable HTTP and persist under active Auth UID", async () => {
                await signInWithEmailAndPassword(auth, "other@example.test", "Synthetic-only-42!");
                const reading = { tanggal, amsal: 18, utama: { kitab: "Yohanes", dari: 1, sampai: 2 } };
                const { data: book } = await call("submitSIPAPUAReading")(reading);
                assert.equal((await db.doc("laporan_bacaan/" + book.id).get()).get("uid"), "other");
                assert.equal((await call("submitSIPAPUAReading")(reading)).data.duplicate, true);
                const training = { tanggal, kegiatan: "Absen Latihan PW", status: "HADIR", keterangan: "",
                    lokasi_koordinat: "-2.5, 140.7", alamat_fisik: "Synthetic location",
                    attempt: "ddad51de-a97e-4933-80df-f591c6f650ed" };
                const { data: attendance } = await call("submitSIPAPUAAttendance")(training);
                assert.equal((await db.doc("kehadiran_jemaat/" + attendance.id).get()).get("uid"), "other");
                assert.equal((await db.doc("statistik_jemaat_pusat/" + attendance.id).get()).get("kegiatan"), training.kegiatan);
                await signOut(auth);
                await assert.rejects(call("submitSIPAPUAAttendance")(training), { code: "functions/unauthenticated" });
            });
        }
        await check("Asia/Jayapura exact opening and closing boundaries", async () => {
            const data = { tanggal: "2026-11-19", utama: { kitab: "Yohanes", dari: 1, sampai: 1 }, amsal: 19 };
            const send = date => reports.submit({ auth: { uid: "member" }, data }, "reading", new Date(date));
            await assert.rejects(send("2026-11-18T15:00:59Z"), { code: "failed-precondition" });
            const result = await send("2026-11-18T15:01:00Z");
            assert.equal((await db.doc("laporan_bacaan/" + result.id).get()).get("tanggal"), "2026-11-19");
            await assert.rejects(send("2026-11-19T13:00:00Z"), { code: "failed-precondition" });
            // Keep the Phase 4 single-period Rapor fixture consistent across the combined checks.
            await db.doc("laporan_bacaan/" + result.id).delete();
        });
    } finally {
        try { await deleteApp(app); }
        finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    }
};
