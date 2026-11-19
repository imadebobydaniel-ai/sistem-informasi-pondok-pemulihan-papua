"use strict";

const { before, after, test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const { resolve } = require("node:path");
const { initializeTestEnvironment, assertFails, assertSucceeds } = require("@firebase/rules-unit-testing");
const { doc, collection, getDoc, getDocs, query, where, setDoc, updateDoc,
    deleteDoc, writeBatch, serverTimestamp, Timestamp } = require("firebase/firestore");

const projectId = "demo-sipapua-qr-r2";
const sender = "qr_sender";
const recipient = "qr-recipient";
const stranger = "qr-stranger";
const moderator = "qr-moderator";
const inactiveModerator = "qr-inactive-mod";
const legacy = "qr-legacy";
const registrant = "qr-registrant";
const pending = "qr-pending";
const privateNij = "NIJ-PPP-ABE-987654321-2099";
const pair = [sender, recipient].sort().join("_");
const requestPath = "friend_requests/" + pair;
const room = "sipapua_group_rooms/official-general";
const thread = "mutual_chats/" + pair;
const digest = value => createHash("sha256").update(value).digest("hex");
const context = (uid, data) => ({ auth: { uid }, app: { appId: "synthetic" }, data });
let environment, app, db, auth, mint, redeem, issueCard, lookupCard, card;

const client = (uid, verified = true) => environment.authenticatedContext(uid, {
    email_verified: verified, firebase: { sign_in_provider: "password" }
}).firestore();
const guest = () => environment.unauthenticatedContext().firestore();
const adminSet = (path, data) => db.doc(path).set(data);

before(async () => {
    assert.equal(process.env.GCLOUD_PROJECT, projectId);
    assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, "127.0.0.1:19099");
    assert.equal(process.env.FIRESTORE_EMULATOR_HOST, "127.0.0.1:18080");
    assert.equal(process.env.FIREBASE_EMULATOR_HUB, "127.0.0.1:14400");
    for (const key of ["GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_TOKEN", "GOOGLE_OAUTH_ACCESS_TOKEN"]) {
        assert.equal(process.env[key], undefined, key);
    }
    const hub = await (await fetch("http://127.0.0.1:14400/emulators")).json();
    assert.equal(hub.auth.host, "127.0.0.1");
    assert.equal(hub.auth.port, 19099);
    assert.equal(hub.firestore.host, "127.0.0.1");
    assert.equal(hub.firestore.port, 18080);
    assert.equal(hub.functions, undefined);
    const dependency = createRequire(resolve(__dirname, "../../functions/package.json"));
    app = dependency("firebase-admin/app").initializeApp({ projectId });
    auth = dependency("firebase-admin/auth").getAuth();
    const firestore = dependency("firebase-admin/firestore");
    db = firestore.getFirestore();
    environment = await initializeTestEnvironment({ projectId, firestore: { host: "127.0.0.1", port: 18080 } });
    ({ mint, redeem } = require("./qr-friend-receipts.cjs").createQrFriendReceiptCandidate(db, auth));
    const qr = require("../../functions/member-card");
    issueCard = uid => qr.getMyCardToken.run(context(uid, {}));
    lookupCard = (uid, token) => qr.lookupMemberCard.run(context(uid, { token }));
    for (const uid of [sender, recipient, stranger, moderator, inactiveModerator, legacy, registrant, pending]) {
        await auth.createUser({ uid, email: uid + "@example.invalid", emailVerified: true, password: "synthetic-password" });
    }
    for (const uid of [sender, recipient, stranger, pending]) {
        await adminSet("users/" + uid, { uid, nama: uid, status_akun: uid === pending ? "Pending" : "Aktif",
            email: uid + "@example.invalid", whatsapp: "synthetic-phone", alamat: "synthetic-address" });
        await adminSet("presence/" + uid, { displayName: uid, photoURL: "", discoverable: false, showOnline: false });
    }
    await db.doc("users/" + recipient).update({ nij: privateNij });
    await adminSet("nij_allocations/" + recipient, { uid: recipient, nij: privateNij, nij_number: 987654321 });
    await adminSet("users/legacy-document", { uid: legacy, status_akun: "Aktif", nama: "Legacy" });
    await adminSet("users/other-legacy-document", { status_akun: "Aktif", nama: "Unbound" });
    await adminSet("member_identity/" + legacy, { uid: legacy, profileId: "legacy-document" });
    await adminSet("admin_users/" + moderator, { role: "super_admin", status: "active" });
    await adminSet("admin_users/" + inactiveModerator, { role: "super_admin", status: "inactive" });
    await adminSet(room, { name: "Synthetic official room" });
    await adminSet("sipapua_group_rooms/other-room", { name: "Synthetic other room" });
    card = await issueCard(recipient);
});

after(async () => {
    if (environment) await environment.cleanup();
    if (db) await db.terminate();
    if (app) await createRequire(resolve(__dirname, "../../functions/package.json"))("firebase-admin/app").deleteApp(app);
});

test("profile privacy, owner edits, administrator access and protected legacy bindings", async () => {
    const own = client(sender);
    const profile = doc(own, "users", sender);
    await assertSucceeds(getDoc(profile));
    await assertSucceeds(updateDoc(profile, { nama: "Updated label" }));
    for (const value of [{ uid: stranger }, { nij: privateNij }, { nij_number: 12 }, { status_akun: "Pending" }]) {
        await assertFails(updateDoc(profile, value));
    }
    await assertFails(getDoc(doc(own, "users", recipient)));
    await assertFails(getDoc(doc(guest(), "users", sender)));
    await adminSet("users/" + sender + "/private/fixture", { secret: true });
    await assertSucceeds(getDoc(doc(own, "users", sender, "private", "fixture")));
    await assertFails(getDoc(doc(client(stranger), "users", sender, "private", "fixture")));
    await assertFails(getDoc(doc(guest(), "users", sender, "private", "fixture")));
    const admin = client(moderator);
    await assertSucceeds(getDocs(collection(admin, "users")));
    await assertSucceeds(updateDoc(doc(admin, "users", sender), { nama: sender }));
    await assertFails(getDoc(doc(client(inactiveModerator), "users", sender)));
    const linked = client(legacy);
    await assertSucceeds(getDoc(doc(linked, "users", "legacy-document")));
    await assertFails(getDoc(doc(linked, "users", "other-legacy-document")));
    await assertFails(updateDoc(doc(linked, "users", "legacy-document"), { uid: stranger }));
    await assertFails(setDoc(doc(linked, "member_identity", legacy), { uid: legacy, profileId: sender }));
    await assertFails(getDocs(query(collection(linked, "users"), where("uid", "==", legacy))));
    await assertFails(getDocs(query(collection(own, "users"), where("email", "==", sender + "@example.invalid"))));
});

test("local Auth sign-in and canonical registration primitives; broad and Spark paths denied", async () => {
    const response = await fetch("http://127.0.0.1:19099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: registrant + "@example.invalid", password: "synthetic-password", returnSecureToken: true })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).localId, registrant);
    const signedIn = client(registrant);
    const own = doc(signedIn, "users", registrant);
    assert.equal((await assertSucceeds(getDoc(own))).exists(), false);
    const initial = { uid: registrant, status_akun: "Menunggu Verifikasi" };
    await assertFails(setDoc(own, { ...initial, status_akun: "Aktif" }));
    await assertFails(setDoc(own, { ...initial, uid: sender }));
    await assertFails(setDoc(own, { ...initial, nij: privateNij, nij_number: 987654321 }));
    await assertFails(setDoc(doc(signedIn, "nij_allocations", registrant), { uid: registrant, nij: privateNij }));
    // An allocation from a trusted issuer is visible to Rules, even though clients cannot write it.
    const allocated = { uid: registrant, nij: "NIJ-PPP-DYO-987654320-2099", nij_number: 987654320 };
    await adminSet("nij_allocations/" + registrant, allocated);
    await assertSucceeds(setDoc(own, { ...initial, ...allocated }));
    await assertSucceeds(getDoc(own));
    await assertFails(getDocs(query(collection(signedIn, "users"), where("email", "==", "synthetic@example.invalid"))));
    await assertFails(getDoc(doc(signedIn, "registration_control", "state")));
});

test("QR R1 under candidate Rules: protected allocation, minimal response and legacy fail-closed", async () => {
    assert.equal(card.profile.nij, privateNij);
    assert.deepEqual(await lookupCard(sender, card.token), { found: true, uid: recipient, nij: privateNij, nama: recipient });
    await assert.rejects(issueCard(legacy), { code: "permission-denied" });
    await assert.rejects(issueCard(pending), { code: "permission-denied" });
    const unallocated = await issueCard(stranger);
    assert.equal(unallocated.profile.nij, null);
    assert.deepEqual(await lookupCard(recipient, unallocated.token),
        { found: true, uid: stranger, nij: null, nama: stranger });
    await assert.rejects(lookupCard(sender, "legacy@example.invalid"), { code: "invalid-argument" });
    await assertFails(getDoc(doc(client(sender), "member_card_tokens", digest(card.token))));
    await assertFails(getDoc(doc(client(recipient), "nij_allocations", recipient)));
});

test("QR receipts enforce Auth, App Check, opt-in, binding, expiry, blocks, replay and recipient consent", async () => {
    const make = (uid = sender) => mint.run(context(uid, { token: card.token }));
    const use = (receipt, uid = sender) => redeem.run(context(uid, { receipt }));
    for (const callable of [mint, redeem]) {
        await assert.rejects(callable.run({ app: { appId: "synthetic" } }), { code: "unauthenticated" });
        await assert.rejects(callable.run({ auth: { uid: sender } }), { code: "unauthenticated" });
    }
    await assert.rejects(make(), { code: "permission-denied" });
    await assertFails(setDoc(doc(client(recipient), "qr_friend_preferences", recipient), { allowQrIntroductions: true }));
    await adminSet("qr_friend_preferences/" + recipient, { allowQrIntroductions: true });
    await assert.rejects(make(recipient), { code: "permission-denied" });
    await assert.rejects(make(pending), { code: "permission-denied" });

    const senderDb = client(sender);
    const recipientDb = client(recipient);
    const direct = { fromUid: sender, toUid: recipient, status: "pending",
        fromDisplayName: sender, fromPhotoURL: "", createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
    await assertFails(setDoc(doc(senderDb, requestPath), direct));
    const expired = await make();
    assert.ok(expired.expiresAt <= Date.now() + 60_000);
    await assertFails(getDoc(doc(senderDb, "qr_friend_receipts", digest(expired.receipt))));
    await db.doc("qr_friend_receipts/" + digest(expired.receipt)).update({ expiresAt: Date.now() - 1 });
    await assert.rejects(use(expired.receipt), { code: "permission-denied" });

    const proof = await make();
    await assert.rejects(use(proof.receipt, stranger), { code: "permission-denied" });
    await assert.rejects(redeem.run(context(sender, { receipt: proof.receipt, target: stranger })), { code: "invalid-argument" });
    const blocks = [
        "user_blocks/" + recipient + "/blocked/" + sender,
        "user_blocks/" + sender + "/blocked/" + recipient
    ];
    for (const blockPath of blocks) {
        await adminSet(blockPath, { blocked: true });
        await assert.rejects(use(proof.receipt), { code: "permission-denied" });
        await assert.rejects(make(), { code: "permission-denied" });
        await db.doc(blockPath).delete();
    }
    await db.doc("qr_friend_preferences/" + recipient).update({ allowQrIntroductions: false });
    await assert.rejects(use(proof.receipt), { code: "permission-denied" });
    await db.doc("qr_friend_preferences/" + recipient).update({ allowQrIntroductions: true });
    await auth.updateUser(recipient, { disabled: true });
    await assert.rejects(use(proof.receipt), { code: "permission-denied" });
    await auth.updateUser(recipient, { disabled: false });

    const simultaneous = await Promise.allSettled([use(proof.receipt), use(proof.receipt)]);
    assert.equal(simultaneous.filter(outcome => outcome.status === "fulfilled").length, 1);
    assert.equal(simultaneous.find(outcome => outcome.status === "rejected").reason.code, "permission-denied");
    assert.equal((await getDoc(doc(recipientDb, requestPath))).get("status"), "pending");
    await assert.rejects(make(), { code: "permission-denied" });
    const senderContact = "contacts/" + sender + "/friends/" + recipient;
    const recipientContact = "contacts/" + recipient + "/friends/" + sender;
    assert.equal((await getDoc(doc(senderDb, senderContact))).exists(), false);
    await assertFails(updateDoc(doc(senderDb, requestPath), { status: "accepted", updatedAt: serverTimestamp() }));
    const accept = writeBatch(recipientDb);
    accept.update(doc(recipientDb, requestPath), { status: "accepted", updatedAt: serverTimestamp() });
    for (const [path, uid] of [[senderContact, recipient], [recipientContact, sender]]) {
        accept.set(doc(recipientDb, path), { friendUid: uid, requestId: pair, status: "accepted",
            displayName: uid, photoURL: "", createdAt: serverTimestamp() });
    }
    await assertSucceeds(accept.commit());
    assert.equal((await getDoc(doc(senderDb, senderContact))).get("status"), "accepted");
    await assert.rejects(make(), { code: "permission-denied" });
});

test("personal chat binds the accepted request and reciprocal contacts to each participant", async () => {
    // Set up an independent accepted fixture compatible with the existing UI schema.
    await db.doc(requestPath).set({ fromUid: sender, toUid: recipient, status: "accepted" });
    const senderContact = "contacts/" + sender + "/friends/" + recipient;
    const recipientContact = "contacts/" + recipient + "/friends/" + sender;
    await adminSet(senderContact, { friendUid: recipient, requestId: pair, status: "accepted" });
    await adminSet(recipientContact, { friendUid: sender, requestId: pair, status: "accepted" });
    const alice = client(sender);
    const bob = client(recipient);
    const outsider = client(stranger);
    const members = [sender, recipient].sort();
    const one = thread + "/messages/first";
    const batch = writeBatch(alice);
    batch.set(doc(alice, thread), { members, createdAt: serverTimestamp(), lastMessageAt: serverTimestamp() });
    batch.set(doc(alice, one), { senderUid: sender, text: "Synthetic message", createdAt: serverTimestamp() });
    await assertSucceeds(getDoc(doc(alice, thread)));
    await assertSucceeds(batch.commit());
    await assertSucceeds(getDocs(collection(bob, thread, "messages")));
    await assertFails(getDoc(doc(outsider, thread)));
    await assertFails(getDocs(collection(outsider, thread, "messages")));
    await assertFails(getDoc(doc(guest(), one)));
    await assertFails(getDocs(collection(alice, "mutual_chats")));
    await assertFails(setDoc(doc(bob, thread, "messages", "spoofed"), { senderUid: sender, text: "Spoof", createdAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(alice, one), { text: "Modified" }));
    await assertFails(updateDoc(doc(alice, thread), { members: [sender, stranger] }));
    await assertFails(deleteDoc(doc(alice, one)));
    await assertFails(deleteDoc(doc(alice, thread)));
    await adminSet("mutual_chats/unbound", { members });
    await assertFails(getDoc(doc(alice, "mutual_chats/unbound")));
    await db.doc(recipientContact).delete();
    await assertFails(getDoc(doc(alice, one)));
    await adminSet(recipientContact, { friendUid: sender, requestId: pair, status: "accepted" });
    await adminSet("user_blocks/" + recipient + "/blocked/" + sender, { blocked: true });
    await assertFails(getDoc(doc(alice, one)));
    await assertFails(getDoc(doc(bob, one)));
});

test("official group authorizes eligible members, rate limits and scoped moderation batches", async () => {
    const member = client(sender);
    const admin = client(moderator);
    const inactive = client(inactiveModerator);
    const ratePath = room + "/rate_limits/" + sender;
    const messagePath = id => room + "/messages/" + id;
    const record = (uid = sender) => ({ senderUid: uid, senderName: sender, senderPhotoURL: "",
        text: "Synthetic group message", createdAt: serverTimestamp(), hidden: false });
    const send = (id, recent = [], uid = sender) => {
        const batch = writeBatch(member);
        batch.set(doc(member, messagePath(id)), record(uid));
        batch.set(doc(member, ratePath), { lastSentAt: serverTimestamp(), lastMessageId: id, recent });
        return batch.commit();
    };
    await assertSucceeds(getDoc(doc(member, room)));
    await assertSucceeds(getDoc(doc(admin, room)));
    await assertFails(getDoc(doc(inactive, room)));
    await assertFails(getDoc(doc(guest(), room)));
    await assertFails(getDoc(doc(client(pending), room)));
    await assertFails(getDoc(doc(client(sender, false), room)));
    await assertFails(getDoc(doc(member, "sipapua_group_rooms/other-room")));
    await assertFails(getDoc(doc(admin, "sipapua_group_rooms/other-room")));
    await assertFails(setDoc(doc(member, "sipapua_group_rooms/other-room/messages/cross-room"), record()));
    await assertFails(setDoc(doc(admin, "sipapua_group_rooms/new-room"), { name: "Unauthorized" }));
    await assertFails(setDoc(doc(member, messagePath("without-rate")), record()));
    await assertFails(send("spoofed", [], recipient));
    await assertSucceeds(send("visible"));
    const firstSend = (await db.doc(ratePath).get()).get("lastSentAt");
    await assertFails(send("too-fast", [new Timestamp(firstSend.seconds, firstSend.nanoseconds)]));
    const sixSecondsAgo = Timestamp.fromMillis(Date.now() - 6_000);
    for (const [windowName, number, start] of [["hour", 59, 30 * 60_000], ["day", 199, 12 * 60 * 60_000]]) {
        const recent = Array.from({ length: number }, (_, i) => Timestamp.fromMillis(Date.now() - start + i * 1000));
        await adminSet(ratePath, { lastSentAt: sixSecondsAgo.toDate(), lastMessageId: "visible",
            recent: recent.map(timestamp => timestamp.toDate()) });
        await assertFails(send("over-" + windowName, [...recent, sixSecondsAgo]));
    }
    await adminSet(ratePath, { lastSentAt: sixSecondsAgo.toDate(), lastMessageId: "visible", recent: [] });
    await assertSucceeds(send("after-window", [sixSecondsAgo]));
    await assertSucceeds(getDocs(query(collection(member, room, "messages"), where("hidden", "==", false))));
    await assertFails(getDocs(collection(member, room, "messages")));
    const fields = { hidden: true, moderatedBy: moderator, moderatedAt: serverTimestamp(), moderationLogId: "hide-fixture" };
    await assertFails(updateDoc(doc(admin, messagePath("visible")), fields));
    await assertFails(updateDoc(doc(member, messagePath("visible")), { text: "Changed" }));
    await assertFails(deleteDoc(doc(admin, messagePath("visible"))));
    const moderation = writeBatch(admin);
    moderation.update(doc(admin, messagePath("visible")), fields);
    moderation.set(doc(admin, room, "moderation_log", "hide-fixture"), {
        action: "hide", messageId: "visible", moderatorUid: moderator, createdAt: serverTimestamp()
    });
    await assertSucceeds(moderation.commit());
    await assertSucceeds(getDoc(doc(admin, messagePath("visible"))));
    await assertFails(getDoc(doc(member, messagePath("visible"))));
    await assertFails(getDoc(doc(member, room, "moderation_log", "hide-fixture")));
    await assertFails(updateDoc(doc(admin, messagePath("after-window")), fields));
});
