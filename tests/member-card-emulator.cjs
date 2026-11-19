"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createHash } = crypto;
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { resolve } = require("node:path");
const { Script, runInNewContext } = require("node:vm");

const projectId = "demo-sipapua-member-card";
const hosts = {
    FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
    FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
    FIREBASE_EMULATOR_HUB: "127.0.0.1:4400"
};

test("card page scripts parse", () => {
    for (const page of ["menu", "qrcode", "bio-singkat-jemaat", "kartu-digital"]) {
        const html = readFileSync(resolve(__dirname, "../" + page + ".html"), "utf8");
        for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
            new Script(script[1], { filename: page + ".html" });
        }
    }
});

test("browser handoff consumes the token once and acquires App Check before calling", async () => {
    const store = new Map();
    const calls = [];
    const auth = { currentUser: { uid: "synthetic-user" } };
    let paused = false;
    const window = {
        sessionStorage: {
            getItem: key => store.get(key),
            setItem: (key, value) => store.set(key, value),
            removeItem: key => store.delete(key)
        },
        SIPAPUA_MAINTENANCE: {
            isPaused: () => paused,
            message: () => "Kartu dalam pemeliharaan."
        },
        SIPAPUA_APP_CHECK: {
            prepare() {
                calls.push("prepare");
                return async () => calls.push("app-check");
            }
        },
        firebase: {
            auth: () => auth,
            app: () => ({
                functions(region) {
                    assert.equal(region, "asia-southeast2");
                    return { httpsCallable: name => async () => {
                        calls.push(name);
                        return { data: { found: true } };
                    } };
                }
            })
        }
    };
    runInNewContext(readFileSync(resolve(__dirname, "../sipapua-member-card.js"), "utf8"), { window });
    const card = window.SIPAPUA_MEMBER_CARD;
    const token = "A".repeat(43);
    assert.equal(card.scanDestination("sipapua://scan?t=" + token), "bio-singkat-jemaat.html");
    assert.equal(card.takeScan(), token);
    assert.equal(card.takeScan(), null);
    assert.equal(card.scanDestination("legacy@example.invalid"), "bio-singkat-jemaat.html?legacy=1");
    assert.equal(card.takeScan(), null);
    assert.equal(card.scanDestination("https://example.invalid/?t=" + token), null);
    paused = true;
    await assert.rejects(card.call("lookupMemberCard", { token }), /pemeliharaan/);
    assert.deepEqual(calls, []);
    paused = false;
    await card.call("lookupMemberCard", { token });
    assert.deepEqual(calls, ["prepare", "app-check", "lookupMemberCard"]);
});

test("member cards and existing social rules on demo emulators", async ({ mock }) => {
    assert.equal(process.env.GCLOUD_PROJECT, projectId);
    for (const name of ["GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_TOKEN", "GOOGLE_OAUTH_ACCESS_TOKEN"]) {
        assert.equal(process.env[name], undefined, name);
    }
    for (const [name, host] of Object.entries(hosts)) assert.equal(process.env[name], host, name);
    for (const [name, info] of Object.entries(await (await fetch("http://127.0.0.1:4400/emulators")).json())) {
        if (name === "firestore" || name === "auth" || name === "functions") assert.equal(info.host, "127.0.0.1");
    }
    const requireFunctionDependency = createRequire(resolve(__dirname, "../functions/package.json"));
    const { initializeApp, deleteApp } = requireFunctionDependency("firebase-admin/app");
    const { getAuth } = requireFunctionDependency("firebase-admin/auth");
    const { getFirestore } = requireFunctionDependency("firebase-admin/firestore");
    const { initializeTestEnvironment, assertFails, assertSucceeds } = require("@firebase/rules-unit-testing");
    const { doc, getDoc, setDoc, updateDoc, writeBatch, serverTimestamp } = require("firebase/firestore");
    const app = initializeApp({ projectId });
    const db = getFirestore();
    const auth = getAuth();
    const rules = await initializeTestEnvironment({ projectId, firestore: { host: "127.0.0.1", port: 8080 } });
    try {
        let forcedBytes;
        const randomBytes = crypto.randomBytes;
        mock.method(crypto, "randomBytes", size => forcedBytes ?? randomBytes(size));
        const { getMyCardToken, lookupMemberCard } = require("../functions/member-card");
        const owner = "qr-owner";
        const scanner = "qr-scanner";
        const pending = "qr-pending";
        const linked = "qr-legacy";
        const ownerNij = "NIJ-PPP-ABE-001-2026";
        for (const uid of [owner, scanner, pending, linked]) {
            await auth.createUser({
                uid, email: uid + "@example.invalid", emailVerified: true, password: "synthetic-password"
            });
            await db.doc("users/" + (uid === linked ? "legacy-profile" : uid)).set({
                uid, nij: ownerNij, nama: uid,
                status_akun: uid === pending ? "Pending" : "Aktif",
                email: uid + "@example.invalid", whatsapp: "synthetic-phone", alamat: "synthetic-address",
                komsel: "synthetic-group", lokasi_berjemaat: "synthetic-location", foto_profil: "synthetic-photo"
            });
            await db.doc("presence/" + uid).set({ displayName: uid, photoURL: "", discoverable: true, showOnline: true });
        }
        await db.doc("nij_allocations/" + owner).set({ uid: owner, nij: ownerNij });
        const context = uid => ({ auth: { uid }, app: { appId: "synthetic-attestation" } });
        const issue = (uid, data) => getMyCardToken.run({ ...context(uid), data });
        const scan = token => lookupMemberCard.run({ ...context(scanner), data: { token } });
        const state = uid => db.doc("member_card_state/" + uid);
        const digest = token => createHash("sha256").update(token).digest("hex");
        const tokenDoc = token => db.doc("member_card_tokens/" + digest(token));
        const allowScan = () => state(scanner).update({ scannedAt: Date.now() - 2_100 });

        for (const callable of [getMyCardToken, lookupMemberCard]) {
            await assert.rejects(callable.run({ app: context(owner).app }), { code: "unauthenticated" });
            await assert.rejects(callable.run({ auth: { uid: owner } }), { code: "unauthenticated" });
        }
        const signIn = await fetch("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: owner + "@example.invalid", password: "synthetic-password", returnSecureToken: true })
        });
        assert.equal(signIn.status, 200);
        const { idToken } = await signIn.json();
        assert.ok(idToken);
        for (const name of ["getMyCardToken", "lookupMemberCard"]) {
            const endpoint = "http://127.0.0.1:5001/" + projectId + "/asia-southeast2/" + name;
            const resp = await fetch(endpoint, {
                method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: {} })
            });
            assert.equal(resp.status, 401);
            const noAppCheck = await fetch(endpoint, {
                method: "POST",
                headers: { "content-type": "application/json", authorization: "Bearer " + idToken },
                body: JSON.stringify({ data: {} })
            });
            assert.equal(noAppCheck.status, 401);
        }
        await assert.rejects(issue(pending), { code: "permission-denied" });
        await assert.rejects(issue(owner, { uid: scanner }), { code: "invalid-argument" });
        await assert.rejects(issue("qr-missing"), { code: "permission-denied" });
        for (const callable of [getMyCardToken, lookupMemberCard]) {
            await assert.rejects(callable.run({
                ...context(owner), auth: { uid: owner, token: { firebase: { sign_in_provider: "anonymous" } } }
            }), { code: "unauthenticated" });
        }
        await assert.rejects(issue(linked), { code: "permission-denied" });
        await db.doc("users/duplicate-legacy-profile").set({ uid: linked, nij: ownerNij, status_akun: "Aktif" });
        await assert.rejects(issue(linked), { code: "permission-denied" });
        await db.doc("users/" + linked).set({ uid: owner, nij: ownerNij, status_akun: "Aktif" });
        await assert.rejects(issue(linked), { code: "permission-denied" });
        const scannerCard = await issue(scanner);
        assert.equal(scannerCard.profile.nij, null, "Copying a profile NIJ never establishes an allocation");
        const scannerLookup = await lookupMemberCard.run({ ...context(owner), data: { token: scannerCard.token } });
        assert.deepEqual(scannerLookup, { found: true, uid: scanner, nij: null, nama: scanner });
        await assert.rejects(scan(owner + "@example.invalid"), { code: "invalid-argument" });

        const simultaneousIssues = await Promise.allSettled([issue(owner), issue(owner)]);
        const first = simultaneousIssues.find(result => result.status === "fulfilled").value;
        assert.equal(simultaneousIssues.filter(result => result.status === "fulfilled").length, 1);
        assert.equal(simultaneousIssues.find(result => result.status === "rejected").reason.code, "resource-exhausted");
        assert.equal(Buffer.from(first.token, "base64url").length, 32);
        assert.equal(Buffer.from(first.token, "base64url").toString("base64url"), first.token);
        assert.equal(first.expiresAt - (await state(owner).get()).get("issuedAt"), 300_000);
        assert.deepEqual(first.profile, {
            nij: ownerNij, nama: owner, komsel: "synthetic-group", lokasi_berjemaat: "synthetic-location"
        });
        assert.deepEqual((await tokenDoc(first.token).get()).data(), { uid: owner, expiresAt: first.expiresAt });
        assert.equal((await state(owner).get()).get("tokenHash"), digest(first.token));
        await assert.rejects(issue(owner), { code: "resource-exhausted" });
        await assert.rejects(lookupMemberCard.run({ ...context(pending), data: { token: first.token } }), { code: "permission-denied" });
        await auth.updateUser(pending, { disabled: true });
        await assert.rejects(issue(pending), { code: "permission-denied" });
        await assert.rejects(lookupMemberCard.run({
            ...context(scanner), data: { token: first.token, uid: scanner }
        }), { code: "invalid-argument" });

        const scanTime = Date.now();
        const concurrentClock = mock.method(Date, "now", () => scanTime);
        let simultaneousScans;
        try {
            simultaneousScans = await Promise.allSettled([scan(first.token), scan(first.token)]);
            await assert.rejects(scan(first.token), { code: "resource-exhausted" });
        } finally {
            concurrentClock.mock.restore();
        }
        const member = simultaneousScans.find(result => result.status === "fulfilled").value;
        assert.deepEqual(member, { found: true, uid: owner, nij: ownerNij, nama: owner });
        assert.equal(simultaneousScans.filter(result => result.status === "fulfilled").length, 1);
        assert.equal(simultaneousScans.find(result => result.status === "rejected").reason.code, "resource-exhausted");
        await state(owner).update({ issuedAt: Date.now() - 15_100 });
        const second = await issue(owner);
        assert.notEqual(second.token, first.token);
        assert.equal((await tokenDoc(first.token).get()).exists, false);
        await allowScan();
        assert.deepEqual(await scan(first.token), { found: false });
        await assert.rejects(scan(second.token), { code: "resource-exhausted" });
        await allowScan();
        await auth.updateUser(owner, { disabled: true });
        assert.deepEqual(await scan(second.token), { found: false });
        await auth.updateUser(owner, { disabled: false });
        await allowScan();
        await db.doc("users/" + owner).update({ status_akun: "Pending" });
        assert.deepEqual(await scan(second.token), { found: false });
        await db.doc("users/" + owner).update({ status_akun: "Aktif" });
        await allowScan();
        assert.deepEqual(await scan(second.token), member);
        await allowScan();
        await tokenDoc(second.token).update({ expiresAt: Date.now() - 1 });
        assert.deepEqual(await scan(second.token), { found: false });

        // Hold the application clock still while exercising exact boundaries.
        const boundary = Date.now();
        const clock = mock.method(Date, "now", () => boundary);
        try {
            await state(owner).update({ issuedAt: boundary - 14_999 });
            await assert.rejects(issue(owner), { code: "resource-exhausted" });
            await state(owner).update({ issuedAt: boundary - 15_000 });
            const third = await issue(owner);
            await tokenDoc(third.token).update({ expiresAt: boundary + 1 });
            await state(scanner).update({ scannedAt: boundary - 1_999 });
            await assert.rejects(scan(third.token), { code: "resource-exhausted" });
            await state(scanner).update({ scannedAt: boundary - 2_000 });
            assert.deepEqual(await scan(third.token), member);
            await tokenDoc(third.token).update({ expiresAt: boundary });
            await state(scanner).update({ scannedAt: boundary - 2_000 });
            assert.deepEqual(await scan(third.token), { found: false });
        } finally {
            clock.mock.restore();
        }

        await state(owner).update({ issuedAt: Date.now() - 15_100 });
        const beforeRace = await issue(owner);
        await state(owner).update({ issuedAt: Date.now() - 15_100 });
        await allowScan();
        const [racingScan, afterRace] = await Promise.all([scan(beforeRace.token), issue(owner)]);
        assert.deepEqual(racingScan, racingScan.found ? member : { found: false });
        await allowScan();
        assert.deepEqual(await scan(beforeRace.token), { found: false });
        await allowScan();
        assert.deepEqual(await scan(afterRace.token), member);

        // Make tx.create fail against a real existing digest after rotation
        // has queued deletion of the old token and an update to the pointer.
        await state(owner).update({ issuedAt: Date.now() - 15_100 });
        const previousState = (await state(owner).get()).data();
        const previousCard = (await tokenDoc(afterRace.token).get()).data();
        const collisionBytes = Buffer.alloc(32, 7);
        const collision = tokenDoc(collisionBytes.toString("base64url"));
        const existingCard = { uid: scanner, expiresAt: Date.now() + 300_000 };
        await collision.create(existingCard);
        try {
            forcedBytes = collisionBytes;
            await assert.rejects(issue(owner), { code: 6 });
        } finally {
            forcedBytes = undefined;
        }
        assert.deepEqual((await state(owner).get()).data(), previousState);
        assert.deepEqual((await tokenDoc(afterRace.token).get()).data(), previousCard);
        assert.deepEqual((await collision.get()).data(), existingCard);
        const senderDb = rules.authenticatedContext(scanner).firestore();
        const receiverDb = rules.authenticatedContext(owner).firestore();
        const guestDb = rules.unauthenticatedContext().firestore();
        await assertSucceeds(updateDoc(doc(receiverDb, "users", owner), { nij: "NIJ-PPP-ABE-002-2026" }));
        await allowScan();
        assert.deepEqual(await scan(afterRace.token), { ...member, nij: null });

        for (const client of [senderDb, receiverDb, guestDb]) {
            for (const path of [state(owner).path, tokenDoc(afterRace.token).path, "nij_allocations/" + owner]) {
                await assertFails(getDoc(doc(client, path)));
                await assertFails(setDoc(doc(client, path), { tokenHash: digest(second.token) }));
            }
        }
        // The configured legacy profile rule allows reads independently of QR lookup.
        assert.equal((await getDoc(doc(senderDb, "users", owner))).get("whatsapp"), "synthetic-phone");
        assert.equal((await getDoc(doc(guestDb, "users", owner))).get("alamat"), "synthetic-address");
        await assertFails(updateDoc(doc(senderDb, "users", owner), { status_akun: "Pending" }));
        const pair = [scanner, member.uid].sort().join("_");
        const requestPath = "friend_requests/" + pair;
        const senderContact = "contacts/" + scanner + "/friends/" + member.uid;
        const receiverContact = "contacts/" + member.uid + "/friends/" + scanner;
        const contact = (uid) => ({ friendUid: uid, displayName: uid, photoURL: "", status: "accepted", requestId: pair, createdAt: serverTimestamp() });
        assert.equal((await getDoc(doc(senderDb, senderContact))).exists(), false);
        await assertSucceeds(setDoc(doc(senderDb, requestPath), {
            fromUid: scanner, toUid: member.uid, status: "pending",
            createdAt: serverTimestamp(), updatedAt: serverTimestamp(), fromDisplayName: scanner, fromPhotoURL: ""
        }));
        await assertFails(updateDoc(doc(senderDb, requestPath), { status: "accepted", updatedAt: serverTimestamp() }));
        await assertFails(setDoc(doc(senderDb, senderContact), contact(owner)));
        const accept = writeBatch(receiverDb);
        accept.update(doc(receiverDb, requestPath), { status: "accepted", updatedAt: serverTimestamp() });
        accept.set(doc(receiverDb, senderContact), contact(owner));
        accept.set(doc(receiverDb, receiverContact), contact(scanner));
        await assertSucceeds(accept.commit());
        assert.equal((await getDoc(doc(senderDb, senderContact))).get("status"), "accepted");
        await assertFails(getDoc(doc(senderDb, receiverContact)));

        // Record the current firebase.json rule behavior for both existing chat entry points.
        await assertFails(getDoc(doc(senderDb, "mutual_chats", pair)));
        await assertFails(getDoc(doc(senderDb, "sipapua_group_rooms", "official-general")));
    } finally {
        await rules.cleanup();
        await db.terminate();
        await deleteApp(app);
    }
});
