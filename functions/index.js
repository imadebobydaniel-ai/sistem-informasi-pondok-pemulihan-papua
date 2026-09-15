const { onCall } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const {
    getFirestore,
    FieldValue
} = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { HttpsError } = require("firebase-functions/v2/https");
const { buildRaporStatistics } = require("./rapor-stats");

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
