(function (root) {
    "use strict";

    const prefix = "SIPAPUA-CARD ";
    const pattern = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
    const storageKey = "sipapua_pending_card_scan";
    const validToken = token => typeof token === "string" && token.length === 43 && pattern.test(token);
    const paused = () => !root.SIPAPUA_MAINTENANCE || root.SIPAPUA_MAINTENANCE.isPaused("memberCard");
    const message = () => root.SIPAPUA_MAINTENANCE?.message("memberCard") ||
        "Kartu QR jemaat sedang dalam pemeliharaan.";

    function takeScan() {
        const token = root.sessionStorage.getItem(storageKey);
        root.sessionStorage.removeItem(storageKey);
        return validToken(token) ? token : null;
    }

    function scanDestination(decodedText) {
        takeScan();
        const token = typeof decodedText === "string" && decodedText.startsWith(prefix)
            ? decodedText.slice(prefix.length) : null;
        if (!validToken(token)) return null;
        root.sessionStorage.setItem(storageKey, token);
        return "bio-singkat-jemaat.html";
    }

    function restoredUser(auth) {
        if (auth.currentUser) return Promise.resolve(auth.currentUser);
        return new Promise((resolve, reject) => {
            const unsubscribe = auth.onAuthStateChanged(user => {
                queueMicrotask(() => unsubscribe());
                resolve(user);
            }, reject);
        });
    }

    async function call(name, data) {
        if (paused()) throw new Error(message());
        const firebase = root.firebase;
        const auth = firebase.auth();
        const user = await restoredUser(auth);
        if (!user || user.isAnonymous) throw new Error("Silakan masuk dengan akun SIPAPUA.");
        const adapter = root.SIPAPUA_QR_HTTP;
        if (!adapter) throw new Error("Layanan QR tidak tersedia.");
        return adapter.call(name, data, firebase, auth, user, paused, message);
    }

    const issue = () => call("getMyCardToken", {});
    const lookup = token => call("lookupMemberCard", {token});

    function render(box, card, size) {
        if (!validToken(card.token) || !(card.expiresAt > Date.now())) throw new Error("QR kartu kedaluwarsa.");
        box.textContent = "";
        new root.QRCode(box, {
            text: prefix + card.token,
            width: size,
            height: size,
            colorDark: "#003366",
            colorLight: "#ffffff",
            correctLevel: root.QRCode.CorrectLevel.M
        });
        const image = box.firstChild;
        root.setTimeout(() => {
            if (box.firstChild === image) box.textContent = "QR kedaluwarsa. Buka kembali kartu digital.";
        }, card.expiresAt - Date.now());
    }

    root.SIPAPUA_MEMBER_CARD = Object.freeze({ paused, message, takeScan, scanDestination, issue, lookup, render });
})(window);
