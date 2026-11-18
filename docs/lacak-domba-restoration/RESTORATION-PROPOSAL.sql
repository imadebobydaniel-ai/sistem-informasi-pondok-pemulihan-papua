-- REVIEW PROPOSAL ONLY. Target cfnimvrxrnmefmxtzqks; NOT APPLIED.
-- Existing migration body is preserved. No base migration, data backfill or RPC call.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $preflight$
begin
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('lacak_domba_discovery_start','lacak_domba_discovery_extend','lacak_domba_discovery_refresh','lacak_domba_discovery_end','lacak_domba_scan_candidates','lacak_domba_purge_stale')) then
    raise exception 'STOP: discovery RPC already exists; compare before any replacement';
  end if;
  if exists(select 1 from information_schema.columns where table_schema='public'
    and table_name='lacak_domba_presence' and column_name in ('discoverable_until','discovery_session_id','session_started_at')) then
    raise exception 'STOP: discovery columns already exist; compare first';
  end if;
  if (select md5(pg_get_functiondef(to_regprocedure('public.lacak_domba_replace_own_blocks(text,text[])')))) is distinct from '5f3d414be75d04cdf44a84216f863db5'
    or (select md5(pg_get_functiondef(to_regprocedure('public.lacak_domba_take_scan_slot(text,integer)')))) is distinct from '50947f36fa1d6bd3cb946437c56f7537' then
    raise exception 'STOP: existing RPC definitions differ from reviewed production snapshot';
  end if;
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
    and c.relname in ('lacak_domba_presence','lacak_domba_blocks','lacak_domba_scan_limits') and not c.relrowsecurity) then
    raise exception 'STOP: existing RLS posture changed';
  end if;
  if exists(select 1 from information_schema.columns where table_schema='public' and table_name='lacak_domba_presence'
    and column_name in ('latitude','longitude') and data_type <> 'double precision') then
    raise exception 'STOP: coordinate column type mismatch';
  end if;
end;
$preflight$;
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

-- Catalog-only postcondition. Never call lifecycle/scan/purge RPCs in production checks.
do $postcheck$
declare v_oid oid; v_name text;
begin
  foreach v_name in array array['lacak_domba_discovery_start','lacak_domba_discovery_extend','lacak_domba_discovery_refresh','lacak_domba_discovery_end','lacak_domba_scan_candidates','lacak_domba_purge_stale'] loop
    select p.oid into strict v_oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=v_name;
    if has_function_privilege('anon',v_oid,'EXECUTE') or has_function_privilege('authenticated',v_oid,'EXECUTE')
      or not has_function_privilege('service_role',v_oid,'EXECUTE') then raise exception 'STOP: RPC execute posture mismatch'; end if;
  end loop;
  if (select md5(pg_get_functiondef(to_regprocedure('public.lacak_domba_replace_own_blocks(text,text[])')))) is distinct from '5f3d414be75d04cdf44a84216f863db5'
    or (select md5(pg_get_functiondef(to_regprocedure('public.lacak_domba_take_scan_slot(text,integer)')))) is distinct from '50947f36fa1d6bd3cb946437c56f7537' then raise exception 'STOP: existing RPC changed'; end if;
end;
$postcheck$;
notify pgrst, 'reload schema';

-- Existing blocks RPC compatibility correction in the SAME transaction.
set local lock_timeout='5s';
set local statement_timeout='60s';
do $compat_preflight$
begin
 if md5(pg_get_functiondef(to_regprocedure('public.lacak_domba_replace_own_blocks(text,text[])'))) is distinct from '5f3d414be75d04cdf44a84216f863db5' then raise exception 'STOP: existing block RPC changed since review'; end if;
 if has_function_privilege('anon','public.lacak_domba_replace_own_blocks(text,text[])','EXECUTE') or has_function_privilege('authenticated','public.lacak_domba_replace_own_blocks(text,text[])','EXECUTE') or not has_function_privilege('service_role','public.lacak_domba_replace_own_blocks(text,text[])','EXECUTE') then raise exception 'STOP: block RPC ACL differs'; end if;
end;
$compat_preflight$;
CREATE OR REPLACE FUNCTION public.lacak_domba_replace_own_blocks(p_blocker_uid text, p_blocked_uids text[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
    v_blocked_uid TEXT;
    inserted_count INTEGER := 0;
BEGIN
    IF p_blocker_uid IS NULL
       OR length(p_blocker_uid) < 1
       OR length(p_blocker_uid) > 128 THEN
        RAISE EXCEPTION 'Invalid blocker UID';
    END IF;

    IF cardinality(COALESCE(p_blocked_uids, ARRAY[]::TEXT[])) > 10000 THEN
        RAISE EXCEPTION 'Block list exceeds limit';
    END IF;

    -- Match the existing repository's per-owner atomic replacement protocol.
    PERFORM pg_advisory_xact_lock(hashtextextended('lacak_domba_blocks:' || p_blocker_uid, 0));

    DELETE FROM public.lacak_domba_blocks
    WHERE blocker_uid = p_blocker_uid;

    FOREACH v_blocked_uid IN ARRAY
        COALESCE(p_blocked_uids, ARRAY[]::TEXT[])
    LOOP
        IF v_blocked_uid IS NULL
           OR length(v_blocked_uid) < 1
           OR length(v_blocked_uid) > 128
           OR v_blocked_uid = p_blocker_uid THEN
            CONTINUE;
        END IF;

        INSERT INTO public.lacak_domba_blocks (
            blocker_uid,
            blocked_uid
        )
        VALUES (
            p_blocker_uid,
            v_blocked_uid
        )
        ON CONFLICT (blocker_uid, blocked_uid) DO NOTHING;

        inserted_count := inserted_count + 1;
    END LOOP;

    RETURN inserted_count;
END;
$function$
;
notify pgrst, 'reload schema';
commit;
