(function (root) {
    "use strict";

    // Browser-only integration candidate. It is inert off the explicit local
    // loopback origin and only accepts short-lived ID tokens issued by the
    // local Firebase Auth Emulator for synthetic test accounts. No Firebase
    // SDK or persistent token storage is used.
    if (root.location?.hostname !== "127.0.0.1" || root.location?.protocol !== "http:") return;
    const origin = root.location.origin;
    const resourceNames = new Map([
        ["10000000-0000-4000-8000-000000000001", "Synthetic Venue One"],
        ["10000000-0000-4000-8000-000000000002", "Synthetic Venue Two"],
        ["10000000-0000-4000-8000-000000000003", "Synthetic Venue Three"],
        ["20000000-0000-4000-8000-000000000001", "Synthetic Pastor One"],
        ["20000000-0000-4000-8000-000000000002", "Synthetic Pastor Two"],
        ["20000000-0000-4000-8000-000000000003", "Synthetic Pastor Three"],
        ["20000000-0000-4000-8000-000000000004", "Synthetic Pastor Four"],
        ["20000000-0000-4000-8000-000000000005", "Synthetic Officer One"]
    ]);
    const resourceIds = new Map([...resourceNames].map(([id, name]) => [name.normalize("NFKC").trim().toLowerCase(), id]));

    function getToken() {
        const token = root.__SIPAPUA_LOCAL_TEST_TOKEN;
        if (typeof token !== "string" || token.length < 20 || token.length > 16384) throw new Error("Sesi sintetis lokal tidak tersedia. Jalankan harness E2E lokal.");
        return token;
    }

    function safeMessage(code) {
        return ({ schedule_conflict: "Jadwal berbenturan dengan lokasi atau petugas lain.",
            revision_or_state_conflict: "Jadwal berubah sejak dibuka. Muat ulang sebelum mencoba kembali.",
            invalid_schedule: "Data jadwal tidak valid.", not_administrator: "Sesi ini tidak berwenang mengelola jadwal.",
            inactive_administrator: "Akun administrator tidak aktif.", role_not_allowed: "Peran ini tidak diizinkan mengelola jadwal.",
            invalid_token: "Sesi sintetis tidak valid atau kedaluwarsa.", schedule_store_unavailable: "Penyimpanan lokal sementara tidak tersedia.",
            identity_lookup_unavailable: "Identitas lokal tidak dapat diverifikasi.", writer_denied: "Operasi ditolak oleh pembatasan backend lokal."
        })[code] || "Permintaan gagal. Periksa koneksi backend lokal lalu muat ulang.";
    }

    async function api(path, body) {
        const url = new URL(path, origin);
        if (url.origin !== origin || url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Target API lokal ditolak.");
        let response;
        try {
            response = await root.fetch(url.href, { method: body === undefined ? "GET" : "POST", mode: "same-origin",
                credentials: "omit", redirect: "error", cache: "no-store",
                headers: { Authorization: `Bearer ${getToken()}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        } catch (_) { throw new Error("Backend jadwal lokal tidak merespons. Tidak ada operasi yang dicoba ulang."); }
        let result;
        try { result = await response.json(); } catch (_) { throw new Error("Respons backend lokal tidak dapat dibaca."); }
        if (!response.ok || result?.ok !== true) throw new Error(safeMessage(result?.code));
        return result.data;
    }

    function resourceId(label) {
        const id = resourceIds.get(String(label || "").normalize("NFKC").trim().toLowerCase());
        if (!id) throw new Error("Pilih hanya lokasi atau petugas sintetis yang sudah terdaftar di katalog lokal.");
        return id;
    }

    function adminRecord(row) {
        return {
            id: row.id, revision: row.revision, status: row.status, area: row.area, category: row.category,
            title: row.title, date: String(row.service_date).slice(0, 10), startTime: String(row.start_time).slice(0, 5),
            endTime: String(row.end_time).slice(0, 5), venue: resourceNames.get(row.venue_id) || "Sumber lokasi lokal tidak tersedia",
            leader: resourceNames.get(row.leader_id) || "Sumber petugas lokal tidak tersedia",
            officers: (Array.isArray(row.officers) ? row.officers : []).map(item => ({
                name: resourceNames.get(item.personId) || "Sumber petugas lokal tidak tersedia", role: item.role || ""
            })), theme: row.theme || "", scripture: row.scripture || "", publicNotes: row.public_notes || "",
            internalNotes: row.internal_notes || "", publishedAt: row.published_at || null, seriesId: null, seriesIndex: 0
        };
    }

    async function adminData() {
        const rows = await api("/api/admin/schedules");
        const records = (Array.isArray(rows) ? rows : []).map(adminRecord);
        const audits = await Promise.all(records.map(record => api(`/api/admin/audit?scheduleId=${encodeURIComponent(record.id)}`)));
        const audit = audits.flatMap(list => (Array.isArray(list) ? list : []).map(event => ({
            scheduleId: event.occurrence_id, actorUid: event.actor_uid, role: event.actor_role,
            action: event.action, at: event.recorded_at, before: event.from_status,
            after: event.to_status, title: records.find(record => record.id === event.occurrence_id)?.title || "Jadwal"
        }))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
        return { records, audit };
    }

    function apiSchedule(item) {
        return { id: item.id, area: item.area, category: item.category, title: item.title,
            date: item.date, startTime: item.startTime, endTime: item.endTime,
            venueId: resourceId(item.venue), leaderId: resourceId(item.leader),
            officers: (item.officers || []).map(person => ({ personId: resourceId(person.name), role: person.role || "Pelayanan" })),
            theme: item.theme || "", scripture: item.scripture || "", publicNotes: item.publicNotes || "", internalNotes: "" };
    }

    const adapter = Object.freeze({
        async session() {
            try { return await api("/api/admin/session"); }
            catch (_) { return await api("/api/member/session"); }
        },
        admin: adminData,
        async save(items) {
            if (!Array.isArray(items) || items.length !== 1) throw new Error("Backend lokal saat ini hanya mendukung satu kejadian per operasi; seri berulang ditahan agar tidak tersimpan sebagian.");
            const item = items[0];
            const expectedRevision = Number.isSafeInteger(item.revision) ? item.revision : 0;
            await api("/api/admin/drafts", { schedule: apiSchedule(item), expectedRevision, operationId: root.crypto.randomUUID() });
            return await adminData();
        },
        async status(id, revision, target) {
            if (!(["published", "cancelled"].includes(target)) || !Number.isSafeInteger(revision) || revision < 1) throw new Error("Perubahan status tidak valid.");
            const operationId = root.crypto.randomUUID();
            if (target === "published") await api("/api/admin/publish", { scheduleId: id, expectedRevision: revision, operationId });
            else await api("/api/admin/cancel", { scheduleId: id, expectedRevision: revision, operationId });
            return await adminData();
        },
        async member() {
            const rows = await api("/api/member/schedules");
            const records = (Array.isArray(rows) ? rows : []).map(row => ({
                id: row.id, title: row.title, date: String(row.date).slice(0, 10), startTime: String(row.startTime).slice(0, 5),
                endTime: String(row.endTime).slice(0, 5), area: row.area, category: row.category, venue: row.venue,
                leader: row.leader, officers: (Array.isArray(row.officers) ? row.officers : []).map(item =>
                    typeof item === "string" ? item : `${item.name}${item.role ? " — " + item.role : ""}`),
                theme: row.theme, scripture: row.scripture, publicNotes: row.publicNotes,
                status: row.status, publishedAt: row.publishedAt
            }));
            return { records };
        },
        async readMemberSchedules() { return (await this.member()).records; }
    });

    root.SIPAPUA_SCHEDULE_LOCAL = adapter;
})(window);
