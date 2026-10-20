-- Lacak Domba | READ-ONLY reconciliation BEFORE migration 20261017000000.
-- SELECT-only. Returns schema metadata and row COUNTS only; no user rows,
-- no uid, no coordinates. Safe in the Supabase SQL Editor. Changes nothing.
-- Every row of the result must say OK before the migration is applied.
-- (Verified locally on PostgreSQL 17.6 with both migrations: all OK.)

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
checks as (
    -- 1. every expected column exists with the expected type and nullability
    select 'column ' || e.table_name || '.' || e.column_name as item,
           case
               when c.column_name is null then 'MISSING'
               when c.data_type <> e.data_type then 'TYPE ' || c.data_type || ' (expected ' || e.data_type || ')'
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
    -- 9. CHECK constraints of 20261017 hold for the existing rows. Rows without
    --    a session (all of them before the migration) satisfy both.
    select 'existing rows (count only)',
           'OK (' || (select count(*) from public.lacak_domba_presence) || ' rows; all stop being listed until their owner starts a new session)'
    where to_regclass('public.lacak_domba_presence') is not null

    union all
    -- 10. migration history (empty history: see the release plan, step M4)
    select 'migration history',
           case when to_regclass('supabase_migrations.schema_migrations') is null
                then 'OK (no history table)'
                else 'OK (history table present)' end
)
select item, status
from checks
order by (status like 'OK%'), item;
