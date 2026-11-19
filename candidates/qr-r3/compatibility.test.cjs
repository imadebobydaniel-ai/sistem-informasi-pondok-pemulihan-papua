"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { initializeTestEnvironment, assertFails, assertSucceeds } = require("@firebase/rules-unit-testing");
const { collection, doc, getDoc, getDocs, query, setDoc, updateDoc, where } = require("firebase/firestore");

const projectId = "demo-sipapua-qr-r3";
const authHost = "127.0.0.1:29099";
const firestorePort = 28080;
const hubHost = "127.0.0.1:24400";
const email = label => label + "@example.invalid";
const password = "synthetic-r3-password";
const context = (uid, data = {}) => ({ auth: { uid }, app: { appId: "synthetic" }, data });

function input(uid, address, digits) {
    return {
        uid, nama: "Synthetic Member", email: address, email_normalized: address,
        whatsapp: "0" + digits, whatsapp_normalized: "62" + digits, wilayah: "Abepura",
        status_akun: "Menunggu Verifikasi", provinsi: "Fixture", kabupaten_kota: "Fixture",
        kecamatan: "Fixture", desa_kelurahan: "Fixture", alamat_detail: "Synthetic private address",
        provinsi_lahir: "Fixture", kota_lahir: "Fixture", kecamatan_lahir: "Fixture", desa_lahir: "Fixture",
        tgl_lahir: "2000-01-01", jenis_kelamin: "Perempuan", status_pernikahan: "Single", pekerjaan: "Fixture",
        komsel: "Fixture", jabatan: "Anggota Jemaat", sub_jabatan: "Jemaat Simpatisan",
        pelayanan: "", detail_pelayanan: "", jumlah_anak: 0, anak: []
    };
}

test("registration and login compatibility against unchanged R2 privacy rules", async t => {
    assert.equal(process.env.GCLOUD_PROJECT, projectId);
    assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, authHost);
    assert.equal(process.env.FIRESTORE_EMULATOR_HOST, "127.0.0.1:" + firestorePort);
    assert.equal(process.env.FIREBASE_EMULATOR_HUB, hubHost);
    for (const key of ["GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_TOKEN", "GOOGLE_OAUTH_ACCESS_TOKEN"]) {
        assert.equal(process.env[key], undefined, key);
    }
    const hub = await (await fetch("http://" + hubHost + "/emulators")).json();
    assert.equal(hub.auth.host + ":" + hub.auth.port, authHost);
    assert.equal(hub.firestore.host + ":" + hub.firestore.port, "127.0.0.1:" + firestorePort);
    assert.equal(hub.functions, undefined);

    const dependencies = createRequire(resolve(__dirname, "../../functions/package.json"));
    const appModule = dependencies("firebase-admin/app");
    const app = appModule.initializeApp({ projectId });
    const db = dependencies("firebase-admin/firestore").getFirestore();
    const auth = dependencies("firebase-admin/auth").getAuth();
    const rules = readFileSync(resolve(__dirname, "../qr-r2/firestore.candidate.rules"), "utf8");
    let environment;
    t.after(async () => {
        if (environment) await environment.cleanup();
        await db.terminate();
        await appModule.deleteApp(app);
    });
    environment = await initializeTestEnvironment({
        projectId, firestore: { host: "127.0.0.1", port: firestorePort, rules }
    });
    const registration = require("../../functions/registration-paket-a");
    const { createMemberAccess } = require("./member-access.cjs");
    const access = createMemberAccess(db, auth);
    const profile = uid => db.doc("users/" + uid);
    const allocation = uid => db.doc("nij_allocations/" + uid);
    const counter = db.doc("nij_counters/Abepura");
    const control = db.doc("registration_control/state");
    const register = (uid, data) => registration.registerSIPAPUAProfile.run(context(uid, { code: "ABE", input: data }));
    const activate = uid => registration.activateVerifiedSIPAPUAProfile.run(context(uid));
    const lookup = uid => access.run(context(uid));
    const client = (uid, address) => environment.authenticatedContext(uid, {
        email: address, email_verified: true, firebase: { sign_in_provider: "password" }
    }).firestore();
    const sign = (operation, address) => fetch("http://" + authHost +
        "/identitytoolkit.googleapis.com/v1/accounts:" + operation + "?key=demo-key", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: address, password, returnSecureToken: true })
    });
    const address = email("r3-new");
    const phone = "81100000301";
    let uid, issuedNij;

    await t.test("Auth signup, registry HOLD, and direct Spark access boundaries", async () => {
        const signUp = await sign("signUp", address);
        assert.equal(signUp.status, 200);
        const account = await signUp.json();
        uid = account.localId;
        assert.ok(uid && account.idToken);
        assert.equal((await profile(uid).get()).exists, false);
        const duplicate = await sign("signUp", address.toUpperCase());
        assert.equal(duplicate.status, 400);
        assert.equal((await duplicate.json()).error.message, "EMAIL_EXISTS");
        const resumed = await sign("signInWithPassword", address);
        assert.equal((await resumed.json()).localId, uid);
        const own = client(uid, address);
        assert.equal((await assertSucceeds(getDoc(doc(own, "users", uid)))).exists(), false);
        for (const path of [control.path, counter.path, allocation(uid).path,
            "registration_unique/email_" + address, "registration_unique/phone_62" + phone]) {
            await assertFails(getDoc(doc(own, path)));
        }
        await assertFails(setDoc(doc(own, allocation(uid).path), { uid, nij: "forged" }));
        await assertFails(setDoc(doc(own, "registration_unique/email_" + address), { uid }));
        await assertFails(getDocs(query(collection(own, "users"), where("email", "==", address))));
        await assert.rejects(register(uid, input(uid, address, phone)), { code: "failed-precondition" });
        await assert.rejects(registration.registerSIPAPUAProfile.run({ app: context(uid).app }), { code: "unauthenticated" });
    });

    await t.test("existing server transaction allocates one permanent NIJ and two unique reservations", async () => {
        // These synthetic fixtures exist in the demo process only.
        await control.set({ enabled: true, maintenance: false, version: "original-spark-v1" });
        await counter.set({ last: 0 });
        await assert.rejects(register(uid, { ...input(uid, address, phone), uid: "other-r3" }), { code: "invalid-argument" });
        const results = await Promise.allSettled([register(uid, input(uid, address, phone)), register(uid, input(uid, address, phone))]);
        const committed = results.filter(result => result.status === "fulfilled");
        assert.equal(committed.length, 1);
        assert.equal(results.find(result => result.status === "rejected").reason.code, "already-exists");
        issuedNij = committed[0].value.nij;
        assert.match(issuedNij, /^NIJ-PPP-ABE-001-[0-9]{4}$/);
        assert.equal((await allocation(uid).get()).get("nij"), issuedNij);
        assert.equal((await profile(uid).get()).get("nij"), issuedNij);
        assert.equal((await profile(uid).get()).get("status_akun"), "Menunggu Verifikasi");
        assert.equal((await db.doc("registration_unique/email_" + address).get()).get("uid"), uid);
        assert.equal((await db.doc("registration_unique/phone_62" + phone).get()).get("uid"), uid);

        for (const [label, number, orphanEmail] of [
            ["r3-duplicate-phone", phone, false], ["r3-reserved-email", "81100000302", true]
        ]) {
            const reservedAddress = email(label);
            const account = await auth.createUser({ uid: label, email: reservedAddress });
            if (orphanEmail) await db.doc("registration_unique/email_" + reservedAddress).set({ uid: "synthetic-prior-owner" });
            await assert.rejects(register(account.uid, input(account.uid, reservedAddress, number)), { code: "already-exists" });
            assert.equal((await profile(account.uid).get()).exists, false);
            assert.equal((await allocation(account.uid).get()).exists, false);
            const unwrittenClaim = orphanEmail ? "phone_62" + number : "email_" + reservedAddress;
            assert.equal((await db.doc("registration_unique/" + unwrittenClaim).get()).exists, false);
        }
        assert.equal((await counter.get()).get("last"), 1);
    });

    await t.test("verified activation and retries keep the NIJ and one activation audit", async () => {
        assert.deepEqual(await lookup(uid), { profileId: uid, active: false, emailVerified: false, legacy: false });
        await assert.rejects(activate(uid), { code: "failed-precondition" });
        const own = client(uid, address);
        await assertFails(updateDoc(doc(own, "users", uid), { status_akun: "Aktif" }));
        await assertFails(updateDoc(doc(own, "users", uid), { nij: "forged" }));
        await auth.updateUser(uid, { emailVerified: true });
        await profile(uid).update({ nij: "synthetic-mismatch" });
        await assert.rejects(activate(uid), { code: "failed-precondition" });
        await profile(uid).update({ nij: issuedNij });
        const reservation = db.doc("registration_unique/phone_62" + phone);
        await reservation.update({ uid: "synthetic-prior-owner" });
        await assert.rejects(activate(uid), { code: "failed-precondition" });
        await reservation.update({ uid });
        assert.deepEqual(await lookup(uid), { profileId: uid, active: false, emailVerified: true, legacy: false });
        assert.deepEqual(await activate(uid), { active: true });
        assert.deepEqual(await activate(uid), { active: true });
        assert.deepEqual(await lookup(uid), { profileId: uid, active: true, emailVerified: true, legacy: false });
        assert.equal((await db.collection("registration_audit").where("uid", "==", uid).get()).size, 1);
        assert.equal((await allocation(uid).get()).get("nij"), issuedNij);
        assert.equal((await counter.get()).get("last"), 1);
        await assertSucceeds(getDoc(doc(own, "users", uid)));
    });

    await t.test("verified legacy mapping succeeds, unknown or unbound accounts fail closed", async () => {
        const legacy = "r3-legacy";
        const legacyPath = "r3-legacy-document";
        const unbound = "r3-unbound";
        for (const id of [legacy, unbound, "r3-unknown", "r3-active-admin"]) {
            await auth.createUser({ uid: id, email: email(id), emailVerified: true });
        }
        await profile(legacyPath).set({ email: email(legacy), status_akun: "Aktif", whatsapp: "private-fixture" });
        await profile("r3-claimed-by-field").set({ uid: unbound, email: email(unbound), status_akun: "Aktif" });
        await db.doc("member_identity/" + legacy).set({ uid: legacy, profileId: legacyPath });
        await db.doc("admin_users/r3-active-admin").set({ role: "super_admin", status: "active" });
        assert.deepEqual(await lookup(legacy), { profileId: legacyPath, active: true, emailVerified: true, legacy: true });
        await assert.rejects(lookup(unbound), { code: "permission-denied" });
        await assert.rejects(lookup("r3-unknown"), { code: "permission-denied" });
        await assert.rejects(lookup("r3-no-auth-record"), { code: "permission-denied" });
        await assert.rejects(access.run(context(legacy, { uid })), { code: "invalid-argument" });
        await assert.rejects(access.run({ auth: { uid: legacy } }), { code: "unauthenticated" });
        await assert.rejects(access.run({ app: context(legacy).app }), { code: "unauthenticated" });
        const owner = client(legacy, email(legacy));
        await assertSucceeds(getDoc(doc(owner, "users", legacyPath)));
        await assertSucceeds(getDoc(doc(client("r3-active-admin"), "users", legacyPath)));
        await assertFails(getDoc(doc(client(unbound), "users", legacyPath)));
        await assertFails(getDoc(doc(environment.unauthenticatedContext().firestore(), "users", legacyPath)));
        await assertFails(getDocs(query(collection(owner, "users"), where("uid", "==", legacy))));
        await assertFails(setDoc(doc(client(unbound), "member_identity", unbound), { uid: unbound, profileId: legacyPath }));
        await auth.updateUser(legacy, { emailVerified: false });
        assert.equal((await lookup(legacy)).active, false);
        await auth.updateUser(legacy, { disabled: true });
        await assert.rejects(lookup(legacy), { code: "permission-denied" });
    });
});
