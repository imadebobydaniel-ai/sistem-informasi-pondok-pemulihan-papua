"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { runInNewContext, runInThisContext } = require("node:vm");
const { initializeTestEnvironment, assertFails } = require("@firebase/rules-unit-testing");
const firebaseCompat = require("firebase/compat/app");
require("firebase/compat/firestore");
const { doc, getDoc, setDoc, updateDoc, serverTimestamp } = require("firebase/firestore");

const projectId = "demo-sipapua-qr-r4";
const host = "127.0.0.1";
const authPort = 29099;
const firestorePort = 28080;
const hubPort = 24400;
const scanner = "r4-scanner";
const recipient = "r4-recipient";
const stranger = "r4-stranger";
const digest = value => createHash("sha256").update(value).digest("hex");
const context = (uid, data = {}) => ({ auth: { uid }, app: { appId: "synthetic-r4" }, data });
const root = resolve(__dirname, "../..");
const source = path => readFileSync(resolve(root, path), "utf8");
const pair = (first, second) => [first, second].sort().join("_");

test("isolated QR scan to explicit request to accepted contacts", async t => {
    assert.equal(process.env.GCLOUD_PROJECT, projectId);
    assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, host + ":" + authPort);
    assert.equal(process.env.FIRESTORE_EMULATOR_HOST, host + ":" + firestorePort);
    assert.equal(process.env.FIREBASE_EMULATOR_HUB, host + ":" + hubPort);
    for (const key of ["GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_TOKEN", "GOOGLE_OAUTH_ACCESS_TOKEN"]) {
        assert.equal(process.env[key], undefined, key);
    }
    const hub = await (await fetch("http://" + host + ":" + hubPort + "/emulators")).json();
    assert.deepEqual([hub.auth.host, hub.auth.port], [host, authPort]);
    assert.deepEqual([hub.firestore.host, hub.firestore.port], [host, firestorePort]);
    assert.equal(hub.functions, undefined);

    const dependency = createRequire(resolve(root, "functions/package.json"));
    const appModule = dependency("firebase-admin/app");
    const app = appModule.initializeApp({ projectId });
    const db = dependency("firebase-admin/firestore").getFirestore();
    const auth = dependency("firebase-admin/auth").getAuth();
    let env;
    t.after(async () => {
        if (env) await env.cleanup();
        await db.terminate();
        await appModule.deleteApp(app);
    });
    env = await initializeTestEnvironment({
        projectId, firestore: { host, port: firestorePort, rules: source("candidates/qr-r2/firestore.candidate.rules") }
    });
    const { getMyCardToken } = require("../../functions/member-card");
    const { createQrFriendshipIntegration } = require("./integration.cjs");
    const { scanQrIntroduction, requestQrIntroduction } = createQrFriendshipIntegration(db, auth);
    const call = (handler, uid, data) => handler.run(context(uid, data));
    const scan = (token, uid = scanner) => call(scanQrIntroduction, uid, { token });
    const redeem = (receipt, uid = scanner) => call(requestQrIntroduction, uid, { receipt });
    const seed = (path, data) => db.doc(path).set(data);
    const client = uid => env.authenticatedContext(uid, {
        email_verified: true, firebase: { sign_in_provider: "password" }
    }).firestore();
    const createMember = async (uid, status = "Aktif") => {
        await auth.createUser({ uid, email: uid + "@example.invalid", emailVerified: true });
        await seed("users/" + uid, { uid, nama: uid, status_akun: status, whatsapp: "private-synthetic" });
        await seed("presence/" + uid, { displayName: uid, photoURL: "", discoverable: false, showOnline: false });
    };
    const optIn = (uid, enabled) => seed("qr_friend_preferences/" + uid, { allowQrIntroductions: enabled });
    const allowScan = (uid = scanner) => db.doc("member_card_state/" + uid)
        .set({ scannedAt: Date.now() - 2_100 }, { merge: true });
    for (const uid of [scanner, recipient, stranger]) await createMember(uid);
    const card = await call(getMyCardToken, recipient);
    const scannerDb = client(scanner);
    const recipientDb = client(recipient);
    const outsiderDb = client(stranger);
    const requestId = pair(scanner, recipient);
    const requestPath = "friend_requests/" + requestId;
    const scannerContact = "contacts/" + scanner + "/friends/" + recipient;
    const recipientContact = "contacts/" + recipient + "/friends/" + scanner;
    const receiptDoc = receipt => db.doc("qr_friend_receipts/" + digest(receipt));

    await t.test("browser handoff through existing helper, explicit consent and existing acceptance handler", async () => {
        const objects = new Map();
        const calls = [];
        let paused = true;
        let requestPayload;
        const currentUser = { uid: scanner };
        const window = {
            sessionStorage: {
                getItem: key => objects.get(key),
                setItem: (key, value) => objects.set(key, value),
                removeItem: key => objects.delete(key)
            },
            SIPAPUA_MAINTENANCE: { isPaused: () => paused, message: () => "Maintenance" },
            SIPAPUA_APP_CHECK: { prepare: () => async () => { calls.push("attested"); } },
            firebase: {
                auth: () => ({ currentUser }),
                app: () => ({ functions: region => {
                    assert.equal(region, "asia-southeast2");
                    return { httpsCallable: name => async data => {
                        calls.push(name);
                        if (name === "scanQrIntroduction") return { data: await call(scanQrIntroduction, scanner, data) };
                        assert.equal(name, "requestQrIntroduction");
                        requestPayload = data;
                        return { data: await call(requestQrIntroduction, scanner, data) };
                    } };
                } })
            }
        };
        runInNewContext(source("sipapua-member-card.js"), { window });
        runInNewContext(source("candidates/qr-r4/introduction-client.js"), { window });
        const helper = window.SIPAPUA_MEMBER_CARD;
        const controller = window.SIPAPUA_QR_INTRODUCTION.create();
        await assert.rejects(controller.scanPending(), /Maintenance/);
        assert.deepEqual(calls, []);
        paused = false; // Synthetic page sandbox only.
        assert.equal(helper.scanDestination("legacy@example.invalid"), "bio-singkat-jemaat.html?legacy=1");
        await assert.rejects(controller.scanPending(), /tidak tersedia/);
        assert.equal(helper.scanDestination("sipapua://scan?t=" + card.token), "bio-singkat-jemaat.html");
        await assert.rejects(controller.scanPending(), { code: "permission-denied" });
        await optIn(recipient, true);
        await allowScan();
        assert.equal(helper.scanDestination("sipapua://scan?t=" + card.token), "bio-singkat-jemaat.html");
        assert.deepEqual(await controller.scanPending(), { nama: recipient, nij: null });
        assert.equal(objects.size, 0);
        assert.equal((await db.doc(requestPath).get()).exists, false);
        assert.equal((await getDoc(doc(scannerDb, scannerContact))).exists(), false);

        const sending = controller.requestFriendship();
        await assert.rejects(controller.requestFriendship(), /sedang diproses/);
        assert.deepEqual(await sending, { status: "pending" });
        assert.deepEqual(Object.keys(requestPayload), ["receipt"]);
        assert.equal((await receiptDoc(requestPayload.receipt).get()).exists, false);
        await assert.rejects(controller.requestFriendship(), /Pindai ulang/);
        await assert.rejects(redeem(requestPayload.receipt), { code: "permission-denied" });
        assert.equal((await getDoc(doc(scannerDb, scannerContact))).exists(), false);
        const pending = (await getDoc(doc(recipientDb, requestPath))).data();
        assert.equal(pending.status, "pending");
        assert.equal(pending.fromUid, scanner);
        assert.equal(pending.toUid, recipient);
        await assertFails(getDoc(doc(outsiderDb, requestPath)));
        await assertFails(updateDoc(doc(scannerDb, requestPath), { status: "accepted", updatedAt: serverTimestamp() }));
        await assertFails(setDoc(doc(scannerDb, scannerContact), {
            friendUid: recipient, status: "accepted", requestId, displayName: recipient, photoURL: "", createdAt: serverTimestamp()
        }));

        const alerts = [];
        const menu = source("menu.html");
        const start = menu.indexOf("    async function terimaPertemanan(");
        const end = menu.indexOf("    async function tolakPertemanan(", start);
        assert.ok(start >= 0 && end > start);
        // Use the SDK's realm for Firestore's plain-object validation.
        const buildAcceptance = runInThisContext(
            "(function (auth, db, firebase, Swal) {\n" + menu.slice(start, end) + "\nreturn terimaPertemanan;\n})"
        );
        const accept = buildAcceptance({ currentUser: { uid: recipient } }, recipientDb,
            firebaseCompat, { fire: item => alerts.push(item) });
        await accept(requestId, pending, recipient);
        assert.equal(alerts[0]?.icon, "success");
        assert.equal((await getDoc(doc(recipientDb, requestPath))).get("status"), "accepted");
        assert.equal((await getDoc(doc(scannerDb, scannerContact))).get("status"), "accepted");
        assert.equal((await getDoc(doc(recipientDb, recipientContact))).get("status"), "accepted");
        await allowScan();
        await assert.rejects(scan(card.token), { code: "permission-denied" });
        assert.equal((await db.collection("sipapua_group_rooms").get()).empty, true);
        assert.equal((await db.collection("mutual_chats").get()).empty, true);
        assert.deepEqual(calls, ["attested", "scanQrIntroduction", "attested", "scanQrIntroduction", "attested", "requestQrIntroduction"]);
    });

    await t.test("receipt authorization, stale proof, bilateral blocks and concurrent redemption", async () => {
        const target = "r4-second-target";
        const legacy = "r4-bound-legacy";
        await createMember(target);
        await auth.createUser({ uid: legacy, email: legacy + "@example.invalid", emailVerified: true });
        await seed("member_identity/" + legacy, { uid: legacy, profileId: "bound-legacy-document" });
        await seed("users/bound-legacy-document", { uid: legacy, status_akun: "Aktif" });
        await optIn(target, true);
        const secondCard = await call(getMyCardToken, target);
        const scanAllowed = async () => { await allowScan(); return scan(secondCard.token); };
        await assert.rejects(scanQrIntroduction.run({ app: context(scanner).app, data: { token: secondCard.token } }), { code: "unauthenticated" });
        await assert.rejects(scanQrIntroduction.run({ auth: { uid: scanner }, data: { token: secondCard.token } }), { code: "unauthenticated" });
        await assert.rejects(requestQrIntroduction.run({ auth: { uid: scanner } }), { code: "unauthenticated" });
        await assert.rejects(scan(secondCard.token, legacy), { code: "permission-denied" });
        await assert.rejects(scan(secondCard.token, target), { code: "permission-denied" });
        await assert.rejects(scan("forged@example.invalid"), { code: "invalid-argument" });
        await allowScan();
        await assert.rejects(scan("A".repeat(43)), { code: "permission-denied" });

        const expired = await scanAllowed();
        assert.ok(expired.expiresAt <= Math.min(Date.now() + 60_000, secondCard.expiresAt));
        await assertFails(getDoc(doc(scannerDb, receiptDoc(expired.receipt).path)));
        await receiptDoc(expired.receipt).update({ expiresAt: Date.now() - 1 });
        await assert.rejects(redeem(expired.receipt), { code: "permission-denied" });
        const proof = await scanAllowed();
        await assert.rejects(redeem(proof.receipt, stranger), { code: "permission-denied" });
        await assert.rejects(call(requestQrIntroduction, scanner, { receipt: proof.receipt, target: stranger }), { code: "invalid-argument" });
        for (const [blocker, blocked] of [[scanner, target], [target, scanner]]) {
            const block = "user_blocks/" + blocker + "/blocked/" + blocked;
            await seed(block, { blocked: true });
            await assert.rejects(redeem(proof.receipt), { code: "permission-denied" });
            await db.doc(block).delete();
        }
        await optIn(target, false);
        await assert.rejects(redeem(proof.receipt), { code: "permission-denied" });
        await optIn(target, true);
        await db.doc("users/" + target).update({ status_akun: "Pending" });
        await assert.rejects(redeem(proof.receipt), { code: "permission-denied" });
        await db.doc("users/" + target).update({ status_akun: "Aktif" });
        await auth.updateUser(scanner, { disabled: true });
        await assert.rejects(redeem(proof.receipt), { code: "permission-denied" });
        await auth.updateUser(scanner, { disabled: false });
        assert.equal((await receiptDoc(proof.receipt).get()).exists, true);
        assert.equal((await db.doc("friend_requests/" + pair(scanner, target)).get()).exists, false);
        await db.doc("member_card_state/" + target).update({ issuedAt: Date.now() - 15_100 });
        const rotated = await call(getMyCardToken, target);
        await assert.rejects(redeem(proof.receipt), { code: "permission-denied" });
        await allowScan();
        const fresh = await scan(rotated.token);
        const attempts = await Promise.allSettled([redeem(fresh.receipt), redeem(fresh.receipt)]);
        assert.equal(attempts.filter(attempt => attempt.status === "fulfilled").length, 1);
        assert.equal(attempts.find(attempt => attempt.status === "rejected").reason.code, "permission-denied");
        assert.equal((await receiptDoc(fresh.receipt).get()).exists, false);
        assert.equal((await db.doc("friend_requests/" + pair(scanner, target)).get()).get("status"), "pending");
    });
});
