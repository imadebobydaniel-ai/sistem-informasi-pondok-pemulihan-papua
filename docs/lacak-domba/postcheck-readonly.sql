-- Lacak Domba | READ-ONLY verification AFTER migration 20261017000000.
-- Metadata and counts only (no user rows, no uid, no coordinates). Runs in a
-- READ ONLY transaction that is rolled back, so it changes nothing, also
-- where it evaluates the stored CHECK expressions. Every row must say OK.
-- (Verified locally on PostgreSQL 17.6 with fresh and legacy schemas.)

begin transaction read only;

with fn (signature) as (
    values
        ('public.lacak_domba_discovery_start(text, jsonb)'),
        ('public.lacak_domba_discovery_extend(text, uuid, jsonb)'),
        ('public.lacak_domba_discovery_refresh(text, jsonb, timestamp with time zone)'),
        ('public.lacak_domba_discovery_end(text, text, uuid)'),
        ('public.lacak_domba_scan_candidates(text, double precision, double precision, integer, integer, integer)'),
        ('public.lacak_domba_purge_stale(integer)'),
        ('public.lacak_domba_take_scan_slot(text, integer)'),
        ('public.lacak_domba_replace_own_blocks(text, text[])')
),
-- What each CHECK of 20261017 must accept and refuse. A name alone proves
-- nothing (the migration skips a constraint whose name already exists), so
-- the stored expression is evaluated against these made-up rows; no table
-- row is read. A CHECK refuses a row only when its expression is FALSE.
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
    select 'function ' || f.signature as item,
           case
               when to_regprocedure(f.signature) is null then 'MISSING'
               when not p.prosecdef then 'NOT SECURITY DEFINER'
               when not exists (select 1 from unnest(p.proconfig) c
                                where replace(replace(c, ' ', ''), '"', '') = 'search_path=pg_catalog,public')
                   then 'search_path not pinned to pg_catalog, public'
               when has_function_privilege('anon', p.oid, 'EXECUTE')
                   or has_function_privilege('authenticated', p.oid, 'EXECUTE')
                   then 'anon/authenticated can EXECUTE'
               when not has_function_privilege('service_role', p.oid, 'EXECUTE')
                   then 'service_role cannot EXECUTE'
               else 'OK'
           end as status
    from fn f
    left join pg_proc p on p.oid = to_regprocedure(f.signature)

    union all
    select 'column lacak_domba_presence.' || n.column_name,
           case when c.data_type = n.data_type and c.is_nullable = 'YES' then 'OK'
                when c.column_name is null then 'MISSING'
                else 'TYPE/NULLABLE ' || c.data_type || '/' || c.is_nullable end
    from (values ('discoverable_until', 'timestamp with time zone'),
                 ('discovery_session_id', 'uuid'),
                 ('session_started_at', 'timestamp with time zone')) n(column_name, data_type)
    left join information_schema.columns c
        on c.table_schema = 'public' and c.table_name = 'lacak_domba_presence' and c.column_name = n.column_name

    union all
    -- present, a validated CHECK, and its definition enforces the rule
    select 'constraint ' || k.name,
           case
               when not exists (select 1 from pg_constraint
                                where conrelid = to_regclass('public.lacak_domba_presence')
                                    and conname = k.name and contype = 'c')
                   then 'MISSING'
               else cv.status
           end
    from (values ('lacak_domba_presence_discoverable_until_cap'),
                 ('lacak_domba_presence_session_consistent'),
                 ('lacak_domba_presence_active_session_location')) k(name)
    left join constraint_verdict cv on cv.conname = k.name

    union all
    select 'index lacak_domba_presence_discoverable_until_idx',
           case when to_regclass('public.lacak_domba_presence_discoverable_until_idx') is null
                then 'MISSING' else 'OK' end

    union all
    select 'access ' || t.relname,
           case
               when not t.relrowsecurity then 'RLS OFF'
               when has_table_privilege('anon', t.oid, 'SELECT,INSERT,UPDATE,DELETE')
                   or has_table_privilege('authenticated', t.oid, 'SELECT,INSERT,UPDATE,DELETE')
                   then 'anon/authenticated HAVE table privileges'
               else 'OK'
           end
    from pg_class t
    where t.oid in (to_regclass('public.lacak_domba_presence'), to_regclass('public.lacak_domba_blocks'),
                    to_regclass('public.lacak_domba_scan_limits'))

    union all
    -- no policy may open the tables to the API roles
    select 'policies on lacak_domba_* tables',
           case when exists (select 1 from pg_policy p join pg_class t on t.oid = p.polrelid
                             where t.relname like 'lacak_domba_%')
                then 'POLICY PRESENT: review' else 'OK (none)' end

    union all
    -- rows that hold a session must hold all of it (the CHECK guarantees it)
    select 'rows with a running session (count only)',
           'OK (' || count(*) || ')'
    from public.lacak_domba_presence
    where discoverable_until > now()

    union all
    -- no row with a session may lack a valid location (the CHECK guarantees it)
    select 'session rows with an invalid location (count only)',
           case when count(*) = 0 then 'OK (0)' else 'BLOCKER: ' || count(*) || ' row(s)' end
    from public.lacak_domba_presence
    where discoverable_until is not null
        and not coalesce(latitude is not null and longitude is not null
                         and location_updated_at is not null
                         and latitude between -90 and 90
                         and longitude between -180 and 180, false)
)
select item, status from checks order by (status like 'OK%'), item;

rollback;
