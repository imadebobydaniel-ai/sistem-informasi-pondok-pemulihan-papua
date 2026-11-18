"use strict";

const { createHash, randomBytes } = require("node:crypto");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const { HttpsError, onCall } = require("firebase-functions/v2/https");

const options = { region: "asia-southeast2", enforceAppCheck: true };
const tokenPattern = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const nijPattern = /^NIJ-PPP-(ABE|STN|DYO|ARS1|ARS2)-[0-9]{3,9}-[0-9]{4}$/;
const lifetime = 5 * 60 * 1000;
const hash = token => createHash("sha256").update(token).digest("hex");

async function enabledAccount(uid) {
    try {
        return !(await getAuth().getUser(uid)).disabled;
    } catch (error) {
        if (error.code === "auth/user-not-found") return false;
        throw error;
    }
}

async function callerUid(request) {
    if (!request.auth?.uid || request.auth.token?.firebase?.sign_in_provider === "anonymous") {
        throw new HttpsError("unauthenticated", "Silakan masuk dengan akun SIPAPUA.");
    }
    if (!request.app) throw new HttpsError("unauthenticated", "App Check diperlukan.");
    if (!(await enabledAccount(request.auth.uid))) {
        throw new HttpsError("permission-denied", "Akun tidak aktif.");
    }
    return request.auth.uid;
}

async function activeProfile(tx, db, uid) {
    const canonical = await tx.get(db.collection("users").doc(uid));
    const profile = canonical.data();
    // The document path binds the profile to Auth. The writable uid field
    // cannot establish ownership of a noncanonical profile.
    if (profile?.status_akun !== "Aktif") return null;
    if (profile.uid != null && profile.uid !== "" && profile.uid !== uid) return null;
    return profile;
}

async function verifiedNij(tx, db, uid, profile) {
    const allocation = (await tx.get(db.collection("nij_allocations").doc(uid))).data();
    if (allocation?.uid !== uid || typeof allocation.nij !== "string" ||
        allocation.nij !== profile.nij || !nijPattern.test(allocation.nij)) return null;
    return allocation.nij;
}

function requireActive(profile) {
    if (!profile) throw new HttpsError("permission-denied", "Keanggotaan belum aktif.");
}

function checkCooldown(last, now, interval) {
    if (typeof last === "number" && now - last < interval) {
        throw new HttpsError("resource-exhausted", "Tunggu sebentar lalu coba kembali.");
    }
}

const text = value => typeof value === "string" ? value : "";

exports.getMyCardToken = onCall(options, async request => {
    const uid = await callerUid(request);
    if (request.data != null && (typeof request.data !== "object" ||
        Array.isArray(request.data) || Object.keys(request.data).length !== 0)) {
        throw new HttpsError("invalid-argument", "Permintaan QR tidak valid.");
    }
    const db = getFirestore();
    const state = db.collection("member_card_state").doc(uid);
    const tokens = db.collection("member_card_tokens");
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hash(token);

    return db.runTransaction(async tx => {
        const current = await tx.get(state);
        const profile = await activeProfile(tx, db, uid);
        requireActive(profile);
        const nij = await verifiedNij(tx, db, uid, profile);
        const now = Date.now();
        checkCooldown(current.get("issuedAt"), now, 15_000);

        const expiresAt = now + lifetime;
        const previousHash = current.get("tokenHash");
        if (previousHash) tx.delete(tokens.doc(previousHash));
        tx.create(tokens.doc(tokenHash), { uid, expiresAt });
        tx.set(state, { tokenHash, issuedAt: now }, { merge: true });
        return {
            token, expiresAt,
            profile: {
                nij,
                nama: text(profile.nama || profile.nama_lengkap),
                komsel: text(profile.komsel),
                lokasi_berjemaat: text(profile.lokasi_berjemaat || profile.cabang)
            }
        };
    });
});

exports.lookupMemberCard = onCall(options, async request => {
    const uid = await callerUid(request);
    const token = request.data?.token;
    if (Object.keys(request.data ?? {}).length !== 1 ||
        typeof token !== "string" || token.length !== 43 || !tokenPattern.test(token)) {
        throw new HttpsError("invalid-argument", "QR kartu tidak dikenal.");
    }

    const db = getFirestore();
    const states = db.collection("member_card_state");
    const scanner = states.doc(uid);
    const tokenHash = hash(token);
    const tokenRef = db.collection("member_card_tokens").doc(tokenHash);

    return db.runTransaction(async tx => {
        const [scan, card, scannerProfile] = await Promise.all([
            tx.get(scanner), tx.get(tokenRef), activeProfile(tx, db, uid)
        ]);
        requireActive(scannerProfile);
        checkCooldown(scan.get("scannedAt"), Date.now(), 2_000);

        let result = { found: false };
        const ownerUid = card.get("uid");
        if (ownerUid && card.get("expiresAt") > Date.now()) {
            const owner = ownerUid === uid ? scan : await tx.get(states.doc(ownerUid));
            if (owner.get("tokenHash") === tokenHash) {
                const profile = ownerUid === uid ? scannerProfile : await activeProfile(tx, db, ownerUid);
                if (profile && (ownerUid === uid || await enabledAccount(ownerUid))) {
                    const nij = await verifiedNij(tx, db, ownerUid, profile);
                    result = { found: true, uid: ownerUid, nij, nama: text(profile.nama || profile.nama_lengkap) };
                }
            }
        }
        const now = Date.now();
        tx.set(scanner, { scannedAt: now }, { merge: true });
        return card.get("expiresAt") > now ? result : { found: false };
    });
});

// Shared with receipt transactions. Only the callables are exported by index.js.
exports.memberCardIdentity = Object.freeze({ callerUid, activeProfile, enabledAccount });
