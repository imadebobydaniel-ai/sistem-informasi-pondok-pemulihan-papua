const { onCall } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { initializeApp } = require("firebase-admin/app");
const {
    getFirestore,
    FieldValue,
    Timestamp
} = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { HttpsError } = require("firebase-functions/v2/https");
const { buildRaporStatistics } = require("./rapor-stats");
const { buildPublicStatistics } = require("./public-statistics");

initializeApp();

exports.healthCheck = onCall(
    {
        region: "asia-southeast2",
        enforceAppCheck: true
    },
    async () => {
        return {
            ok: true,
            service: "sipapua-functions"
        };
    }
);


const db = getFirestore();
const PUBLIC_STATISTICS_CACHE_MS = 60 * 1000;
let publicStatisticsCache = null;
let publicStatisticsCacheAt = 0;
let publicStatisticsRequest = null;

exports.findNearbyMembers = onCall(
    {
        region: "asia-southeast2",
        enforceAppCheck: false,
        timeoutSeconds: 15,
        memory: "256MiB"
    },
    async (request) => {
        if (!request.auth) {
            throw new HttpsError(
                "unauthenticated",
                "Silakan login untuk menggunakan Lacak Domba."
            );
        }

        // Caller coordinates in request.data are ignored; the caller's location
        // is read server-side from presence_locations/{auth uid}.
        const radiusKm = Number(request.data?.radiusKm);

        if (![1, 5, 10].includes(radiusKm)) {
            throw new HttpsError("invalid-argument", "Radius tidak valid.");
        }

        const callerUid = request.auth.uid;
        const now = Date.now();
        const locationMaxAgeMs = 15 * 60 * 1000;

        const callerLocationSnapshot = await db
            .collection("presence_locations")
            .doc(callerUid)
            .get();
        const callerLocation = callerLocationSnapshot.exists
            ? callerLocationSnapshot.data()
            : null;
        const latitude = callerLocation?.latitude;
        const longitude = callerLocation?.longitude;
        const callerLocationTime = callerLocation?.updatedAt?.toMillis?.() || 0;

        if (
            !callerLocation
            || typeof latitude !== "number" || !Number.isFinite(latitude)
            || latitude < -90 || latitude > 90
            || typeof longitude !== "number" || !Number.isFinite(longitude)
            || longitude < -180 || longitude > 180
            || now - callerLocationTime > locationMaxAgeMs
        ) {
            throw new HttpsError(
                "failed-precondition",
                "Lokasi Anda belum tersedia atau sudah kedaluwarsa. Pindai ulang untuk memperbarui lokasi."
            );
        }

        const rateLimitRef = db.collection("social_rate_limits").doc(callerUid);

        await db.runTransaction(async (transaction) => {
            const rateLimit = await transaction.get(rateLimitRef);
            const lastRequestAt = rateLimit.exists
                ? rateLimit.data().lastRequestAt?.toMillis?.() || 0
                : 0;

            if (now - lastRequestAt < 15000) {
                throw new HttpsError(
                    "resource-exhausted",
                    "Tunggu sebentar sebelum memindai kembali."
                );
            }

            transaction.set(rateLimitRef, {
                lastRequestAt: FieldValue.serverTimestamp()
            });
        });

        const latitudeDelta = radiusKm / 110.574;
        const cosineLatitude = Math.max(
            0.01,
            Math.cos(latitude * Math.PI / 180)
        );
        const longitudeDelta = Math.min(
            180,
            radiusKm / (111.320 * cosineLatitude)
        );
        const minLatitude = Math.max(-90, latitude - latitudeDelta);
        const maxLatitude = Math.min(90, latitude + latitudeDelta);
        const minLongitude = longitude - longitudeDelta;
        const maxLongitude = longitude + longitudeDelta;

        const locationsSnapshot = await db
            .collection("presence_locations")
            .where("latitude", ">=", minLatitude)
            .where("latitude", "<=", maxLatitude)
            .limit(501)
            .get();

        if (locationsSnapshot.size > 500) {
            throw new HttpsError(
                "resource-exhausted",
                "Terlalu banyak lokasi aktif di area ini. Perkecil radius dan coba lagi."
            );
        }

        const blockedSnapshot = await db
            .collection("user_blocks")
            .doc(callerUid)
            .collection("blocked")
            .get();
        const blockedUids = new Set(blockedSnapshot.docs.map((doc) => doc.id));
        const candidates = [];
        const staleLocationDeletes = [];
        const presenceMaxAgeMs = 3 * 60 * 1000;

        function getDistanceKm(firstLatitude, firstLongitude, secondLatitude, secondLongitude) {
            const earthRadiusKm = 6371;
            const toRadians = (value) => value * Math.PI / 180;
            const latitudeDifference = toRadians(secondLatitude - firstLatitude);
            const longitudeDifference = toRadians(secondLongitude - firstLongitude);
            const haversine = Math.sin(latitudeDifference / 2) ** 2
                + Math.cos(toRadians(firstLatitude))
                * Math.cos(toRadians(secondLatitude))
                * Math.sin(longitudeDifference / 2) ** 2;

            return earthRadiusKm * 2 * Math.atan2(
                Math.sqrt(haversine),
                Math.sqrt(1 - haversine)
            );
        }

        function getDistanceBucket(distanceKm) {
            if (distanceKm < 1) return { rank: 0, label: "< 1 KM" };
            if (distanceKm < 5) return { rank: 1, label: "1–5 KM" };
            return { rank: 2, label: "5–10 KM" };
        }

        await Promise.all(locationsSnapshot.docs.map(async (locationDoc) => {
            const candidateUid = locationDoc.id;
            const location = locationDoc.data();
            const locationTime = location.updatedAt?.toMillis?.() || 0;

            if (now - locationTime > locationMaxAgeMs) {
                staleLocationDeletes.push(locationDoc.ref.delete());
                return;
            }

            if (candidateUid === callerUid || blockedUids.has(candidateUid)) {
                return;
            }

            if (
                minLongitude >= -180 && maxLongitude <= 180
                && (location.longitude < minLongitude || location.longitude > maxLongitude)
            ) {
                return;
            }

            const distanceKm = getDistanceKm(
                latitude,
                longitude,
                location.latitude,
                location.longitude
            );

            if (distanceKm > radiusKm) return;

            const [presenceSnapshot, reverseBlockSnapshot] = await Promise.all([
                db.collection("presence").doc(candidateUid).get(),
                db.collection("user_blocks")
                    .doc(candidateUid)
                    .collection("blocked")
                    .doc(callerUid)
                    .get()
            ]);

            if (!presenceSnapshot.exists || reverseBlockSnapshot.exists) return;

            const presence = presenceSnapshot.data();
            const lastSeen = presence.lastSeen?.toMillis?.() || 0;
            if (
                presence.discoverable !== true
                || presence.online !== true
                || now - lastSeen > presenceMaxAgeMs
            ) {
                return;
            }

            const distanceBucket = getDistanceBucket(distanceKm);
            const rawPhoto = String(presence.photoURL || "").trim();
            let photoURL = "";
            try {
                const parsedPhoto = new URL(rawPhoto);
                if (parsedPhoto.protocol === "https:") photoURL = parsedPhoto.href;
            } catch (_) {
                photoURL = "";
            }

            candidates.push({
                uid: candidateUid,
                displayName: String(presence.displayName || "Jemaat").slice(0, 100),
                photoURL,
                online: presence.showOnline === true,
                komsel: String(presence.komsel || "").slice(0, 120),
                wilayah: String(presence.wilayah || "").slice(0, 120),
                distanceRange: distanceBucket.label,
                distanceRank: distanceBucket.rank
            });
        }));

        if (staleLocationDeletes.length) {
            await Promise.all(staleLocationDeletes);
        }

        // Sort by coarse range only so result order does not leak exact distance.
        candidates.sort((first, second) =>
            first.distanceRank - second.distanceRank
            || first.displayName.localeCompare(second.displayName)
        );

        return {
            results: candidates
                .slice(0, 100)
                .map(({ distanceRank, ...result }) => result),
            truncated: candidates.length > 100
        };
    }
);

exports.cleanupExpiredPresenceLocations = onSchedule(
    {
        schedule: "every 15 minutes",
        timeZone: "Asia/Jayapura",
        region: "asia-southeast2",
        timeoutSeconds: 60,
        memory: "256MiB"
    },
    async () => {
        const expiration = Timestamp.fromMillis(Date.now() - 15 * 60 * 1000);
        let deletedCount = 0;

        while (true) {
            const staleLocations = await db
                .collection("presence_locations")
                .where("updatedAt", "<", expiration)
                .limit(500)
                .get();

            if (staleLocations.empty) break;

            const batch = db.batch();
            staleLocations.docs.forEach((location) => batch.delete(location.ref));
            await batch.commit();
            deletedCount += staleLocations.size;

            if (staleLocations.size < 500) break;
        }

        return { deletedCount };
    }
);

function normalizeEmail(value) {
    return String(value || "")
        .trim()
        .toLowerCase();
}

function normalizePhone(value) {
    const digits = String(value || "")
        .replace(/\D/g, "");

    if (!digits) {
        return "";
    }

    if (digits.startsWith("62")) {
        return digits;
    }

    if (digits.startsWith("0")) {
        return "62" + digits.substring(1);
    }

    return digits;
}

exports.checkRegistrationDuplicate = onCall(
    {
        region: "asia-southeast2",
        enforceAppCheck: process.env.FUNCTIONS_EMULATOR !== "true",
        timeoutSeconds: 10,
        memory: "256MiB"
    },
    async (request) => {

        const data = request.data || {};

        const email =
            normalizeEmail(data.email);

        const whatsapp =
            normalizePhone(data.whatsapp);

        if (!email && !whatsapp) {
            return {
                duplicate: false,
                matchedBy: [],
                candidateCount: 0
            };
        }

        const matchedBy = [];
        const candidateIds = new Set();

        async function collectMatches(
            field,
            value,
            label
        ) {
            if (!value) {
                return;
            }

            const snapshot = await db
                .collection("users")
                .where(field, "==", value)
                .limit(2)
                .get();

            if (snapshot.empty) {
                return;
            }

            matchedBy.push(label);

            snapshot.forEach((doc) => {
                candidateIds.add(doc.id);
            });
        }

        /*
         * =====================================================
         * CANONICAL RECORD
         * =====================================================
         */

        await collectMatches(
            "email_normalized",
            email,
            "email"
        );

        await collectMatches(
            "whatsapp_normalized",
            whatsapp,
            "whatsapp"
        );

        /*
         * =====================================================
         * LEGACY RECORD
         * =====================================================
         *
         * Dipakai sementara selama record lama belum
         * mempunyai field *_normalized.
         *
         * Tidak melakukan full collection scan.
         */

        await collectMatches(
            "email",
            email,
            "email_legacy"
        );

        await collectMatches(
            "whatsapp",
            whatsapp,
            "whatsapp_legacy"
        );

        return {
            duplicate:
                candidateIds.size > 0,

            matchedBy:
                [...new Set(matchedBy)],

            candidateCount:
                candidateIds.size
        };
    }
);

const adminAuth = getAuth();

const PKS_WILAYAH_KOMSEL = {
    "Abepura": [
        "Lansia Abepura",
        "Joseph 1",
        "Joseph 2",
        "Joseph 3",
        "Joseph 4",
        "Joseph 5",
        "Esther 1",
        "Esther 2",
        "Esther 3",
        "Esther 4",
        "Esther 5",
        "Esther 6",
        "Esther 7",
        "Esther 8",
        "Esther 9",
        "Esther 10",
        "Esther 11",
        "Esther 12",
        "Komsel Mahasiswa Abe",
        "Komsel Profesi Abe",
        "Komsel Pelajar Abe",
        "Komsel Sekolah Minggu"
    ],
    "Sentani": [
        "Siloam 1",
        "Siloam 2",
        "Siloam 3",
        "Siloam 4",
        "Komsel 5",
        "Siloam 6",
        "Siloam 8",
        "Agape 1",
        "Agape 2",
        "Agape 3",
        "Agape 4",
        "Agape 5",
        "Komsel Mahasiswa Sentani",
        "Komsel Profesi Sentani",
        "Komsel Pelajar Sentani",
        "Komsel Remaja Sentani",
        "Komsel Sekolah Minggu Sentani"
    ],
    "Doyo": [
        "Komsel Bapak doyo",
        "Komsel Ibu doyo"
    ],
    "Arso 1": [
        "Komsel Keluarga Arso 1"
    ],
    "Arso 2": [
        "Komsel Keluarga Arso 2"
    ]
};

const PKS_JABATAN = [
    "Anggota Jemaat",
    "Gembala Sidang",
    "Pemimpin / Koordinator",
    "PKS Komsel",
    "Fulltimer"
];
const MASTER_UID =
    "hXo6v5OKhkMVtRAAuUqcYcASplo2";

const ADMIN_LIMITS = {
    super_admin: 4,
    admin: 6,
    viewer: 10
};

async function getCallerAdmin(request) {
    if (!request.auth) {
        throw new HttpsError(
            "unauthenticated",
            "Autentikasi administrator diperlukan."
        );
    }

    const uid =
        String(
            request.auth.uid || ""
        ).trim();

    const snapshot =
        await db
            .collection("admin_users")
            .doc(uid)
            .get();

    if (!snapshot.exists) {
        throw new HttpsError(
            "permission-denied",
            "Akun tidak terdaftar sebagai administrator."
        );
    }

    const data =
        snapshot.data();

    const role =
        normalizeAdminRole(
            data.role
        );

    const status =
        String(
            data.status || "inactive"
        )
            .trim()
            .toLowerCase();

    if (
        ![
            "master",
            "super_admin"
        ].includes(role)
    ) {
        throw new HttpsError(
            "permission-denied",
            "Hanya Master atau Super Admin yang dapat mengelola akun administrator."
        );
    }

    if (
        status !== "active"
    ) {
        throw new HttpsError(
            "permission-denied",
            "Akun administrator sedang tidak aktif."
        );
    }

    return {
        uid,
        role,
        data
    };
}

async function assertRoleCapacity(
    role,
    excludeUid = null
) {
    role =
        normalizeAdminRole(
            role
        );

    const max =
        ADMIN_LIMITS[role];

    if (!max) {
        throw new HttpsError(
            "invalid-argument",
            "Role administrator tidak valid."
        );
    }

    const snapshot =
        await db
            .collection("admin_users")
            .where(
                "role",
                "==",
                role
            )
            .where(
                "status",
                "==",
                "active"
            )
            .get();

    let currentCount =
        snapshot.size;

    if (
        excludeUid &&
        snapshot.docs.some(
            (doc) =>
                doc.id ===
                excludeUid
        )
    ) {
        currentCount--;
    }

    if (
        currentCount >= max
    ) {
        throw new HttpsError(
            "failed-precondition",
            `Kuota ${role} sudah penuh (${max} akun aktif).`
        );
    }

    return {
        role,
        currentCount,
        max
    };
}

exports.adminGetRoleCounts = onCall(
    {
        region: "asia-southeast2",
        enforceAppCheck: false
    },
    async (request) => {
        await getCallerAdmin(
            request
        );

        const snapshot =
            await db
                .collection("admin_users")
                .get();

        const counts = {
            super_admin: 0,
            admin: 0,
            viewer: 0
        };

        snapshot.forEach(
            (doc) => {
                const data =
                    doc.data();

                const role =
                    normalizeAdminRole(
                        data.role
                    );

                const status =
                    String(
                        data.status ||
                        "inactive"
                    )
                        .trim()
                        .toLowerCase();

                if (
                    status === "active" &&
                    Object.prototype.hasOwnProperty.call(
                        counts,
                        role
                    )
                ) {
                    counts[role]++;
                }
            }
        );

        return {
            counts,
            limits:
                ADMIN_LIMITS
        };
    }
);

exports.pksCreateUser = onCall(
    {
        region: "asia-southeast2",
        enforceAppCheck: false,
        timeoutSeconds: 30
    },
    async (request) => {
        const caller =
            await getCallerAdmin(
                request
            );

        const data =
            request.data || {};

        const nama =
            String(
                data.nama || ""
            ).trim();

        const email =
            normalizeEmail(
                data.email
            );

        const password =
            String(
                data.password || ""
            );

        const wilayah =
            String(
                data.wilayah || ""
            ).trim();

        const komsel =
            String(
                data.komsel || ""
            ).trim();

        const jabatan =
            String(
                data.jabatan || ""
            ).trim();

        if (
            !nama ||
            !email ||
            !password ||
            !wilayah ||
            !komsel ||
            !jabatan
        ) {
            throw new HttpsError(
                "invalid-argument",
                "Data akun PKS belum lengkap."
            );
        }

        if (
            password.length < 6
        ) {
            throw new HttpsError(
                "invalid-argument",
                "Password minimal 6 karakter."
            );
        }

        if (
            !Object.prototype.hasOwnProperty.call(
                PKS_WILAYAH_KOMSEL,
                wilayah
            )
        ) {
            throw new HttpsError(
                "invalid-argument",
                "Wilayah PKS tidak valid."
            );
        }

        if (
            !PKS_WILAYAH_KOMSEL[wilayah].includes(
                komsel
            )
        ) {
            throw new HttpsError(
                "invalid-argument",
                "Komsel tidak sesuai dengan wilayah yang dipilih."
            );
        }

        if (
            !PKS_JABATAN.includes(jabatan)
        ) {
            throw new HttpsError(
                "invalid-argument",
                "Jabatan PKS tidak valid."
            );
        }

        let createdUser = null;

        try {
            createdUser =
                await adminAuth.createUser({
                    email,
                    password,
                    displayName:
                        nama
                });

            const uid =
                createdUser.uid;

            await db
                .collection(
                    "pks_users"
                )
                .doc(uid)
                .set({
                    uid,
                    nama,
                    email,
                    wilayah,
                    komsel,
                    jabatan,
                    role: "pks",
                    status: "active",
                    createdBy:
                        caller.uid,
                    createdAt:
                        FieldValue.serverTimestamp(),
                    updatedAt:
                        FieldValue.serverTimestamp()
                });

            return {
                ok: true,
                uid,
                email,
                role: "pks",
                wilayah,
                komsel,
                jabatan,
                createdBy:
                    caller.uid
            };
        } catch (error) {
            if (
                createdUser?.uid
            ) {
                try {
                    await adminAuth.deleteUser(
                        createdUser.uid
                    );
                } catch (_) {
                    // Abaikan cleanup failure.
                }
            }

            if (
                error instanceof HttpsError
            ) {
                throw error;
            }

            if (
                error.code ===
                "auth/email-already-exists"
            ) {
                throw new HttpsError(
                    "already-exists",
                    "Email tersebut sudah terdaftar di Firebase Authentication."
                );
            }

            throw new HttpsError(
                "internal",
                "Gagal membuat akun PKS."
            );
        }
    }
);
exports.adminCreateUser = onCall(
    {
        region: "asia-southeast2",
        enforceAppCheck: false,
        timeoutSeconds: 30
    },
    async (request) => {
        const caller =
            await getCallerAdmin(
                request
            );

        const data =
            request.data || {};

        const nama =
            String(
                data.nama || ""
            ).trim();

        const email =
            String(
                data.email || ""
            )
                .trim()
                .toLowerCase();

        const hp =
            String(
                data.hp || ""
            ).trim();

        const jabatan =
            String(
                data.jabatan || ""
            ).trim();

        const password =
            String(
                data.password || ""
            );

        const role =
            normalizeAdminRole(
                data.role
            );

        if (
            !nama ||
            !email ||
            !jabatan ||
            !password
        ) {
            throw new HttpsError(
                "invalid-argument",
                "Data akun administrator belum lengkap."
            );
        }

        if (
            password.length < 6
        ) {
            throw new HttpsError(
                "invalid-argument",
                "Password minimal 6 karakter."
            );
        }

        if (
            !Object.prototype.hasOwnProperty.call(
                ADMIN_LIMITS,
                role
            )
        ) {
            throw new HttpsError(
                "invalid-argument",
                "Role administrator tidak valid."
            );
        }

        await assertRoleCapacity(
            role
        );

        let createdUser = null;

        try {
            createdUser =
                await adminAuth.createUser({
                    email,
                    password,
                    displayName:
                        nama
                });

            const uid =
                createdUser.uid;

            await db
                .collection(
                    "admin_users"
                )
                .doc(uid)
                .set({
                    nama,
                    email,
                    hp,
                    jabatan,
                    role,
                    status:
                        "active",
                    protected:
                        false,
                    createdAt:
                        FieldValue.serverTimestamp(),
                    updatedAt:
                        FieldValue.serverTimestamp()
                });

            return {
                ok: true,
                uid,
                email,
                role,
                createdBy:
                    caller.uid
            };
        } catch (error) {
            if (
                createdUser?.uid
            ) {
                try {
                    await adminAuth.deleteUser(
                        createdUser.uid
                    );
                } catch (_) {
                    // Abaikan cleanup failure.
                }
            }

            if (
                error instanceof HttpsError
            ) {
                throw error;
            }

            if (
                error.code ===
                "auth/email-already-exists"
            ) {
                throw new HttpsError(
                    "already-exists",
                    "Email tersebut sudah terdaftar di Firebase Authentication."
                );
            }

            throw new HttpsError(
                "internal",
                "Gagal membuat akun administrator."
            );
        }
    }
);

exports.adminToggleStatus = onCall(
    {
        region: "asia-southeast2",
        enforceAppCheck: false
    },
    async (request) => {
        await getCallerAdmin(
            request
        );

        const targetUid =
            String(
                request.data?.uid ||
                ""
            ).trim();

        if (!targetUid) {
            throw new HttpsError(
                "invalid-argument",
                "UID administrator wajib diisi."
            );
        }

        if (
            targetUid ===
            MASTER_UID
        ) {
            throw new HttpsError(
                "failed-precondition",
                "Akun Master dilindungi."
            );
        }

        const ref =
            db
                .collection(
                    "admin_users"
                )
                .doc(targetUid);

        const snapshot =
            await ref.get();

        if (!snapshot.exists) {
            throw new HttpsError(
                "not-found",
                "Data administrator tidak ditemukan."
            );
        }

        const data =
            snapshot.data();

        if (
            data.role === "master" ||
            data.protected === true
        ) {
            throw new HttpsError(
                "failed-precondition",
                "Akun yang dilindungi tidak dapat diubah."
            );
        }

        const currentStatus =
            String(
                data.status ||
                "active"
            )
                .trim()
                .toLowerCase();

        const nextStatus =
            currentStatus ===
                "active"
                ? "inactive"
                : "active";

        if (
            nextStatus ===
            "active"
        ) {
            await assertRoleCapacity(
                data.role,
                targetUid
            );
        }

        await ref.update({
            status:
                nextStatus,
            updatedAt:
                FieldValue.serverTimestamp(),
        });

        return {
            ok: true,
            uid: targetUid,
            status:
                nextStatus
        };
    }
);

exports.adminDeleteUser = onCall(
    {
        region: "asia-southeast2",
        enforceAppCheck: false
    },
    async (request) => {
        await getCallerAdmin(
            request
        );

        const targetUid =
            String(
                request.data?.uid ||
                ""
            ).trim();

        if (!targetUid) {
            throw new HttpsError(
                "invalid-argument",
                "UID administrator wajib diisi."
            );
        }

        if (
            targetUid ===
            MASTER_UID
        ) {
            throw new HttpsError(
                "failed-precondition",
                "Akun Master tidak dapat dihapus."
            );
        }

        const ref =
            db
                .collection(
                    "admin_users"
                )
                .doc(targetUid);

        const snapshot =
            await ref.get();

        if (!snapshot.exists) {
            throw new HttpsError(
                "not-found",
                "Data administrator tidak ditemukan."
            );
        }

        const data =
            snapshot.data();

        if (
            data.role === "master" ||
            data.protected === true
        ) {
            throw new HttpsError(
                "failed-precondition",
                "Akun yang dilindungi tidak dapat dihapus."
            );
        }

        await adminAuth.deleteUser(
            targetUid
        );

        await ref.delete();

        return {
            ok: true,
            uid: targetUid
        };
    }
);

exports.adminPreviewReportUidMigration = onCall(
    {
        region: "asia-southeast2",
        enforceAppCheck: false,
        timeoutSeconds: 60,
        memory: "256MiB"
    },
    async (request) => {
        const caller =
            await getCallerAdmin(
                request
            );

        if (
            ![
                "master",
                "super_admin"
            ].includes(caller.role)
        ) {
            throw new HttpsError(
                "permission-denied",
                "Hanya Master atau Super Admin yang dapat menjalankan preview migrasi UID."
            );
        }

        const userSnapshot =
            await db
                .collection("users")
                .get();

        const users = [];
        const usersByEmail = new Map();
        const usersByName = new Map();

        userSnapshot.forEach(
            doc => {
                const data =
                    doc.data() || {};

                const uid =
                    String(
                        doc.id || ""
                    ).trim();

                const email =
                    normalizeEmail(
                        data.email
                    );

                const name =
                    String(
                        data.nama ||
                        data.nama_lengkap ||
                        ""
                    )
                    .trim()
                    .toLowerCase();

                const entry = {
                    uid,
                    email,
                    name
                };

                users.push(
                    entry
                );

                if (email) {
                    const list =
                        usersByEmail.get(
                            email
                        ) || [];

                    list.push(
                        entry
                    );

                    usersByEmail.set(
                        email,
                        list
                    );
                }

                if (name) {
                    const list =
                        usersByName.get(
                            name
                        ) || [];

                    list.push(
                        entry
                    );

                    usersByName.set(
                        name,
                        list
                    );
                }
            }
        );

        const collections = [
            "kehadiran_jemaat",
            "laporan_komsel_umum",
            "laporan_doa",
            "laporan_bacaan",
            "laporan_pelayanan"
        ];

        const summary = {};

        for (
            const collectionName
            of collections
        ) {
            const snapshot =
                await db
                    .collection(
                        collectionName
                    )
                    .get();

            const result = {
                total: snapshot.size,
                already_uid: 0,
                email_match: 0,
                name_match: 0,
                ambiguous: 0,
                unmatched: 0
            };

            snapshot.forEach(
                doc => {
                    const data =
                        doc.data() || {};

                    const existingUid =
                        String(
                            data.uid || ""
                        ).trim();

                    if (
                        existingUid
                    ) {
                        result.already_uid++;
                        return;
                    }

                    const email =
                        normalizeEmail(
                            data.email
                        );

                    const name =
                        String(
                            data.nama ||
                            data.nama_lengkap ||
                            ""
                        )
                        .trim()
                        .toLowerCase();

                    if (email) {
                        const matches =
                            usersByEmail.get(
                                email
                            ) || [];

                        if (
                            matches.length === 1
                        ) {
                            result.email_match++;
                            return;
                        }

                        if (
                            matches.length > 1
                        ) {
                            result.ambiguous++;
                            return;
                        }
                    }

                    if (name) {
                        const matches =
                            usersByName.get(
                                name
                            ) || [];

                        if (
                            matches.length === 1
                        ) {
                            result.name_match++;
                            return;
                        }

                        if (
                            matches.length > 1
                        ) {
                            result.ambiguous++;
                            return;
                        }
                    }

                    result.unmatched++;
                }
            );

            summary[
                collectionName
            ] = result;
        }

        return {
            ok: true,
            mode: "PREVIEW_ONLY",
            generatedAt:
                new Date().toISOString(),
            userCount:
                users.length,
            collections:
                summary
        };
    }
);
exports.getRaporStatistics = onCall(
    {
        region: "asia-southeast2",
        enforceAppCheck: false,
        timeoutSeconds: 60,
        memory: "256MiB"
    },
    async (request) => {
        if (!request.auth) {
            throw new HttpsError(
                "unauthenticated",
                "Autentikasi diperlukan untuk membaca Rapor."
            );
        }

        return buildRaporStatistics(
            db,
            request.auth.uid
        );
    }
);

exports.getPublicStatistics = onCall(
    {
        region: "asia-southeast2",
        enforceAppCheck: false,
        timeoutSeconds: 120,
        memory: "1GiB",
        maxInstances: 2
    },
    async () => {
        if (
            publicStatisticsCache &&
            Date.now() - publicStatisticsCacheAt < PUBLIC_STATISTICS_CACHE_MS
        ) {
            return publicStatisticsCache;
        }

        if (!publicStatisticsRequest) {
            publicStatisticsRequest = buildPublicStatistics(db)
                .then(rows => {
                    publicStatisticsCache = rows;
                    publicStatisticsCacheAt = Date.now();
                    return rows;
                })
                .finally(() => {
                    publicStatisticsRequest = null;
                });
        }

        return publicStatisticsRequest;
    }
);
const DEMO_PKS_WILAYAH = [
    "Abepura",
    "Sentani",
    "Doyo",
    "Arso 1",
    "Arso 2"
];

const DEMO_PKS_DIVISI = [
    "Praise and Worship (PW)",
    "Multimedia & Sound Engineering",
    "Tamborin and Banner",
    "Event & Organizer",
    "Komsel Bapak",
    "Komsel Ibu",
    "Komsel Pelajar",
    "Komsel Mahasiswa",
    "Komsel Profesi",
    "Sekolah Minggu",
    "Lansia",
    "Team Doa",
    "Team Misi",
    "Perparkiran dan Keamanan",
    "General Affairs"
];

function demoPksSlug(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ".")
        .replace(/^\.+|\.+$/g, "");
}

function getDemoPksAccount(email, password) {
    const normalizedEmail = normalizeEmail(email);

    for (
        let wilayahIndex = 0;
        wilayahIndex < DEMO_PKS_WILAYAH.length;
        wilayahIndex++
    ) {
        for (
            let divisiIndex = 0;
            divisiIndex < DEMO_PKS_DIVISI.length;
            divisiIndex++
        ) {
            const number =
                wilayahIndex *
                    DEMO_PKS_DIVISI.length +
                divisiIndex +
                1;

            const wilayah =
                DEMO_PKS_WILAYAH[wilayahIndex];

            const divisi =
                DEMO_PKS_DIVISI[divisiIndex];

            const account = {
                uid:
                    `demo-pks-${String(number).padStart(3, "0")}`,
                nama:
                    `PKS ${wilayah} - ${divisi}`,
                email:
                    `pks.${demoPksSlug(wilayah)}.${demoPksSlug(divisi)}@demo.sipapua.local`,
                password:
                    `DemoPKS-${String(number).padStart(3, "0")}-2026!`,
                wilayah,
                divisi,
                komsel: "Demo",
                jabatan: "PKS",
                role: "pks",
                status: "active"
            };

            if (
                account.email === normalizedEmail &&
                account.password === String(password || "")
            ) {
                return account;
            }
        }
    }

    return null;
}

exports.pksDemoLogin = onCall(
    {
        region: "asia-southeast2",
        enforceAppCheck: false,
        timeoutSeconds: 15
    },
    async (request) => {
        const data = request.data || {};

        const email =
            normalizeEmail(data.email);

        const password =
            String(data.password || "");

        if (!email || !password) {
            throw new HttpsError(
                "invalid-argument",
                "Email dan password wajib diisi."
            );
        }

        const account =
            getDemoPksAccount(
                email,
                password
            );

        if (!account) {
            throw new HttpsError(
                "unauthenticated",
                "Email atau password demo PKS tidak valid."
            );
        }

        const token =
            await adminAuth.createCustomToken(
                account.uid,
                {
                    role: "pks",
                    wilayah: account.wilayah,
                    divisi: account.divisi,
                    komsel: account.komsel,
                    jabatan: account.jabatan
                }
            );

        return {
            ok: true,
            token,
            profile: {
                uid: account.uid,
                nama: account.nama,
                email: account.email,
                wilayah: account.wilayah,
                divisi: account.divisi,
                komsel: account.komsel,
                jabatan: account.jabatan,
                role: account.role,
                status: account.status
            }
        };
    }
);
