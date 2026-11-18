"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");

const roles = new Set(["master", "super_admin", "admin", "viewer"]);
const collections = ["laporan_bacaan", "kehadiran_jemaat", "laporan_komsel_umum", "laporan_doa"];
const profileFields = ["nama_lengkap", "nama", "nij", "no_komsel", "wilayah_jemaat", "wilayah",
    "nama_komsel", "lokasi_komsel", "komsel"];
const dateFields = ["tanggal_str", "tanggal", "tanggal_kegiatan", "created_at", "timestamp"];
const reportFields = ["kegiatan", "status", "status_doa", "event_id", "eventId", "id_event", "meeting_id", "meetingId",
    "jc", "komsel", "nama_komsel", "gabungan_tanggal_pelaksanaan", "gabungan_nama_komsel", "gabungan_lokasi",
    ...dateFields];
const maximumRecords = 10000;
const deny = () => new HttpsError("permission-denied", "Akses Rapor administrator ditolak.");
const unbound = () => new HttpsError("failed-precondition", "Ikatan NIJ dan akun anggota belum dapat dikonfirmasi.");
const tooLarge = () => new HttpsError("resource-exhausted", "Riwayat laporan melebihi batas tampilan Rapor.");

function project(data, fields) {
    const result = {};
    for (const key of fields) {
        const value = data[key];
        if (["string", "number", "boolean"].includes(typeof value)) result[key] = value;
        else if (dateFields.includes(key) && typeof value?.toDate === "function") {
            result[key] = value.toDate().toISOString();
        }
    }
    return result;
}

async function getAdministratorRapor(request) {
    if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Login diperlukan.");
    const auth = getAuth();
    const administrator = await auth.getUser(request.auth.uid);
    if (administrator.disabled) throw deny();
    const db = getFirestore();
    return db.runTransaction(async tx => {
        const role = (await tx.get(db.doc("admin_users/" + administrator.uid))).data();
        if (role?.status !== "active" || !roles.has(role.role)) throw deny();

        const data = request.data;
        const nij = typeof data?.nij === "string" ? data.nij.trim() : "";
        if (!data || Object.keys(data).length !== 1 || !nij || nij.length > 100 || /[\x00-\x1f]/.test(nij)) {
            throw new HttpsError("invalid-argument", "Masukkan NIJ anggota.");
        }
        const users = db.collection("users");
        const matches = await tx.get(users.where("nij", "==", nij).limit(2));
        if (matches.size !== 1) throw unbound();
        const member = matches.docs[0];
        const profile = member.data();
        const uid = profile.uid;
        if (typeof uid !== "string" || !uid || uid.length > 128 || uid.includes("/")) throw unbound();
        const [linked, canonical, allocation] = await Promise.all([
            tx.get(users.where("uid", "==", uid).limit(2)),
            tx.get(users.doc(uid)),
            tx.get(db.doc("nij_allocations/" + uid))
        ]);
        if (linked.size !== 1 || linked.docs[0].id !== member.id || (canonical.exists && canonical.id !== member.id)) {
            throw unbound();
        }
        const account = await auth.getUser(uid).catch(error => {
            if (error.code === "auth/user-not-found") throw unbound();
            throw error;
        });
        if (account.disabled) throw unbound();
        if (allocation.exists) {
            const binding = allocation.data();
            if (member.id !== uid || binding.uid !== uid || binding.nij !== nij ||
                !Number.isSafeInteger(binding.nij_number) || binding.nij_number < 1 ||
                binding.nij_number !== profile.nij_number) throw unbound();
        } else {
            // Historical records require explicit UID linkage and a verified Auth email match.
            const email = typeof profile.email === "string" ? profile.email.trim().toLowerCase() : "";
            if (!account.emailVerified || !email || email !== account.email?.trim().toLowerCase()) throw unbound();
        }

        const records = [];
        for (const collection of collections) {
            const snapshot = await tx.get(db.collection(collection).where("uid", "==", uid)
                .limit(maximumRecords - records.length + 1));
            for (const doc of snapshot.docs) records.push({ collection, id: doc.id, data: project(doc.data(), reportFields) });
            if (records.length > maximumRecords) throw tooLarge();
        }
        const result = { profile: project(profile, profileFields), records };
        if (!result.profile.nama_lengkap && !result.profile.nama && account.displayName) {
            result.profile.nama = account.displayName;
        }
        if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024) throw tooLarge();
        return result;
    });
}

exports.getSIPAPUAAdministratorRapor = onCall({
    region: "asia-southeast2", enforceAppCheck: process.env.FUNCTIONS_EMULATOR !== "true", timeoutSeconds: 60
}, getAdministratorRapor);
