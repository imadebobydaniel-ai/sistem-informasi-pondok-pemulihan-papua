'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),snapshot=JSON.parse(fs.readFileSync(path.join(__dirname,'PRODUCTION-SCHEMA.json')));
const original=fs.readFileSync(path.join(root,'supabase/migrations/20261017000000_lacak_domba_discovery_session.sql'),'utf8').replace(/\r\n/g,'\n');
const statement=/^alter table public\.lacak_domba_presence$/m.exec(original);assert.ok(statement&&statement.index>0);const ddl=original.slice(statement.index);
const names=['lacak_domba_discovery_start','lacak_domba_discovery_extend','lacak_domba_discovery_refresh','lacak_domba_discovery_end','lacak_domba_scan_candidates','lacak_domba_purge_stale'];
const preflight=`-- REVIEW PROPOSAL ONLY. Target cfnimvrxrnmefmxtzqks; NOT APPLIED.
-- Existing migration body is preserved. No base migration, data backfill or RPC call.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $preflight$
begin
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in (${names.map(n=>"'"+n+"'").join(',')})) then
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
`;
const post=`
-- Catalog-only postcondition. Never call lifecycle/scan/purge RPCs in production checks.
do $postcheck$
declare v_oid oid; v_name text;
begin
  foreach v_name in array array[${names.map(n=>"'"+n+"'").join(',')}] loop
    select p.oid into strict v_oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=v_name;
    if has_function_privilege('anon',v_oid,'EXECUTE') or has_function_privilege('authenticated',v_oid,'EXECUTE')
      or not has_function_privilege('service_role',v_oid,'EXECUTE') then raise exception 'STOP: RPC execute posture mismatch'; end if;
  end loop;
  if (select md5(pg_get_functiondef(to_regprocedure('public.lacak_domba_replace_own_blocks(text,text[])')))) is distinct from '5f3d414be75d04cdf44a84216f863db5'
    or (select md5(pg_get_functiondef(to_regprocedure('public.lacak_domba_take_scan_slot(text,integer)')))) is distinct from '50947f36fa1d6bd3cb946437c56f7537' then raise exception 'STOP: existing RPC changed'; end if;
end;
$postcheck$;
notify pgrst, 'reload schema';
commit;
`;
fs.writeFileSync(path.join(__dirname,'DISCOVERY-SESSION-PROPOSAL.sql'),preflight+ddl+post);
const signatures=['lacak_domba_discovery_start(text,jsonb)','lacak_domba_discovery_extend(text,uuid,jsonb)','lacak_domba_discovery_refresh(text,jsonb,timestamptz)','lacak_domba_discovery_end(text,text,uuid)','lacak_domba_scan_candidates(text,double precision,double precision,integer,integer,integer)','lacak_domba_purge_stale(integer)'];
fs.writeFileSync(path.join(__dirname,'ROLLBACK-DISABLE-PROPOSAL.sql'),'-- REVIEW ONLY: disable ONLY the new service RPCs; retain every column and row.\nbegin;\n'+signatures.map(s=>'revoke execute on function public.'+s+' from service_role;').join('\n')+"\nnotify pgrst, 'reload schema';\ncommit;\n");
const quoted=s=>'"'+s.replace(/"/g,'""')+'"';
let clone='-- LOCAL SYNTHETIC TEST DATABASE ONLY. Reconstructed catalog, NO production rows.\n';
for(const table of ['lacak_domba_presence','lacak_domba_blocks','lacak_domba_scan_limits']){
  clone+='create table public.'+quoted(table)+' (\n'+snapshot.columns.filter(c=>c.relname===table).map(c=>'  '+quoted(c.attname)+' '+c.type+(c.default_value?' default '+c.default_value:'')+(c.attnotnull?' not null':'')).join(',\n')+'\n);\n';
  for(const c of snapshot.constraints.filter(c=>c.table_name===table))clone+='alter table public.'+quoted(table)+' add constraint '+quoted(c.conname)+' '+c.definition+';\n';
  clone+='alter table public.'+quoted(table)+' enable row level security;\n';
}
for(const i of snapshot.indexes.filter(i=>!i.indexname.endsWith('_pkey')))clone+=i.indexdef+';\n';
for(const p of snapshot.base_rpc_definitions)clone+=p.definition+';\n';
for(const g of snapshot.tableGrants)clone+='grant '+g.privilege_type+' on public.'+quoted(g.table_name)+' to '+quoted(g.grantee)+';\n';
clone+='revoke all on function public.lacak_domba_replace_own_blocks(text,text[]) from public,anon,authenticated;\ngrant execute on function public.lacak_domba_replace_own_blocks(text,text[]) to service_role;\nrevoke all on function public.lacak_domba_take_scan_slot(text,integer) from public,anon,authenticated;\ngrant execute on function public.lacak_domba_take_scan_slot(text,integer) to service_role;\n';
fs.writeFileSync(path.join(__dirname,'LOCAL-BASELINE.sql'),clone);
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const files=['supabase/migrations/20261010000000_lacak_domba.sql','supabase/migrations/20261017000000_lacak_domba_discovery_session.sql','supabase/functions/lacak-domba-nearby/index.ts','supabase/functions/lacak-domba-nearby/discovery.ts','supabase/config.toml'];
const manifest={project:snapshot.project,status:'OWNER_APPROVAL_REQUIRED',originalSources:files.map(file=>({file,sha256:hash(fs.readFileSync(path.join(root,file)))})),proposalSha256:hash(Buffer.from(preflight+ddl+post)),baseRpcDefinitionsPreserved:true,productionApplied:false,tableDataExported:false};
fs.writeFileSync(path.join(__dirname,'REVIEW-MANIFEST.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify({proposalPrepared:true,originalRpcBodiesPreserved:true,productionApplied:false}));
