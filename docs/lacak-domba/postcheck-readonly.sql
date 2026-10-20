-- Lacak Domba | READ-ONLY verification AFTER migration 20261017000000.
-- SELECT-only, metadata only (no user rows). Every row must say OK.
-- (Verified locally on PostgreSQL 17.6: all OK.)

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
    select 'constraint ' || k.name,
           case when exists (select 1 from pg_constraint
                             where conrelid = 'public.lacak_domba_presence'::regclass
                                 and conname = k.name and contype = 'c' and convalidated)
                then 'OK' else 'MISSING' end
    from (values ('lacak_domba_presence_discoverable_until_cap'),
                 ('lacak_domba_presence_session_consistent')) k(name)

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
)
select item, status from checks order by (status like 'OK%'), item;
