-- Owner post-deploy checks: metadata and counts ONLY. Never call mutation RPCs here.
select p.proname,pg_get_function_identity_arguments(p.oid) as arguments,
 pg_get_function_result(p.oid) as result,p.prosecdef,p.proconfig,
 pg_get_userbyid(p.proowner) as owner,md5(pg_get_functiondef(p.oid)) as definition_md5,
 has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
 has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
 has_function_privilege('service_role',p.oid,'EXECUTE') as service_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname like 'lacak_domba_%' order by p.proname;
select column_name,data_type,is_nullable from information_schema.columns
where table_schema='public' and table_name='lacak_domba_presence'
and column_name in ('latitude','longitude','location_updated_at','discoverable_until','discovery_session_id','session_started_at') order by column_name;
select relname,relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and relname in ('lacak_domba_presence','lacak_domba_blocks','lacak_domba_scan_limits');
