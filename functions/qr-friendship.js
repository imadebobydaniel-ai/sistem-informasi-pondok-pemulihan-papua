"use strict";

const { createHash, randomBytes } = require("node:crypto");
const { HttpsError, onCall } = require("firebase-functions/v2/https");
const { FieldValue } = require("firebase-admin/firestore");
const { lookupMemberCard, memberCardIdentity } = require("./member-card");
const { callerUid, activeProfile, enabledAccount } = memberCardIdentity;

const options = { region: "asia-southeast2", enforceAppCheck: true };
const tokenPattern = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const digest = value => createHash("sha256").update(value).digest("hex");
const deny = () => { throw new HttpsError("permission-denied", "QR introduction unavailable."); };

function suppliedSecret(data, field) {
    const value = data?.[field];
    if (Object.keys(data ?? {}).length !== 1 || typeof value !== "string" ||
        value.length !== 43 || !tokenPattern.test(value)) {
        throw new HttpsError("invalid-argument", "Invalid QR introduction proof.");
    }
    return value;
}

function createQrFriendship(db) {
    async function readCard(tx, hash) {
        const card = (await tx.get(db.collection("member_card_tokens").doc(hash))).data();
        if (!card?.uid || !Number.isFinite(card.expiresAt) || card.expiresAt <= Date.now()) deny();
        const pointer = await tx.get(db.collection("member_card_state").doc(card.uid));
        if (pointer.get("tokenHash") !== hash) deny();
        return card;
    }

    async function introduction(tx, scanner, target) {
        if (target === scanner) deny();
        const pairId = [scanner, target].sort().join("_");
        const pair = db.doc("friend_requests/" + pairId);
        const [sender, recipient, preference, senderBlock, recipientBlock, existing, senderContact, recipientContact, presence] =
            await Promise.all([
                activeProfile(tx, db, scanner),
                activeProfile(tx, db, target),
                tx.get(db.doc("qr_friend_preferences/" + target)),
                tx.get(db.doc("user_blocks/" + scanner + "/blocked/" + target)),
                tx.get(db.doc("user_blocks/" + target + "/blocked/" + scanner)),
                tx.get(pair),
                tx.get(db.doc("contacts/" + scanner + "/friends/" + target)),
                tx.get(db.doc("contacts/" + target + "/friends/" + scanner)),
                tx.get(db.doc("presence/" + scanner))
            ]);
        if (!sender || !recipient ||
            preference.get("allowQrIntroductions") !== true || senderBlock.exists || recipientBlock.exists ||
            existing.exists || senderContact.exists || recipientContact.exists || !presence.exists) deny();
        const accounts = await Promise.all([enabledAccount(scanner), enabledAccount(target)]);
        if (accounts.includes(false)) deny();
        const displayName = presence.get("displayName");
        const photoURL = presence.get("photoURL");
        if (typeof displayName !== "string" || displayName.length > 100 ||
            typeof photoURL !== "string" || photoURL.length > 2048) deny();
        return { pair, displayName, photoURL };
    }

    const scanQrIntroduction = onCall(options, async request => {
        const member = await lookupMemberCard.run(request);
        if (!member.found) deny();
        const scanner = request.auth.uid;
        const cardHash = digest(request.data.token);
        const receipt = randomBytes(32).toString("base64url");
        return db.runTransaction(async tx => {
            const card = await readCard(tx, cardHash);
            if (card.uid !== member.uid) deny();
            await introduction(tx, scanner, card.uid);
            const now = Date.now();
            if (card.expiresAt <= now) deny();
            const expiresAt = Math.min(card.expiresAt, now + 60_000);
            tx.create(db.doc("qr_friend_receipts/" + digest(receipt)), {
                scanner, target: card.uid, cardHash, expiresAt
            });
            return { receipt, expiresAt, member: { nama: member.nama, nij: member.nij } };
        });
    });

    const requestQrIntroduction = onCall(options, async request => {
        const scanner = await callerUid(request);
        const reference = db.doc("qr_friend_receipts/" + digest(suppliedSecret(request.data, "receipt")));
        return db.runTransaction(async tx => {
            const proof = (await tx.get(reference)).data();
            if (!proof || proof.scanner !== scanner || proof.expiresAt <= Date.now()) deny();
            const card = await readCard(tx, proof.cardHash);
            if (card.uid !== proof.target) deny();
            const { pair, displayName, photoURL } = await introduction(tx, scanner, proof.target);
            if (Math.min(proof.expiresAt, card.expiresAt) <= Date.now()) deny();
            const now = FieldValue.serverTimestamp();
            tx.create(pair, {
                fromUid: scanner, toUid: proof.target, status: "pending",
                createdAt: now, updatedAt: now, fromDisplayName: displayName, fromPhotoURL: photoURL
            });
            tx.delete(reference);
            return { status: "pending" };
        });
    });

    return { scanQrIntroduction, requestQrIntroduction };
}

module.exports = { createQrFriendship };
