-- REVIEW ONLY: disable ONLY the new service RPCs; retain every column and row.
begin;
revoke execute on function public.lacak_domba_discovery_start(text,jsonb) from service_role;
revoke execute on function public.lacak_domba_discovery_extend(text,uuid,jsonb) from service_role;
revoke execute on function public.lacak_domba_discovery_refresh(text,jsonb,timestamptz) from service_role;
revoke execute on function public.lacak_domba_discovery_end(text,text,uuid) from service_role;
revoke execute on function public.lacak_domba_scan_candidates(text,double precision,double precision,integer,integer,integer) from service_role;
revoke execute on function public.lacak_domba_purge_stale(integer) from service_role;
notify pgrst, 'reload schema';
commit;
