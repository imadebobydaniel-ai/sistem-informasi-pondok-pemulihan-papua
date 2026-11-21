"use strict";
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const options = { region: "asia-southeast2", enforceAppCheck: process.env.FUNCTIONS_EMULATOR !== "true", timeoutSeconds: 60 };
const fail = (code, message) => { throw new HttpsError(code, message); };
const email = value => String(value || "").trim().toLowerCase();
const phone = value => { const n = String(value || "").replace(/\D/g, ""); return n.startsWith("0") ? "62" + n.slice(1) : n; };
const emailKey = value => "email_" + email(value).replace(/%/g, "%25").replace(/\//g, "%2F");
const fields = new Set(("nama nama_lengkap tgl_lahir tanggal_lahir tanggal_lahir_murni jenis_kelamin sudah_dibaptis pemuridan_kd pemuridan_kd_angkatan sudah_alpha alpha_angkatan darah whatsapp whatsapp_normalized email email_normalized provinsi kabupaten_kota kota kecamatan desa_kelurahan desa alamat_detail alamat provinsi_lahir kota_lahir kecamatan_lahir desa_lahir pekerjaan status_pernikahan nama_pasangan jumlah_anak anak nama_ayah nama_ibu orang_tua_berjemaat wilayah_orang_tua wilayah lokasi_berjemaat komsel jabatan sub_jabatan sub_bidang pelayanan detail_pelayanan foto_profil last_update status_akun").split(" "));
function id(value) { return typeof value === "string" && value.length > 0 && value.length <= 160 && !value.includes("/"); }
async function actor(request) {
    if (!request.auth?.uid) fail("unauthenticated", "Login diperlukan.");
    const user = await getAuth().getUser(request.auth.uid);
    if (user.disabled) fail("permission-denied", "Akun dinonaktifkan.");
    return user;
}
function owns(user, snapshot) {
    const d = snapshot.data();
    return snapshot.id === user.uid || d.uid === user.uid ||
        (!d.uid && user.emailVerified && email(d.email) === email(user.email));
}
async function resolveOwnedProfile(db, user, tx) {
    const get = ref => tx ? tx.get(ref) : ref.get();
    const canonical = await get(db.doc("users/" + user.uid));
    if (canonical.exists) {
        if (canonical.data().uid && canonical.data().uid !== user.uid) fail("failed-precondition", "Kepemilikan profil tidak cocok.");
        return canonical;
    }
    const linked = await get(db.collection("users").where("uid", "==", user.uid).limit(2));
    if (linked.size === 1) return linked.docs[0];
    if (linked.size > 1) fail("failed-precondition", "Profil ganda memerlukan pemeriksaan pengurus.");
    if (!user.email) fail("failed-precondition", "Profil belum dapat dicocokkan.");
    const legacy = await get(db.collection("users").where("email", "==", user.email).limit(2));
    if (legacy.size !== 1) fail("failed-precondition", "Profil lama perlu diperiksa pengurus.");
    if (!owns(user, legacy.docs[0])) {
        const d = legacy.docs[0].data(), auditId = d.activation?.auditId;
        if (d.uid || d.status_akun !== "Aktif" || d.activation?.method !== "admin-override" || !id(auditId)) fail("permission-denied", "Kepemilikan legacy belum terverifikasi.");
        const audit = await get(db.doc("registration_audit/" + auditId)), a = audit.data();
        if (!audit.exists || a.targetUid !== user.uid || a.uid !== user.uid || a.action !== "activate-admin-override" ||
            a.identityVerificationAttested !== true || a.newStatus !== "Aktif" || !["Pending", "Menunggu Verifikasi"].includes(a.previousStatus) ||
            typeof a.createdAt?.toMillis !== "function" || typeof d.activation.at?.toMillis !== "function" || a.createdAt.toMillis() !== d.activation.at.toMillis()) fail("permission-denied", "Audit aktivasi legacy tidak cocok.");
    }
    return legacy.docs[0]; // Read-only compatibility, never migration or NIJ allocation.
}
async function authorize(tx, db, user, snapshots, roles = ["master", "super_admin", "admin", "viewer"]) {
    const admin = await tx.get(db.doc("admin_users/" + user.uid)), d = admin.data();
    const manager = admin.exists && d.status === "active" && roles.includes(d.role);
    if (!manager && snapshots.some(s => s.exists && !owns(user, s))) {
        let own;
        try { own = await resolveOwnedProfile(db, user, tx); } catch (_) { fail("permission-denied", "Tidak berwenang mengubah profil ini."); }
        if (snapshots.some(s => s.exists && s.id !== own.id)) fail("permission-denied", "Tidak berwenang mengubah profil ini.");
    }
    return manager;
}
exports.getSIPAPUAOwnProfile = onCall(options, async request => {
    const user = await actor(request);
    if (Object.keys(request.data || {}).length) fail("invalid-argument", "Parameter tidak valid.");
    const p = await resolveOwnedProfile(getFirestore(), user);
    return { id: p.id, profile: p.data() };
});
exports.updateSIPAPUAProfile = onCall(options, async request => {
    const user = await actor(request), data = request.data || {}, changes = data.changes;
    if (!id(data.docId) || !changes || typeof changes !== "object" || Array.isArray(changes) ||
        Object.keys(data).some(k => !["docId", "changes"].includes(k)) || Object.keys(changes).some(k => !fields.has(k))) fail("invalid-argument", "Field perubahan tidak didukung.");
    if (Buffer.byteLength(JSON.stringify(changes)) > 900000) fail("invalid-argument", "Ukuran profil terlalu besar.");
    for (const [key, value] of Object.entries(changes)) {
        if (key === "anak") {
            if (!Array.isArray(value) || value.length > 30 || value.some(c => !c || typeof c.nama !== "string" || c.nama.length > 150 || Object.keys(c).some(k => !["nama", "uid", "nij"].includes(k)))) fail("invalid-argument", "Data anak tidak valid.");
        } else if (key === "jumlah_anak") {
            if (!Number.isInteger(value) || value < 0 || value > 30) fail("invalid-argument", "Jumlah anak tidak valid.");
        } else if (typeof value !== "string" || value.length > (key === "foto_profil" ? 850000 : 2000)) fail("invalid-argument", "Nilai field tidak valid.");
    }
    if (changes.foto_profil && !/^(https:\/\/|data:image\/(jpeg|png|webp);base64,)/.test(changes.foto_profil)) fail("invalid-argument", "Format foto tidak didukung.");
    const db = getFirestore();
    return db.runTransaction(async tx => {
        const ref = db.doc("users/" + data.docId), p = await tx.get(ref);
        if (!p.exists) fail("not-found", "Profil tidak ditemukan.");
        const manager = await authorize(tx, db, user, [p]);
        const before = p.data(), after = { ...before, ...changes }, patch = { ...changes };
        if (Object.hasOwn(changes, "status_akun") && changes.status_akun !== before.status_akun) {
            if (!manager || changes.status_akun !== "Pending") fail("failed-precondition", "Gunakan aktivasi ber-audit di form administrator.");
        } else delete patch.status_akun;
        if (changes.anak?.some((c, i) => (c.uid || c.nij) && JSON.stringify(c) !== JSON.stringify(before.anak?.[i]))) fail("failed-precondition", "Tautan keluarga baru memerlukan consent pemilik data.");
        if (Object.hasOwn(changes, "jumlah_anak") && Array.isArray(after.anak) && changes.jumlah_anak !== after.anak.length) fail("invalid-argument", "Jumlah anak tidak cocok.");
        if (after.sub_jabatan === "Jemaat Simpatisan" || after.sub_bidang === "Jemaat Simpatisan") { patch.pelayanan = ""; patch.detail_pelayanan = ""; }
        const ownerUid = before.uid || p.id;
        const newClaims = [];
        if (["email", "email_normalized"].some(k => Object.hasOwn(changes, k))) {
            const normalized = email(after.email);
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || (changes.email_normalized && changes.email_normalized !== normalized)) fail("invalid-argument", "Email tidak valid.");
            if (normalized !== email(before.email)) {
                const target = await getAuth().getUser(ownerUid);
                if (email(target.email) !== normalized) fail("failed-precondition", "Email Auth belum sesuai. Perubahan email administrator memerlukan workflow yang disetujui.");
                newClaims.push(db.collection("registration_unique").doc(emailKey(normalized)));
            }
            patch.email_normalized = normalized;
        }
        if (["whatsapp", "whatsapp_normalized"].some(k => Object.hasOwn(changes, k))) {
            const normalized = phone(after.whatsapp);
            if (!/^62[0-9]{8,13}$/.test(normalized) || (changes.whatsapp_normalized && changes.whatsapp_normalized !== normalized)) fail("invalid-argument", "WhatsApp tidak valid.");
            if (normalized !== phone(before.whatsapp)) newClaims.push(db.collection("registration_unique").doc("phone_" + normalized));
            patch.whatsapp_normalized = normalized;
        }
        const claims = await Promise.all(newClaims.map(r => tx.get(r)));
        if (claims.some(s => s.exists && s.data().uid !== ownerUid)) fail("already-exists", "Identitas telah digunakan.");
        // Existing keys and permanent allocation are retained, never recycled.
        for (let i = 0; i < newClaims.length; i++) if (!claims[i].exists) tx.create(newClaims[i], { uid: ownerUid, createdAt: FieldValue.serverTimestamp() });
        tx.update(ref, patch);
        tx.create(db.collection("registration_audit").doc(), { action: "profile-update", actorUid: user.uid, targetUid: ownerUid, profileId: p.id, fields: Object.keys(patch), createdAt: FieldValue.serverTimestamp() });
        return { updated: true, id: p.id };
    });
});
exports.deleteSIPAPUAProfiles = onCall(options, async request => {
    const user = await actor(request), data = request.data || {}, ids = data.docIds;
    if (Object.keys(data).some(k => k !== "docIds") || !Array.isArray(ids) || !ids.length || ids.length > 4 || ids.some(v => !id(v)) || new Set(ids).size !== ids.length) fail("invalid-argument", "Hapus paling banyak empat profil.");
    const db = getFirestore();
    return db.runTransaction(async tx => {
        const snapshots = await Promise.all(ids.map(v => tx.get(db.doc("users/" + v))));
        await authorize(tx, db, user, snapshots, ["master", "super_admin"]);
        for (const p of snapshots) {
            if (!p.exists) continue;
            tx.delete(p.ref); // Existing hard-delete behavior; no archive or new recovery policy.
            tx.create(db.collection("registration_audit").doc(), { action: "profile-delete", actorUid: user.uid, targetUid: p.data().uid || p.id, profileId: p.id, createdAt: FieldValue.serverTimestamp() });
        }
        return { deleted: true, docIds: ids };
    });
});
exports.resolveOwnedProfile = resolveOwnedProfile;
