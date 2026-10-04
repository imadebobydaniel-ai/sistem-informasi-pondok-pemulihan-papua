// Supabase Edge Function: admin-delete-annual-records
//
// Lets a Firebase Administrator (the existing login of laporan-tahunan.html)
// permanently delete published Program Tahunan (agenda_programs) or Kegiatan
// Tahunan (annual_activities) rows, together with their photo rows, without
// Firebase Cloud Functions.
//
// Same security model as admin-delete-event-jemaat: the caller sends its
// Firebase ID token, gateway JWT verification is disabled for this function
// (supabase/config.toml), the token is verified here against Google's public
// keys, and the role comes from Firestore admin_users/{uid} read with the
// caller's own token. The Supabase service-role key is injected by Supabase
// into the function environment and never leaves the server.

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
const MAX_RECORDS_PER_REQUEST = 50;
const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Only these tables can be targeted; the client picks a kind, never a table name.
const RECORD_KINDS = {
    agenda_programs: {
        label: "Program Tahunan",
        table: "agenda_programs",
        nameColumn: "program_kerja",
        photoTable: "agenda_program_photos",
        photoForeignKey: "agenda_id",
    },
    annual_activities: {
        label: "Kegiatan Tahunan",
        table: "annual_activities",
        nameColumn: "nama_kegiatan",
        photoTable: "annual_activity_photos",
        photoForeignKey: "activity_id",
    },
} as const;
type RecordKind = keyof typeof RECORD_KINDS;

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
            "Hanya Master atau Superadmin yang dapat menghapus data ini.",
            { role },
        );
    }
    return role;
}

async function readRequest(request: Request): Promise<{ kind: RecordKind; ids: string[] }> {
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        throw new HttpError(400, "invalid_body", "Body request harus JSON.");
    }

    const kind = (body as { kind?: unknown })?.kind;
    if (typeof kind !== "string" || !Object.hasOwn(RECORD_KINDS, kind)) {
        throw new HttpError(
            400,
            "invalid_kind",
            "Jenis data harus agenda_programs atau annual_activities.",
        );
    }

    const rawIds = (body as { ids?: unknown })?.ids;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
        throw new HttpError(
            400,
            "invalid_ids",
            "ids wajib berupa daftar ID data.",
        );
    }

    const ids = [...new Set(rawIds.map((id) => String(id).trim().toLowerCase()))];
    const invalid = ids.filter((id) => !UUID_PATTERN.test(id));
    if (invalid.length) {
        throw new HttpError(
            400,
            "invalid_ids",
            "Ada ID data yang tidak valid.",
            { invalid },
        );
    }
    if (ids.length > MAX_RECORDS_PER_REQUEST) {
        throw new HttpError(
            400,
            "too_many_records",
            `Maksimal ${MAX_RECORDS_PER_REQUEST} data per penghapusan.`,
        );
    }
    return { kind: kind as RecordKind, ids };
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

async function deleteRecords(kind: RecordKind, ids: string[]) {
    const config = RECORD_KINDS[kind];
    const supabase = serviceClient();

    // Only published rows are shown in the monitoring tables, so only those can
    // be deleted from here.
    const { data: existing, error: readError } = await supabase
        .from(config.table)
        .select(`id,${config.nameColumn}`)
        .in("id", ids)
        .eq("status", "published");
    if (readError) throw databaseError(`baca ${config.table}`, readError);

    const rows = (existing || []) as Record<string, unknown>[];
    const foundIds = new Set(rows.map((row) => String(row.id)));
    const missing = ids.filter((id) => !foundIds.has(id));
    if (missing.length) {
        throw new HttpError(
            404,
            "records_not_found",
            `Sebagian ${config.label} tidak ditemukan. Tidak ada data yang dihapus.`,
            { missing },
        );
    }

    const { data: deletedPhotos, error: photoError } = await supabase
        .from(config.photoTable)
        .delete()
        .in(config.photoForeignKey, ids)
        .select("id");
    if (photoError) throw databaseError(`hapus ${config.photoTable}`, photoError);
    const photosDeleted = deletedPhotos?.length || 0;

    const { data: deletedRows, error: deleteError } = await supabase
        .from(config.table)
        .delete()
        .in("id", ids)
        .select("id");
    if (deleteError) {
        throw databaseError(`hapus ${config.table}`, deleteError, {
            partial: photosDeleted > 0,
            photosDeleted,
        });
    }

    const [{ count: remainingRecords, error: recordCountError }, {
        count: remainingPhotos,
        error: photoCountError,
    }] = await Promise.all([
        supabase.from(config.table).select("id", { count: "exact", head: true }).in("id", ids),
        supabase.from(config.photoTable).select("id", { count: "exact", head: true }).in(
            config.photoForeignKey,
            ids,
        ),
    ]);
    if (recordCountError) throw databaseError(`verifikasi ${config.table}`, recordCountError);
    if (photoCountError) throw databaseError(`verifikasi ${config.photoTable}`, photoCountError);

    const recordsDeleted = deletedRows?.length || 0;
    if (remainingRecords !== 0 || remainingPhotos !== 0 || recordsDeleted !== ids.length) {
        throw new HttpError(
            500,
            "delete_not_confirmed",
            "Penghapusan tidak terkonfirmasi di database.",
            {
                partial: recordsDeleted > 0 || photosDeleted > 0,
                recordsDeleted,
                photosDeleted,
                remainingRecords,
                remainingPhotos,
            },
        );
    }

    return {
        kind,
        recordsDeleted,
        photosDeleted,
        deletedIds: (deletedRows || []).map((row) => String(row.id)),
        names: rows.map((row) => String(row[config.nameColumn] || row.id)),
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
    let kind: string | null = null;
    let ids: string[] = [];
    try {
        const verified = await verifyFirebaseToken(request);
        uid = verified.uid;
        role = await readAdminRole(verified.uid, verified.idToken);
        ({ kind, ids } = await readRequest(request));

        const result = await deleteRecords(kind as RecordKind, ids);
        console.log(JSON.stringify({
            action: "admin-delete-annual-records",
            result: "success",
            uid,
            role,
            kind,
            ids,
            recordsDeleted: result.recordsDeleted,
            photosDeleted: result.photosDeleted,
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
            action: "admin-delete-annual-records",
            result: "failed",
            uid,
            role,
            kind,
            ids,
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
