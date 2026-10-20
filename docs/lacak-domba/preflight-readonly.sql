-- Lacak Domba | READ-ONLY reconciliation BEFORE migration 20261017000000.
-- Returns schema metadata and row COUNTS only; no user rows, no uid, no
-- coordinates. Runs in a READ ONLY transaction that is rolled back, so it
-- changes nothing, also where it evaluates stored CHECK expressions (item 12).
-- Safe in the Supabase SQL Editor and in psql.
-- Every row of the result must say OK before the migration is applied; a
-- BLOCKER or REVIEW row stops the release (RELEASE-PLAN step M2).
-- (Verified locally on PostgreSQL 17.6 with fresh and legacy schemas.)

begin transaction read only;

with expected (table_name, column_name, data_type, is_nullable) as (
    values
        -- 20261010000000: the columns the Edge Function and 20261017 use
        ('lacak_domba_presence', 'firebase_uid',        'text',                     'NO'),
        ('lacak_domba_presence', 'latitude',            'double precision',         'NO'),
        ('lacak_domba_presence', 'longitude',           'double precision',         'NO'),
        ('lacak_domba_presence', 'display_name',        'text',                     'NO'),
        ('lacak_domba_presence', 'photo_url',           'text',                     'NO'),
        ('lacak_domba_presence', 'komsel',              'text',                     'NO'),
        ('lacak_domba_presence', 'wilayah',             'text',                     'NO'),
        ('lacak_domba_presence', 'discoverable',        'boolean',                  'NO'),
        ('lacak_domba_presence', 'show_online',         'boolean',                  'NO'),
        ('lacak_domba_presence', 'online',              'boolean',                  'NO'),
        ('lacak_domba_presence', 'last_seen',           'timestamp with time zone', 'YES'),
        ('lacak_domba_presence', 'location_updated_at', 'timestamp with time zone', 'NO'),
        ('lacak_domba_presence', 'updated_at',          'timestamp with time zone', 'NO'),
        ('lacak_domba_blocks',   'blocker_uid',         'text',                     'NO'),
        ('lacak_domba_blocks',   'blocked_uid',         'text',                     'NO'),
        ('lacak_domba_blocks',   'created_at',          'timestamp with time zone', 'NO')
),
added_by_20261017 (column_name) as (
    values ('discoverable_until'), ('discovery_session_id'), ('session_started_at')
),
-- Item 11 counts only when the columns it reads exist with the expected
-- types. Its query text goes through query_to_xml, so this file still parses
-- on a database without the session columns.
session_state (state) as (
    select case
        when not exists (select 1 from information_schema.columns
                         where table_schema = 'public' and table_name = 'lacak_domba_presence'
                             and column_name = 'discoverable_until')
            then 'no_session_columns'
        when (select count(*) from information_schema.columns c
              where c.table_schema = 'public' and c.table_name = 'lacak_domba_presence'
                  and (c.column_name, c.data_type) in (
                      ('discoverable_until',  'timestamp with time zone'),
                      ('latitude',            'double precision'),
                      ('longitude',           'double precision'),
                      ('location_updated_at', 'timestamp with time zone'))) < 4
            then 'unexpected_columns'
        else 'ready'
    end
),
session_counts (x) as (
    select case when state = 'ready' then query_to_xml($q$
        select count(*) filter (where not coalesce(
                       latitude is not null and longitude is not null
                       and location_updated_at is not null
                       and latitude between -90 and 90
                       and longitude between -180 and 180, false))            as invalid,
               count(*) filter (where latitude is null or longitude is null)  as null_coordinates,
               count(*) filter (where location_updated_at is null)            as null_location_time,
               count(*) filter (where latitude = 'NaN' or longitude = 'NaN')  as nan,
               count(*) filter (where latitude in ('Infinity', '-Infinity')
                                   or longitude in ('Infinity', '-Infinity')) as infinity,
               count(*) filter (where (latitude <> 'NaN' and latitude not in ('Infinity', '-Infinity')
                                       and latitude not between -90 and 90)
                                   or (longitude <> 'NaN' and longitude not in ('Infinity', '-Infinity')
                                       and longitude not between -180 and 180)) as out_of_range
        from public.lacak_domba_presence
        where discoverable_until is not null
    $q$, false, true, '') end
    from session_state
),
-- Item 12: what each CHECK of 20261017 must accept and refuse. A stored
-- expression is evaluated against these made-up rows; no table row is read.
-- A CHECK refuses a row only when its expression is FALSE (NULL passes).
-- Keep this block identical in preflight-readonly.sql and postcheck-readonly.sql.
vector_base (active, ended, idle) as (
    select jsonb_build_object(
               'firebase_uid', 'vector', 'latitude', -1, 'longitude', 131,
               'location_updated_at', now(), 'updated_at', now(), 'last_seen', now(),
               'discoverable', true, 'online', true, 'show_online', false,
               'display_name', 'vector', 'photo_url', '', 'komsel', '', 'wilayah', '',
               'discoverable_until', now() + interval '10 minutes',
               'discovery_session_id', '00000000-0000-4000-8000-000000000001',
               'session_started_at', now() - interval '5 minutes'),
           jsonb_build_object(
               'firebase_uid', 'vector', 'latitude', -1, 'longitude', 131,
               'location_updated_at', now() - interval '10 minutes',
               'updated_at', now() - interval '10 minutes',
               'discoverable', true, 'online', false, 'show_online', false,
               'display_name', 'vector', 'photo_url', '', 'komsel', '', 'wilayah', '',
               'discoverable_until', now() - interval '1 minute',
               'discovery_session_id', '00000000-0000-4000-8000-000000000002',
               'session_started_at', now() - interval '16 minutes'),
           jsonb_build_object(
               'firebase_uid', 'vector', 'latitude', null, 'longitude', null,
               'location_updated_at', null, 'updated_at', now(),
               'discoverable', false, 'online', false, 'show_online', false,
               'display_name', 'vector', 'photo_url', '', 'komsel', '', 'wilayah', '',
               'discoverable_until', null, 'discovery_session_id', null,
               'session_started_at', null)
),
constraint_vectors (conname, label, rec, must_refuse) as (
    select 'lacak_domba_presence_active_session_location', v.label, b.active || v.patch, v.must_refuse
    from vector_base b, (values
        ('active, valid',                   '{}'::jsonb,                            false),
        ('active, corner -90/-180',         '{"latitude": -90, "longitude": -180}', false),
        ('active, corner 90/180',           '{"latitude": 90, "longitude": 180}',   false),
        ('active, latitude NULL',           '{"latitude": null}',                   true),
        ('active, longitude NULL',          '{"longitude": null}',                  true),
        ('active, location time NULL',      '{"location_updated_at": null}',        true),
        ('active, not discoverable, latitude NULL',
                                            '{"discoverable": false, "latitude": null}', true),
        ('active, latitude 90.0001',        '{"latitude": 90.0001}',                true),
        ('active, latitude -91',            '{"latitude": -91}',                    true),
        ('active, longitude 180.5',         '{"longitude": 180.5}',                 true),
        ('active, longitude -181',          '{"longitude": -181}',                  true),
        ('active, latitude NaN',            '{"latitude": "NaN"}',                  true),
        ('active, longitude NaN',           '{"longitude": "NaN"}',                 true),
        ('active, latitude Infinity',       '{"latitude": "Infinity"}',             true),
        ('active, latitude -Infinity',      '{"latitude": "-Infinity"}',            true),
        ('active, longitude Infinity',      '{"longitude": "Infinity"}',            true),
        ('active, longitude -Infinity',     '{"longitude": "-Infinity"}',           true)
    ) v(label, patch, must_refuse)
    union all
    select 'lacak_domba_presence_active_session_location', v.label, b.ended || v.patch, v.must_refuse
    from vector_base b, (values
        ('ended, latitude NULL',            '{"latitude": null}'::jsonb,            true),
        ('ended, longitude NaN',            '{"longitude": "NaN"}',                 true),
        ('ended, latitude 999',             '{"latitude": 999}',                    true)
    ) v(label, patch, must_refuse)
    union all
    select 'lacak_domba_presence_active_session_location', 'no session, no location (legacy)', b.idle, false
    from vector_base b
    union all
    select 'lacak_domba_presence_discoverable_until_cap', v.label, b.active || v.patch, v.must_refuse
    from vector_base b, (values
        ('end 10 minutes after write',      '{}'::jsonb, false),
        ('end exactly 15 minutes after write',
            jsonb_build_object('discoverable_until', now() + interval '15 minutes'), false),
        ('end 15 minutes 1 second after write',
            jsonb_build_object('discoverable_until', now() + interval '15 minutes 1 second'), true)
    ) v(label, patch, must_refuse)
    union all
    select 'lacak_domba_presence_discoverable_until_cap', 'no session', b.idle, false
    from vector_base b
    union all
    select 'lacak_domba_presence_session_consistent', v.label, b.active || v.patch, v.must_refuse
    from vector_base b, (values
        ('complete session',                '{}'::jsonb,                           false),
        ('session id missing',              '{"discovery_session_id": null}',      true),
        ('end missing',                     '{"discoverable_until": null}',        true),
        ('start missing',                   '{"session_started_at": null}',        true),
        ('only the id',                     '{"discoverable_until": null, "session_started_at": null}', true)
    ) v(label, patch, must_refuse)
    union all
    select 'lacak_domba_presence_session_consistent', 'no session', b.idle, false
    from vector_base b
),
constraint_eval as (
    select v.conname, v.label, v.must_refuse, k.convalidated,
           (xpath('/row/r/text()', query_to_xml(format(
               'select (%s) as r from jsonb_populate_record(null::public.lacak_domba_presence, %L::jsonb) t',
               pg_get_expr(k.conbin, k.conrelid), v.rec), true, true, '')))[1]::text as r
    from constraint_vectors v
    join pg_constraint k
        on k.conrelid = to_regclass('public.lacak_domba_presence')
        and k.conname = v.conname and k.contype = 'c'
),
constraint_verdict (conname, status) as (
    select conname,
           case
               when not bool_and(convalidated) then 'NOT VALIDATED (existing rows were never checked)'
               when bool_or(must_refuse and r is distinct from 'false')
                   then 'WEAK: accepts ' || string_agg(label, '; ' order by label)
                        filter (where must_refuse and r is distinct from 'false')
               when bool_or(not must_refuse and r = 'false')
                   then 'TOO STRICT: refuses ' || string_agg(label, '; ' order by label)
                        filter (where not must_refuse and r = 'false')
               else 'OK'
           end
    from constraint_eval
    group by conname
),
checks as (
    -- 1. every expected column exists with the expected type and nullability
    select 'column ' || e.table_name || '.' || e.column_name as item,
           case
               when c.column_name is null then 'MISSING'
               when c.data_type <> e.data_type then 'TYPE ' || c.data_type || ' (expected ' || e.data_type || ')'
               -- Production's legacy presence allows missing coordinates while
               -- no discovery session is active. 20261017 adds the active-session
               -- location constraint; do NOT change old nullable columns here.
               -- Item 11 blocks when a row that already holds a session lacks them.
               when e.table_name = 'lacak_domba_presence'
                    and e.column_name in ('latitude', 'longitude', 'location_updated_at')
                    and e.is_nullable = 'NO' and c.is_nullable = 'YES'
                   then 'OK (legacy nullable; guarded by pending 20261017 migration)'
               when c.is_nullable <> e.is_nullable then 'NULLABLE ' || c.is_nullable || ' (expected ' || e.is_nullable || ')'
               else 'OK'
           end as status
    from expected e
    left join information_schema.columns c
        on c.table_schema = 'public' and c.table_name = e.table_name and c.column_name = e.column_name

    union all
    -- 2. production columns the repository does not know about (reported, not fatal
    --    unless NOT NULL without default: the INSERT in discovery_start would fail)
    select 'unknown column lacak_domba_presence.' || c.column_name,
           case when c.is_nullable = 'NO' and c.column_default is null
                then 'BLOCKER: NOT NULL without default'
                else 'OK (extra, nullable or defaulted)' end
    from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = 'lacak_domba_presence'
        and c.column_name not in (select column_name from expected where table_name = 'lacak_domba_presence')
        and c.column_name not in (select column_name from added_by_20261017)

    union all
    -- 3. firebase_uid is the primary key (ON CONFLICT (firebase_uid) needs it)
    select 'primary key lacak_domba_presence(firebase_uid)',
           case when exists (
               select 1 from pg_constraint k
               where k.conrelid = to_regclass('public.lacak_domba_presence')
                   and k.contype in ('p', 'u')
                   and k.conkey = array[(select attnum from pg_attribute
                                         where attrelid = to_regclass('public.lacak_domba_presence')
                                             and attname = 'firebase_uid')]::smallint[]
           ) then 'OK' else 'MISSING' end

    union all
    -- 4. RLS on and no direct access for anon / authenticated
    select 'access ' || t.relname,
           case
               when not t.relrowsecurity then 'RLS OFF'
               when has_table_privilege('anon', t.oid, 'SELECT,INSERT,UPDATE,DELETE')
                   or has_table_privilege('authenticated', t.oid, 'SELECT,INSERT,UPDATE,DELETE')
                   then 'anon/authenticated HAVE table privileges'
               -- scan_limits is used only inside lacak_domba_take_scan_slot
               -- (SECURITY DEFINER), so service_role needs no table privilege.
               when t.relname <> 'lacak_domba_scan_limits'
                   and not has_table_privilege('service_role', t.oid, 'SELECT,INSERT,UPDATE,DELETE')
                   then 'service_role lacks privileges'
               else 'OK'
           end
    from pg_class t
    where t.oid in (to_regclass('public.lacak_domba_presence'), to_regclass('public.lacak_domba_blocks'),
                    to_regclass('public.lacak_domba_scan_limits'))

    union all
    -- 5. functions 20261017 creates: report if a DIFFERENT definition already exists
    --    (create or replace would overwrite it)
    select 'function ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
           'EXISTS BEFORE MIGRATION: compare with the repository before replacing'
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
        and p.proname in ('lacak_domba_discovery_start', 'lacak_domba_discovery_extend',
                          'lacak_domba_discovery_refresh', 'lacak_domba_discovery_end',
                          'lacak_domba_scan_candidates', 'lacak_domba_purge_stale')

    union all
    -- 6. the older functions the Edge Function still calls
    select 'function ' || f.name,
           case
               when to_regprocedure(f.name) is null then 'MISSING'
               when has_function_privilege('anon', to_regprocedure(f.name), 'EXECUTE')
                   or has_function_privilege('authenticated', to_regprocedure(f.name), 'EXECUTE')
                   then 'anon/authenticated can EXECUTE'
               else 'OK'
           end
    from (values ('public.lacak_domba_take_scan_slot(text, integer)'),
                 ('public.lacak_domba_replace_own_blocks(text, text[])')) f(name)

    union all
    -- 6a. their bodies, which no migration replaces: identical to the
    --     repository (whitespace ignored), or at least serializing concurrent
    --     calls of one user. The pattern test is a heuristic over the source
    --     text; REVIEW means a person must read the body, see
    --     docs/lacak-domba/FUNGSI-KOMPATIBILITAS.md. The body is not returned.
    select 'function body ' || f.name,
           case
               when p.oid is null then 'MISSING (see function row)'
               when md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) = f.repo_md5
                   then 'OK (identical to the repository)'
               when lower(p.prosrc) ~ f.serializing
                   then 'OK (differs from the repository; serializing pattern found; see FUNGSI-KOMPATIBILITAS.md)'
               else 'REVIEW: differs from the repository and shows no serializing pattern; concurrent calls may race'
           end
    from (values
        ('lacak_domba_take_scan_slot(text, integer)', '594062c2e873ba323a4d4d5afe7c8c40',
         -- one upsert whose UPDATE re-checks the time, or an explicit lock
         'do\s+update\s+set[^;]*\mwhere\M|for\s+update|lock\s+table|pg_advisory'),
        ('lacak_domba_replace_own_blocks(text, text[])', '27efc296208f98cd2d09122b9f59e70a',
         -- the delete and the insert of one owner must not interleave
         'pg_advisory|for\s+update|lock\s+table')
    ) f(name, repo_md5, serializing)
    left join pg_proc p on p.oid = to_regprocedure('public.' || f.name)

    union all
    -- 6b. dependencies outside Lacak Domba: views/rules on the presence table
    --     and functions in other schemas or with other names whose body
    --     mentions these objects. Anything listed must be reviewed before
    --     the result type of the discovery functions changes.
    select 'dependent view ' || v.oid::regclass::text, 'REVIEW: depends on lacak_domba_presence'
    from pg_depend d
    join pg_rewrite r on r.oid = d.objid
    join pg_class v on v.oid = r.ev_class
    where d.refobjid = to_regclass('public.lacak_domba_presence')
        and v.oid <> to_regclass('public.lacak_domba_presence')
    union all
    select 'dependent function ' || p.oid::regprocedure::text, 'REVIEW: body mentions Lacak Domba objects'
    from pg_proc p
    where p.prokind = 'f'
        and p.pronamespace not in ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
        and p.proname not like 'lacak_domba\_%'
        and (p.prosrc ilike '%lacak_domba_discovery_%' or p.prosrc ilike '%lacak_domba_presence%')

    union all
    -- 7. built-ins 20261017 relies on (PostgreSQL 13+)
    select 'builtin ' || b.name,
           case when to_regprocedure(b.name) is null then 'MISSING' else 'OK' end
    from (values ('gen_random_uuid()'), ('hashtextextended(text, bigint)'),
                 ('pg_advisory_xact_lock(bigint)')) b(name)

    union all
    -- 8. new columns not there yet (informational: the migration adds them)
    select 'new column lacak_domba_presence.' || a.column_name,
           case when exists (select 1 from information_schema.columns c
                             where c.table_schema = 'public' and c.table_name = 'lacak_domba_presence'
                                 and c.column_name = a.column_name)
                then 'OK (already present; migration skips it)' else 'OK (will be added)' end
    from added_by_20261017 a

    union all
    -- 9. existing rows. Rows without a session (all of them where 20261017
    --    never ran) satisfy every CHECK of 20261017; item 11 checks the rest.
    --    Counted through query_to_xml so that a database without the table
    --    still gets the whole report (the table then shows as MISSING).
    select 'existing rows (count only)',
           'OK (' || (xpath('/row/n/text()', query_to_xml(
               'select count(*) as n from public.lacak_domba_presence', false, true, '')))[1]::text
           || ' rows; all stop being listed until their owner starts a new session)'
    where to_regclass('public.lacak_domba_presence') is not null

    union all
    -- 10. migration history (empty history: see the release plan, step M4)
    select 'migration history',
           case when to_regclass('supabase_migrations.schema_migrations') is null
                then 'OK (no history table)'
                else 'OK (history table present)' end

    union all
    -- 11. rows that already hold a discovery session (running, or ended and
    --     not yet purged; only possible where a draft of 20261017 ran) need a
    --     complete, finite, in-range location and a location time, otherwise
    --     adding lacak_domba_presence_active_session_location fails. Counts
    --     only. The categories may overlap; "invalid location (total)" is the
    --     rule the CHECK enforces.
    select 'session rows: ' || v.label || ' (count only)',
           case
               when s.state = 'no_session_columns'
                   then 'OK (no session column yet: no session row can exist)'
               when s.state = 'unexpected_columns'
                   then 'BLOCKER: cannot check (location or session column missing or of another type; see column rows)'
               when n.n = 0 then 'OK (0)'
               else 'BLOCKER: ' || n.n || ' row(s); the migration would fail'
           end
    from session_state s
    cross join session_counts c
    cross join (values
        ('invalid location (total)', 'invalid'),
        ('latitude/longitude NULL',  'null_coordinates'),
        ('location time NULL',       'null_location_time'),
        ('coordinate NaN',           'nan'),
        ('coordinate Infinity',      'infinity'),
        ('coordinate out of range',  'out_of_range')
    ) v(label, tag)
    cross join lateral (
        select (xpath('/row/' || v.tag || '/text()', c.x))[1]::text::bigint as n
    ) n
    where s.state = 'ready' or v.tag = 'invalid'

    union all
    -- 12. CHECKs of 20261017 that already exist. The migration adds each one
    --     only when NO constraint of that name exists, so an earlier, weaker
    --     version would silently stay. Its stored definition is evaluated
    --     against the made-up rows above.
    select 'existing constraint ' || n.name,
           case
               when k.oid is null then 'OK (will be added)'
               when k.contype <> 'c' then 'BLOCKER: exists but is not a CHECK; the migration would keep it'
               when cv.status = 'OK' then 'OK (already present and enforces the rule)'
               else 'BLOCKER: already present but ' || cv.status || '; the migration would keep it'
           end
    from (values ('lacak_domba_presence_active_session_location'),
                 ('lacak_domba_presence_discoverable_until_cap'),
                 ('lacak_domba_presence_session_consistent')) n(name)
    left join pg_constraint k
        on k.conrelid = to_regclass('public.lacak_domba_presence') and k.conname = n.name
    left join constraint_verdict cv on cv.conname = n.name
)
select item, status
from checks
order by (status like 'OK%'), item;

rollback;
