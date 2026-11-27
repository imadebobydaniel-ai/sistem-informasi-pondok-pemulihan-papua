(function (root) {
    "use strict";

    const areas = Object.freeze({
        ABE: ["Abepura", "abepura"], STN: ["Sentani", "sentani"], DYO: ["Doyo", "doyo"],
        ARS1: ["Arso 1", "arso-1"], ARS2: ["Arso 2", "arso-2"]
    });
    const statuses = { draft: "Draft", published: "Terbit", cancelled: "Dibatalkan" };
    const categories = ["sunday-worship", "other-ministry"];
    const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const dayLength = 86_400_000;
    const day = date => new Date(date + "T00:00:00Z");
    const isoDate = date => date.toISOString().slice(0, 10);
    const validDate = value => datePattern.test(value) && Number.isFinite(+day(value)) && isoDate(day(value)) === value;
    const plusDays = (date, amount) => isoDate(new Date(+day(date) + amount * dayLength));
    const daysBetween = (a, b) => (+day(b) - +day(a)) / dayLength;
    const normalize = name => name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
    const witDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Jayapura", year: "numeric", month: "2-digit", day: "2-digit" });
    const dayLabel = new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jayapura", weekday: "short", day: "numeric", month: "short" });
    const auditTime = new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jayapura", dateStyle: "medium", timeStyle: "short" });

    function validate(fields) {
        if (!fields.title.trim() || !fields.venue.trim() || !fields.leader.trim()) throw new Error("Lengkapi judul, lokasi, dan pemimpin pelayanan.");
        if (!fields.theme.trim() || fields.theme.trim().length > 150) throw new Error("Tema khotbah wajib diisi (maksimal 150 karakter).");
        if (!Object.hasOwn(areas, fields.area) || !categories.includes(fields.category)) throw new Error("Wilayah atau jenis kegiatan tidak valid.");
        if (!validDate(fields.date)) throw new Error("Tanggal WIT tidak valid.");
        if (!timePattern.test(fields.startTime) || !timePattern.test(fields.endTime) || fields.startTime >= fields.endTime) {
            throw new Error("Waktu selesai harus setelah waktu mulai pada tanggal WIT yang sama.");
        }
        const participants = [fields.leader, ...fields.officers.map(person => person.name)].map(normalize);
        if (participants.some(name => !name) || new Set(participants).size !== participants.length) {
            throw new Error("Nama petugas wajib diisi dan setiap orang hanya boleh ditugaskan sekali dalam satu jadwal.");
        }
    }

    function plan(fields, records, options) {
        const { editId, id, scope, weeks, leaderOverrides, makeId } = options;
        if (editId) {
            const selected = records.find(record => record.id === editId);
            if (!selected || selected.status === "cancelled") throw new Error("Jadwal ini tidak dapat diedit.");
            if (scope !== "one" && scope !== "future") throw new Error("Cakupan edit tidak valid.");
            const targets = scope === "future" && selected.seriesId
                ? records.filter(record => record.seriesId === selected.seriesId &&
                    record.seriesIndex >= selected.seriesIndex && record.status !== "cancelled").sort((a, b) => a.seriesIndex - b.seriesIndex)
                : [selected];
            const shift = daysBetween(selected.date, fields.date);
            return targets.map((record, index) => ({
                ...record, ...fields,
                date: plusDays(record.date, shift),
                leader: leaderOverrides.get(index) ?? (index === 0 ? fields.leader : record.leader)
            }));
        }

        if (!Number.isInteger(weeks) || weeks < 1 || weeks > 12) throw new Error("Pengulangan harus antara 1 dan 12 pekan.");
        const used = new Set(records.map(record => record.id));
        return Array.from({ length: weeks }, (_, index) => {
            const recordId = index === 0 ? id : makeId(index);
            if (!recordId || used.has(recordId)) throw new Error("ID jadwal tidak unik.");
            used.add(recordId);
            return {
                ...fields, id: recordId, date: plusDays(fields.date, index * 7),
                leader: leaderOverrides.get(index) ?? fields.leader,
                seriesId: weeks > 1 ? id : null, seriesIndex: index,
                status: "draft", publishedAt: null
            };
        });
    }

    function conflicts(proposed, records) {
        const edited = new Set(proposed.map(record => record.id));
        const candidates = records.filter(record => !edited.has(record.id) && record.status !== "cancelled");
        const results = [];
        for (const item of proposed) {
            const people = new Set([item.leader, ...item.officers.map(person => person.name)].map(normalize));
            for (const existing of candidates) {
                if (existing.date !== item.date || existing.startTime >= item.endTime || existing.endTime <= item.startTime) continue;
                const causes = [];
                if (normalize(item.venue) === normalize(existing.venue)) causes.push("lokasi");
                if (people.has(normalize(existing.leader))) causes.push("pemimpin");
                if (existing.officers.some(person => people.has(normalize(person.name)))) causes.push("petugas");
                if (causes.length) results.push({ item, existing, causes });
            }
            candidates.push(item);
        }
        return results;
    }

    function transition(record, target, timestamp) {
        if (record.status === "draft" && target === "published" && !record.publishedAt) {
            return { ...record, status: target, publishedAt: timestamp };
        }
        if (record.status === "published" && target === "cancelled" && record.publishedAt) {
            return { ...record, status: target };
        }
        throw new Error("Perubahan status ini tidak diizinkan.");
    }

    // The member adapter must receive this allowlisted projection only. Auth
    // ownership, revision, recurrence IDs and audit stay on the admin side.
    function memberProjection(record) {
        if (!["published", "cancelled"].includes(record.status) || !record.publishedAt) return null;
        const { id, title, date, startTime, endTime, category, venue, leader, theme, scripture, publicNotes, status, publishedAt } = record;
        return {
            id, title, date, startTime, endTime, area: areas[record.area][1], category, venue, leader,
            officers: record.officers.map(({ name, role }) => role ? name + " — " + role : name),
            theme, scripture, publicNotes, status, publishedAt
        };
    }

    function calendarPeriod(anchor, mode) {
        const date = day(anchor);
        if (mode === "month") {
            date.setUTCDate(1);
            const start = isoDate(date);
            const offset = (date.getUTCDay() + 6) % 7;
            date.setUTCMonth(date.getUTCMonth() + 1, 0);
            return { start, count: date.getUTCDate(), offset };
        }
        return { start: plusDays(anchor, -(date.getUTCDay() + 6) % 7), count: 7, offset: 0 };
    }

    const managerRole = data => data?.status === "active" && ["master", "super_admin"].includes(data.role) ? data.role : null;
    if (typeof module === "object" && module.exports) {
        module.exports = { areas, validDate, validate, plan, conflicts, transition, memberProjection, calendarPeriod, managerRole };
        return;
    }

    const document = root.document;
    const get = id => document.getElementById(id);
    const form = get("schedule-form");
    const scheduleBackendEnabled = false;
    get("save").disabled = true;
    get("save").textContent = "Simpan draft (backend belum aktif)";
    get("publish").disabled = true;
    get("cancel").disabled = true;
    const field = name => form.elements.namedItem(name);
    const newId = () => root.crypto.randomUUID();
    const createElement = (tag, label) => {
        const element = document.createElement(tag);
        if (label) element.textContent = label;
        return element;
    };
    for (const [id, [label]] of Object.entries(areas)) {
        get("area-filter").add(new Option(label, id));
        field("area").add(new Option(label, id));
    }

    let records = [];
    let audit = [];
    let session;
    let generation = 0;
    let loginUser;
    let editingId;
    let pendingId;
    let pendingOccurrences = [];
    let rotation = new Map();
    let dirty = false;
    let saving = false;
    const anchor = get("anchor");
    anchor.value = witDate.format();

    function render() {
        const status = get("status-filter").value;
        const area = get("area-filter").value;
        const start = validDate(anchor.value) ? anchor.value : witDate.format();
        const end = plusDays(start, 6);
        const query = normalize(get("search").value || "");
        const selected = records.filter(record => record.date >= start && record.date <= end &&
            (!area || record.area === area) && (!status || record.status === status) &&
            (!query || [record.title, record.theme, record.venue, record.leader].some(value => normalize(value || "").includes(query))));
        get("summary").textContent = Object.entries(statuses).map(([key, label]) =>
            label + " " + records.filter(record => record.status === key).length).join(" · ");
        get("period").textContent = "Sesi " + dayLabel.format(day(start)) + " – " + dayLabel.format(day(end)) + " " + end.slice(0, 4) + " · WIT";
        get("empty").hidden = selected.length > 0;
        const rows = selected.slice().sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime)).map(item => {
            const article = createElement("article");
            article.className = "schedule-row";
            const info = createElement("div");
            info.append(createElement("h3", item.title), createElement("div",
                item.theme + " · " + item.date + " · " + item.startTime + " WIT · " + areas[item.area][0] + " · " + item.venue,
                "row-meta"));
            const button = createElement("button", item.startTime + " · " + item.title + " · " + areas[item.area][0] + " · " + statuses[item.status]);
            button.className = "button";
            button.type = "button";
            button.setAttribute("aria-label", "Edit jadwal " + item.title);
            button.addEventListener("click", () => { if (authorized()) openEditor(item); });
            article.append(info, button);
            return article;
        });
        get("calendar").replaceChildren(...rows);
        get("audit").replaceChildren(...audit.slice().reverse().map(event => createElement("li",
            auditTime.format(new Date(event.at)) + " WIT · " + (event.action === "publish" ? "Jadwal diterbitkan" :
                event.action === "cancel" ? "Jadwal dibatalkan" : "Jadwal disimpan") + " · " + event.title)));
        get("audit-empty").hidden = audit.length > 0;
        get("member-preview").textContent = JSON.stringify(records.map(memberProjection).filter(Boolean), null, 2);
    }

    function authorized() {
        return !saving && session && auth.currentUser === session.user;
    }

    function feedback(message, state = "") {
        get("editor-feedback").textContent = message;
        get("editor-feedback").dataset.state = state;
    }

    function renderConflicts(found) {
        get("conflicts").replaceChildren(...found.map(({ item, existing, causes }) => createElement("li",
            item.title + " berbenturan dengan " + existing.title + " · " + areas[existing.area][0] +
            " · " + existing.date + " " + existing.startTime + "–" + existing.endTime + " WIT (" + causes.join(", ") + ").")));
    }

    function updateActions(record) {
        const cancelled = record?.status === "cancelled";
        get("save").disabled = !scheduleBackendEnabled || cancelled;
        get("preview").disabled = cancelled;
        get("publish").hidden = record?.status !== "draft";
        get("cancel").hidden = record?.status !== "published";
        get("publish").disabled = !scheduleBackendEnabled || dirty;
        get("cancel").disabled = !scheduleBackendEnabled || dirty;
        get("editor-state").textContent = (record ? statuses[record.status] : "Draft baru") +
            (record?.publishedAt ? " · Pertama terbit " + auditTime.format(new Date(record.publishedAt)) + " WIT" : "") +
            (dirty ? " · Simpan perubahan sebelum mengubah status." : "");
    }

    function openEditor(record, focus = true) {
        form.reset();
        posterDataUrl = null;
        get("poster-file").value = "";
        get("poster-note").textContent = "Poster belum memiliki penyimpanan permanen. Berkas hanya ditinjau sementara di browser dan tidak ikut tersimpan; anggota memakai poster fallback.";
        get("member-preview-image").src = "poster-fallback.svg";
        get("member-preview-image").alt = "Poster fallback Jadwal Pelayanan SIPAPUA";
        editingId = record?.id;
        pendingId = record?.id || newId();
        pendingOccurrences = [];
        rotation = new Map();
        dirty = false;
        field("id").value = pendingId;
        field("date").value = record?.date || anchor.value || witDate.format();
        if (record) {
            for (const name of ["title", "category", "area", "venue", "startTime", "endTime", "leader", "theme", "scripture", "publicNotes"]) {
                field(name).value = record[name];
            }
            field("officers").value = record.officers.map(({ name, role }) => role ? name + " | " + role : name).join("\n");
        }
        for (const input of form.querySelectorAll("input, select, textarea")) input.disabled = record?.status === "cancelled";
        field("weeks").value = "1";
        field("weeks").disabled = true;
        get("recurrence-label").hidden = true;
        get("scope-label").hidden = !record?.seriesId || record.status === "cancelled";
        get("editor-title").textContent = record ? (record.status === "cancelled" ? "Lihat jadwal" : "Edit jadwal") : "Tambah jadwal";
        get("rotation").replaceChildren();
        renderConflicts([]);
        feedback("");
        updateActions(record);
        renderPreview();
        get("editor").hidden = false;
        if (focus) get("editor-title").focus();
    }

    function buildPlan() {
        const fields = Object.fromEntries(["title", "category", "area", "venue", "date", "startTime", "endTime", "leader", "theme", "scripture", "publicNotes"]
            .map(name => [name, field(name).value.trim()]));
        fields.officers = field("officers").value.split(/\r?\n/).filter(line => line.trim()).map(line => {
            const [name, role = "", extra] = line.split("|").map(part => part.trim());
            if (extra !== undefined) throw new Error("Gunakan format Nama | Peran untuk setiap petugas.");
            return { name, role };
        });
        validate(fields);
        const items = plan(fields, records, {
            editId: editingId, id: pendingId, scope: field("scope").value, weeks: Number(field("weeks").value),
            leaderOverrides: rotation, makeId: index => pendingOccurrences[index] ??= newId()
        });
        for (const item of items) validate(item);
        return items;
    }

    let posterDataUrl = null;
    function renderPreview() {
        const title = field("title").value.trim();
        const theme = field("theme").value.trim();
        const areaLabel = areas[field("area").value]?.[0] || "Wilayah";
        const categoryLabel = field("category").selectedOptions[0]?.textContent || "Pelayanan";
        const dateValue = field("date").value;
        const dateText = validDate(dateValue) ? dayLabel.format(day(dateValue)) : "Tanggal";
        const timeText = field("startTime").value || "Jam";
        const venue = field("venue").value.trim() || "Lokasi gereja";
        get("preview-category").textContent = categoryLabel.toLocaleUpperCase("id-ID");
        get("preview-title").textContent = title || "Judul pelayanan";
        get("preview-theme").textContent = theme || "Tema khotbah akan tampil di sini";
        get("preview-facts").textContent = `${dateText} · ${timeText} WIT · ${venue} · ${areaLabel}`;
        get("preview-leader").textContent = field("leader").value.trim() || "Pelayan firman";
        get("member-preview-image").src = posterDataUrl || "poster-fallback.svg";
        get("member-preview-image").alt = get("preview-image-alt").value.trim() || (posterDataUrl ? "Poster pilihan, pratinjau sementara" : "Poster fallback Jadwal Pelayanan SIPAPUA");
    }

    function sniffPoster(bytes) {
        const b = new Uint8Array(bytes);
        if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
        if (b.length >= 8 && [137,80,78,71,13,10,26,10].every((value,index) => b[index] === value)) return "image/png";
        if (b.length >= 12 && String.fromCharCode(...b.slice(0,4)) === "RIFF" && String.fromCharCode(...b.slice(8,12)) === "WEBP") return "image/webp";
        return null;
    }

    get("poster-file").addEventListener("change", async () => {
        const file = get("poster-file").files?.[0];
        posterDataUrl = null;
        if (!file) { get("poster-note").textContent = "Poster tidak dipilih. Kartu anggota memakai poster fallback."; renderPreview(); return; }
        if (file.size < 1 || file.size > 2 * 1024 * 1024) {
            get("poster-file").value = "";
            get("poster-note").textContent = "Berkas harus berukuran maksimal 2 MB. Tidak ada berkas yang diunggah.";
            feedback("Ukuran poster tidak valid.", "error");
            renderPreview();
            return;
        }
        try {
            const bytes = await file.arrayBuffer();
            const detected = sniffPoster(bytes);
            if (!detected || !["image/jpeg","image/png","image/webp"].includes(file.type) || detected !== file.type) throw new Error("Format atau isi poster tidak didukung.");
            const view = new Uint8Array(bytes);
            let binary = "";
            for (let offset = 0; offset < view.length; offset += 0x8000) binary += String.fromCharCode(...view.subarray(offset, offset + 0x8000));
            const base64 = btoa(binary);
            posterDataUrl = `data:${detected};base64,${base64}`;
            get("poster-note").textContent = "Poster lolos pemeriksaan format/ukuran untuk pratinjau sementara. Tidak diunggah atau disimpan; anggota tetap memakai poster fallback.";
            feedback("Poster hanya tampil sementara di pratinjau browser.");
            renderPreview();
        } catch (error) {
            get("poster-file").value = "";
            posterDataUrl = null;
            get("poster-note").textContent = "Poster tidak lolos pemeriksaan. Tidak ada berkas yang diunggah.";
            feedback(error.message || "Poster tidak valid.", "error");
            renderPreview();
        }
    });
    get("preview-image-alt").addEventListener("input", renderPreview);
    form.addEventListener("input", renderPreview);
    form.addEventListener("change", renderPreview);

    function showRotation(items) {
        get("rotation").replaceChildren(...items.map((item, index) => {
            const label = createElement("label", "Pemimpin · " + item.date + " · " + areas[item.area][0]);
            const input = createElement("input");
            input.value = item.leader;
            input.required = true;
            input.maxLength = 100;
            input.addEventListener("input", () => { rotation.set(index, input.value.trim()); });
            label.append(input);
            return label;
        }));
    }

    get("add").addEventListener("click", () => { if (authorized()) openEditor(); });
    get("close-editor").addEventListener("click", () => { get("editor").hidden = true; get("add").focus(); });
    form.addEventListener("input", event => {
        if (!get("rotation").contains(event.target) && ["date", "weeks", "scope", "leader", "area"].includes(event.target.name)) {
            rotation.clear();
            get("rotation").replaceChildren();
        }
        dirty = true;
        renderConflicts([]);
        updateActions(records.find(item => item.id === editingId));
    });

    get("preview").addEventListener("click", () => {
        if (!authorized() || !form.reportValidity()) return;
        try {
            const items = buildPlan();
            const found = conflicts(items, records);
            showRotation(items);
            renderConflicts(found);
            feedback(items.length + " kejadian siap ditinjau. " + (found.length ? "Periksa benturan sebelum terbit." : "Tidak ada benturan."), found.length ? "error" : "");
        } catch (error) { feedback(error.message, "error"); }
    });

    form.addEventListener("submit", event => {
        event.preventDefault();
        if (!authorized()) return;
        if (!scheduleBackendEnabled) feedback("Backend jadwal belum aktif. Draft tidak disimpan.", "error");
    });
    function changeStatus() {
        if (!authorized()) return;
        if (!scheduleBackendEnabled) feedback("Backend jadwal belum aktif. Status tidak diubah.", "error");
    }
    get("publish").addEventListener("click", () => changeStatus("published"));
    get("cancel").addEventListener("click", () => changeStatus("cancelled"));
    for (const id of ["anchor", "area-filter", "status-filter"]) get(id).addEventListener("change", render);
    get("search").addEventListener("input", render);
    for (const [id, step] of [["previous", -1], ["next", 1]]) {
        get(id).addEventListener("click", () => {
            const date = validDate(anchor.value) ? anchor.value : witDate.format();
            anchor.value = plusDays(date, 7 * step);
            render();
        });
    }

    let auth;
    function clearWorkspace() {
        session = undefined;
        records = [];
        audit = [];
        rotation.clear();
        pendingOccurrences = [];
        editingId = undefined;
        form.reset();
        get("rotation").replaceChildren();
        renderConflicts([]);
        feedback("");
        get("workspace").hidden = true;
        get("editor").hidden = true;
        render();
    }

    const loopbackHost = ["127.0.0.1", "localhost", "::1"].includes(root.location?.hostname);
    if (loopbackHost && !root.firebase) {
        clearWorkspace();
        get("login").hidden = true;
        get("access").textContent = "Pratinjau lokal tertutup. Login Firebase tidak disimulasikan.";
        return;
    }
    try {
        const firebase = root.firebase;
        if (!firebase || !firebase.apps) throw new Error("Firebase SDK unavailable");
        if (!firebase.apps.length) firebase.initializeApp({
            apiKey: "AIzaSyDU2rk0rIF-sos_Sj7C5IMM9dU8z8p_VJM",
            authDomain: "boby-apps-project.firebaseapp.com",
            projectId: "boby-apps-project",
            appId: "1:125984859692:web:09f75df5d2e4b6e3bcd389"
        });
        auth = firebase.auth();
        auth.onAuthStateChanged(async user => {
            const request = ++generation;
            loginUser = user;
            clearWorkspace();
            get("login").hidden = !!user && !user.isAnonymous;
            if (!user || user.isAnonymous) {
                get("access").textContent = "Masuk sebagai Master atau SuperAdmin aktif.";
                return;
            }
            get("access").textContent = "Memeriksa izin administrator…";
            try {
                const admin = await firebase.firestore().collection("admin_users").doc(user.uid).get({ source: "server" });
                if (request !== generation || auth.currentUser !== user) return;
                const data = admin.exists ? admin.data() : null;
                const role = admin.metadata?.fromCache === false && admin.metadata.hasPendingWrites === false ? managerRole(data) : null;
                if (!role || (role === "master" && data.protected !== true)) {
                    get("access").textContent = "Pengelolaan jadwal hanya tersedia untuk Master atau SuperAdmin aktif.";
                    return;
                }
                session = { user, role };
                get("workspace").hidden = false;
                if (get("storage-mode")) get("storage-mode").textContent = "Pratinjau non-persisten. Backend jadwal belum diaktifkan.";
                get("access").textContent = "Akses administrator terverifikasi · " + (role === "master" ? "Master" : "SuperAdmin") + " · pratinjau non-persisten.";
            } catch (_) {
                if (request === generation && auth.currentUser === user) {
                    get("access").textContent = "Izin administrator belum dapat dikonfirmasi. Muat ulang halaman.";
                }
            }
        }, () => {
            ++generation;
            loginUser = undefined;
            clearWorkspace();
            get("access").textContent = "Sesi administrator belum dapat diperiksa.";
        });
    } catch (_) {
        clearWorkspace();
        get("access").textContent = "Layanan sesi administrator belum termuat. Muat ulang halaman.";
    }
})(typeof window === "object" ? window : globalThis);