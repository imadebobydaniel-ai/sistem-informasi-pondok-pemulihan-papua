const SOURCE_COLLECTIONS = {
    ibadah: "kehadiran_jemaat",
    komsel: "laporan_komsel_umum",
    doa: "laporan_doa",
    alkitab: "laporan_bacaan"
};

const REPORT_FIELDS = [
    "uid",
    "kegiatan",
    "status",
    "Status",
    "status_doa",
    "tanggal",
    "tanggal_str",
    "wilayah_ibadah",
    "wilayah",
    "Wilayah",
    "jc",
    "JC",
    "komsel",
    "Komsel",
    "gabungan_lokasi",
    "gabungan_nama_komsel",
    "gabungan_tanggal_pelaksanaan"
];

const PROFILE_FIELDS = [
    "wilayah",
    "Wilayah",
    "lokasi_berjemaat",
    "jemaat",
    "komsel",
    "Komsel",
    "jc",
    "JC",
    "darah",
    "gol_darah"
];

const REGIONS = [
    "Abepura",
    "Sentani",
    "Doyo",
    "Arso 1",
    "Arso 2"
];

const KOMSEL_BY_REGION = {
    Abepura: [
        "Joseph 1", "Joseph 2", "Joseph 3", "Joseph 4", "Joseph 5",
        "Esther 1", "Esther 2", "Esther 3", "Esther 4", "Esther 5",
        "Esther 6", "Esther 7", "Esther 8", "Esther 9", "Esther 10",
        "Esther 11", "Esther 12", "Esther 13", "Komsel Profesi Abe",
        "Komsel Mahasiswa Abe", "Komsel Pelajar Abe",
        "Komsel Sekolah Minggu Abe", "Komsel Lansia"
    ],
    Sentani: [
        "Siloam 1", "Siloam 2", "Siloam 3", "Siloam 4", "Siloam 5",
        "Siloam 6", "Siloam 7", "Siloam 8", "Agape 1", "Agape 2",
        "Agape 3", "Agape 4", "Agape 5", "Agape 6", "Agape 7",
        "Agape 8", "Komsel Mahasiswa Sentani", "Komsel Profesi Sentani",
        "Komsel Pelajar Sentani", "Komsel Sekolah Minggu Sentani",
        "Komsel Lansia Sentani"
    ],
    Doyo: [
        "Komsel Bapak Doyo", "Komsel Ibu Doyo", "Komsel Profesi Doyo",
        "Komsel Mahasiswa Doyo", "Komsel Pelajar Doyo",
        "Komsel Sekolah Minggu Doyo", "Komsel Lansia Doyo"
    ],
    "Arso 1": ["Komsel Keluarga Arso 1"],
    "Arso 2": ["Komsel Keluarga Arso 2"]
};

const KOMSEL_NAMES = Object.values(KOMSEL_BY_REGION).flat();
const ACTIVITY_INDICATORS = {
    komsel: "Komsel Reguler",
    ibadah: "Ibadah Raya",
    doa: "Doa Puasa Jemaat",
    gabungan: "Komsel Gabungan",
    alkitab: "Pembacaan Alkitab"
};

function normalize(value) {
    return String(value ?? "").trim().toLocaleLowerCase("id-ID");
}

function canonicalChoice(value, allowedValues) {
    const normalized = normalize(value);
    return allowedValues.find(
        item => normalize(item) === normalized
    ) || "";
}

function canonicalDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return "";
    }

    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));

    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
    ) {
        return "";
    }

    return value;
}

function reportDate(data, indicator) {
    if (indicator === "Komsel Gabungan") {
        const eventDate = canonicalDate(data.gabungan_tanggal_pelaksanaan);
        if (eventDate) return eventDate;
    }

    // `tanggal` is canonical. `tanggal_str` is read only for legacy reports.
    return canonicalDate(data.tanggal) || canonicalDate(data.tanggal_str);
}

function periodKeys(dateValue) {
    const [year, month, day] = dateValue.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    const weekday = date.getUTCDay();
    const daysSinceMonday = weekday === 0 ? 6 : weekday - 1;
    date.setUTCDate(date.getUTCDate() - daysSinceMonday);

    const week = [
        date.getUTCFullYear(),
        String(date.getUTCMonth() + 1).padStart(2, "0"),
        String(date.getUTCDate()).padStart(2, "0")
    ].join("-");

    return [
        `WEEK:${week}`,
        `MONTH:${dateValue.slice(0, 7)}`,
        `YEAR:${dateValue.slice(0, 4)}`
    ];
}

function getProfileScope(profile) {
    const data = profile || {};
    const region = canonicalChoice(
        data.wilayah || data.Wilayah || data.lokasi_berjemaat || data.jemaat,
        REGIONS
    );
    const komsel = canonicalChoice(
        data.komsel || data.Komsel || data.jc || data.JC,
        KOMSEL_NAMES
    );
    return { region, komsel };
}

function getRecordScopes(indicator, data, profile) {
    if (indicator === "Komsel Gabungan") {
        return {
            region: canonicalChoice(data.gabungan_lokasi, REGIONS),
            komsel: canonicalChoice(data.gabungan_nama_komsel, KOMSEL_NAMES)
        };
    }

    const profileScope = getProfileScope(profile);
    const directRegion = canonicalChoice(
        data.wilayah_ibadah || data.wilayah || data.Wilayah,
        REGIONS
    );
    const directKomsel = canonicalChoice(
        data.jc || data.JC || data.komsel || data.Komsel,
        KOMSEL_NAMES
    );

    return {
        region: directRegion || profileScope.region,
        komsel: directKomsel || profileScope.komsel
    };
}

function getActivityIndicator(collectionName, data) {
    const activity = String(data.kegiatan || "").trim();

    if (
        collectionName === SOURCE_COLLECTIONS.ibadah &&
        activity === "Absen Ibadah Raya"
    ) return ACTIVITY_INDICATORS.ibadah;

    if (collectionName === SOURCE_COLLECTIONS.komsel) {
        if (activity === "Absen Komsel Reguler") return ACTIVITY_INDICATORS.komsel;
        if (activity === "Absen Komsel Gabungan") return ACTIVITY_INDICATORS.gabungan;
    }

    if (
        collectionName === SOURCE_COLLECTIONS.doa &&
        activity === "Doa Puasa Jemaat"
    ) return ACTIVITY_INDICATORS.doa;

    if (collectionName === SOURCE_COLLECTIONS.alkitab) {
        return ACTIVITY_INDICATORS.alkitab;
    }

    return "";
}

function isValidReport(indicator, data) {
    if (indicator === ACTIVITY_INDICATORS.alkitab) return true;

    const status = String(data.status || data.Status || "")
        .trim()
        .toUpperCase();

    if (indicator === ACTIVITY_INDICATORS.doa) {
        const doaStatus = String(data.status_doa || "")
            .trim()
            .toUpperCase();
        return (doaStatus || status) === "HADIR" &&
            (!doaStatus || !status || doaStatus === status);
    }

    return status === "HADIR";
}

function increment(counts, period, indicator, scope) {
    const id = `${period}\n${indicator}\n${scope}`;
    const row = counts.get(id) || { period, indicator, scope, count: 0 };
    row.count += 1;
    counts.set(id, row);
}

function aggregateRecord(counts, indicator, data, profile, seenReports) {
    if (!isValidReport(indicator, data)) return;

    const date = reportDate(data, indicator);
    if (!date) return;

    const uid = String(data.uid || "").trim();
    if (!uid) return;

    const eventIdentity = indicator === ACTIVITY_INDICATORS.gabungan
        ? `${normalize(data.gabungan_nama_komsel)}|${normalize(data.gabungan_lokasi)}`
        : "";
    const reportIdentity = `${uid}|${indicator}|${date}|${eventIdentity}`;
    if (seenReports.has(reportIdentity)) return;
    seenReports.add(reportIdentity);

    const recordScope = getRecordScopes(indicator, data, profile);
    const scopes = ["GLOBAL"];
    if (recordScope.region) scopes.push(`WILAYAH:${recordScope.region}`);
    if (recordScope.komsel) scopes.push(`KOMSEL:${recordScope.komsel}`);

    // Count one valid attendance report per UID/activity/date. This mirrors
    // the existing daily locks; combined groups distinguish each named event.
    periodKeys(date).forEach(period => {
        scopes.forEach(scope => increment(counts, period, indicator, scope));
    });
}

function bloodGroup(value) {
    const normalized = String(value || "").trim().toUpperCase();
    return ["A", "B", "O", "AB"].includes(normalized)
        ? normalized
        : "LAIN";
}

function aggregateBlood(counts, profile, profileScope) {
    const indicator = `Golongan Darah ${bloodGroup(profile.darah || profile.gol_darah)}`;
    const scopes = ["GLOBAL"];
    if (profileScope.region) scopes.push(`WILAYAH:${profileScope.region}`);
    if (profileScope.komsel) scopes.push(`KOMSEL:${profileScope.komsel}`);
    scopes.forEach(scope => increment(counts, "ALL", indicator, scope));
}

function buildAggregateRows(sourceRecords, profiles) {
    const counts = new Map();
    const seenReports = new Set();
    const profileByUid = profiles || new Map();

    Object.entries(sourceRecords || {}).forEach(([collectionName, records]) => {
        (records || []).forEach(record => {
            const data = record.data || {};
            const indicator = getActivityIndicator(collectionName, data);
            if (!indicator) return;
            const profile = data.uid ? profileByUid.get(String(data.uid)) : null;
            aggregateRecord(counts, indicator, data, profile, seenReports);
        });
    });

    profileByUid.forEach(profile => {
        aggregateBlood(counts, profile, getProfileScope(profile));
    });

    return counts;
}

async function readRecords(db, collectionName) {
    const snapshot = await db
        .collection(collectionName)
        .select(...REPORT_FIELDS)
        .get();
    return snapshot.docs.map(doc => ({ data: doc.data() || {} }));
}

async function buildPublicStatistics(db) {
    const collectionNames = Object.values(SOURCE_COLLECTIONS);
    const [sourceSnapshots, userSnapshot] = await Promise.all([
        Promise.all(collectionNames.map(name => readRecords(db, name))),
        db.collection("users").select(...PROFILE_FIELDS).get()
    ]);

    const sourceRecords = {};
    collectionNames.forEach((name, index) => {
        sourceRecords[name] = sourceSnapshots[index];
    });

    const profiles = new Map();
    userSnapshot.docs.forEach(doc => {
        profiles.set(doc.id, doc.data() || {});
    });

    const counts = buildAggregateRows(sourceRecords, profiles);
    return [...counts.values()].map(row => ({
        period: row.period,
        indicator: row.indicator,
        scope: row.scope,
        count: row.count
    }));
}

module.exports = {
    buildAggregateRows,
    buildPublicStatistics
};
