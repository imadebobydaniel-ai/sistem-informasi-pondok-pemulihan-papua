// Unit tests for the discovery session helpers.
// Run: deno test --no-lock --no-config supabase/functions/tests/lacak-domba-discovery_test.ts
import { assertEquals } from "jsr:@std/assert@1";
import {
    DISCOVERY_SESSION_MS,
    discoveryFromRow,
    INACTIVE_DISCOVERY,
    validSessionId,
} from "../lacak-domba-nearby/discovery.ts";

const SESSION = "6f1c2a52-6a39-4d55-9a40-1d1b8c2f0e11";

Deno.test("a running session row gives an active state with its id", () => {
    assertEquals(
        discoveryFromRow({ outcome: "started", session_id: SESSION, expires_in_ms: 4 * 60 * 1000 }),
        { active: true, expiresInMs: 4 * 60 * 1000, sessionId: SESSION, expiresAt: null },
    );
});

Deno.test("the database end time is passed on as ISO, a malformed one as null", () => {
    const row = { outcome: "started", session_id: SESSION, expires_in_ms: 1000 };
    assertEquals(
        discoveryFromRow({ ...row, expires_at: "2026-10-19T08:15:00.123456+00:00" }).expiresAt,
        "2026-10-19T08:15:00.123Z",
    );
    for (const expires_at of [null, undefined, "", "tomorrow"]) {
        assertEquals(discoveryFromRow({ ...row, expires_at }).expiresAt, null);
    }
    assertEquals(
        discoveryFromRow({ outcome: "ended", session_id: null, expires_in_ms: 0, expires_at: "2026-10-19T08:15:00Z" }),
        INACTIVE_DISCOVERY,
        "no end time without a running session",
    );
});

Deno.test("bigint results arrive as strings and are accepted", () => {
    assertEquals(
        discoveryFromRow({ outcome: "active", session_id: SESSION, expires_in_ms: "1234" }).expiresInMs,
        1234,
    );
});

Deno.test("no session, no time left or a malformed row is inactive", () => {
    for (const row of [
        undefined,
        { outcome: "ended", session_id: null, expires_in_ms: 0 },
        { outcome: "active", session_id: SESSION, expires_in_ms: 0 },
        { outcome: "active", session_id: SESSION, expires_in_ms: -5 },
        { outcome: "active", session_id: SESSION, expires_in_ms: "soon" },
        { outcome: "active", session_id: "not-a-uuid", expires_in_ms: 1000 },
    ]) {
        assertEquals(discoveryFromRow(row), INACTIVE_DISCOVERY);
    }
});

Deno.test("remaining time is never reported above one session", () => {
    assertEquals(
        discoveryFromRow({ outcome: "active", session_id: SESSION, expires_in_ms: 3 * DISCOVERY_SESSION_MS }).expiresInMs,
        DISCOVERY_SESSION_MS,
    );
});

Deno.test("session ids must be UUIDs", () => {
    assertEquals(validSessionId(SESSION), true);
    for (const value of [null, undefined, "", "x", 42, SESSION + "0", `${SESSION}' or 1=1`]) {
        assertEquals(validSessionId(value), false);
    }
});
