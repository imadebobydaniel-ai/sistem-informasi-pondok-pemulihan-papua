"use strict";

const { createHash } = require("node:crypto");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { resolveOwnedProfile, hasAuditedOverride } = require("./member-lifecycle");

const books = new Map(Object.entries({
    Kejadian: 50, Keluaran: 40, Imamat: 27, Bilangan: 36, Ulangan: 34,
    Yosua: 24, "Hakim-hakim": 21, Rut: 4, "1 Samuel": 31, "2 Samuel": 24,
    "1 Raja-raja": 22, "2 Raja-raja": 25, "1 Tawarikh": 29, "2 Tawarikh": 36,
    Ezra: 10, Nehemia: 13, Ester: 10, Ayub: 42, Mazmur: 150, Amsal: 31,
    Pengkhotbah: 12, "Kidung Agung": 8, Yesaya: 66, Yeremia: 52, Ratapan: 5,
    Yehezkiel: 48, Daniel: 12, Hosea: 14, Yoel: 3, Amos: 9, Obaja: 1,
    Yunus: 4, Mikha: 7, Nahum: 3, Habakuk: 3, Zefanya: 3, Hagai: 2,
    Zakharia: 14, Maleakhi: 4, Matius: 28, Markus: 16, Lukas: 24, Yohanes: 21,
    "Kisah Para Rasul": 28, Roma: 16, "1 Korintus": 16, "2 Korintus": 13,
    Galatia: 6, Efesus: 6, Filipi: 4, Kolose: 4, "1 Tesalonika": 5,
    "2 Tesalonika": 3, "1 Timotius": 6, "2 Timotius": 4, Titus: 3,
    Filemon: 1, Ibrani: 13, Yakobus: 5, "1 Petrus": 5, "2 Petrus": 3,
    "1 Yohanes": 5, "2 Yohanes": 1, "3 Yohanes": 1, Yudas: 1, Wahyu: 22
}));
const categories = new Set([
    "Musik", "WL", "Singer", "Choirs", "Tamborin", "Flag", "Multimedia",
    "Sound Engineer", "Kotbah", "MC", "Pelayanan Altar", "Doa Syafaat",
    "Koordinator KD", "Supervisor KD", "Pendamping KD", "Mentor KD",
    "User", "Parkir", "Cleaning Service", "Extention"
]);
const wit = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jayapura", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
});
const options = { region: "asia-southeast2", enforceAppCheck: process.env.FUNCTIONS_EMULATOR !== "true" };

function invalid() {
    throw new HttpsError("invalid-argument", "Isian laporan tidak valid.");
}

function checkKeys(data, allowed) {
    if (!data || typeof data !== "object" || Array.isArray(data) ||
        Object.keys(data).some(key => !allowed.includes(key))) invalid();
}

function chapterRange(data) {
    checkKeys(data, ["kitab", "dari", "sampai"]);
    if (!books.has(data.kitab) || !Number.isInteger(data.dari) || !Number.isInteger(data.sampai) ||
        data.dari < 1 || data.sampai < data.dari || data.sampai > books.get(data.kitab)) invalid();
    return `${data.kitab} ${data.dari}-${data.sampai}`;
}

function readingData(data, now) {
    checkKeys(data, ["tanggal", "utama", "amsal", "extension"]);
    const date = reportingDate(data.tanggal, now);
    const main = chapterRange(data.utama);
    if (!Number.isInteger(data.amsal) || data.amsal < 1 || data.amsal > 31) invalid();
    return {
        kitab: data.utama.kitab, pasal_dari: data.utama.dari, pasal_sampai: data.utama.sampai,
        pasal_utama_full: main, pasal_hikmat: `Amsal ${data.amsal}`,
        tanggal: date, tanggal_str: date, created_at: now.getTime(),
        ...(data.extension === undefined ? {} : { pasal_extension: chapterRange(data.extension) })
    };
}

function reportingDate(requestedDate, now) {
    const parts = Object.fromEntries(wit.formatToParts(now).map(part => [part.type, part.value]));
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    const minutes = Number(parts.hour) * 60 + Number(parts.minute);
    if (requestedDate !== date || minutes < 1 || minutes >= 22 * 60) {
        throw new HttpsError("failed-precondition", "Jendela pelaporan WIT telah berubah.");
    }
    return date;
}

function text(value) {
    if (typeof value !== "string" || !value.trim() || value.trim().length > 2000) invalid();
    return value.trim();
}

function calendarDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid();
    const date = new Date(value + "T00:00:00Z");
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) invalid();
    return value;
}

function serviceData(data) {
    checkKeys(data, ["kategori", "nama_kegiatan", "lokasi", "tanggal"]);
    if (!categories.has(data.kategori)) invalid();
    return { kategori: data.kategori, nama_kegiatan: text(data.nama_kegiatan),
        lokasi: text(data.lokasi), tanggal: calendarDate(data.tanggal) };
}

async function authenticatedUser(request) {
    if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Login diperlukan.");
    const user = await getAuth().getUser(request.auth.uid);
    if (user.disabled || !user.email) throw new HttpsError("permission-denied", "Akun tidak tersedia.");
    return user;
}

async function reportingProfile(db, tx, user) {
    const profile = await resolveOwnedProfile(db, user, tx);
    const admin = await tx.get(db.doc("admin_users/" + user.uid));
    const data = profile.data();
    if (data.status_akun !== "Aktif" ||
        (admin.exists && (admin.data().status !== "active" || !["master", "super_admin"].includes(admin.data().role)))) {
        throw new HttpsError("permission-denied", "Akun tidak berwenang mengirim laporan.");
    }
    if (!user.emailVerified) {
        const allocation = profile.id === user.uid && await tx.get(db.doc("nij_allocations/" + user.uid));
        const approved = await hasAuditedOverride(tx, db, user.uid, data, allocation?.exists === true);
        if (!approved) throw new HttpsError("permission-denied", "Aktivasi laporan belum terkonfirmasi.");
    }
    return profile;
}

async function submit(request, kind, now = new Date()) {
    const user = await authenticatedUser(request);
    const reading = kind === "reading";
    const report = reading ? readingData(request.data, now) : serviceData(request.data);
    const db = getFirestore();
    const reports = db.collection(reading ? "laporan_bacaan" : "laporan_pelayanan");
    const key = createHash("sha256").update(JSON.stringify([user.uid, reading ? report.tanggal : report])).digest("hex");
    const target = reports.doc(key);
    return db.runTransaction(async tx => {
        const profile = await reportingProfile(db, tx, user);
        const existing = await tx.get(target);
        if (existing.exists) return { id: existing.id, duplicate: true };

        const dateFields = reading ? ["tanggal_str", "tanggal"] : ["tanggal"];
        for (const field of dateFields) {
            const old = await tx.get(reports.where("uid", "==", user.uid).where(field, "==", report.tanggal));
            const match = old.docs.find(doc => reading || Object.entries(report).every(([name, value]) =>
                (typeof doc.get(name) === "string" ? doc.get(name).trim() : doc.get(name)) === value));
            if (match) return { id: match.id, duplicate: true };
        }
        const identity = { uid: user.uid, email: user.email };
        const stamp = FieldValue.serverTimestamp();
        if (reading) {
            const data = profile.data();
            tx.create(target, { ...report, ...identity, nama: data.nama || "Tanpa Nama",
                jc: String(data.komsel || data.jc || "Umum").trim(), timestamp: stamp });
        } else {
            const total = profile.data().total_poin ?? 0;
            if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(total + 10)) {
                throw new HttpsError("failed-precondition", "Total poin memerlukan pemeriksaan pengurus.");
            }
            tx.create(target, { ...report, ...identity, created_at: stamp, poin: 10 });
            tx.update(profile.ref, { total_poin: total + 10 });
        }
        return { id: target.id, duplicate: false };
    });
}

const attendanceFields = new Map([
    ["Absen Ibadah Raya", ["wilayah_ibadah"]], ["Absen Komsel Reguler", []],
    ["Absen Komsel Gabungan", ["gabungan_lokasi", "gabungan_nama_komsel", "gabungan_tanggal_pelaksanaan"]],
    ["Absen Doa", []], ["Doa Puasa Jemaat", ["wilayah_ibadah"]],
    ["Absen KD", []], ["Absen Pertemuan Pemimpin", []], ["Absen Latihan PW", []],
    ["Absen Pelayanan PW", ["pelayanan_pw"]], ["Pelayanan Non PW", ["pelayanan_nonpw"]],
    ["Absen Extention", ["extension_nama_kegiatan", "extension_lokasi", "extension_tanggal"]]
]);
const attendanceCollections = new Map([
    ["Absen Komsel Reguler", "laporan_komsel_umum"], ["Absen Komsel Gabungan", "laporan_komsel_umum"],
    ["Doa Puasa Jemaat", "laporan_doa"]
]);
const dailyLocks = new Set(["Absen Ibadah Raya", "Absen Komsel Reguler", "Doa Puasa Jemaat"]);
const attendanceChoices = {
    wilayah_ibadah: new Set(["Abepura", "Sentani", "Doyo", "Arso 1", "Arso 2"]),
    pelayanan_pw: new Set(["WL", "Pemusik", "Singers", "Choirs"]),
    pelayanan_nonpw: new Set(["Soundman", "Operator Live Streaming", "Operator Media", "Crew Floor",
        "Tamborin", "Flag / Banner", "Desk User", "Gate User", "Parking", "General Affairs"])
};

async function submitAttendance(request, now = new Date()) {
    const user = await authenticatedUser(request);
    const data = request.data;
    const extra = attendanceFields.get(data?.kegiatan);
    if (!extra || !["HADIR", "TIDAK HADIR"].includes(data.status) ||
        typeof data.attempt !== "string" || !/^[a-f0-9-]{36}$/.test(data.attempt)) invalid();
    checkKeys(data, ["kegiatan", "status", "tanggal", "lokasi_koordinat", "alamat_fisik", "keterangan", "attempt", ...extra]);
    const date = reportingDate(data.tanggal, now);
    const activity = data.kegiatan;
    const daily = dailyLocks.has(activity);
    const db = getFirestore();
    const reports = db.collection(attendanceCollections.get(activity) || "kehadiran_jemaat");
    const key = createHash("sha256").update(JSON.stringify([user.uid, activity, date, daily ? null : data.attempt])).digest("hex");
    const target = reports.doc(key);
    const details = Object.fromEntries(extra.map(field => [field,
        field.includes("tanggal") ? calendarDate(data[field]) : text(data[field])]));
    for (const [field, value] of Object.entries(details)) {
        if (attendanceChoices[field] && !attendanceChoices[field].has(value)) invalid();
    }
    const reason = data.status === "HADIR" ? "Hadir di Lokasi" : text(data.keterangan);
    const coordinates = text(data.lokasi_koordinat);
    const gps = coordinates.match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/);
    if (!gps || Math.abs(Number(gps[1])) > 90 || Math.abs(Number(gps[2])) > 180) invalid();
    const address = text(data.alamat_fisik);
    return db.runTransaction(async tx => {
        const profile = await reportingProfile(db, tx, user);
        const existing = await tx.get(target);
        if (existing.exists) return { id: target.id, duplicate: true };
        if (daily) {
            const previous = await tx.get(reports.where("uid", "==", user.uid).where("tanggal", "==", date)
                .where("kegiatan", "==", activity).limit(1));
            if (!previous.empty) return { id: previous.docs[0].id, duplicate: true };
        }
        const report = { ...details, uid: user.uid, nama: profile.data().nama || "Jemaat",
            tanggal: date, kegiatan: activity, status: data.status, timestamp: FieldValue.serverTimestamp(),
            lokasi_koordinat: coordinates, alamat_fisik: address, keterangan: reason,
            ...(activity === "Doa Puasa Jemaat" ? { status_doa: data.status,
                pokok_doa: data.status === "HADIR" ? "Hadir di Doa Puasa Jemaat" : reason } : {}) };
        tx.create(target, report);
        tx.create(db.collection("statistik_jemaat_pusat").doc(key), { ...report, type: "Umum_Entry" });
        return { id: target.id, duplicate: false };
    });
}

exports.submitSIPAPUAReading = onCall(options, request => submit(request, "reading"));
exports.submitSIPAPUAServiceReport = onCall(options, request => submit(request, "service"));
exports.submitSIPAPUAAttendance = onCall(options, request => submitAttendance(request));
exports.submit = submit;
exports.submitAttendance = submitAttendance;
