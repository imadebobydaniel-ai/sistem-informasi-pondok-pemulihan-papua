import { createRemoteJWKSet, jwtVerify } from "npm:jose@5.9.6";
import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import {
    type DiscoveryState,
    discoveryFromRow,
    type SessionRow,
    validSessionId,
} from "./discovery.ts";

const PROJECT_ID = "boby-apps-project";

const ISSUER = `https://securetoken.google.com/${PROJECT_ID}`;

const JWKS = createRemoteJWKSet(
    new URL(
        "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
    ),
);

const FIRESTORE =
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}` +
    "/databases/(default)/documents";

const ALLOWED_ORIGINS = new Set([
    "http://localhost:5500",
    "http://127.0.0.1:5500",
    "https://imadebobydaniel-ai.github.io",
]);

const MAX_LOCATION_AGE_MS = 15 * 60 * 1000;

const MAX_PRESENCE_AGE_MS = 3 * 60 * 1000;

const MAX_CANDIDATES = 500;

const MAX_RESULTS = 100;

class HttpError extends Error {
    constructor(
        public status: number,
        public code: string,
        message: string,
        // The caller's session after a refused session change, so the
        // browser can adopt it.
        public discovery?: DiscoveryState,
    ) {
        super(message);
    }
}

function corsHeaders(origin: string | null): Record<string, string> {
    const headers: Record<string, string> = {
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers":
            "authorization, apikey, content-type, x-client-info",
        "Access-Control-Max-Age": "600",
        "Vary": "Origin",
    };
    if (origin && ALLOWED_ORIGINS.has(origin)) {
        headers["Access-Control-Allow-Origin"] = origin;
    }
    return headers;
}

function json(
    status: number,
    body: Record<string, unknown>,
    origin: string | null,
): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            ...corsHeaders(origin),
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
        },
    });
}

function firestoreValue(
    fields: Record<string, any> | undefined,
    key: string,
): any {
    const value = fields?.[key];
    if (!value) return undefined;
    if ("stringValue" in value) return value.stringValue;
    if ("booleanValue" in value) return value.booleanValue;
    if ("integerValue" in value) return Number(value.integerValue);
    if ("doubleValue" in value) return Number(value.doubleValue);
    if ("timestampValue" in value) return value.timestampValue;
    if ("nullValue" in value) return null;
    return undefined;
}

function timestampMs(value: unknown): number {
    if (typeof value !== "string") return 0;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function validCoordinates(
    latitude: unknown,
    longitude: unknown,
): latitude is number {
    return typeof latitude === "number"
        && Number.isFinite(latitude)
        && latitude >= -90
        && latitude <= 90
        && typeof longitude === "number"
        && Number.isFinite(longitude)
        && longitude >= -180
        && longitude <= 180;
}

function safePhotoURL(value: unknown): string {
    if (typeof value !== "string") return "";
    try {
        const url = new URL(value.trim());
        return url.protocol === "https:" ? url.href : "";
    } catch {
        return "";
    }
}

async function verifyFirebaseToken(request: Request): Promise<{
    uid: string;
    token: string;
}> {
    const match = (request.headers.get("authorization") || "")
        .match(/^Bearer\s+(.+)$/i);
    if (!match) {
        throw new HttpError(401, "missing_token", "Login Firebase diperlukan.");
    }
    const token = match[1].trim();
    try {
        const { payload } = await jwtVerify(token, JWKS, {
            issuer: ISSUER,
            audience: PROJECT_ID,
            algorithms: ["RS256"],
        });
        if (
            typeof payload.sub !== "string"
            || payload.sub.length < 1
            || payload.sub.length > 128
        ) {
            throw new Error("Invalid UID");
        }
        return { uid: payload.sub, token };
    } catch {
        throw new HttpError(
            401,
            "invalid_token",
            "Token Firebase tidak valid atau sudah kedaluwarsa.",
        );
    }
}

async function firestoreGet(
    path: string,
    token: string,
): Promise<Record<string, any> | null> {
    const response = await fetch(`${FIRESTORE}/${path}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 404) return null;
    if (!response.ok) {
        throw new HttpError(
            response.status === 401 ? 401 : 403,
            "firestore_read_failed",
            "Data Firestore tidak dapat dibaca dengan izin pengguna ini.",
        );
    }
    return await response.json();
}

async function firestoreList(
    path: string,
    token: string,
): Promise<Record<string, any>[]> {
    const documents: Record<string, any>[] = [];
    let pageToken = "";
    do {
        const url = new URL(`${FIRESTORE}/${path}`);
        url.searchParams.set("pageSize", "1000");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const response = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) {
            throw new HttpError(
                response.status === 401 ? 401 : 403,
                "firestore_list_failed",
                "Daftar blokir tidak dapat dibaca.",
            );
        }
        const result = await response.json();
        documents.push(...(result.documents || []));
        if (documents.length > 10000) {
            throw new HttpError(
                413,
                "block_list_too_large",
                "Daftar blokir melebihi batas yang diizinkan.",
            );
        }
        pageToken = result.nextPageToken || "";
    } while (pageToken);
    return documents;
}

function firestorePath(...segments: string[]): string {
    return segments.map(encodeURIComponent).join("/");
}

function getSupabase() {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) {
        throw new HttpError(
            500,
            "server_configuration",
            "Konfigurasi backend belum lengkap.",
        );
    }
    return createClient(url, key, {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
        },
    });
}

async function requireActiveAccount(
    uid: string,
    token: string,
): Promise<void> {
    const document = await firestoreGet(
        firestorePath("users", uid),
        token,
    );
    const status = firestoreValue(document?.fields, "status_akun");
    if (!document || status !== "Aktif") {
        throw new HttpError(
            403,
            "account_not_active",
            "Akun SIPAPUA belum aktif atau belum terverifikasi.",
        );
    }
}

async function syncOwnBlocks(
    supabase: ReturnType<typeof getSupabase>,
    uid: string,
    token: string,
): Promise<void> {
    const documents = await firestoreList(
        firestorePath("user_blocks", uid, "blocked"),
        token,
    );
    const blockedUids = documents
        .map((document) => {
            const parts = String(document.name || "").split("/");
            return parts[parts.length - 1] || "";
        })
        .filter((blockedUid) => blockedUid && blockedUid !== uid);
    const { error } = await supabase.rpc(
        "lacak_domba_replace_own_blocks",
        {
            p_blocker_uid: uid,
            p_blocked_uids: [...new Set(blockedUids)],
        },
    );
    if (error) {
        throw new HttpError(
            500,
            "block_sync_failed",
            "Sinkronisasi daftar blokir gagal.",
        );
    }
}

// Calls one lacak_domba_discovery_* function; each runs as one statement on
// the database clock (migration 20261017000000).
async function sessionRpc(
    supabase: ReturnType<typeof getSupabase>,
    name: string,
    args: Record<string, unknown>,
): Promise<SessionRow> {
    const { data, error } = await supabase.rpc(name, args);
    const row = Array.isArray(data) ? data[0] : data;
    if (error || !row || typeof row.outcome !== "string") {
        throw new HttpError(
            500,
            "presence_sync_failed",
            "Status penemuan tidak dapat diperbarui.",
        );
    }
    return row as SessionRow;
}

// Ends the caller's discovery; see lacak_domba_discovery_end for the modes.
async function endDiscovery(
    supabase: ReturnType<typeof getSupabase>,
    uid: string,
    mode: "stop" | "stop_retry" | "expired" | "leave",
    sessionId: string | null,
): Promise<DiscoveryState> {
    return discoveryFromRow(await sessionRpc(
        supabase,
        "lacak_domba_discovery_end",
        { p_uid: uid, p_mode: mode, p_session_id: sessionId },
    ));
}

// Drops rows no scan may return any more. Best effort: the scan filter
// excludes them anyway, so a failure must not block the request.
async function purgeStale(
    supabase: ReturnType<typeof getSupabase>,
): Promise<void> {
    const { error } = await supabase.rpc("lacak_domba_purge_stale", {
        p_location_max_age_seconds: MAX_LOCATION_AGE_MS / 1000,
    });
    if (error) console.warn("lacak-domba-nearby: stale presence purge failed.");
}

// Builds the caller's presence row from their own Firestore documents, or
// returns null when they are not discoverable or have no fresh location.
// The row never carries session times; the database sets those.
async function readOwnPresenceRecord(
    uid: string,
    token: string,
    now: number,
): Promise<Record<string, unknown> | null> {
    const [presenceDocument, locationDocument] = await Promise.all([
        firestoreGet(firestorePath("presence", uid), token),
        firestoreGet(firestorePath("presence_locations", uid), token),
    ]);
    const presence = presenceDocument?.fields;
    const location = locationDocument?.fields;
    const discoverable = firestoreValue(presence, "discoverable") === true;
    const latitude = firestoreValue(location, "latitude");
    const longitude = firestoreValue(location, "longitude");
    const locationUpdatedAt = timestampMs(
        firestoreValue(location, "updatedAt"),
    );
    if (
        !discoverable
        || !validCoordinates(latitude, longitude)
        || !locationUpdatedAt
        || now - locationUpdatedAt > MAX_LOCATION_AGE_MS
    ) {
        return null;
    }
    const lastSeen = firestoreValue(presence, "lastSeen");
    const displayName = String(
        firestoreValue(presence, "displayName") || "Jemaat SIPAPUA",
    ).trim().slice(0, 100);
    return {
        firebase_uid: uid,
        latitude,
        longitude,
        display_name: displayName || "Jemaat SIPAPUA",
        photo_url: safePhotoURL(firestoreValue(presence, "photoURL")),
        komsel: String(firestoreValue(presence, "komsel") || "").slice(0, 120),
        wilayah: String(firestoreValue(presence, "wilayah") || "").slice(0, 120),
        discoverable: true,
        show_online: firestoreValue(presence, "showOnline") === true,
        online: firestoreValue(presence, "online") === true,
        last_seen: lastSeen || null,
        location_updated_at: new Date(locationUpdatedAt).toISOString(),
    };
}

// Mirrors the caller's presence and reports their discovery session.
//   refresh - heartbeat, sync and scan: updates a RUNNING session's row and
//             never moves its end. When Firestore says the caller is not
//             discoverable, the row is removed (except a session opened
//             after this read began).
//   start   - explicit activation: opens a 15-minute session when none is
//             running; a running one is kept as it is.
//   extend  - explicit "Perpanjang 15 Menit": 15 minutes from now, only for
//             the session the browser shows (sessionId). Another running
//             session is reported (409 discovery_session_changed), an ended
//             one must be started again (409 discovery_expired).
// Every time is taken from the database clock, never from the browser.
async function syncOwnPresence(
    supabase: ReturnType<typeof getSupabase>,
    uid: string,
    token: string,
    mode: "refresh" | "start" | "extend",
    sessionId: string | null = null,
): Promise<DiscoveryState> {
    const readAt = new Date().toISOString();
    const record = await readOwnPresenceRecord(uid, token, Date.now());
    if (mode === "refresh") {
        return discoveryFromRow(await sessionRpc(
            supabase,
            "lacak_domba_discovery_refresh",
            { p_uid: uid, p_row: record, p_read_at: readAt },
        ));
    }
    if (!record) {
        throw new HttpError(
            412,
            "discovery_not_ready",
            "Aktifkan Bisa Ditemukan dengan lokasi terbaru.",
        );
    }
    if (mode === "start") {
        return discoveryFromRow(await sessionRpc(
            supabase,
            "lacak_domba_discovery_start",
            { p_uid: uid, p_row: record },
        ));
    }
    const row = await sessionRpc(
        supabase,
        "lacak_domba_discovery_extend",
        { p_uid: uid, p_session_id: sessionId, p_row: record },
    );
    if (row.outcome === "extended") return discoveryFromRow(row);
    throw new HttpError(
        409,
        row.outcome === "session_changed"
            ? "discovery_session_changed"
            : "discovery_expired",
        row.outcome === "session_changed"
            ? "Sesi Bisa Ditemukan sudah berubah di tab atau perangkat lain."
            : "Sesi Bisa Ditemukan sudah berakhir. Aktifkan sesi baru.",
        discoveryFromRow(row),
    );
}

function distanceKm(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
): number {
    const radians = (degrees: number) => degrees * Math.PI / 180;
    const dLat = radians(lat2 - lat1);
    const dLon = radians(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(radians(lat1))
        * Math.cos(radians(lat2))
        * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(
        Math.sqrt(a),
        Math.sqrt(1 - a),
    );
}

function distanceBucket(distance: number): {
    rank: number;
    label: string;
} {
    if (distance < 1) return { rank: 0, label: "< 1 KM" };
    if (distance < 5) return { rank: 1, label: "1–5 KM" };
    return { rank: 2, label: "5–10 KM" };
}

function requireRadiusKm(value: unknown): number {
    const radiusKm = Number(value);
    if (![1, 5, 10].includes(radiusKm)) {
        throw new HttpError(400, "invalid_radius", "Radius tidak valid.");
    }
    return radiusKm;
}

async function scanNearby(
    supabase: ReturnType<typeof getSupabase>,
    uid: string,
    token: string,
    radiusKm: number,
): Promise<Record<string, unknown>> {
    const ownLocationDocument = await firestoreGet(
        firestorePath("presence_locations", uid),
        token,
    );
    const ownFields = ownLocationDocument?.fields;
    const latitude = firestoreValue(ownFields, "latitude");
    const longitude = firestoreValue(ownFields, "longitude");
    const updatedAt = timestampMs(firestoreValue(ownFields, "updatedAt"));
    const now = Date.now();
    if (
        !validCoordinates(latitude, longitude)
        || !updatedAt
        || now - updatedAt > MAX_LOCATION_AGE_MS
    ) {
        throw new HttpError(
            412,
            "location_expired",
            "Lokasi Anda belum tersedia atau sudah kedaluwarsa. Pindai ulang.",
        );
    }
    const { data: allowed, error: rateLimitError } = await supabase.rpc(
        "lacak_domba_take_scan_slot",
        {
            p_firebase_uid: uid,
            p_min_interval_seconds: 15,
        },
    );
    if (rateLimitError) {
        throw new HttpError(
            500,
            "rate_limit_failed",
            "Pembatasan pemindaian belum dapat diperiksa.",
        );
    }
    if (allowed !== true) {
        throw new HttpError(
            429,
            "scan_too_soon",
            "Tunggu 15 detik sebelum memindai kembali.",
        );
    }
    const latDelta = radiusKm / 110.574;
    const cosLat = Math.max(0.01, Math.cos(latitude * Math.PI / 180));
    const lonDelta = Math.min(180, radiusKm / (111.320 * cosLat));
    const minLat = Math.max(-90, latitude - latDelta);
    const maxLat = Math.min(90, latitude + latDelta);
    const minLon = longitude - lonDelta;
    const maxLon = longitude + lonDelta;
    await purgeStale(supabase);
    // Session, presence and location age, the caller and blocks in both
    // directions are filtered in the database, on the database clock.
    const { data: locations, error: locationsError } = await supabase.rpc(
        "lacak_domba_scan_candidates",
        {
            p_uid: uid,
            p_min_lat: minLat,
            p_max_lat: maxLat,
            p_presence_max_age_seconds: MAX_PRESENCE_AGE_MS / 1000,
            p_location_max_age_seconds: MAX_LOCATION_AGE_MS / 1000,
            p_limit: MAX_CANDIDATES + 1,
        },
    );
    if (locationsError || !Array.isArray(locations)) {
        throw new HttpError(
            500,
            "location_query_failed",
            "Data lokasi sekitar tidak dapat dimuat.",
        );
    }
    if (locations.length > MAX_CANDIDATES) {
        throw new HttpError(
            429,
            "too_many_candidates",
            "Terlalu banyak lokasi aktif. Perkecil radius dan coba lagi.",
        );
    }
    const candidates: Array<Record<string, unknown> & {
        distanceRank: number;
        displayNameSort: string;
    }> = [];
    for (const row of locations) {
        const candidateUid = row.firebase_uid;
        if (
            candidateUid === uid
            || !validCoordinates(row.latitude, row.longitude)
        ) {
            continue;
        }
        if (
            minLon >= -180 && maxLon <= 180
            && (row.longitude < minLon || row.longitude > maxLon)
        ) {
            continue;
        }
        const distance = distanceKm(
            latitude,
            longitude,
            row.latitude,
            row.longitude,
        );
        if (distance > radiusKm) continue;
        const bucket = distanceBucket(distance);
        candidates.push({
            uid: candidateUid,
            displayName: String(row.display_name || "Jemaat").slice(0, 100),
            photoURL: safePhotoURL(row.photo_url),
            online: row.show_online === true,
            komsel: String(row.komsel || "").slice(0, 120),
            wilayah: String(row.wilayah || "").slice(0, 120),
            distanceRange: bucket.label,
            distanceRank: bucket.rank,
            displayNameSort: String(row.display_name || "Jemaat"),
        });
    }
    candidates.sort((a, b) =>
        a.distanceRank - b.distanceRank
        || a.displayNameSort.localeCompare(b.displayNameSort)
    );
    const results = candidates.slice(0, MAX_RESULTS).map(
        ({ distanceRank: _rank, displayNameSort: _sort, ...item }) => item,
    );
    return {
        results,
        truncated: candidates.length > MAX_RESULTS,
    };
}

Deno.serve(async (request: Request) => {
    const origin = request.headers.get("origin");
    if (request.method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: corsHeaders(origin),
        });
    }
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
        return json(403, {
            error: "origin_not_allowed",
            message: "Origin tidak diizinkan.",
        }, origin);
    }
    if (request.method !== "POST") {
        return json(405, {
            error: "method_not_allowed",
            message: "Gunakan POST.",
        }, origin);
    }
    try {
        const { uid, token } = await verifyFirebaseToken(request);
        let body: Record<string, unknown>;
        try {
            body = await request.json();
        } catch {
            throw new HttpError(400, "invalid_json", "JSON tidak valid.");
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            throw new HttpError(400, "invalid_json", "JSON tidak valid.");
        }
        const supabase = getSupabase();
        const sessionId = body.sessionId == null ? null : body.sessionId;
        if (sessionId !== null && !validSessionId(sessionId)) {
            throw new HttpError(400, "invalid_session", "Sesi tidak valid.");
        }
        // Touches only the caller's own row, so it needs no Firestore state.
        //   stop       - "Matikan": ends whatever session is running (also
        //                the default, so an old client's clear still hides)
        //   stop_retry - a "Matikan" retried later: only that session
        //   expired    - the browser's countdown ended: only an ended session
        //   leave      - the last tab closed: only that session
        // The reply carries a session that is still running, if any.
        if (body.action === "clear") {
            const mode = body.mode == null ? "stop" : body.mode;
            if (
                mode !== "stop" && mode !== "stop_retry"
                && mode !== "expired" && mode !== "leave"
            ) {
                throw new HttpError(400, "invalid_mode", "Mode tidak valid.");
            }
            if ((mode === "stop_retry" || mode === "leave") && !sessionId) {
                throw new HttpError(400, "invalid_session", "Sesi tidak valid.");
            }
            const discovery = await endDiscovery(supabase, uid, mode, sessionId);
            return json(200, { ok: true, discovery }, origin);
        }
        // Everything else needs an active account. Clearing does not: it
        // only hides the caller, so a deactivated account can still do it.
        // A deactivated account is also hidden at once (fail closed).
        try {
            await requireActiveAccount(uid, token);
        } catch (error) {
            if (error instanceof HttpError && error.code === "account_not_active") {
                await endDiscovery(supabase, uid, "stop", null).catch(() => {});
            }
            throw error;
        }
        await purgeStale(supabase);
        // Opening or lengthening a session re-reads the caller's block list
        // first: a block made elsewhere (e.g. kontak.html) since the last
        // sync must apply before the caller becomes listed again.
        if (body.action === "discovery_start") {
            await syncOwnBlocks(supabase, uid, token);
            const discovery = await syncOwnPresence(supabase, uid, token, "start");
            return json(200, { ok: true, discovery }, origin);
        }
        if (body.action === "discovery_extend") {
            if (!sessionId) {
                throw new HttpError(400, "invalid_session", "Sesi tidak valid.");
            }
            await syncOwnBlocks(supabase, uid, token);
            const discovery = await syncOwnPresence(
                supabase,
                uid,
                token,
                "extend",
                sessionId,
            );
            return json(200, { ok: true, discovery }, origin);
        }
        if (body.action === "sync") {
            // The block list is re-read on EVERY sync, before the presence
            // refresh (body.syncBlocks is ignored). So no request can keep
            // the caller listed (fresh last_seen) without also applying
            // blocks made elsewhere, e.g. in kontak.html: a new block takes
            // effect at the caller's next sync, and without one the caller
            // drops out of scans 3 minutes after the previous sync anyway.
            // If the block list cannot be read, nothing is refreshed.
            await syncOwnBlocks(supabase, uid, token);
            const discovery = await syncOwnPresence(
                supabase,
                uid,
                token,
                "refresh",
            );
            return json(200, { ok: true, discovery }, origin);
        }
        if (body.action === "scan") {
            // Rejected before any sync so a bad request does no work.
            const radiusKm = requireRadiusKm(body.radiusKm);
            await syncOwnBlocks(supabase, uid, token);
            const discovery = await syncOwnPresence(
                supabase,
                uid,
                token,
                "refresh",
            );
            const result = await scanNearby(
                supabase,
                uid,
                token,
                radiusKm,
            );
            return json(200, { ...result, discovery }, origin);
        }
        throw new HttpError(
            400,
            "invalid_action",
            "Aksi tidak dikenal.",
        );
    } catch (error) {
        if (error instanceof HttpError) {
            return json(error.status, {
                error: error.code,
                message: error.message,
                ...(error.discovery ? { discovery: error.discovery } : {}),
            }, origin);
        }
        console.error("lacak-domba-nearby error:", error);
        return json(500, {
            error: "internal_error",
            message: "Terjadi kesalahan pada backend Lacak Domba.",
        }, origin);
    }
});
