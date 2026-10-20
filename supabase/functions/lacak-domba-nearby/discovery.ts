// Discovery session ("Bisa Ditemukan"): a caller is listed in scans only
// while lacak_domba_presence.discoverable_until is in the future. The
// database functions of migration 20261017000000 set and check it on the
// database clock; only discovery_start / discovery_extend open or lengthen a
// session, sync, scan and heartbeats never move it forward.

export const DISCOVERY_SESSION_MS = 15 * 60 * 1000;

export type DiscoveryState = {
    active: boolean;
    expiresInMs: number;
    sessionId: string | null;
    // The session end on the DATABASE clock (ISO 8601), or null. The
    // browser shows it as the server-verified end; expiresInMs drives its
    // countdown.
    expiresAt: string | null;
};

export const INACTIVE_DISCOVERY: DiscoveryState = {
    active: false,
    expiresInMs: 0,
    sessionId: null,
    expiresAt: null,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validSessionId(value: unknown): value is string {
    return typeof value === "string" && UUID.test(value);
}

// One row returned by a lacak_domba_discovery_* function.
export type SessionRow = {
    outcome: string;
    session_id: string | null;
    expires_in_ms: number | string | null;
    expires_at?: string | null;
};

export function discoveryFromRow(row: SessionRow | undefined): DiscoveryState {
    const remaining = Number(row?.expires_in_ms);
    if (
        !row
        || !validSessionId(row.session_id)
        || !Number.isFinite(remaining)
        || remaining <= 0
    ) {
        return INACTIVE_DISCOVERY;
    }
    const end = typeof row.expires_at === "string" ? Date.parse(row.expires_at) : NaN;
    // Never report more than one session, whatever the stored value says.
    return {
        active: true,
        expiresInMs: Math.min(DISCOVERY_SESSION_MS, Math.floor(remaining)),
        sessionId: row.session_id,
        expiresAt: Number.isFinite(end) ? new Date(end).toISOString() : null,
    };
}
