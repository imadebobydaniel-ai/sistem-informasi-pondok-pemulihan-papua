// Real-PostgreSQL tests for the discovery session functions of migration
// 20261017000000, including races between two database connections.
// Synthetic users only. Needs a LOCAL test database with the Supabase roles
// and the Lacak Domba migrations applied; never point it at production.
//   LD_TEST_DB_URL=postgres://postgres@127.0.0.1:54329/lacak_test
// Run: deno test --no-lock --no-config --allow-env --allow-net supabase/functions/tests/lacak-domba-db_test.ts
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import postgres from "npm:postgres@3.4.5";

const DB_URL = Deno.env.get("LD_TEST_DB_URL") || "";
const LOCAL = /^postgres(ql)?:\/\/[^@]*@(127\.0\.0\.1|localhost)[:/]/.test(DB_URL);
const ignore = !LOCAL;
if (ignore) console.warn("LD_TEST_DB_URL is not a local database: real-PostgreSQL tests SKIPPED.");

const ALICE = "test-ld-alice";
const BOB = "test-ld-bob";

type Sql = ReturnType<typeof postgres>;
const open = (): Sql => postgres(DB_URL, { max: 1, onnotice: () => {} });

// A fresh, valid presence row for p_row: a made-up point, not a person.
function row(latOffset = 0) {
    const now = new Date().toISOString();
    return {
        latitude: -1 + latOffset,
        longitude: 131,
        display_name: "Sintetis",
        photo_url: "",
        komsel: "",
        wilayah: "",
        show_online: true,
        online: true,
        last_seen: now,
        location_updated_at: now,
    };
}

async function reset(sql: Sql) {
    await sql`delete from public.lacak_domba_presence where firebase_uid like 'test-ld-%'`;
    await sql`delete from public.lacak_domba_blocks where blocker_uid like 'test-ld-%'`;
}

async function start(sql: Sql, uid = ALICE) {
    const [r] = await sql`select * from public.lacak_domba_discovery_start(${uid}, ${sql.json(row())})`;
    return r;
}

async function stored(sql: Sql, uid = ALICE) {
    const [r] = await sql`
        select discovery_session_id::text as session_id, discoverable_until,
               session_started_at, updated_at
        from public.lacak_domba_presence where firebase_uid = ${uid}`;
    return r;
}

// Moves the stored session times back, as if `seconds` had passed.
async function elapse(sql: Sql, seconds: number, uid = ALICE) {
    const shift = `${seconds} seconds`;
    await sql`
        update public.lacak_domba_presence set
            discoverable_until = discoverable_until - ${shift}::interval,
            session_started_at = session_started_at - ${shift}::interval,
            updated_at = updated_at - ${shift}::interval,
            last_seen = last_seen - ${shift}::interval,
            location_updated_at = location_updated_at - ${shift}::interval
        where firebase_uid = ${uid}`;
}

// Waits until the other connection is blocked on a lock.
async function waitForLock(observer: Sql, pid: number): Promise<boolean> {
    for (let i = 0; i < 150; i++) {
        const [r] = await observer`select wait_event_type from pg_stat_activity where pid = ${pid}`;
        if (r?.wait_event_type === "Lock") return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
}

// Runs `first` inside an open transaction on connection A, then starts
// `second` on connection B, checks B is blocked by a lock A holds, commits A,
// and returns both results. A race in which B is not blocked fails: the
// test would then not exercise the interleaving it names. With
// mustBlock = false, B must instead finish while A is still open.
async function race<T, U>(
    first: (sql: Sql) => Promise<T>,
    second: (sql: Sql) => Promise<U>,
    mustBlock = true,
): Promise<[T, U]> {
    const a = open();
    const b = open();
    const observer = open();
    const ca = await a.reserve();
    const cb = await b.reserve();
    let open_ = false;
    try {
        const [{ pid }] = await cb`select pg_backend_pid() as pid`;
        await ca`begin`;
        open_ = true;
        const firstResult = await first(ca as unknown as Sql);
        // postgres.js sends a query only once it is awaited.
        const secondPromise = (async () => await second(cb as unknown as Sql))();
        const blocked = mustBlock ? await waitForLock(observer, pid) : false;
        // Without a lock to wait for, B must finish while A is still open.
        const secondResult = mustBlock ? undefined : await secondPromise;
        await ca`commit`;
        open_ = false;
        if (mustBlock) {
            assert(blocked, "the second connection did not wait for the first one's lock");
            return [firstResult, await secondPromise];
        }
        return [firstResult, secondResult as U];
    } finally {
        if (open_) await ca`rollback`.catch(() => {});
        ca.release();
        cb.release();
        await Promise.all([a.end(), b.end(), observer.end()]);
    }
}

const sqlTest = (name: string, fn: (sql: Sql) => Promise<void>) =>
    Deno.test({
        name,
        ignore,
        sanitizeOps: false,
        sanitizeResources: false,
        fn: async () => {
            const sql = open();
            try {
                await reset(sql);
                await fn(sql);
            } finally {
                await reset(sql);
                await sql.end();
            }
        },
    });

// --- single connection -------------------------------------------------------

sqlTest("start opens one 15-minute session on the database clock", async (sql) => {
    const r = await start(sql);
    assertEquals(r.outcome, "started");
    assert(r.session_id);
    assertEquals(Number(r.expires_in_ms), 15 * 60 * 1000);
    const s = await stored(sql);
    assertEquals(s.session_id, r.session_id);
    assertEquals(s.discoverable_until.getTime() - s.session_started_at.getTime(), 15 * 60 * 1000);
    assertEquals(r.expires_at.getTime(), s.discoverable_until.getTime(), "expires_at is the stored end");
    const [ended] = await sql`select * from public.lacak_domba_discovery_end(${ALICE}, 'stop', null)`;
    assertEquals(ended.expires_at, null, "no end time without a session");
});

sqlTest("a second start keeps the running session and never lengthens it", async (sql) => {
    const first = await start(sql);
    await elapse(sql, 300);
    const before = await stored(sql);
    const again = await start(sql);
    assertEquals(again.outcome, "already_active");
    assertEquals(again.session_id, first.session_id);
    assertEquals((await stored(sql)).discoverable_until.getTime(), before.discoverable_until.getTime());
});

sqlTest("refresh (heartbeat) never moves the end", async (sql) => {
    const first = await start(sql);
    await elapse(sql, 600);
    const before = await stored(sql);
    for (let i = 0; i < 3; i++) {
        const r = await sql`select * from public.lacak_domba_discovery_refresh(${ALICE}, ${sql.json(row())}, now())`;
        assertEquals(r[0].outcome, "active");
        assertEquals(r[0].session_id, first.session_id);
    }
    assertEquals((await stored(sql)).discoverable_until.getTime(), before.discoverable_until.getTime());
});

sqlTest("extend: 15 minutes from now, only for the named session", async (sql) => {
    const first = await start(sql);
    await elapse(sql, 600);
    const other = "00000000-0000-4000-8000-000000000000";
    const wrong = await sql`select * from public.lacak_domba_discovery_extend(${ALICE}, ${other}::uuid, ${sql.json(row())})`;
    assertEquals(wrong[0].outcome, "session_changed");
    assertEquals(wrong[0].session_id, first.session_id);
    const right = await sql`select * from public.lacak_domba_discovery_extend(${ALICE}, ${first.session_id}::uuid, ${sql.json(row())})`;
    assertEquals(right[0].outcome, "extended");
    assertEquals(Number(right[0].expires_in_ms), 15 * 60 * 1000);
    const s = await stored(sql);
    assertEquals(s.discoverable_until.getTime() - s.updated_at.getTime(), 15 * 60 * 1000);
});

sqlTest("after expiry: refresh does not revive, extend is refused, start opens a NEW session", async (sql) => {
    const first = await start(sql);
    await elapse(sql, 15 * 60 + 1);
    const refresh = await sql`select * from public.lacak_domba_discovery_refresh(${ALICE}, ${sql.json(row())}, now())`;
    assertEquals(refresh[0].outcome, "inactive");
    assertEquals(await stored(sql), undefined);
    const extend = await sql`select * from public.lacak_domba_discovery_extend(${ALICE}, ${first.session_id}::uuid, ${sql.json(row())})`;
    assertEquals(extend[0].outcome, "expired");
    const again = await start(sql);
    assertEquals(again.outcome, "started");
    assert(again.session_id !== first.session_id);
});

sqlTest("end modes: expired/leave/stop_retry never end another running session; stop always does", async (sql) => {
    const s1 = await start(sql);
    const expired = await sql`select * from public.lacak_domba_discovery_end(${ALICE}, 'expired', null)`;
    assertEquals(expired[0].outcome, "active", "a running session is not an expired one");
    assertEquals(expired[0].session_id, s1.session_id);

    await elapse(sql, 15 * 60 + 1);
    const s2 = await start(sql);
    assert(s2.session_id !== s1.session_id);
    for (const mode of ["leave", "stop_retry"]) {
        const r = await sql`select * from public.lacak_domba_discovery_end(${ALICE}, ${mode}, ${s1.session_id}::uuid)`;
        assertEquals(r[0].outcome, "active", `${mode} for the old session keeps the new one`);
        assertEquals(r[0].session_id, s2.session_id);
    }
    const leave = await sql`select * from public.lacak_domba_discovery_end(${ALICE}, 'leave', ${s2.session_id}::uuid)`;
    assertEquals(leave[0].outcome, "ended");

    await start(sql);
    const stop = await sql`select * from public.lacak_domba_discovery_end(${ALICE}, 'stop', null)`;
    assertEquals(stop[0].outcome, "ended");
    assertEquals(await stored(sql), undefined);
});

sqlTest("withdrawn in Firestore: removes the row, except a session opened after the read", async (sql) => {
    await start(sql);
    const withdrawn = await sql`select * from public.lacak_domba_discovery_refresh(${ALICE}, null, now() + interval '1 second')`;
    assertEquals(withdrawn[0].outcome, "withdrawn");
    assertEquals(await stored(sql), undefined);

    const s = await start(sql);
    const staleRead = await sql`select * from public.lacak_domba_discovery_refresh(${ALICE}, null, now() - interval '5 seconds')`;
    assertEquals(staleRead[0].outcome, "active", "an older read does not undo a newer session");
    assertEquals(staleRead[0].session_id, s.session_id);
});

sqlTest("the table refuses a session longer than 15 minutes or a half session", async (sql) => {
    await start(sql);
    await assertRejects(
        () => sql`update public.lacak_domba_presence set discoverable_until = updated_at + interval '16 minutes' where firebase_uid = ${ALICE}`,
        Error,
        "lacak_domba_presence_discoverable_until_cap",
    );
    await assertRejects(
        () => sql`update public.lacak_domba_presence set discovery_session_id = null where firebase_uid = ${ALICE}`,
        Error,
        "lacak_domba_presence_session_consistent",
    );
});

sqlTest("scan candidates: running session, fresh presence and location, no blocks either way", async (sql) => {
    await start(sql, ALICE);
    const scan = () => sql`select firebase_uid from public.lacak_domba_scan_candidates(${BOB}, -2, 0, 180, 900, 501)`;
    assertEquals((await scan()).map((r) => r.firebase_uid), [ALICE]);

    await sql`insert into public.lacak_domba_blocks (blocker_uid, blocked_uid) values (${ALICE}, ${BOB})`;
    assertEquals((await scan()).length, 0, "Alice blocked Bob");
    await sql`delete from public.lacak_domba_blocks where blocker_uid = ${ALICE}`;
    await sql`insert into public.lacak_domba_blocks (blocker_uid, blocked_uid) values (${BOB}, ${ALICE})`;
    assertEquals((await scan()).length, 0, "Bob blocked Alice");
    await sql`delete from public.lacak_domba_blocks where blocker_uid = ${BOB}`;

    await sql`update public.lacak_domba_presence set last_seen = now() - interval '181 seconds' where firebase_uid = ${ALICE}`;
    assertEquals((await scan()).length, 0, "presence older than 3 minutes");
    await sql`update public.lacak_domba_presence set last_seen = now() where firebase_uid = ${ALICE}`;
    await elapse(sql, 15 * 60 + 1);
    await sql`update public.lacak_domba_presence set last_seen = now(), location_updated_at = now() where firebase_uid = ${ALICE}`;
    assertEquals((await scan()).length, 0, "an ended session with a fresh location");
});

sqlTest("only service_role may execute the functions or read the tables", async (sql) => {
    for (const role of ["anon", "authenticated"]) {
        await assertRejects(
            () => sql.begin(async (tx) => {
                await tx.unsafe(`set local role ${role}`);
                await tx`select * from public.lacak_domba_discovery_start(${ALICE}, ${tx.json(row())})`;
            }),
            Error,
            "permission denied",
        );
        await assertRejects(
            () => sql.begin(async (tx) => {
                await tx.unsafe(`set local role ${role}`);
                await tx`select * from public.lacak_domba_scan_candidates(${BOB}, -90, 90, 180, 900, 10)`;
            }),
            Error,
            "permission denied",
        );
        for (const table of ["lacak_domba_presence", "lacak_domba_blocks", "lacak_domba_scan_limits"]) {
            await assertRejects(
                () => sql.begin(async (tx) => {
                    await tx.unsafe(`set local role ${role}`);
                    await tx.unsafe(`select 1 from public.${table} limit 1`);
                }),
                Error,
                "permission denied",
            );
        }
    }
    const ok = await sql.begin(async (tx) => {
        await tx.unsafe("set local role service_role");
        return await tx`select * from public.lacak_domba_discovery_start(${ALICE}, ${tx.json(row())})`;
    });
    assertEquals(ok[0].outcome, "started");
});

// --- races between two connections -----------------------------------------

sqlTest("race start/start: two concurrent starts open ONE session", async () => {
    const [a, b] = await race(
        (sql) => start(sql),
        (sql) => start(sql),
    );
    assertEquals(a.session_id, b.session_id);
    assertEquals(b.outcome, "already_active");
});

sqlTest("race start/stop: a stop that waits for a start still ends it", async (sql) => {
    // An ended session's row is still stored, so the start locks it.
    await start(sql);
    await elapse(sql, 15 * 60 + 1);
    const [, stop] = await race(
        (tx) => start(tx),
        (tx) => tx`select * from public.lacak_domba_discovery_end(${ALICE}, 'stop', null)`,
    );
    assertEquals(stop[0].outcome, "ended");
    assertEquals(await stored(sql), undefined);
});

sqlTest("race stop/start: a start that waits for a stop opens a new, consistent session", async (sql) => {
    const s1 = await start(sql);
    const [, s2] = await race(
        (tx) => tx`select * from public.lacak_domba_discovery_end(${ALICE}, 'stop', null)`,
        (tx) => start(tx),
    );
    assertEquals(s2.outcome, "started");
    assert(s2.session_id !== s1.session_id);
    assertEquals((await stored(sql)).session_id, s2.session_id);
});

sqlTest("race extend/stop: a stop that waits for an extend still ends it", async (sql) => {
    const s1 = await start(sql);
    const [extend, stop] = await race(
        (tx) => tx`select * from public.lacak_domba_discovery_extend(${ALICE}, ${s1.session_id}::uuid, ${tx.json(row())})`,
        (tx) => tx`select * from public.lacak_domba_discovery_end(${ALICE}, 'stop', null)`,
    );
    assertEquals(extend[0].outcome, "extended");
    assertEquals(stop[0].outcome, "ended");
    assertEquals(await stored(sql), undefined);
});

sqlTest("race stop/extend: an extend that waits for a stop does not revive", async (sql) => {
    const s1 = await start(sql);
    const [, extend] = await race(
        (tx) => tx`select * from public.lacak_domba_discovery_end(${ALICE}, 'stop', null)`,
        (tx) => tx`select * from public.lacak_domba_discovery_extend(${ALICE}, ${s1.session_id}::uuid, ${tx.json(row())})`,
    );
    assertEquals(extend[0].outcome, "expired");
    assertEquals(await stored(sql), undefined);
});

// Tab A's countdown ends a little BEFORE the server's end (it counts from
// the send time), so its clear always meets a session that has not ended.
// It queues behind the extend on the user's lock and then deletes nothing.
sqlTest("race extend (tab B) / expired clear (stale tab A): the extended session survives", async (sql) => {
    const s1 = await start(sql);
    await elapse(sql, 15 * 60 - 1); // one second left
    const [, clear] = await race(
        (tx) => tx`select * from public.lacak_domba_discovery_extend(${ALICE}, ${s1.session_id}::uuid, ${tx.json(row())})`,
        (tx) => tx`select * from public.lacak_domba_discovery_end(${ALICE}, 'expired', null)`,
    );
    assertEquals(clear[0].outcome, "active");
    assertEquals(clear[0].session_id, s1.session_id);
    assert(await stored(sql), "the extended session was not deleted");
});

sqlTest("race expiry/start: an expired-clear that waits for a new start keeps the new session", async (sql) => {
    await start(sql);
    await elapse(sql, 15 * 60 + 1);
    const [s2, clear] = await race(
        (tx) => start(tx),
        (tx) => tx`select * from public.lacak_domba_discovery_end(${ALICE}, 'expired', null)`,
    );
    assertEquals(s2.outcome, "started");
    assertEquals(clear[0].outcome, "active");
    assertEquals((await stored(sql)).session_id, s2.session_id);
});

sqlTest("race start / stale leave of the previous session: the new session survives", async (sql) => {
    const s1 = await start(sql);
    await elapse(sql, 15 * 60 + 1);
    const [s2, leave] = await race(
        (tx) => start(tx),
        (tx) => tx`select * from public.lacak_domba_discovery_end(${ALICE}, 'leave', ${s1.session_id}::uuid)`,
    );
    assertEquals(leave[0].outcome, "active");
    assertEquals((await stored(sql)).session_id, s2.session_id);
});

sqlTest("race withdrawn refresh / start: a start that waits for a withdrawal opens its session", async (sql) => {
    await start(sql);
    const [, s2] = await race(
        (tx) => tx`select * from public.lacak_domba_discovery_refresh(${ALICE}, null, now())`,
        (tx) => start(tx),
    );
    assertEquals(s2.outcome, "started");
    assertEquals((await stored(sql)).session_id, s2.session_id);
});

sqlTest("the session lock is per user: Alice's open call never blocks Bob", async () => {
    const [, bob] = await race(
        (tx) => start(tx, ALICE),
        (tx) => start(tx, BOB),
        false,
    );
    assertEquals(bob.outcome, "started");
});

// --- stale transaction clock -----------------------------------------------
// The interleaving that two tabs produce in practice: B's transaction starts
// FIRST (so its now() is older), A's call takes the per-user lock and opens or
// changes the session, B's call waits for that lock and runs after A commits.
// Every session write must use the time after the lock, never B's older
// transaction start, or the 15-minute CHECK refuses B (23514, HTTP 500).
async function staleRace<T, U>(
    first: (sql: Sql) => Promise<T>,
    second: (sql: Sql) => Promise<U>,
): Promise<[T, U]> {
    const a = open();
    const b = open();
    const observer = open();
    const ca = await a.reserve();
    const cb = await b.reserve();
    let openA = false;
    let openB = false;
    try {
        const [{ pid }] = await cb`select pg_backend_pid() as pid`;
        await cb`begin`;
        openB = true;
        await cb`select now()`;
        await new Promise((resolve) => setTimeout(resolve, 30));
        await ca`begin`;
        openA = true;
        const firstResult = await first(ca as unknown as Sql);
        const secondPromise = (async () => await second(cb as unknown as Sql))();
        const blocked = await waitForLock(observer, pid);
        await ca`commit`;
        openA = false;
        const secondResult = await secondPromise;
        await cb`commit`;
        openB = false;
        assert(blocked, "the second connection did not wait for the first one's lock");
        return [firstResult, secondResult];
    } finally {
        if (openA) await ca`rollback`.catch(() => {});
        if (openB) await cb`rollback`.catch(() => {});
        ca.release();
        cb.release();
        await Promise.all([a.end(), b.end(), observer.end()]);
    }
}

// The stored row, when there is one, obeys the session rules and holds one
// of the submitted locations, complete.
async function assertConsistent(sql: Sql, uid = ALICE) {
    const rows = await sql`
        select latitude, longitude, location_updated_at,
               discoverable_until <= updated_at + interval '15 minutes' as capped,
               discoverable_until <= clock_timestamp() + interval '15 minutes' as within_now,
               updated_at >= session_started_at as ordered
        from public.lacak_domba_presence where firebase_uid = ${uid}`;
    for (const r of rows) {
        assertEquals([r.capped, r.within_now, r.ordered], [true, true, true]);
        assertEquals([r.latitude, r.longitude], [-1, 131]);
        assert(r.location_updated_at !== null, "location time missing");
    }
}

const sessionCall = {
    start: (tx: Sql) => start(tx),
    refresh: (tx: Sql) => tx`select * from public.lacak_domba_discovery_refresh(${ALICE}, ${tx.json(row())}, now())`.then((r) => r[0]),
    extend: (id: string) => (tx: Sql) =>
        tx`select * from public.lacak_domba_discovery_extend(${ALICE}, ${id}::uuid, ${tx.json(row())})`.then((r) => r[0]),
    stop: (tx: Sql) => tx`select * from public.lacak_domba_discovery_end(${ALICE}, 'stop', null)`.then((r) => r[0]),
};

sqlTest("stale clock start/start (two tabs): the later start adopts the session, no CHECK error", async (sql) => {
    const [first, second] = await staleRace(sessionCall.start, sessionCall.start);
    assertEquals([first.outcome, second.outcome], ["started", "already_active"]);
    assertEquals(second.session_id, first.session_id);
    assert(Number(second.expires_in_ms) <= 15 * 60 * 1000);
    await assertConsistent(sql);
});

sqlTest("stale clock start (new session) / heartbeat refresh: the refresh keeps the session", async (sql) => {
    const [first, second] = await staleRace(sessionCall.start, sessionCall.refresh);
    assertEquals([first.outcome, second.outcome], ["started", "active"]);
    assertEquals(second.expires_at.getTime(), first.expires_at.getTime());
    await assertConsistent(sql);
});

sqlTest("stale clock extend / start: the start adopts the extended session", async (sql) => {
    const s0 = await start(sql);
    await elapse(sql, 60);
    const [ext, st] = await staleRace(sessionCall.extend(s0.session_id), sessionCall.start);
    assertEquals([ext.outcome, st.outcome], ["extended", "already_active"]);
    assertEquals(st.expires_at.getTime(), ext.expires_at.getTime());
    await assertConsistent(sql);
});

sqlTest("stale clock start (after expiry) / extend of the old session: reported, not extended", async (sql) => {
    const s0 = await start(sql);
    await elapse(sql, 15 * 60 + 1);
    const [st, ext] = await staleRace(sessionCall.start, sessionCall.extend(s0.session_id));
    assertEquals([st.outcome, ext.outcome], ["started", "session_changed"]);
    assertEquals(ext.session_id, st.session_id);
    await assertConsistent(sql);
});

sqlTest("stale clock extend / stop and stop / extend: the session always ends, never revived", async (sql) => {
    const s0 = await start(sql);
    const [ext, stop] = await staleRace(sessionCall.extend(s0.session_id), sessionCall.stop);
    assertEquals([ext.outcome, stop.outcome], ["extended", "ended"]);
    assertEquals(await stored(sql), undefined);
    const s1 = await start(sql);
    const [stop2, ext2] = await staleRace(sessionCall.stop, sessionCall.extend(s1.session_id));
    assertEquals([stop2.outcome, ext2.outcome], ["ended", "expired"]);
    assertEquals(await stored(sql), undefined);
});

sqlTest("stress: 10 connections, starts and mixed start/extend/refresh/stop, 10 rounds, no error", async (sql) => {
    const conns = Array.from({ length: 10 }, open);
    try {
        for (let round = 0; round < 10; round++) {
            await reset(sql);
            const starts = await Promise.all(conns.map((c) => start(c)));
            assertEquals(new Set(starts.map((r) => r.session_id)).size, 1);
            assertEquals(starts.filter((r) => r.outcome === "started").length, 1);
            await assertConsistent(sql);
            const id = starts[0].session_id;
            const calls = [sessionCall.start, sessionCall.refresh, sessionCall.extend(id), sessionCall.stop];
            await Promise.all(conns.map((c, i) => calls[i % calls.length](c)));
            await assertConsistent(sql);
        }
    } finally {
        await Promise.all(conns.map((c) => c.end()));
    }
});
