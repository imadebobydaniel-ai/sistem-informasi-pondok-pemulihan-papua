"use strict";

// Local candidate. This module has no entry in functions/index.js.
const { createHash, randomBytes } = require("node:crypto");
const { createRequire } = require("node:module");
const { resolve } = require("node:path");
const requireFunctionDependency = createRequire(resolve(__dirname, "../../functions/package.json"));
const { HttpsError, onCall } = requireFunctionDependency("firebase-functions/v2/https");
const { FieldValue } = requireFunctionDependency("firebase-admin/firestore");

const options = { region: "asia-southeast2", enforceAppCheck: true };
const tokenPattern = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const digest = value => createHash("sha256").update(value).digest("hex");
const deny = () => { throw new HttpsError("permission-denied", "QR introduction unavailable."); };

function caller(request) {
    if (!request.auth?.uid || !request.app ||
        request.auth.token?.firebase?.sign_in_provider === "anonymous") {
        throw new HttpsError("unauthenticated", "Auth and App Check required.");
    }
    return request.auth.uid;
}

function suppliedSecret(data, field) {
    const value = data?.[field];
    if (Object.keys(data ?? {}).length !== 1 || typeof value !== "string" ||
        value.length !== 43 || !tokenPattern.test(value)) {
        throw new HttpsError("invalid-argument", "Invalid QR introduction proof.");
    }
    return value;
}

function createQrFriendReceiptCandidate(db, auth) {
    async function enabled(uid) {
        try {
            return !(await auth.getUser(uid)).disabled;
        } catch (error) {
            if (error.code === "auth/user-not-found") return false;
            throw error;
        }
    }

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
                tx.get(db.doc("users/" + scanner)),
                tx.get(db.doc("users/" + target)),
                tx.get(db.doc("qr_friend_preferences/" + target)),
                tx.get(db.doc("user_blocks/" + scanner + "/blocked/" + target)),
                tx.get(db.doc("user_blocks/" + target + "/blocked/" + scanner)),
                tx.get(pair),
                tx.get(db.doc("contacts/" + scanner + "/friends/" + target)),
                tx.get(db.doc("contacts/" + target + "/friends/" + scanner)),
                tx.get(db.doc("presence/" + scanner))
            ]);
        const active = (profile, uid) => {
            const linkedUid = profile.get("uid");
            return profile.get("status_akun") === "Aktif" &&
                (linkedUid == null || linkedUid === "" || linkedUid === uid);
        };
        if (!active(sender, scanner) || !active(recipient, target) ||
            preference.get("allowQrIntroductions") !== true || senderBlock.exists || recipientBlock.exists ||
            existing.exists || senderContact.exists || recipientContact.exists || !presence.exists) deny();
        const accounts = await Promise.all([enabled(scanner), enabled(target)]);
        if (accounts.includes(false)) deny();
        const displayName = presence.get("displayName");
        const photoURL = presence.get("photoURL");
        if (typeof displayName !== "string" || displayName.length > 100 ||
            typeof photoURL !== "string" || photoURL.length > 2048) deny();
        return { pair, displayName, photoURL };
    }

    const mint = onCall(options, async request => {
        const scanner = caller(request);
        const cardHash = digest(suppliedSecret(request.data, "token"));
        const receipt = randomBytes(32).toString("base64url");
        return db.runTransaction(async tx => {
            const card = await readCard(tx, cardHash);
            await introduction(tx, scanner, card.uid);
            const now = Date.now();
            if (card.expiresAt <= now) deny();
            const expiresAt = Math.min(card.expiresAt, now + 60_000);
            tx.create(db.doc("qr_friend_receipts/" + digest(receipt)), {
                scanner, target: card.uid, cardHash, expiresAt
            });
            return { receipt, expiresAt };
        });
    });

    const redeem = onCall(options, async request => {
        const scanner = caller(request);
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

    return { mint, redeem };
}

module.exports = { createQrFriendReceiptCandidate };
