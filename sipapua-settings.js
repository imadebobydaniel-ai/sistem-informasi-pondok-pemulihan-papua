(function (root) {
    "use strict";

    const preferenceKey = uid => "sipapua.settings.v1:" + uid;
    const startKey = uid => "sipapua.settings.session:" + uid;
    const minutes = value => [0, 30, 60].includes(value) ? value : 0;

    function read(uid) {
        const saved = JSON.parse(root.localStorage.getItem(preferenceKey(uid))) || {};
        return {
            timer: minutes(saved.timer),
            bible: saved.bible === true,
            sound: saved.sound === true,
            theme: saved.theme === "dark" ? "dark" : "light",
            textSize: saved.textSize === "large" ? "large" : "normal"
        };
    }

    function watchTimeout(auth, expire, report) {
        let timer;
        let expiring;
        function refresh() {
            root.clearTimeout(timer);
            const user = auth.currentUser;
            if (!user || expiring === user) return;
            try {
                const duration = read(user.uid).timer;
                const key = startKey(user.uid);
                if (!duration) {
                    root.sessionStorage.removeItem(key);
                    return;
                }
                const now = Date.now();
                let started = Number(root.sessionStorage.getItem(key));
                if (!Number.isSafeInteger(started) || started <= 0 || started > now) {
                    started = now;
                    root.sessionStorage.setItem(key, String(now));
                }
                const remaining = started + duration * 60_000 - now;
                if (remaining > 0) {
                    timer = root.setTimeout(refresh, remaining);
                } else {
                    expiring = user;
                    Promise.resolve().then(() => {
                        if (auth.currentUser === user) return expire(user);
                    }).catch(report).finally(() => { expiring = undefined; });
                }
            } catch (_) {
                report();
            }
        }
        auth.onAuthStateChanged(refresh);
        root.addEventListener("storage", event => {
            if (auth.currentUser && (event.key === null || event.key === preferenceKey(auth.currentUser.uid))) refresh();
        });
        root.document.addEventListener("visibilitychange", () => {
            if (!root.document.hidden) refresh();
        });
        return refresh;
    }

    function clearSession(uid) {
        root.sessionStorage.removeItem(startKey(uid));
    }

    root.SIPAPUA_SETTINGS = Object.freeze({ watchTimeout, clearSession });
    const page = root.document.getElementById("settings");
    if (!page) return;
    const byId = id => root.document.getElementById(id);
    const sections = [...page.querySelectorAll("section")];
    const links = [...page.querySelectorAll("nav a")];
    function activateSection(focus = false) {
        const id = root.location.hash.slice(1);
        const active = sections.find(section => section.id === id) || sections[0];
        for (const section of sections) section.hidden = section !== active;
        for (const link of links) {
            if (link.hash === "#" + active.id) link.setAttribute("aria-current", "location");
            else link.removeAttribute("aria-current");
        }
        if (focus) active.querySelector("h2").focus();
    }
    root.addEventListener("hashchange", () => activateSection(true));
    activateSection();

    const maintenance = root.SIPAPUA_MAINTENANCE;
    const paused = !maintenance || maintenance.isPaused("memberCard");
    byId("qr-status").textContent = paused
        ? maintenance?.message("memberCard") || "Kartu Digital dalam pemeliharaan."
        : "Kartu Digital tersedia untuk akun yang memenuhi syarat.";
    byId("open-card").hidden = paused;

    const firebase = root.firebase;
    const sessionStatus = byId("session-status");
    if (typeof firebase?.auth !== "function") {
        sessionStatus.textContent = "Layanan login belum termuat. Muat ulang halaman untuk mengaktifkan pengaturan akun.";
        byId("open-card").hidden = true;
        return;
    }
    const auth = firebase.auth();
    let user;
    let profile;
    let busy = false;
    let generation = 0;
    const buttons = id => byId(id).querySelector("button");
    const normalizedEmail = value => String(value || "").trim().toLowerCase();
    const passwordProvider = current => current?.providerData?.some(provider => provider.providerId === "password");
    const requireSession = current => {
        if (!current || current.isAnonymous || auth.currentUser !== current) {
            throw new Error("Sesi berubah. Masuk kembali.");
        }
    };

    function availability() {
        const signedIn = !!user && auth.currentUser === user;
        const editable = signedIn && !!profile;
        const hasPassword = signedIn && passwordProvider(user) && !!user.email;
        const canChangeEmail = hasPassword && typeof user.verifyBeforeUpdateEmail === "function";
        const canSync = editable && user.emailVerified && user.email &&
            normalizedEmail(profile.data().email) !== normalizedEmail(user.email);
        byId("sync-form").hidden = !canSync;
        byId("open-card").hidden = paused || !signedIn;
        buttons("profile-form").disabled = busy || !editable;
        buttons("sync-form").disabled = busy || !canSync;
        buttons("email-form").disabled = busy || !editable || !canChangeEmail;
        buttons("password-form").disabled = busy || !hasPassword;
        byId("profile-edit-status").textContent = editable ? "" : "Perubahan tersedia setelah profil dikonfirmasi.";
        byId("email-edit-status").textContent = !editable ? "Perubahan tersedia setelah profil dikonfirmasi."
            : !hasPassword ? "Perubahan email memerlukan akun dengan metode masuk email dan password."
            : !canChangeEmail ? "Verifikasi perubahan email belum tersedia di browser ini." : "";
        byId("password-edit-status").textContent = !signedIn ? "Masuk untuk mengubah password."
            : !hasPassword ? "Akun ini tidak memiliki metode masuk email dan password." : "";
        buttons("verify-form").disabled = busy || !signedIn || !user.email || user.emailVerified;
        for (const id of ["session-form", "logout-form", "notification-form", "appearance-form"]) {
            buttons(id).disabled = busy || !signedIn;
        }
    }

    function applyPreferences(prefs) {
        byId("timer").value = String(prefs.timer);
        byId("sound").checked = prefs.sound;
        byId("bible").checked = prefs.bible;
        byId("theme").value = prefs.theme;
        byId("text-size").value = prefs.textSize;
        root.document.documentElement.dataset.theme = prefs.theme;
        root.document.documentElement.dataset.text = prefs.textSize;
    }

    function showIdentity(current, snapshot, fillPhone = true) {
        const data = snapshot?.data();
        byId("member-name").textContent = data?.nama || data?.nama_lengkap || "—";
        byId("member-email").textContent = current?.email || "—";
        byId("member-nij").textContent = data?.nij || "—";
        if (fillPhone) byId("whatsapp").value = data?.whatsapp || "";
        byId("verification").textContent = current?.email
            ? (current.emailVerified ? "Email terverifikasi." : "Email belum terverifikasi.")
            : "Email akun tidak tersedia.";
    }

    async function readProfile(current) {
        const snapshot = await root.SIPAPUA_MEMBER_SESSION.create(firebase).ownProfile();
        requireSession(current);
        const uid = snapshot.data()?.uid;
        if ((uid && uid !== current.uid) || (snapshot.id !== current.uid && uid !== current.uid)) {
            throw new Error("Kepemilikan profil belum terverifikasi.");
        }
        return snapshot;
    }

    async function logout(current) {
        requireSession(current);
        await auth.signOut();
        if (auth.currentUser) return;
        try {
            clearSession(current.uid);
            root.sessionStorage.removeItem("sipapua_session_started_at");
            root.sessionStorage.removeItem("sipapua_popup_dismissed");
            root.localStorage.removeItem("userEmail");
            root.localStorage.removeItem("userUid");
        } catch (_) { /* Auth sign-out already succeeded. */ }
    }

    const refreshTimeout = watchTimeout(auth, logout, () => {
        sessionStatus.textContent = "Logout otomatis belum dapat dijalankan. Gunakan tombol Keluar.";
    });

    auth.onAuthStateChanged(async current => {
        const request = ++generation;
        user = current && !current.isAnonymous ? current : null;
        profile = null;
        for (const form of page.querySelectorAll("form")) {
            form.reset();
            form.querySelector(".feedback").textContent = "";
        }
        showIdentity(user, null);
        applyPreferences({ timer: 0, sound: false, bible: false, theme: "light", textSize: "normal" });
        availability();
        if (!user) {
            root.location.replace("index.html");
            return;
        }
        sessionStatus.textContent = "Memuat profil anggota…";
        let preferencesAvailable = true;
        try { applyPreferences(read(user.uid)); } catch (_) { preferencesAvailable = false; }
        try {
            await current.reload();
            requireSession(current);
            const snapshot = await readProfile(current);
            if (request !== generation) return;
            profile = snapshot;
            showIdentity(current, profile);
            sessionStatus.textContent = preferencesAvailable ? "Sesi anggota aktif." : "Preferensi browser belum dapat dibaca.";
        } catch (_) {
            if (request !== generation) return;
            showIdentity(current, null);
            sessionStatus.textContent = "Profil belum dapat dikonfirmasi. Muat ulang atau hubungi pengurus.";
        }
        availability();
    });

    function errorMessage(error) {
        const messages = {
            "auth/requires-recent-login": "Demi keamanan, masuk kembali lalu coba lagi.",
            "auth/wrong-password": "Password saat ini salah.",
            "auth/invalid-credential": "Kredensial saat ini tidak valid.",
            "auth/invalid-email": "Format email tidak valid.",
            "auth/email-already-in-use": "Email sudah digunakan.",
            "auth/weak-password": "Password baru belum memenuhi kebijakan Firebase.",
            "auth/too-many-requests": "Terlalu banyak percobaan. Coba lagi nanti.",
            "permission-denied": "Server menolak perubahan. Hubungi pengurus jika masalah berlanjut."
        };
        if (error.code === "settings/input") return error.message;
        if (error.message === "Identitas sudah digunakan.") return "Nomor atau identitas sudah digunakan.";
        return messages[error.code] || "Perubahan belum dapat dikonfirmasi. Periksa sesi dan koneksi, lalu coba lagi.";
    }

    function inputError(message) {
        throw Object.assign(new Error(message), { code: "settings/input" });
    }

    function bind(id, operation) {
        const form = byId(id);
        const feedback = form.querySelector(".feedback");
        form.addEventListener("submit", async event => {
            event.preventDefault();
            if (busy || buttons(id).disabled) return;
            const current = user;
            const request = generation;
            busy = true;
            availability();
            form.setAttribute("aria-busy", "true");
            feedback.dataset.state = "loading";
            feedback.textContent = "Memproses…";
            try {
                requireSession(current);
                const message = await operation(current, profile);
                if (request === generation) {
                    feedback.dataset.state = "saved";
                    feedback.textContent = message;
                }
            } catch (error) {
                if (request === generation) {
                    feedback.dataset.state = "error";
                    feedback.textContent = errorMessage(error);
                }
            } finally {
                form.removeAttribute("aria-busy");
                busy = false;
                availability();
            }
        });
    }

    async function updateProfile(current, snapshot, changes) {
        if (!snapshot) inputError("Profil belum dikonfirmasi.");
        requireSession(current);
        const service = root.SIPAPUA_REGISTRATION.create(firebase.firestore(), auth,
            () => firebase.firestore.FieldValue.serverTimestamp());
        await service.updateProfile(snapshot.id, changes);
        const saved = await readProfile(current);
        profile = saved;
        showIdentity(current, saved, false);
        return saved.data();
    }

    async function reauthenticate(current, field) {
        if (!passwordProvider(current) || !current.email) inputError("Perubahan ini memerlukan akun email dan password.");
        const credential = firebase.auth.EmailAuthProvider.credential(current.email, byId(field).value);
        await current.reauthenticateWithCredential(credential);
        requireSession(current);
    }

    bind("profile-form", async (current, snapshot) => {
        const input = byId("whatsapp").value.trim();
        const normalized = root.SIPAPUA_REGISTRATION.normalizePhone(input);
        if (!/^\+?[\d .()-]+$/.test(input) || !/^62\d{8,13}$/.test(normalized)) {
            inputError("Masukkan nomor WhatsApp Indonesia yang valid, diawali 08 atau +62.");
        }
        const saved = await updateProfile(current, snapshot, { whatsapp: input });
        if (root.SIPAPUA_REGISTRATION.normalizePhone(saved.whatsapp) !== normalized) {
            inputError("Nomor yang tersimpan belum cocok. Muat ulang sebelum mencoba lagi.");
        }
        byId("whatsapp").value = saved.whatsapp;
        return "Nomor WhatsApp tersimpan.";
    });

    bind("email-form", async current => {
        const email = normalizedEmail(byId("new-email").value);
        if (!email || email === normalizedEmail(current.email)) inputError("Masukkan alamat email yang berbeda.");
        if (typeof current.verifyBeforeUpdateEmail !== "function") inputError("Verifikasi perubahan email belum tersedia.");
        if (!root.confirm("Kirim tautan perubahan email ke alamat baru?")) return "Dibatalkan.";
        await reauthenticate(current, "email-password");
        await current.verifyBeforeUpdateEmail(email);
        requireSession(current);
        byId("email-password").value = "";
        return "Tautan verifikasi dikirim. Email berubah setelah tautan dikonfirmasi.";
    });

    bind("sync-form", async (current, snapshot) => {
        await current.reload();
        requireSession(current);
        if (!current.emailVerified || !current.email) inputError("Email baru belum terverifikasi.");
        const email = normalizedEmail(current.email);
        const saved = await updateProfile(current, snapshot, { email, email_normalized: email });
        if (normalizedEmail(saved.email) !== email) inputError("Email profil belum cocok. Hubungi pengurus.");
        sessionStatus.textContent = "Email Auth dan profil sudah cocok.";
        return "Email profil tersinkron.";
    });

    bind("password-form", async current => {
        const password = byId("new-password").value;
        if (password.length < 6 || password !== byId("confirm-password").value) {
            inputError("Gunakan minimal enam karakter dan pastikan kedua password baru cocok.");
        }
        if (!root.confirm("Ubah password akun ini?")) return "Dibatalkan.";
        await reauthenticate(current, "current-password");
        await current.updatePassword(password);
        requireSession(current);
        byId("password-form").reset();
        return "Password diperbarui.";
    });

    bind("verify-form", async current => {
        await current.reload();
        requireSession(current);
        showIdentity(current, profile, false);
        if (current.emailVerified) return "Email sudah terverifikasi.";
        await current.sendEmailVerification();
        return "Tautan verifikasi dikirim.";
    });
    bind("logout-form", async current => {
        if (!root.confirm("Keluar dari SIPAPUA?")) return "Dibatalkan.";
        await logout(current);
        return "Sesi berakhir.";
    });

    function save(current, changes) {
        requireSession(current);
        try {
            const key = preferenceKey(current.uid);
            root.localStorage.setItem(key, JSON.stringify({ ...read(current.uid), ...changes }));
            return read(current.uid);
        } catch (_) {
            inputError("Preferensi tidak dapat disimpan di browser ini.");
        }
    }
    bind("session-form", current => {
        const timer = minutes(Number(byId("timer").value));
        const saved = save(current, { timer });
        byId("timer").value = String(saved.timer);
        refreshTimeout();
        return "Waktu logout tersimpan untuk akun ini.";
    });
    bind("notification-form", current => {
        const saved = save(current, { bible: byId("bible").checked, sound: byId("sound").checked });
        byId("bible").checked = saved.bible;
        byId("sound").checked = saved.sound;
        return "Preferensi notifikasi tersimpan.";
    });
    bind("appearance-form", current => {
        const theme = byId("theme").value === "dark" ? "dark" : "light";
        const textSize = byId("text-size").value === "large" ? "large" : "normal";
        const saved = save(current, { theme, textSize });
        root.document.documentElement.dataset.theme = saved.theme;
        root.document.documentElement.dataset.text = saved.textSize;
        byId("theme").value = saved.theme;
        byId("text-size").value = saved.textSize;
        return "Tampilan tersimpan.";
    });
})(window);
