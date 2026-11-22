(function (root) {
    "use strict";

    // Set only through a reviewed source change after the Worker release gates pass.
    const workerOrigin = null;
    const operations = Object.freeze({ getMyCardToken: "/v1/issue", lookupMemberCard: "/v1/lookup" });
    const cardToken = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
    const nijFormat = /^NIJ-PPP-(ABE|STN|DYO|ARS1|ARS2)-[0-9]{3,9}-[0-9]{4}$/;
    const credentialFormat = /^[A-Za-z0-9_.-]+$/;

    function approvedOrigin() {
        if (typeof workerOrigin === "string") {
            try {
                const url = new URL(workerOrigin);
                if (url.protocol === "https:" && url.origin === workerOrigin &&
                    /\.[a-z]{2,}$/i.test(url.hostname) &&
                    !/(^|\.)(example|invalid|test|localhost|local)(\.|$)/i.test(url.hostname) &&
                    !/placeholder|your-worker/i.test(url.hostname)) return url.origin;
            } catch { /* Reject invalid configuration before acquiring credentials. */ }
        }
        throw new Error("Layanan QR belum dikonfigurasi.");
    }

    function failure(status) {
        const error = new Error(status === 429 ? "Tunggu sebentar sebelum mencoba lagi."
            : status === 401 ? "Sesi QR tidak dapat diverifikasi. Silakan masuk kembali."
            : status === 404 ? "Kartu QR tidak ditemukan atau sudah kedaluwarsa."
            : status === 403 ? "Identitas kartu QR tidak dapat diverifikasi."
            : "Layanan QR tidak tersedia. Coba lagi nanti.");
        error.code = status === 429 ? "resource-exhausted"
            : status === 401 ? "unauthenticated"
            : status === 403 ? "permission-denied"
            : status === 404 ? "not-found" : "unavailable";
        return error;
    }

    function project(result, issue) {
        const profile = result?.profile;
        if (!profile || typeof profile.nij !== "string" || !nijFormat.test(profile.nij) ||
            typeof profile.nama !== "string" || profile.nama.length > 120 ||
            typeof profile.komsel !== "string" || profile.komsel.length > 80) throw failure();
        const identity = { nij: profile.nij, nama: profile.nama, komsel: profile.komsel };
        if (!issue) {
            if (result.verified !== true) throw failure();
            return { profile: identity, verified: true };
        }
        if (typeof result.token !== "string" || !cardToken.test(result.token) ||
            !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= Date.now() ||
            result.expiresAt - Date.now() > 330000) throw failure();
        return { token: result.token, expiresAt: result.expiresAt, profile: identity };
    }

    async function call(name, data, firebase, auth, user, paused, maintenanceMessage) {
        const checkSession = () => {
            if (paused()) throw new Error(maintenanceMessage());
            if (!user || user.isAnonymous || auth.currentUser !== user) throw new Error("Sesi berubah. Masuk kembali.");
        };
        checkSession();
        if (!Object.hasOwn(operations, name)) throw failure();
        const origin = approvedOrigin();
        const issue = name === "getMyCardToken";
        if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).length !== (issue ? 0 : 1) ||
            (!issue && (!Object.hasOwn(data, "token") || typeof data.token !== "string" || !cardToken.test(data.token)))) {
            throw new Error("Permintaan QR tidak valid.");
        }

        const body = JSON.stringify(issue ? {} : { token: data.token });
        let idToken, appToken;
        try { idToken = await user.getIdToken(); } catch { throw failure(401); }
        checkSession();
        try { appToken = await root.SIPAPUA_QR_LIMITED_APP_CHECK(firebase.app().options, root.SIPAPUA_APP_CHECK.configuration); } catch { throw failure(401); }
        checkSession();
        if (typeof idToken !== "string" || !credentialFormat.test(idToken) ||
            typeof appToken !== "string" || !credentialFormat.test(appToken)) throw failure(401);

        const controller = new AbortController();
        const timeout = root.setTimeout(() => controller.abort(), 10000);
        let result, status;
        try {
            const response = await root.fetch(origin + operations[name], {
                method: "POST", mode: "cors", credentials: "omit", cache: "no-store",
                redirect: "error", signal: controller.signal,
                headers: { Authorization: "Bearer " + idToken, "X-Firebase-AppCheck": appToken,
                    "Content-Type": "application/json" },
                body
            });
            status = response.status;
            if (!response.ok) throw failure(status);
            result = await response.json();
        } catch {
            checkSession();
            throw failure(status);
        } finally {
            root.clearTimeout(timeout);
        }
        checkSession();
        return project(result, issue);
    }

    root.SIPAPUA_QR_HTTP = Object.freeze({ call });
})(window);
