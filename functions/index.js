const { onCall } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const {
    getFirestore,
    FieldValue
} = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { HttpsError } = require("firebase-functions/v2/https");

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
        String(
            data.role || ""
        )
            .trim()
            .toLowerCase();

    const status =
        String(
            data.status || "inactive"
        )
            .trim()
            .toLowerCase();

    if (
        ![
            "master",
            "super_admin",
            "admin"
        ].includes(role)
    ) {
        throw new HttpsError(
            "permission-denied",
            "Akses administrator tidak sah."
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

exports.adminGetRoleCounts = onCall(
    {
        region: "asia-southeast2",
        enforceAppCheck:
            process.env.FUNCTIONS_EMULATOR !== "true"
    },
    async (request) => {
        await getCallerAdmin(request);

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
                    String(
                        data.role || ""
                    )
                        .trim()
                        .toLowerCase();

                const status =
                    String(
                        data.status || "inactive"
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
            limits: ADMIN_LIMITS
        };
    }
);

function normalizeAdminRole(value) {
    return String(
        value || ""
    )
        .trim()
        .toLowerCase();
}

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
