(function (global) {
    var registry = global.__SIPAPUA_NOTIFICATION_MODULES__ = global.__SIPAPUA_NOTIFICATION_MODULES__ || {};
    if (registry.errorNormalizer) return;

    var MESSAGES = {
        "permission-denied": "Anda tidak memiliki izin untuk melakukan tindakan ini.",
        "unauthenticated": "Sesi Anda berakhir. Silakan login kembali.",
        "auth/user-not-found": "Akun tidak ditemukan.",
        "auth/wrong-password": "Email atau password tidak sesuai.",
        "auth/invalid-credential": "Email atau password tidak sesuai.",
        "auth/too-many-requests": "Terlalu banyak percobaan. Silakan coba lagi nanti.",
        "resource-exhausted": "Terlalu banyak permintaan. Silakan coba lagi nanti.",
        "network": "Koneksi tidak tersedia. Periksa internet lalu coba lagi.",
        "auth/network-request-failed": "Koneksi tidak tersedia. Periksa internet lalu coba lagi.",
        "unavailable": "Layanan sedang tidak dapat dihubungi. Periksa koneksi lalu coba lagi.",
        "not-found": "Data tidak ditemukan.",
        "already-exists": "Data sudah ada.",
        "failed-precondition": "Permintaan belum dapat diproses saat ini.",
        "deadline-exceeded": "Permintaan terlalu lama diproses.",
        "invalid-argument": "Data yang dikirim belum valid.",
        "internal": "Sistem mengalami gangguan. Silakan coba lagi."
    };

    // HTTP statuses that mean the same thing as a mapped code.
    var STATUS_CODES = { "401": "unauthenticated", "403": "permission-denied", "404": "not-found", "429": "resource-exhausted" };

    // Service prefixes such as "firestore/permission-denied" share one user message.
    function canonicalCode(error) {
        var raw = String(error && (error.code || error.status || error.name) || "").toLowerCase();
        var code = raw.replace(/^(firestore|functions|storage|database)\//, "");
        return STATUS_CODES[code] || code;
    }

    // The raw backend message is never part of the default result; `detail` is opt-in.
    function normalize(error, options) {
        options = options || {};
        var code = canonicalCode(error);
        var message = options.userMessage || MESSAGES[code] || "Operasi belum dapat diselesaikan. Silakan coba lagi.";
        return { code: code || "unknown", message: message, detail: options.includeDetail ? String(error && error.message || "") : undefined };
    }

    registry.errorNormalizer = normalize;
}(window));
