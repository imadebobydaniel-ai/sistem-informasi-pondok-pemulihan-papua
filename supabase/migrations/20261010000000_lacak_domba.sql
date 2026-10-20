-- Lacak Domba: database objects used by supabase/functions/lacak-domba-nearby.
--
-- SOURCE OF TRUTH
--   * tables    - columns are taken from the calls the Edge Function makes.
--                 They were NOT exported from production.
--   * functions - signature, result type, SECURITY DEFINER, search_path and
--                 limits follow the audited production definitions. The
--                 production function BODIES are not in this repository, so
--                 the bodies below are written for fresh installations and
--                 are not claimed to be identical to production.
-- Run the read-only checks at the bottom first and compare.
--
-- What this file does to a database that already has these objects:
--   * tables    - left exactly as they are (create table if not exists). A
--                 production column that differs is neither reported nor
--                 fixed here; that is what the checks at the bottom are for.
--   * functions - never replaced, never dropped, never overloaded. A function
--                 is created only when no function of that name exists at
--                 all. When the exact signature already exists, its result
--                 type, argument names, SECURITY DEFINER and search_path are
--                 compared with this file: a match gives a NOTICE, a
--                 difference gives a WARNING starting with "CONFLICT". The
--                 body is never compared. The reviewed manual step for a
--                 conflict is at the bottom, commented out.
--   * execute   - for the exact signatures, EXECUTE is revoked from public,
--                 anon and authenticated and granted to service_role, also
--                 when the function already existed. This DOES change
--                 production if execute is currently looser.
--   * indexes   - added when missing.
--   * access    - RLS is enabled and anon/authenticated lose direct table
--                 access. This DOES change production if it is currently
--                 looser. No policies are created: only the Edge Function
--                 (service_role, which bypasses RLS) reads or writes.
-- Nothing is dropped and no row is deleted, so it is safe to re-run.

create table if not exists public.lacak_domba_presence (
    firebase_uid        text primary key
                        check (char_length(firebase_uid) between 1 and 128),
    latitude            double precision not null
                        check (latitude between -90 and 90),
    longitude           double precision not null
                        check (longitude between -180 and 180),
    display_name        text not null default 'Jemaat SIPAPUA'
                        check (char_length(display_name) <= 100),
    photo_url           text not null default ''
                        check (char_length(photo_url) <= 2048),
    komsel              text not null default ''
                        check (char_length(komsel) <= 120),
    wilayah             text not null default ''
                        check (char_length(wilayah) <= 120),
    discoverable        boolean not null default false,
    show_online         boolean not null default false,
    online              boolean not null default false,
    last_seen           timestamptz,
    location_updated_at timestamptz not null,
    updated_at          timestamptz not null default now()
);

-- Scan filters on a latitude band; the purge filters on location age.
create index if not exists lacak_domba_presence_latitude_idx
    on public.lacak_domba_presence (latitude);

create index if not exists lacak_domba_presence_location_updated_at_idx
    on public.lacak_domba_presence (location_updated_at);

create table if not exists public.lacak_domba_blocks (
    blocker_uid text not null check (char_length(blocker_uid) between 1 and 128),
    blocked_uid text not null check (char_length(blocked_uid) between 1 and 128),
    created_at  timestamptz not null default now(),
    primary key (blocker_uid, blocked_uid),
    check (blocker_uid <> blocked_uid)
);

-- Reverse lookup: "who has blocked the caller".
create index if not exists lacak_domba_blocks_blocked_uid_idx
    on public.lacak_domba_blocks (blocked_uid);

alter table public.lacak_domba_presence enable row level security;
alter table public.lacak_domba_blocks   enable row level security;

revoke all on public.lacak_domba_presence from public, anon, authenticated;
revoke all on public.lacak_domba_blocks   from public, anon, authenticated;

grant select, insert, update, delete on public.lacak_domba_presence to service_role;
grant select, insert, update, delete on public.lacak_domba_blocks   to service_role;

-- lacak_domba_take_scan_slot(p_firebase_uid, p_min_interval_seconds) -> boolean
--
-- Returns true and records the scan when the caller's previous scan is at
-- least p_min_interval_seconds old, false otherwise. The check and the write
-- are one INSERT ... ON CONFLICT DO UPDATE ... WHERE statement: a concurrent
-- call waits on the row lock and then re-checks against the committed value,
-- so two concurrent scans cannot both take the slot.
-- An interval outside 1-300 seconds or an invalid uid raises 22023; the Edge
-- Function then answers 500 and no scan runs. (Whether production raises or
-- returns false for these is not known here; the Edge Function always
-- passes 15.)
-- SECURITY DEFINER: every object is schema-qualified, search_path is pinned,
-- and execute is limited to service_role below.
-- The bookkeeping table is created together with the function, because an
-- existing production function keeps its own storage. Its name is a choice
-- made in this file, not something read from production.
do $migration$
declare
    v_oid    oid := to_regprocedure('public.lacak_domba_take_scan_slot(text, integer)');
    v_others text;
    v_diff   text := '';
begin
    select string_agg(p.oid::regprocedure::text, ', ')
    into v_others
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
        and p.proname = 'lacak_domba_take_scan_slot'
        and p.oid is distinct from v_oid;

    if v_others is not null then
        raise warning 'CONFLICT: lacak_domba_take_scan_slot also exists with other arguments (%). Nothing was created or changed for them; PostgREST may not resolve the call. Review manually.', v_others;
    end if;

    if v_oid is not null then
        select concat_ws('; ',
            case when p.prorettype <> 'boolean'::regtype or p.proretset
                then 'returns ' || pg_get_function_result(p.oid) || ', expected boolean' end,
            case when p.proargnames is distinct from array['p_firebase_uid', 'p_min_interval_seconds']
                then 'argument names ' || coalesce(p.proargnames::text, '(none)') end,
            case when not p.prosecdef then 'is SECURITY INVOKER, expected SECURITY DEFINER' end,
            case when not exists (
                    select 1 from unnest(p.proconfig) c
                    where replace(replace(c, ' ', ''), '"', '') = 'search_path=pg_catalog,public'
                ) then 'search_path is not pg_catalog, public' end)
        into v_diff
        from pg_proc p
        where p.oid = v_oid;

        if v_diff <> '' then
            raise warning 'CONFLICT: lacak_domba_take_scan_slot(text, integer) exists and differs: %. NOT modified. See the manual step at the bottom of this file.', v_diff;
        else
            raise notice 'lacak_domba_take_scan_slot(text, integer) already exists with the expected declaration: NOT modified. Its body was not compared.';
        end if;
    elsif v_others is null then
        create table if not exists public.lacak_domba_scan_limits (
            firebase_uid text primary key
                         check (char_length(firebase_uid) between 1 and 128),
            last_scan_at timestamptz not null default now()
        );
        alter table public.lacak_domba_scan_limits enable row level security;
        -- Only the SECURITY DEFINER function (its owner) touches this table.
        revoke all on public.lacak_domba_scan_limits from public, anon, authenticated;

        execute $create$
            create function public.lacak_domba_take_scan_slot(
                p_firebase_uid text,
                p_min_interval_seconds integer
            )
            returns boolean
            language plpgsql
            security definer
            set search_path = pg_catalog, public
            as $body$
            declare
                v_taken boolean;
            begin
                if p_firebase_uid is null
                    or char_length(p_firebase_uid) not between 1 and 128
                then
                    raise exception 'invalid firebase uid' using errcode = '22023';
                end if;
                if p_min_interval_seconds is null
                    or p_min_interval_seconds not between 1 and 300
                then
                    raise exception 'p_min_interval_seconds must be between 1 and 300'
                        using errcode = '22023';
                end if;

                insert into public.lacak_domba_scan_limits as l (firebase_uid, last_scan_at)
                values (p_firebase_uid, now())
                on conflict (firebase_uid) do update
                    set last_scan_at = excluded.last_scan_at
                    where l.last_scan_at <= now() - make_interval(secs => p_min_interval_seconds)
                returning true into v_taken;

                return coalesce(v_taken, false);
            end;
            $body$
        $create$;
    end if;

    if to_regprocedure('public.lacak_domba_take_scan_slot(text, integer)') is not null then
        revoke all on function public.lacak_domba_take_scan_slot(text, integer)
            from public, anon, authenticated;
        grant execute on function public.lacak_domba_take_scan_slot(text, integer)
            to service_role;
    end if;
end;
$migration$;

-- lacak_domba_replace_own_blocks(p_blocker_uid, p_blocked_uids) -> integer
--
-- Makes the caller's block list equal to p_blocked_uids, atomically: the
-- function runs in one transaction, and a per-owner advisory lock makes two
-- concurrent replacements for the same owner run one after the other.
-- Only rows whose blocker_uid = p_blocker_uid are ever read, deleted or
-- inserted. NULL or '{}' clears the caller's list. NULL elements, empty or
-- over-long uids, the caller's own uid and duplicates are ignored. More than
-- 10,000 elements (counted before that clean-up) raises 22023.
--
-- RETURN VALUE: the number of rows actually inserted by this call, read from
-- the INSERT's row count. Entries that were already in the list are kept
-- and are NOT counted; deleted rows are not counted either.
-- DIFFERENCE FROM PRODUCTION: the production function also returns integer,
-- but per the audit its value is the number of rows it attempts to insert,
-- so it also counts entries that already existed. Re-sending an unchanged
-- list of 3 gives 0 here and 3 there. The Edge Function ignores the value
-- (it only checks for an error), so both work with it. Production is not
-- replaced by this file.
do $migration$
declare
    v_oid    oid := to_regprocedure('public.lacak_domba_replace_own_blocks(text, text[])');
    v_others text;
    v_diff   text := '';
begin
    select string_agg(p.oid::regprocedure::text, ', ')
    into v_others
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
        and p.proname = 'lacak_domba_replace_own_blocks'
        and p.oid is distinct from v_oid;

    if v_others is not null then
        raise warning 'CONFLICT: lacak_domba_replace_own_blocks also exists with other arguments (%). Nothing was created or changed for them; PostgREST may not resolve the call. Review manually.', v_others;
    end if;

    if v_oid is not null then
        select concat_ws('; ',
            case when p.prorettype <> 'integer'::regtype or p.proretset
                then 'returns ' || pg_get_function_result(p.oid) || ', expected integer' end,
            case when p.proargnames is distinct from array['p_blocker_uid', 'p_blocked_uids']
                then 'argument names ' || coalesce(p.proargnames::text, '(none)') end,
            case when not p.prosecdef then 'is SECURITY INVOKER, expected SECURITY DEFINER' end,
            case when not exists (
                    select 1 from unnest(p.proconfig) c
                    where replace(replace(c, ' ', ''), '"', '') = 'search_path=pg_catalog,public'
                ) then 'search_path is not pg_catalog, public' end)
        into v_diff
        from pg_proc p
        where p.oid = v_oid;

        if v_diff <> '' then
            raise warning 'CONFLICT: lacak_domba_replace_own_blocks(text, text[]) exists and differs: %. NOT modified. See the manual step at the bottom of this file.', v_diff;
        else
            raise notice 'lacak_domba_replace_own_blocks(text, text[]) already exists with the expected declaration: NOT modified. Its body was not compared.';
        end if;
    elsif v_others is null then
        execute $create$
            create function public.lacak_domba_replace_own_blocks(
                p_blocker_uid text,
                p_blocked_uids text[]
            )
            returns integer
            language plpgsql
            security definer
            set search_path = pg_catalog, public
            as $body$
            declare
                v_wanted   text[];
                v_inserted integer;
            begin
                if p_blocker_uid is null
                    or char_length(p_blocker_uid) not between 1 and 128
                then
                    raise exception 'invalid blocker uid' using errcode = '22023';
                end if;
                if coalesce(cardinality(p_blocked_uids), 0) > 10000 then
                    raise exception 'block list exceeds 10000 elements'
                        using errcode = '22023';
                end if;

                -- Never NULL and without NULL elements: a NULL inside
                -- "not (x = any (...))" would leave rows that must be removed.
                select coalesce(array_agg(distinct u.uid), '{}'::text[])
                into v_wanted
                from unnest(p_blocked_uids) as u(uid)
                where u.uid is not null
                    and char_length(u.uid) between 1 and 128
                    and u.uid <> p_blocker_uid;

                perform pg_advisory_xact_lock(
                    hashtextextended('lacak_domba_blocks:' || p_blocker_uid, 0)
                );

                delete from public.lacak_domba_blocks b
                where b.blocker_uid = p_blocker_uid
                    and not (b.blocked_uid = any (v_wanted));

                insert into public.lacak_domba_blocks (blocker_uid, blocked_uid)
                select p_blocker_uid, w.uid
                from unnest(v_wanted) as w(uid)
                on conflict (blocker_uid, blocked_uid) do nothing;

                get diagnostics v_inserted = row_count;
                return v_inserted;
            end;
            $body$
        $create$;
    end if;

    if to_regprocedure('public.lacak_domba_replace_own_blocks(text, text[])') is not null then
        revoke all on function public.lacak_domba_replace_own_blocks(text, text[])
            from public, anon, authenticated;
        grant execute on function public.lacak_domba_replace_own_blocks(text, text[])
            to service_role;
    end if;
end;
$migration$;

-- ---------------------------------------------------------------------------
-- Read-only checks. Run these in the SQL editor BEFORE applying and compare
-- the output with the definitions above.
--
-- 1. Columns the Edge Function reads and writes:
-- select table_name, column_name, data_type, is_nullable
-- from information_schema.columns
-- where table_schema = 'public' and table_name like 'lacak_domba_%'
-- order by table_name, ordinal_position;
--
-- 2. The upsert needs a unique or primary key on presence.firebase_uid:
-- select conrelid::regclass as table_name, conname, pg_get_constraintdef(oid)
-- from pg_constraint
-- where conrelid::regclass::text like 'lacak_domba_%' and contype in ('p', 'u');
--
-- 3. Functions: argument names and types, result, security, search_path,
--    who may execute, and the full body.
--    Expected: (p_firebase_uid text, p_min_interval_seconds integer) -> boolean
--              (p_blocker_uid text, p_blocked_uids text[])           -> integer
--              both SECURITY DEFINER with search_path=pg_catalog, public,
--              execute for service_role only.
-- select p.proname,
--        pg_get_function_identity_arguments(p.oid) as arguments,
--        pg_get_function_result(p.oid)             as result,
--        p.prosecdef                               as security_definer,
--        p.proconfig                               as settings,
--        p.proacl                                  as grants,
--        pg_get_functiondef(p.oid)                 as definition
-- from pg_proc p
-- join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public' and p.proname like 'lacak_domba_%';
--
-- 4. RLS and direct grants (anon / authenticated should have none):
-- select relname, relrowsecurity
-- from pg_class
-- where relnamespace = 'public'::regnamespace and relname like 'lacak_domba_%';
--
-- select grantee, table_name, privilege_type
-- from information_schema.role_table_grants
-- where table_schema = 'public' and table_name like 'lacak_domba_%'
-- order by table_name, grantee;
--
-- ---------------------------------------------------------------------------
-- MANUAL STEP FOR A REPORTED CONFLICT - NOT part of this migration. Review,
-- then run by hand only after approval.
--
-- PostgreSQL cannot change a function's result type in place, and this file
-- never overwrites an existing function. To move an existing function to the
-- definition above (for example to make replace_own_blocks return the
-- actual inserted count):
--   1. Save the current definition (check 3, column "definition") so it can
--      be restored.
--   2. In ONE transaction: remove exactly that signature, then run the
--      matching "do $migration$ ... $migration$;" block from this file. It
--      creates the function and sets its grants because the name is now free.
--        begin;
--        drop function public.lacak_domba_replace_own_blocks(text, text[]);
--        -- paste the lacak_domba_replace_own_blocks DO block here
--        commit;
--   3. Re-run check 3 and one sync from the app.
-- For lacak_domba_take_scan_slot, do NOT do this without first checking
-- which table the existing function stores its timestamps in: the block
-- above creates public.lacak_domba_scan_limits, and switching storage resets
-- every user's rate limit once.
