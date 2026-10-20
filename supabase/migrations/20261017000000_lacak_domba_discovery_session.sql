-- Lacak Domba: server-side "Bisa Ditemukan" sessions on database time
-- (LD-16, LD16-01, LD16-03, LD16-04, LD16-05).
--
-- DRAFT - not applied anywhere. Review, then apply BEFORE deploying the Edge
-- Function version that calls these functions; no deployed code uses them
-- yet, so applying this first is harmless. Requires 20261010000000.
--
-- What this file does:
--   * adds lacak_domba_presence.discoverable_until, discovery_session_id and
--     session_started_at (all nullable). Rows without a session never appear
--     in a scan, so existing rows stop being listed until their owner starts
--     a new session.
--   * adds a CHECK that a session never ends more than 15 minutes after the
--     row was last written, and a CHECK that keeps a session id, a start
--     time and an end time together (a row is in one session or in none).
--   * adds an index for the scan filter and the purge.
--   * adds functions that start, extend, refresh and end a session, each in
--     one transaction, with every time taken from the database clock, never
--     from the Edge Function or the browser. The four session functions
--     read that time once, with clock_timestamp() right after the per-user
--     lock, and use it for every write and comparison of the call (see
--     concurrency below):
--       lacak_domba_discovery_start   - opens a 15-minute session, or keeps
--                                       the running one (never lengthens it)
--       lacak_domba_discovery_extend  - 15 minutes from now, only for the
--                                       session the caller names
--       lacak_domba_discovery_refresh - updates a running session's row;
--                                       never moves its end
--       lacak_domba_discovery_end     - stop / stop_retry / expired / leave,
--                                       see the function comment
--       lacak_domba_scan_candidates   - the scan filter, on database time,
--                                       with blocks in both directions
--       lacak_domba_purge_stale       - drops rows nobody may see any more
--   * concurrency: every session function first takes a per-user
--     transaction-scoped advisory lock (pg_advisory_xact_lock), so the calls
--     of one user run one after another; start is a single
--     INSERT ... ON CONFLICT, so two starts open at most one session.
--     now() would be the start of the caller's transaction, which can be
--     older than a session another call committed while this one waited
--     for the lock; the 15-minute CHECK then refused the write (23514).
--   * every function is SECURITY DEFINER with a pinned search_path, and
--     EXECUTE is revoked from public, anon and authenticated and granted to
--     service_role only. No table grant changes.
-- Nothing is dropped and no row is changed by the file itself, so it is safe
-- to re-run. Exception: a DEVELOPMENT database that has an earlier draft of
-- the four discovery_* functions (three result columns, without expires_at;
-- never applied to production) needs them dropped first with the rollback
-- statements below, because create or replace cannot change a result type.
--
-- Rollback (manual, after review):
--   drop function if exists public.lacak_domba_discovery_start(text, jsonb);
--   drop function if exists public.lacak_domba_discovery_extend(text, uuid, jsonb);
--   drop function if exists public.lacak_domba_discovery_refresh(text, jsonb, timestamptz);
--   drop function if exists public.lacak_domba_discovery_end(text, text, uuid);
--   drop function if exists public.lacak_domba_scan_candidates(text, double precision, double precision, integer, integer, integer);
--   drop function if exists public.lacak_domba_purge_stale(integer);
--   alter table public.lacak_domba_presence
--       drop constraint if exists lacak_domba_presence_active_session_location;
--   alter table public.lacak_domba_presence
--       drop constraint if exists lacak_domba_presence_session_consistent;
--   alter table public.lacak_domba_presence
--       drop constraint if exists lacak_domba_presence_discoverable_until_cap;
--   drop index if exists public.lacak_domba_presence_discoverable_until_idx;
--   alter table public.lacak_domba_presence drop column if exists session_started_at;
--   alter table public.lacak_domba_presence drop column if exists discovery_session_id;
--   alter table public.lacak_domba_presence drop column if exists discoverable_until;
--
-- Apply the whole file as ONE transaction, so a failure leaves nothing half
-- done, e.g.: psql --single-transaction -v ON_ERROR_STOP=1 -f <this file>

alter table public.lacak_domba_presence
    add column if not exists discoverable_until timestamptz;

do $migration$
begin
    if not exists (
        select 1
        from pg_constraint
        where conrelid = 'public.lacak_domba_presence'::regclass
            and conname = 'lacak_domba_presence_discoverable_until_cap'
    ) then
        alter table public.lacak_domba_presence
            add constraint lacak_domba_presence_discoverable_until_cap
            check (
                discoverable_until is null
                or discoverable_until <= updated_at + interval '15 minutes'
            );
    end if;
end;
$migration$;

create index if not exists lacak_domba_presence_discoverable_until_idx
    on public.lacak_domba_presence (discoverable_until);

alter table public.lacak_domba_presence
    add column if not exists discovery_session_id uuid;

alter table public.lacak_domba_presence
    add column if not exists session_started_at timestamptz;

do $migration$
begin
    if not exists (
        select 1
        from pg_constraint
        where conrelid = 'public.lacak_domba_presence'::regclass
            and conname = 'lacak_domba_presence_session_consistent'
    ) then
        alter table public.lacak_domba_presence
            add constraint lacak_domba_presence_session_consistent
            check (
                (discovery_session_id is null)
                    = (discoverable_until is null)
                and (discovery_session_id is null)
                    = (session_started_at is null)
            );
    end if;
end;
$migration$;

-- Legacy production deliberately allows null coordinates when there is no
-- discovery session. Preserve that backwards-compatible column nullability,
-- but reject an ACTIVE SESSION without complete, bounded coordinates and a
-- location timestamp. SQL CHECK must explicitly test IS NOT NULL because
-- PostgreSQL accepts a CHECK expression that evaluates to UNKNOWN.
do $migration$
begin
    if not exists (
        select 1 from pg_constraint
        where conrelid = 'public.lacak_domba_presence'::regclass
          and conname = 'lacak_domba_presence_active_session_location'
    ) then
        alter table public.lacak_domba_presence
            add constraint lacak_domba_presence_active_session_location
            check (
                discoverable_until is null
                or (
                    latitude is not null
                    and longitude is not null
                    and location_updated_at is not null
                    and latitude between -90 and 90
                    and longitude between -180 and 180
                )
            );
    end if;
end;
$migration$;

-- The row the Edge Function builds from the caller's own Firestore documents.
-- Only these keys are read; anything else in p_row is ignored. Values are
-- checked by the table's CHECK constraints.

-- Result of every session function:
--   outcome        - what happened, see each function
--   session_id     - the running session, or NULL when there is none
--   expires_in_ms  - time left on the database clock, 0 when none
--   expires_at     - the session end on the database clock (NULL when none),
--                    so the browser can show a server-verified clock time
create or replace function public.lacak_domba_discovery_start(
    p_uid text,
    p_row jsonb
)
returns table (outcome text, session_id uuid, expires_in_ms bigint, expires_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
    v_row public.lacak_domba_presence;
    v_now timestamptz;
begin
    if p_uid is null or char_length(p_uid) not between 1 and 128 then
        raise exception 'invalid firebase uid' using errcode = '22023';
    end if;
    -- One user at a time: concurrent session calls of the same user queue
    -- here until the first one commits.
    perform pg_advisory_xact_lock(hashtextextended('lacak_domba_presence:' || p_uid, 0));
    -- The time of this call, read AFTER the lock: a call that waited for
    -- another one of this user is never older than what that call wrote.
    v_now := clock_timestamp();
    if p_row is null then
        raise exception 'presence row required' using errcode = '22023';
    end if;

    -- One statement: a running session is kept, otherwise a new one is
    -- opened. Without the advisory lock above, a concurrent start would wait
    -- on the row lock and then see the committed session; either way two
    -- starts open at most one session.
    insert into public.lacak_domba_presence as p (
        firebase_uid, latitude, longitude, display_name, photo_url, komsel,
        wilayah, discoverable, show_online, online, last_seen,
        location_updated_at, updated_at, discoverable_until,
        discovery_session_id, session_started_at
    )
    values (
        p_uid,
        (p_row ->> 'latitude')::double precision,
        (p_row ->> 'longitude')::double precision,
        coalesce(p_row ->> 'display_name', 'Jemaat SIPAPUA'),
        coalesce(p_row ->> 'photo_url', ''),
        coalesce(p_row ->> 'komsel', ''),
        coalesce(p_row ->> 'wilayah', ''),
        true,
        coalesce((p_row ->> 'show_online')::boolean, false),
        coalesce((p_row ->> 'online')::boolean, false),
        (p_row ->> 'last_seen')::timestamptz,
        (p_row ->> 'location_updated_at')::timestamptz,
        v_now,
        v_now + interval '15 minutes',
        gen_random_uuid(),
        v_now
    )
    on conflict (firebase_uid) do update set
        latitude = excluded.latitude,
        longitude = excluded.longitude,
        display_name = excluded.display_name,
        photo_url = excluded.photo_url,
        komsel = excluded.komsel,
        wilayah = excluded.wilayah,
        discoverable = true,
        show_online = excluded.show_online,
        online = excluded.online,
        last_seen = excluded.last_seen,
        location_updated_at = excluded.location_updated_at,
        updated_at = v_now,
        -- A running session keeps its id, start and end.
        discoverable_until = case when p.discoverable_until > v_now
            then p.discoverable_until else excluded.discoverable_until end,
        discovery_session_id = case when p.discoverable_until > v_now
            then p.discovery_session_id else excluded.discovery_session_id end,
        session_started_at = case when p.discoverable_until > v_now
            then p.session_started_at else excluded.session_started_at end
    returning p.* into v_row;

    -- A session opened by this call starts exactly at v_now; one opened by
    -- an earlier call (which held the lock before) starts earlier.
    return query select
        case when v_row.session_started_at = v_now then 'started' else 'already_active' end,
        v_row.discovery_session_id,
        greatest(0, floor(extract(epoch from (v_row.discoverable_until - v_now)) * 1000))::bigint,
            v_row.discoverable_until;
end;
$function$;

-- Outcomes: 'extended'; 'session_changed' (another session is running: it is
-- reported, not extended); 'expired' (no session; any leftover row of an
-- ended session is removed).
create or replace function public.lacak_domba_discovery_extend(
    p_uid text,
    p_session_id uuid,
    p_row jsonb
)
returns table (outcome text, session_id uuid, expires_in_ms bigint, expires_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
    v_row public.lacak_domba_presence;
    v_now timestamptz;
begin
    if p_uid is null or char_length(p_uid) not between 1 and 128 then
        raise exception 'invalid firebase uid' using errcode = '22023';
    end if;
    -- One user at a time: concurrent session calls of the same user queue
    -- here until the first one commits.
    perform pg_advisory_xact_lock(hashtextextended('lacak_domba_presence:' || p_uid, 0));
    -- The time of this call, read AFTER the lock: a call that waited for
    -- another one of this user is never older than what that call wrote.
    v_now := clock_timestamp();
    if p_row is null or p_session_id is null then
        raise exception 'presence row and session id required' using errcode = '22023';
    end if;

    update public.lacak_domba_presence p set
        latitude = (p_row ->> 'latitude')::double precision,
        longitude = (p_row ->> 'longitude')::double precision,
        display_name = coalesce(p_row ->> 'display_name', 'Jemaat SIPAPUA'),
        photo_url = coalesce(p_row ->> 'photo_url', ''),
        komsel = coalesce(p_row ->> 'komsel', ''),
        wilayah = coalesce(p_row ->> 'wilayah', ''),
        show_online = coalesce((p_row ->> 'show_online')::boolean, false),
        online = coalesce((p_row ->> 'online')::boolean, false),
        last_seen = (p_row ->> 'last_seen')::timestamptz,
        location_updated_at = (p_row ->> 'location_updated_at')::timestamptz,
        updated_at = v_now,
        discoverable_until = v_now + interval '15 minutes'
    where p.firebase_uid = p_uid
        and p.discovery_session_id = p_session_id
        and p.discoverable_until > v_now
    returning p.* into v_row;

    if found then
        return query select 'extended'::text, v_row.discovery_session_id,
            greatest(0, floor(extract(epoch from (v_row.discoverable_until - v_now)) * 1000))::bigint,
            v_row.discoverable_until;
        return;
    end if;

    select * into v_row
    from public.lacak_domba_presence p
    where p.firebase_uid = p_uid and p.discoverable_until > v_now;
    if found then
        return query select 'session_changed'::text, v_row.discovery_session_id,
            greatest(0, floor(extract(epoch from (v_row.discoverable_until - v_now)) * 1000))::bigint,
            v_row.discoverable_until;
        return;
    end if;

    delete from public.lacak_domba_presence p
    where p.firebase_uid = p_uid
        and (p.discoverable_until is null or p.discoverable_until <= v_now);
    return query select 'expired'::text, null::uuid, 0::bigint, null::timestamptz;
end;
$function$;

-- Heartbeat, sync and scan. Never moves the end of a session.
--   p_row NOT NULL - the caller is discoverable in Firestore with a fresh
--                    location: a running session's row is updated
--                    ('active'); without one, any leftover row is removed
--                    ('inactive').
--   p_row NULL     - Firestore says the caller is not discoverable (or has
--                    no fresh location): the row is removed ('withdrawn'),
--                    except a session that started after p_read_at, the
--                    time the Edge Function began reading Firestore. That
--                    session was opened after the read and is not undone
--                    by an older read.
create or replace function public.lacak_domba_discovery_refresh(
    p_uid text,
    p_row jsonb,
    p_read_at timestamptz
)
returns table (outcome text, session_id uuid, expires_in_ms bigint, expires_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
    v_row public.lacak_domba_presence;
    v_now timestamptz;
begin
    if p_uid is null or char_length(p_uid) not between 1 and 128 then
        raise exception 'invalid firebase uid' using errcode = '22023';
    end if;
    -- One user at a time: concurrent session calls of the same user queue
    -- here until the first one commits.
    perform pg_advisory_xact_lock(hashtextextended('lacak_domba_presence:' || p_uid, 0));
    -- The time of this call, read AFTER the lock: a call that waited for
    -- another one of this user is never older than what that call wrote.
    v_now := clock_timestamp();

    if p_row is null then
        if p_read_at is null then
            raise exception 'read time required' using errcode = '22023';
        end if;
        delete from public.lacak_domba_presence p
        where p.firebase_uid = p_uid
            and (p.session_started_at is null or p.session_started_at <= p_read_at);
        select * into v_row
        from public.lacak_domba_presence p
        where p.firebase_uid = p_uid and p.discoverable_until > v_now;
        if found then
            return query select 'active'::text, v_row.discovery_session_id,
                greatest(0, floor(extract(epoch from (v_row.discoverable_until - v_now)) * 1000))::bigint,
            v_row.discoverable_until;
        else
            return query select 'withdrawn'::text, null::uuid, 0::bigint, null::timestamptz;
        end if;
        return;
    end if;

    update public.lacak_domba_presence p set
        latitude = (p_row ->> 'latitude')::double precision,
        longitude = (p_row ->> 'longitude')::double precision,
        display_name = coalesce(p_row ->> 'display_name', 'Jemaat SIPAPUA'),
        photo_url = coalesce(p_row ->> 'photo_url', ''),
        komsel = coalesce(p_row ->> 'komsel', ''),
        wilayah = coalesce(p_row ->> 'wilayah', ''),
        discoverable = true,
        show_online = coalesce((p_row ->> 'show_online')::boolean, false),
        online = coalesce((p_row ->> 'online')::boolean, false),
        last_seen = (p_row ->> 'last_seen')::timestamptz,
        location_updated_at = (p_row ->> 'location_updated_at')::timestamptz,
        updated_at = v_now
    where p.firebase_uid = p_uid
        and p.discoverable_until > v_now
    returning p.* into v_row;

    if found then
        return query select 'active'::text, v_row.discovery_session_id,
            greatest(0, floor(extract(epoch from (v_row.discoverable_until - v_now)) * 1000))::bigint,
            v_row.discoverable_until;
        return;
    end if;

    delete from public.lacak_domba_presence p
    where p.firebase_uid = p_uid
        and (p.discoverable_until is null or p.discoverable_until <= v_now);
    return query select 'inactive'::text, null::uuid, 0::bigint, null::timestamptz;
end;
$function$;

-- Ends discovery. p_mode:
--   'stop'       - explicit "Matikan": removes the caller's row whatever
--                  session it holds. Always allowed: it only hides the user.
--   'stop_retry' - a "Matikan" that could not reach the server earlier and
--                  is retried later: removes only the session it was meant
--                  for (p_session_id), so a session started since then on
--                  another tab or device survives.
--   'expired'    - the browser's countdown reached zero: removes only a row
--                  whose session has ended on the database clock.
--   'leave'      - the last open tab is closed: removes only p_session_id.
-- Outcome 'ended' when no session is running afterwards, otherwise 'active'
-- with the session that is still running (the caller adopts it).
create or replace function public.lacak_domba_discovery_end(
    p_uid text,
    p_mode text,
    p_session_id uuid
)
returns table (outcome text, session_id uuid, expires_in_ms bigint, expires_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
    v_row public.lacak_domba_presence;
    v_now timestamptz;
begin
    if p_uid is null or char_length(p_uid) not between 1 and 128 then
        raise exception 'invalid firebase uid' using errcode = '22023';
    end if;
    -- One user at a time: concurrent session calls of the same user queue
    -- here until the first one commits.
    perform pg_advisory_xact_lock(hashtextextended('lacak_domba_presence:' || p_uid, 0));
    -- The time of this call, read AFTER the lock: a call that waited for
    -- another one of this user is never older than what that call wrote.
    v_now := clock_timestamp();

    if p_mode = 'stop' then
        delete from public.lacak_domba_presence p where p.firebase_uid = p_uid;
    elsif p_mode in ('stop_retry', 'leave') then
        if p_session_id is null then
            raise exception 'session id required' using errcode = '22023';
        end if;
        delete from public.lacak_domba_presence p
        where p.firebase_uid = p_uid
            and (p.discovery_session_id = p_session_id
                or p.discoverable_until is null
                or p.discoverable_until <= v_now);
    elsif p_mode = 'expired' then
        delete from public.lacak_domba_presence p
        where p.firebase_uid = p_uid
            and (p.discoverable_until is null or p.discoverable_until <= v_now);
    else
        raise exception 'unknown mode' using errcode = '22023';
    end if;

    select * into v_row
    from public.lacak_domba_presence p
    where p.firebase_uid = p_uid and p.discoverable_until > v_now;
    if found then
        return query select 'active'::text, v_row.discovery_session_id,
            greatest(0, floor(extract(epoch from (v_row.discoverable_until - v_now)) * 1000))::bigint,
            v_row.discoverable_until;
    else
        return query select 'ended'::text, null::uuid, 0::bigint, null::timestamptz;
    end if;
end;
$function$;

-- Candidates for a scan by p_uid inside a latitude band, filtered on the
-- database clock: a running session, a fresh presence and a fresh location,
-- not the caller, and no block in either direction. Coordinates go to the
-- Edge Function only (service_role); it returns distance ranges, never
-- coordinates. At most p_limit rows.
create or replace function public.lacak_domba_scan_candidates(
    p_uid text,
    p_min_lat double precision,
    p_max_lat double precision,
    p_presence_max_age_seconds integer,
    p_location_max_age_seconds integer,
    p_limit integer
)
returns table (
    firebase_uid text,
    latitude double precision,
    longitude double precision,
    display_name text,
    photo_url text,
    komsel text,
    wilayah text,
    show_online boolean
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
    select p.firebase_uid, p.latitude, p.longitude, p.display_name,
           p.photo_url, p.komsel, p.wilayah, p.show_online
    from public.lacak_domba_presence p
    where p.discoverable
        and p.online
        and p.latitude between p_min_lat and p_max_lat
        and p.discoverable_until > now()
        and p.last_seen >= now() - make_interval(secs => p_presence_max_age_seconds)
        and p.location_updated_at >= now() - make_interval(secs => p_location_max_age_seconds)
        and p.firebase_uid <> p_uid
        and not exists (
            select 1 from public.lacak_domba_blocks b
            where (b.blocker_uid = p_uid and b.blocked_uid = p.firebase_uid)
                or (b.blocker_uid = p.firebase_uid and b.blocked_uid = p_uid)
        )
    limit greatest(0, least(p_limit, 1000));
$function$;

-- Removes rows that no scan may return any more: ended or missing sessions
-- and locations older than p_location_max_age_seconds. Returns the count.
create or replace function public.lacak_domba_purge_stale(
    p_location_max_age_seconds integer
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
    v_count integer;
begin
    delete from public.lacak_domba_presence p
    where p.discoverable_until is null
        or p.discoverable_until <= now()
        or p.location_updated_at < now() - make_interval(secs => p_location_max_age_seconds);
    get diagnostics v_count = row_count;
    return v_count;
end;
$function$;

revoke all on function public.lacak_domba_discovery_start(text, jsonb) from public, anon, authenticated;
revoke all on function public.lacak_domba_discovery_extend(text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.lacak_domba_discovery_refresh(text, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.lacak_domba_discovery_end(text, text, uuid) from public, anon, authenticated;
revoke all on function public.lacak_domba_scan_candidates(text, double precision, double precision, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.lacak_domba_purge_stale(integer) from public, anon, authenticated;

grant execute on function public.lacak_domba_discovery_start(text, jsonb) to service_role;
grant execute on function public.lacak_domba_discovery_extend(text, uuid, jsonb) to service_role;
grant execute on function public.lacak_domba_discovery_refresh(text, jsonb, timestamptz) to service_role;
grant execute on function public.lacak_domba_discovery_end(text, text, uuid) to service_role;
grant execute on function public.lacak_domba_scan_candidates(text, double precision, double precision, integer, integer, integer) to service_role;
grant execute on function public.lacak_domba_purge_stale(integer) to service_role;

-- ---------------------------------------------------------------------------
-- Read-only checks after applying:
-- select column_name, data_type, is_nullable
-- from information_schema.columns
-- where table_schema = 'public' and table_name = 'lacak_domba_presence'
--     and column_name in ('discoverable_until', 'discovery_session_id', 'session_started_at');
--
-- select p.proname, pg_get_function_identity_arguments(p.oid), p.prosecdef,
--        p.proconfig, p.proacl
-- from pg_proc p
-- where p.pronamespace = 'public'::regnamespace
--     and p.proname like 'lacak_domba_%'
-- order by 1;
