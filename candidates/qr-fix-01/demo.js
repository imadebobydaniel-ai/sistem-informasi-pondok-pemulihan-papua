(() => {
    "use strict";
    const el = id => document.getElementById(id);
    const tokenFormat = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
    const prefix = "SIPAPUA-CARD ";
    const routes = new Set(["/mock/login", "/mock/app-check", "/v1/issue", "/v1/lookup"]);
    let session, generation = 0, expiration;
    const setStatus = text => { el("status").textContent = text; };
    function clearCard() {
        clearTimeout(expiration);
        el("qr").replaceChildren();
        el("profile").textContent = "";
    }
    function show(profile) {
        if (!profile || ["nama", "nij", "komsel"].some(key => typeof profile[key] !== "string")) {
            throw Error("Respons identitas tidak valid.");
        }
        el("profile").textContent = [profile.nama, profile.nij, profile.komsel].filter(Boolean).join(" · ");
    }
    function assertLocal() {
        if (location.protocol !== "http:" || location.hostname !== "127.0.0.1" || !location.port) {
            throw Error("Demo hanya tersedia di loopback.");
        }
    }
    async function post(path, body, headers = {}) {
        assertLocal();
        if (!routes.has(path)) throw Error("Endpoint demo tidak valid.");
        let response;
        try {
            response = await fetch(path, {
                method: "POST", credentials: "omit", redirect: "error", cache: "no-store",
                signal: AbortSignal.timeout(10000),
                headers: {"Content-Type": "application/json", ...headers}, body: JSON.stringify(body)
            });
        } catch { throw Error("Layanan QR tidak tersedia."); }
        if (!response.ok) {
            const messages = {401:"Sesi atau App Check tidak valid.",403:"Identitas tidak dapat diverifikasi.",
                404:"Kartu tidak ditemukan, sudah dipakai, atau kedaluwarsa.",429:"Batas penerbitan atau pemindaian tercapai."};
            throw Error(messages[response.status] || "Layanan QR tidak tersedia.");
        }
        return response.json();
    }
    async function call(operation, token) {
        const issue = operation === "issue";
        if (!issue && (operation !== "lookup" || !tokenFormat.test(token))) throw Error("QR kartu tidak valid.");
        const current = session;
        if (!current) throw Error("Masuk dengan akun sintetis terlebih dahulu.");
        const auth = {Authorization:"Bearer " + current.idToken};
        const {token:attestation} = await post("/mock/app-check", {}, auth);
        if (session !== current || !attestation) throw Error("Sesi berubah. Masuk kembali.");
        const data = await post(issue ? "/v1/issue" : "/v1/lookup", issue ? {} : {token}, {
            ...auth, "X-Firebase-AppCheck":attestation
        });
        if (session !== current) throw Error("Sesi berubah. Masuk kembali.");
        return data;
    }
    function run(action) {
        const request = generation;
        return action().catch(error => {
            if (generation === request) setStatus(error.message);
        });
    }
    function login(identity) {
        generation++;
        session = undefined;
        clearCard();
        el("issue").disabled = el("scan").disabled = true;
        const request = generation;
        return run(async () => {
            const result = await post("/mock/login", {identity});
            if (request !== generation) return;
            if (!result.idToken) throw Error("Login sintetis gagal.");
            session = result;
            el("issue").disabled = el("scan").disabled = false;
            setStatus("Sesi sintetis aktif.");
        });
    }
    el("member").onclick = () => login("issuer");
    el("scanner").onclick = () => login("scanner");
    el("issue").onclick = () => run(async () => {
        clearCard();
        const card = await call("issue");
        if (!tokenFormat.test(card.token) || !Number.isSafeInteger(card.expiresAt) || card.expiresAt <= Date.now()) {
            throw Error("QR kartu kedaluwarsa.");
        }
        show(card.profile);
        new QRCode(el("qr"), {text:prefix+card.token, width:256, height:256, correctLevel:QRCode.CorrectLevel.M});
        setStatus("QR siap dipindai.");
        expiration = setTimeout(() => {
            clearCard();
            setStatus("QR kedaluwarsa. Terbitkan kartu baru.");
        }, card.expiresAt - Date.now());
    });
    el("scan").onchange = () => run(async () => {
        const scanner = session;
        const file = el("scan").files[0];
        el("scan").value = "";
        clearCard();
        if (!file || file.size > 5_000_000) throw Error("Pilih gambar QR maksimal 5 MB.");
        const image = await createImageBitmap(file);
        const size = Math.min(1, 1024 / Math.max(image.width, image.height));
        const canvas = Object.assign(document.createElement("canvas"), {width:Math.ceil(image.width*size),height:Math.ceil(image.height*size)});
        const ctx = canvas.getContext("2d", {willReadFrequently:true});
        ctx.drawImage(image,0,0,canvas.width,canvas.height);
        image.close();
        const {data} = ctx.getImageData(0,0,canvas.width,canvas.height);
        const decoded = jsQR(data,canvas.width,canvas.height)?.data;
        if (!decoded?.startsWith(prefix)) throw Error("QR kartu tidak valid.");
        if (session !== scanner) throw Error("Sesi berubah. Masuk kembali.");
        const result = await call("lookup",decoded.slice(prefix.length));
        if (result.verified !== true) throw Error("Hasil pemindaian tidak terverifikasi.");
        show(result.profile);
        setStatus("Kartu terverifikasi.");
    });
})();
