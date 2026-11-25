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
    const anchor = get("anchor");
    anchor.value = witDate.format();

    function render() {
        const status = get("status-filter").value;
        const area = get("area-filter").value;
        const { start, count, offset } = calendarPeriod(validDate(anchor.value) ? anchor.value : witDate.format(), get("calendar-mode").value);
        const end = plusDays(start, count - 1);
        const selected = records.filter(record => record.date >= start && record.date <= end &&
            (!area || record.area === area) && (!status || record.status === status));
        get("summary").textContent = Object.entries(statuses).map(([key, label]) =>
            label + " " + records.filter(record => record.status === key).length).join(" · ");
        get("period").textContent = dayLabel.format(day(start)) + " – " + dayLabel.format(day(end)) + " " + end.slice(0, 4) + " · WIT";
        get("empty").hidden = selected.length > 0;
        const cells = Array.from({ length: offset }, () => {
            const cell = createElement("div");
            cell.className = "day offset";
            cell.setAttribute("aria-hidden", "true");
            return cell;
        });
        for (let index = 0; index < count; index++) {
            const date = plusDays(start, index);
            const cell = createElement("div");
            cell.className = "day";
            cell.append(createElement("h3", dayLabel.format(day(date))));
            for (const item of selected.filter(record => record.date === date).sort((a, b) => a.startTime.localeCompare(b.startTime))) {
                const button = createElement("button", item.startTime + " · " + item.title + " · " + areas[item.area][0] + " · " + statuses[item.status]);
                button.className = "secondary";
                button.type = "button";
                button.addEventListener("click", () => { if (authorized()) openEditor(item); });
                cell.append(button);
            }
            cells.push(cell);
        }
        get("calendar").replaceChildren(...cells);
        get("audit").replaceChildren(...audit.slice().reverse().map(event => createElement("li",
            auditTime.format(new Date(event.at)) + " WIT · " + event.role + " · " + event.action + " · " + event.title +
                " (" + (statuses[event.before] || "baru") + " → " + statuses[event.after] + ")")));
        get("member-preview").textContent = JSON.stringify(records.map(memberProjection).filter(Boolean), null, 2);
    }

    function authorized() {
        return session && auth.currentUser === session.user;
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
        get("save").disabled = cancelled;
        get("preview").disabled = cancelled;
        get("publish").hidden = record?.status !== "draft";
        get("cancel").hidden = record?.status !== "published";
        get("publish").disabled = dirty;
        get("cancel").disabled = dirty;
        get("editor-state").textContent = (record ? statuses[record.status] : "Draft baru") +
            (record?.publishedAt ? " · Pertama terbit " + auditTime.format(new Date(record.publishedAt)) + " WIT" : "") +
            (dirty ? " · Perbarui contoh sebelum mengganti status." : "");
    }

    function openEditor(record, focus = true) {
        form.reset();
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
        field("weeks").disabled = !!record;
        get("recurrence-label").hidden = !!record;
        get("scope-label").hidden = !record?.seriesId || record.status === "cancelled";
        get("editor-title").textContent = record ? (record.status === "cancelled" ? "Lihat jadwal" : "Edit jadwal") : "Tambah jadwal";
        get("rotation").replaceChildren();
        renderConflicts([]);
        feedback("");
        updateActions(record);
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

    function save(items, action) {
        const at = new Date().toISOString();
        for (const item of items) {
            const index = records.findIndex(existing => existing.id === item.id);
            const before = index === -1 ? null : records[index].status;
            if (index === -1) records.push(item);
            else records[index] = item;
            audit.push({ scheduleId: item.id, actorUid: session.user.uid, role: session.role, action, at, before, after: item.status, title: item.title });
        }
        render();
    }

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
        if (!authorized() || !form.reportValidity()) return;
        try {
            const items = buildPlan();
            const found = conflicts(items, records);
            if (found.length && items.some(item => item.status === "published")) {
                renderConflicts(found);
                throw new Error("Selesaikan benturan sebelum merevisi jadwal terbit.");
            }
            const action = editingId ? "Revisi" : "Buat draft";
            anchor.value = items[0].date;
            save(items, action);
            openEditor(records.find(record => record.id === items[0].id), false);
            renderConflicts(found);
            feedback(items.length + " kejadian ditambahkan ke pratinjau halaman." + (found.length ? " Draft masih memiliki benturan." : ""));
        } catch (error) { feedback(error.message, "error"); }
    });

    function changeStatus(target) {
        if (!authorized() || dirty) return;
        const record = records.find(item => item.id === editingId);
        if (!record) return;
        try {
            if (target === "published") {
                const found = conflicts([record], records);
                renderConflicts(found);
                if (found.length) throw new Error("Selesaikan benturan sebelum menerbitkan.");
            }
            if (!root.confirm(target === "published" ? "Tampilkan status terbit pada contoh jadwal ini?" : "Tampilkan status dibatalkan pada contoh ini?")) return;
            const next = transition(record, target, new Date().toISOString());
            save([next], target === "published" ? "Simulasi terbit" : "Simulasi pembatalan");
            openEditor(records.find(item => item.id === record.id), false);
            feedback(target === "published" ? "Contoh sekarang berstatus terbit. Tidak ada jadwal yang dipublikasikan." : "Contoh sekarang berstatus dibatalkan.");
        } catch (error) { feedback(error.message, "error"); }
    }
    get("publish").addEventListener("click", () => changeStatus("published"));
    get("cancel").addEventListener("click", () => changeStatus("cancelled"));
    for (const id of ["calendar-mode", "anchor", "area-filter", "status-filter"]) get(id).addEventListener("change", render);
    for (const [id, step] of [["previous", -1], ["next", 1]]) {
        get(id).addEventListener("click", () => {
            const date = validDate(anchor.value) ? anchor.value : witDate.format();
            if (get("calendar-mode").value === "month") {
                const month = day(date);
                month.setUTCDate(1);
                month.setUTCMonth(month.getUTCMonth() + step);
                anchor.value = isoDate(month);
            } else {
                anchor.value = plusDays(date, 7 * step);
            }
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

    try {
        const firebase = root.firebase;
        if (!firebase.apps.length) firebase.initializeApp({
            apiKey: "AIzaSyDU2rk0rIF-sos_Sj7C5IMM9dU8z8p_VJM",
            authDomain: "boby-apps-project.firebaseapp.com",
            projectId: "boby-apps-project",
            appId: "1:125984859692:web:09f75df5d2e4b6e3bcd389"
        });
        auth = firebase.auth();
        auth.onAuthStateChanged(async user => {
            if (auth.currentUser !== user || loginUser === user) return;
            loginUser = user;
            const request = ++generation;
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
                const role = admin.metadata?.fromCache === false && admin.metadata.hasPendingWrites === false && managerRole(data);
                // Apply the dashboard's protection requirement to Master previews without embedding an account UID.
                if (!role || (role === "master" && data.protected !== true)) {
                    get("access").textContent = "Pengelolaan jadwal hanya tersedia untuk Master atau SuperAdmin aktif.";
                    return;
                }
                session = { user, role };
                get("workspace").hidden = false;
                get("access").textContent = "Akses pratinjau non-persisten · " + (role === "master" ? "Master" : "SuperAdmin");
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
        get("access").textContent = "Layanan sesi administrator belum termuat. Muat ulang halaman.";
    }
})(typeof window === "object" ? window : globalThis);
