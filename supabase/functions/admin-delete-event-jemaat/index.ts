// Supabase Edge Function: admin-delete-event-jemaat
//
// Lets a Firebase Administrator (the existing login of laporan-tahunan.html)
// withdraw published Event Jemaat from the public pages without Firebase Cloud
// Functions. "Delete" archives the event (status = 'archived'); the row and its
// photos stay in the database as history for Dashboard PKS.
//
// The caller sends its Firebase ID token, not a Supabase JWT, so gateway JWT
// verification is disabled for this function (supabase/config.toml) and the
// token is verified here against Google's public keys. The role comes from
// Firestore admin_users/{uid}, read with the caller's own token (the Firestore
// rules allow reading only your own admin document). The Supabase service-role
// key is injected by Supabase into the function environment and never leaves
// the server.

import { createRemoteJWKSet, jwtVerify } from "npm:jose@5.9.6";
import { createClient } from "npm:@supabase/supabase-js@2.116.0";

const FIREBASE_PROJECT_ID = "boby-apps-project";
const FIREBASE_ISSUER = `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`;
const FIREBASE_JWKS = createRemoteJWKSet(
    new URL(
        "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
    ),
);
const FIRESTORE_ADMIN_DOC_URL =
    `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}` +
    "/databases/(default)/documents/admin_users/";

const DELETE_ROLES = new Set(["master", "super_admin", "superadmin"]);
const MAX_EVENTS_PER_REQUEST = 50;
const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_ORIGINS = new Set([
    "http://127.0.0.1:5500",
    "http://localhost:5500",
    "https://imadebobydaniel-ai.github.io",
]);

class HttpError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
        readonly details: Record<string, unknown> = {},
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
        },
    });
}

async function verifyFirebaseToken(request: Request) {
    const header = request.headers.get("authorization") || "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
        throw new HttpError(
            401,
            "missing_token",
            "Token login Administrator tidak dikirim.",
        );
    }

    const idToken = match[1].trim();
    try {
        const { payload } = await jwtVerify(idToken, FIREBASE_JWKS, {
            issuer: FIREBASE_ISSUER,
            audience: FIREBASE_PROJECT_ID,
            algorithms: ["RS256"],
        });
        const uid = typeof payload.sub === "string" ? payload.sub : "";
        const authTime = Number(payload.auth_time);
        if (!uid || uid.length > 128) {
            throw new Error("Token has no valid subject.");
        }
        if (!Number.isFinite(authTime) || authTime * 1000 > Date.now() + 60_000) {
            throw new Error("Token has an invalid auth_time.");
        }
        return { uid, idToken };
    } catch (error) {
        throw new HttpError(
            401,
            "invalid_token",
            "Sesi Administrator tidak valid atau sudah kedaluwarsa. Silakan login ulang.",
            { reason: String((error as Error)?.message || error) },
        );
    }
}

async function readAdminRole(uid: string, idToken: string) {
    let response: Response;
    try {
        response = await fetch(
            FIRESTORE_ADMIN_DOC_URL + encodeURIComponent(uid),
            { headers: { Authorization: `Bearer ${idToken}` } },
        );
    } catch (error) {
        throw new HttpError(
            503,
            "role_lookup_failed",
            "Status Administrator belum dapat diverifikasi. Coba lagi nanti.",
            { reason: String((error as Error)?.message || error) },
        );
    }

    if (response.status === 404 || response.status === 403) {
        throw new HttpError(
            403,
            "not_administrator",
            "Akun ini tidak terdaftar sebagai Administrator.",
        );
    }
    if (!response.ok) {
        throw new HttpError(
            503,
            "role_lookup_failed",
            "Status Administrator belum dapat diverifikasi. Coba lagi nanti.",
            { firestoreStatus: response.status },
        );
    }

    const document = await response.json();
    const role = String(document?.fields?.role?.stringValue || "")
        .trim()
        .toLowerCase();
    const status = String(document?.fields?.status?.stringValue || "")
        .trim()
        .toLowerCase();

    if (status !== "active") {
        throw new HttpError(
            403,
            "inactive_administrator",
            "Akun Administrator tidak aktif.",
        );
    }
    if (!DELETE_ROLES.has(role)) {
        throw new HttpError(
            403,
            "role_not_allowed",
            "Hanya Master atau Superadmin yang dapat menghapus Event Jemaat.",
            { role },
        );
    }
    return role;
}

async function readEventIds(request: Request): Promise<string[]> {
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        throw new HttpError(400, "invalid_body", "Body request harus JSON.");
    }

    const rawIds = (body as { eventIds?: unknown })?.eventIds;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
        throw new HttpError(
            400,
            "invalid_event_ids",
            "eventIds wajib berupa daftar ID Event Jemaat.",
        );
    }

    const eventIds = [...new Set(rawIds.map((id) => String(id).trim().toLowerCase()))];
    const invalid = eventIds.filter((id) => !UUID_PATTERN.test(id));
    if (invalid.length) {
        throw new HttpError(
            400,
            "invalid_event_ids",
            "Ada ID Event Jemaat yang tidak valid.",
            { invalid },
        );
    }
    if (eventIds.length > MAX_EVENTS_PER_REQUEST) {
        throw new HttpError(
            400,
            "too_many_events",
            `Maksimal ${MAX_EVENTS_PER_REQUEST} Event Jemaat per penghapusan.`,
        );
    }
    return eventIds;
}

function serviceClient() {
    const url = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !serviceRoleKey) {
        throw new HttpError(
            500,
            "server_not_configured",
            "Konfigurasi server Edge Function belum lengkap.",
        );
    }
    return createClient(url, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
}

function databaseError(
    step: string,
    error: { code?: string; message?: string },
    details: Record<string, unknown> = {},
) {
    return new HttpError(
        500,
        "database_error",
        `Gagal pada langkah ${step}: ${error.message || "kesalahan database"}`,
        { step, dbCode: error.code || null, ...details },
    );
}

async function archiveEvents(eventIds: string[]) {
    const supabase = serviceClient();

    const { data: existing, error: readError } = await supabase
        .from("events")
        .select("id,nama,status,deleted_at")
        .in("id", eventIds);
    if (readError) throw databaseError("baca events", readError);

    const rows = existing || [];
    const foundIds = new Set(rows.map((row) => String(row.id)));
    const missing = eventIds.filter((id) => !foundIds.has(id));
    if (missing.length) {
        throw new HttpError(
            404,
            "events_not_found",
            "Sebagian Event Jemaat tidak ditemukan. Tidak ada event yang diarsipkan.",
            { missing },
        );
    }

    // All or nothing: only active published events can be withdrawn.
    const notPublished = rows
        .filter((row) => row.status !== "published" || row.deleted_at !== null)
        .map((row) => ({
            id: String(row.id),
            status: row.status,
            deleted: row.deleted_at !== null,
        }));
    if (notPublished.length) {
        throw new HttpError(
            409,
            "events_not_published",
            "Hanya Event Jemaat berstatus Published yang dapat diarsipkan. Tidak ada event yang diarsipkan.",
            { notPublished },
        );
    }

    // Photos are kept as history; published_event_photos hides them once the
    // parent event is no longer published.
    const { data: archivedRows, error: archiveError } = await supabase
        .from("events")
        .update({ status: "archived" })
        .in("id", eventIds)
        .eq("status", "published")
        .is("deleted_at", null)
        .select("id");
    if (archiveError) throw databaseError("arsipkan events", archiveError);

    const archivedIds = (archivedRows || []).map((row) => String(row.id));
    if (archivedIds.length !== eventIds.length) {
        // A target changed status after validation. Restore the rows archived by
        // this request so the result is never partial.
        const { error: revertError } = archivedIds.length
            ? await supabase
                .from("events")
                .update({ status: "published" })
                .in("id", archivedIds)
                .eq("status", "archived")
            : { error: null };
        throw new HttpError(
            409,
            "archive_not_confirmed",
            "Sebagian Event Jemaat berubah status saat diproses. Tidak ada event yang diarsipkan.",
            {
                archivedCount: archivedIds.length,
                expected: eventIds.length,
                reverted: !revertError,
                revertError: revertError?.message || null,
            },
        );
    }

    const [{ count: stillPublished, error: publishedCountError }, {
        count: stillPublishedPhotos,
        error: publishedPhotoCountError,
    }] = await Promise.all([
        supabase.from("published_events").select("id", { count: "exact", head: true }).in(
            "id",
            eventIds,
        ),
        supabase.from("published_event_photos").select("id", { count: "exact", head: true })
            .in("event_id", eventIds),
    ]);
    if (publishedCountError) {
        throw databaseError("verifikasi published_events", publishedCountError);
    }
    if (publishedPhotoCountError) {
        throw databaseError("verifikasi published_event_photos", publishedPhotoCountError);
    }
    if (stillPublished !== 0 || stillPublishedPhotos !== 0) {
        throw new HttpError(
            500,
            "archive_not_confirmed",
            "Event sudah diarsipkan tetapi masih terlihat di tampilan publik.",
            { stillPublished, stillPublishedPhotos },
        );
    }

    return {
        eventsArchived: archivedIds.length,
        archivedIds,
        names: rows.map((row) => String(row.nama || row.id)),
    };
}

Deno.serve(async (request) => {
    const origin = request.headers.get("origin");

    if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
        return json(405, { ok: false, code: "method_not_allowed", error: "Gunakan POST." }, origin);
    }

    let uid: string | null = null;
    let role: string | null = null;
    let eventIds: string[] = [];
    try {
        const verified = await verifyFirebaseToken(request);
        uid = verified.uid;
        role = await readAdminRole(verified.uid, verified.idToken);
        eventIds = await readEventIds(request);

        const result = await archiveEvents(eventIds);
        console.log(JSON.stringify({
            action: "admin-delete-event-jemaat",
            result: "success",
            uid,
            role,
            eventIds,
            eventsArchived: result.eventsArchived,
        }));
        return json(200, { ok: true, ...result }, origin);
    } catch (error) {
        const httpError = error instanceof HttpError
            ? error
            : new HttpError(
                500,
                "unexpected_error",
                "Terjadi kesalahan tak terduga di server.",
                { reason: String((error as Error)?.message || error) },
            );
        console.error(JSON.stringify({
            action: "admin-delete-event-jemaat",
            result: "failed",
            uid,
            role,
            eventIds,
            code: httpError.code,
            message: httpError.message,
            details: httpError.details,
        }));
        return json(
            httpError.status,
            { ok: false, code: httpError.code, error: httpError.message, details: httpError.details },
            origin,
        );
    }
});
