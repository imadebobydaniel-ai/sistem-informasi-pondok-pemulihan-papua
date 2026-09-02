const INDICATORS = {
    alkitab: {
        collection: "laporan_bacaan"
    },

    ibadah: {
        collection: "kehadiran_jemaat",
        kegiatan: "Absen Ibadah Raya",
        scope: "wilayah"
    },

    komsel: {
        collection: "laporan_komsel_umum",
        kegiatan: "Absen Komsel Reguler",
        scope: "komsel"
    },

    gabungan: {
        collection: "laporan_komsel_umum",
        kegiatan: "Absen Komsel Gabungan",
        scope: "global"
    },

    pemimpin: {
        collection: "kehadiran_jemaat",
        kegiatan: "Absen Pertemuan Pemimpin",
        scope: "global"
    },

    doa: {
        collection: "laporan_doa",
        scope: "wilayah"
    }
};

function normalize(value) {
    return String(value ?? "")
        .trim()
        .toLowerCase();
}

function dateFromValue(value) {
    if (!value) {
        return null;
    }

    if (
        typeof value === "object" &&
        typeof value.toDate === "function"
    ) {
        return value.toDate();
    }

    if (value instanceof Date) {
        return value;
    }

    if (
        typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(value)
    ) {
        const [
            year,
            month,
            day
        ] = value.split("-").map(Number);

        return new Date(
            year,
            month - 1,
            day
        );
    }

    const date = new Date(value);

    return Number.isNaN(
        date.getTime()
    )
        ? null
        : date;
}

function getRecordDate(data) {
    const candidates = [
        data.tanggal_str,
        data.tanggal,
        data.tanggal_kegiatan,
        data.gabungan_tanggal_pelaksanaan,
        data.extension_tanggal,
        data.created_at,
        data.timestamp
    ];

    for (const value of candidates) {
        const date = dateFromValue(value);

        if (date) {
            return date;
        }
    }

    return null;
}

function dateKey(date) {
    return date
        .toISOString()
        .slice(0, 10);
}

function weekKey(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);

    const day = d.getDay();
    const offset =
        day === 0
            ? -6
            : 1 - day;

    d.setDate(
        d.getDate() + offset
    );

    return dateKey(d);
}

function monthKey(date) {
    return (
        `${date.getFullYear()}-` +
        `${String(
            date.getMonth() + 1
        ).padStart(2, "0")}`
    );
}

function yearKey(date) {
    return String(
        date.getFullYear()
    );
}

function isSuccessful(
    indicatorKey,
    data
) {
    if (
        indicatorKey ===
        "alkitab"
    ) {
        return true;
    }

    const status = String(
        data.status ||
        data.status_doa ||
        ""
    )
        .trim()
        .toUpperCase();

    return status === "HADIR";
}

function matchesIndicator(
    indicatorKey,
    data
) {
    const indicator =
        INDICATORS[indicatorKey];

    if (!indicator) {
        return false;
    }

    if (
        indicator.collection ===
        "laporan_bacaan"
    ) {
        return true;
    }

    if (
        indicator.collection ===
        "laporan_doa"
    ) {
        return true;
    }

    return normalize(
        data.kegiatan
    ) === normalize(
        indicator.kegiatan
    );
}

function profileScope(
    indicatorKey,
    profile
) {
    const data =
        profile || {};

    if (
        indicatorKey === "ibadah" ||
        indicatorKey === "doa"
    ) {
        return normalize(
            data.wilayah_ibadah ||
            data.wilayah_jemaat ||
            data.wilayah
        );
    }

    if (
        indicatorKey === "komsel"
    ) {
        return normalize(
            data.komsel ||
            data.jc ||
            data.nama_komsel ||
            data.lokasi_komsel
        );
    }

    return "";
}

function recordScope(
    indicatorKey,
    data
) {
    if (
        indicatorKey === "ibadah" ||
        indicatorKey === "doa"
    ) {
        return normalize(
            data.wilayah_ibadah ||
            data.wilayah_jemaat ||
            data.wilayah
        );
    }

    if (
        indicatorKey === "komsel"
    ) {
        return normalize(
            data.jc ||
            data.komsel ||
            data.nama_komsel ||
            data.gabungan_nama_komsel
        );
    }

    return "";
}

function eventKey(
    indicatorKey,
    data,
    date
) {
    const base = dateKey(date);

    if (
        indicatorKey === "ibadah" ||
        indicatorKey === "doa"
    ) {
        return (
            `${base}|` +
            recordScope(
                indicatorKey,
                data
            )
        );
    }

    if (
        indicatorKey === "komsel"
    ) {
        return (
            `${base}|` +
            recordScope(
                indicatorKey,
                data
            )
        );
    }

    if (
        indicatorKey === "gabungan"
    ) {
        return (
            `${data.gabungan_tanggal_pelaksanaan || base}|` +
            `${normalize(data.gabungan_nama_komsel)}|` +
            `${normalize(data.gabungan_lokasi)}`
        );
    }

    return base;
}

function periodFor(
    date
) {
    return {
        WEEK: weekKey(date),
        MONTH: monthKey(date),
        YEAR: yearKey(date)
    };
}

async function readCollection(
    db,
    collectionName
) {
    const snapshot =
        await db
            .collection(
                collectionName
            )
            .get();

    return snapshot.docs.map(
        doc => ({
            id: doc.id,
            data:
                doc.data() || {}
        })
    );
}

async function buildRaporStatistics(
    db,
    uid
) {
    const profileSnapshot =
        await db
            .collection("users")
            .doc(uid)
            .get();

    const profile =
        profileSnapshot.exists
            ? profileSnapshot.data() || {}
            : {};

    const collections = [
        "laporan_bacaan",
        "kehadiran_jemaat",
        "laporan_komsel_umum",
        "laporan_doa"
    ];

    const allRecords = {};

    for (
        const collectionName
        of collections
    ) {
        allRecords[
            collectionName
        ] =
            await readCollection(
                db,
                collectionName
            );
    }

    const result = {
        generatedAt:
            new Date().toISOString(),
        basis:
            "Observed activity events from Firestore reports",
        WEEK: {},
        MONTH: {},
        YEAR: {}
    };

    for (
        const indicatorKey
        of Object.keys(INDICATORS)
    ) {
        const indicator =
            INDICATORS[
                indicatorKey
            ];

        const records =
            allRecords[
                indicator.collection
            ] || [];

        const userScope =
            profileScope(
                indicatorKey,
                profile
            );

        const opportunities = {
            WEEK: new Map(),
            MONTH: new Map(),
            YEAR: new Map()
        };

        const successful = {
            WEEK: new Map(),
            MONTH: new Map(),
            YEAR: new Map()
        };

        for (
            const entry of records
        ) {
            const data =
                entry.data;

            if (
                !matchesIndicator(
                    indicatorKey,
                    data
                )
            ) {
                continue;
            }

            const date =
                getRecordDate(data);

            if (!date) {
                continue;
            }

            if (
                indicator.scope !==
                "global" &&
                indicator.scope
            ) {
                const scope =
                    recordScope(
                        indicatorKey,
                        data
                    );

                if (
                    userScope &&
                    scope &&
                    scope !== userScope
                ) {
                    continue;
                }
            }

            const periods =
                periodFor(date);

            const key =
                eventKey(
                    indicatorKey,
                    data,
                    date
                );

            for (
                const mode of [
                    "WEEK",
                    "MONTH",
                    "YEAR"
                ]
            ) {
                const period =
                    periods[mode];

                if (
                    !opportunities[
                        mode
                    ].has(period)
                ) {
                    opportunities[
                        mode
                    ].set(
                        period,
                        new Set()
                    );
                }

                opportunities[
                    mode
                ].get(period).add(
                    key
                );

                if (
                    entry.data.uid ===
                        uid &&
                    isSuccessful(
                        indicatorKey,
                        data
                    )
                ) {
                    if (
                        !successful[
                            mode
                        ].has(period)
                    ) {
                        successful[
                            mode
                        ].set(
                            period,
                            new Set()
                        );
                    }

                    successful[
                        mode
                    ].get(period).add(
                        key
                    );
                }
            }
        }

        for (
            const mode of [
                "WEEK",
                "MONTH",
                "YEAR"
            ]
        ) {
            for (
                const [
                    period,
                    eventSet
                ] of opportunities[
                    mode
                ].entries()
            ) {
                const target =
                    eventSet.size;

                const successSet =
                    successful[
                        mode
                    ].get(period) ||
                    new Set();

                const count =
                    successSet.size;

                const percentage =
                    target > 0
                        ? Math.min(
                            100,
                            Math.max(
                                0,
                                (
                                    count /
                                    target
                                ) * 100
                            )
                        )
                        : null;

                if (
                    !result[
                        mode
                    ][period]
                ) {
                    result[
                        mode
                    ][period] = {};
                }

                result[
                    mode
                ][period][
                    indicatorKey
                ] = {
                    count,
                    target,
                    percentage
                };
            }
        }
    }

    return result;
}

module.exports = {
    buildRaporStatistics
};