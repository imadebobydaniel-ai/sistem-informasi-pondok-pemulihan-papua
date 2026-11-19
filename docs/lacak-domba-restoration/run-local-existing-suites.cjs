'use strict';
// Portable PostgreSQL/PostgREST on new loopback ports; existing Deno suites only.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),net=require('node:net'),http=require('node:http'),{spawn,execFileSync}=require('node:child_process'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),tools=path.join(__dirname,'.cache/tools'),pgbin=path.join(tools,'pgsql/bin');
const deno=path.join(process.env.APPDATA,'npm/node_modules/deno/deno.exe');
const env={};for(const key of ['SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','PATH'])if(process.env[key])env[key]=process.env[key];
env.PATH=pgbin+path.delimiter+env.PATH;env.DENO_DIR=path.join(__dirname,'.cache/deno');env.CI='true';env.NO_COLOR='1';
env.PGPASSWORD='synthetic-local-only'; // Never consult a personal password file.
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
  const ports=[],reservations=[];for(let i=0;i<3;i++){const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));ports.push(server.address().port);reservations.push(server);}for(const server of reservations)await new Promise(r=>server.close(r));
  const [pgport,restport,gatewayport]=ports,dir=fs.mkdtempSync(path.join(__dirname,'.cache/cluster-')),data=path.join(dir,'data');
  const result={postgres:'17.12 portable',postgrest:'16.5 portable',isolated:true,productionWrites:0,tests:[]};let pg,rest,gateway;
  const run=(exe,args,input)=>execFileSync(exe,args,{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:8*1024*1024,input,stdio:[input?'pipe':'ignore','pipe','pipe']});
  const psql=(query,file)=>run(path.join(pgbin,'psql.exe'),['-h','127.0.0.1','-p',String(pgport),'-U','postgres','-d','postgres','-X','-Atq','-v','ON_ERROR_STOP=1',...(file?['-f',file]:['-c',query])]);
  const rowFingerprint=`select md5(jsonb_build_object('presence',(select jsonb_agg(to_jsonb(p)-'discoverable_until'-'discovery_session_id'-'session_started_at') from public.lacak_domba_presence p),'blocks',(select jsonb_agg(to_jsonb(b)) from public.lacak_domba_blocks b),'limits',(select jsonb_agg(to_jsonb(l)) from public.lacak_domba_scan_limits l))::text)`;
  const rpcFingerprint=`select md5(string_agg(pg_get_functiondef(p.oid)||coalesce(p.proacl::text,''),'|' order by p.proname)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('lacak_domba_replace_own_blocks','lacak_domba_take_scan_slot')`;
  try{
    result.stage='local-init';run(path.join(pgbin,'initdb.exe'),['-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);
    const log=fs.openSync(path.join(dir,'postgres.log'),'a');pg=spawn(path.join(pgbin,'postgres.exe'),['-D',data,'-h','127.0.0.1','-p',String(pgport)],{cwd:dir,env,windowsHide:true,stdio:['ignore',log,log]});
    let ready=false;for(let i=0;i<80;i++){try{if(psql('select 1').trim()==='1'){ready=true;break;}}catch{}await pause(250);}assert.ok(ready,'Local PostgreSQL did not start');
    psql('create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create role authenticator login noinherit; grant anon,authenticated,service_role to authenticator;');
    result.stage='baseline-clone';psql(null,path.join(__dirname,'LOCAL-BASELINE.sql'));
    psql("insert into public.lacak_domba_presence(firebase_uid,latitude,longitude,discoverable,location_updated_at) values('legacy-fixture',null,null,false,null); insert into public.lacak_domba_blocks(blocker_uid,blocked_uid) values('legacy-fixture','legacy-peer'); insert into public.lacak_domba_scan_limits(firebase_uid) values('legacy-fixture');");
    const before=psql(rowFingerprint).trim(),beforeRpc=psql(rpcFingerprint).trim(),combined=process.argv.includes('--combined-check');
    const originalBlockAcl=psql("select proacl::text from pg_proc where oid='public.lacak_domba_replace_own_blocks(text,text[])'::regprocedure").trim();
    result.stage='migration-proposal';psql(null,path.join(__dirname,combined?'RESTORATION-PROPOSAL.sql':'DISCOVERY-SESSION-PROPOSAL.sql'));
    assert.equal(psql(rowFingerprint).trim(),before,'Migration changed legacy data');
    if(!combined){assert.equal(psql(rpcFingerprint).trim(),beforeRpc,'Migration changed existing RPC definitions or ACL');result.existingRpcDefinitionsAndAclUnchanged=true;}
    else{assert.equal(psql("select md5(pg_get_functiondef('public.lacak_domba_take_scan_slot(text,integer)'::regprocedure))").trim(),'50947f36fa1d6bd3cb946437c56f7537');assert.equal(psql("select proacl::text from pg_proc where oid='public.lacak_domba_replace_own_blocks(text,text[])'::regprocedure").trim(),originalBlockAcl);result.combinedProposalVerified=true;result.blockRepairChangesCodeOnly=true;result.blockRepairAclUnchanged=true;}
    result.migrationPreservedLegacyRows=true;
    const privilege=JSON.parse(psql("select json_agg(json_build_object('name',p.proname,'anon',has_function_privilege('anon',p.oid,'EXECUTE'),'authenticated',has_function_privilege('authenticated',p.oid,'EXECUTE'),'service',has_function_privilege('service_role',p.oid,'EXECUTE'),'securityDefiner',p.prosecdef)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('lacak_domba_discovery_start','lacak_domba_discovery_extend','lacak_domba_discovery_refresh','lacak_domba_discovery_end','lacak_domba_scan_candidates','lacak_domba_purge_stale')").trim());
    assert.equal(privilege.length,6);assert.ok(privilege.every(p=>!p.anon&&!p.authenticated&&p.service&&p.securityDefiner));result.newRpcPrivileges=privilege;
    let refused=false;try{psql(null,path.join(__dirname,'DISCOVERY-SESSION-PROPOSAL.sql'));}catch{refused=true;}assert.ok(refused,'Unexpected reapply not refused');assert.equal(psql(rowFingerprint).trim(),before);result.reapplyFailsClosedWithoutDataChanges=true;
    psql(null,path.join(__dirname,'ROLLBACK-DISABLE-PROPOSAL.sql'));assert.equal(psql(rowFingerprint).trim(),before);assert.equal(psql("select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'lacak_domba_discovery_%'").trim(),'4');
    result.rollbackRetainsRowsColumnsAndFunctions=true;
    if(combined){psql(null,path.join(__dirname,'ROLLBACK-BLOCKS-CODE-ONLY.sql'));assert.equal(psql(rowFingerprint).trim(),before);assert.equal(psql(rpcFingerprint).trim(),beforeRpc);result.fullRollbackRetainsRowsAndRestoresOriginalRpc=true;psql(null,path.join(__dirname,'BLOCKS-COMPATIBILITY-PROPOSAL.sql'));}
    for(const p of privilege){const sig=psql("select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='"+p.name+"'").trim();psql('grant execute on function '+sig+' to service_role;');}
    psql("delete from public.lacak_domba_blocks where blocker_uid='legacy-fixture'; delete from public.lacak_domba_presence where firebase_uid='legacy-fixture'; delete from public.lacak_domba_scan_limits where firebase_uid='legacy-fixture';"); // Synthetic local fixtures only.
    if(process.argv.includes('--edge-compat-only')){
      result.stage='blocks-compatibility';
      const rowsBefore=psql(rowFingerprint).trim(),aclBefore=psql("select proacl::text from pg_proc where oid='public.lacak_domba_replace_own_blocks(text,text[])'::regprocedure").trim();
      psql(null,path.join(__dirname,'BLOCKS-COMPATIBILITY-PROPOSAL.sql'));
      assert.equal(psql(rowFingerprint).trim(),rowsBefore);assert.equal(psql("select proacl::text from pg_proc where oid='public.lacak_domba_replace_own_blocks(text,text[])'::regprocedure").trim(),aclBefore);
      result.blockRepairChangesCodeOnly=true;result.blockRepairAclUnchanged=true;
    }
    result.stage='local-postgrest';const secret=crypto.randomBytes(48).toString('hex');
    const jwt=role=>{const header=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),payload=Buffer.from(JSON.stringify({role,iss:'local-synthetic-lacak',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600})).toString('base64url');return header+'.'+payload+'.'+crypto.createHmac('sha256',secret).update(header+'.'+payload).digest('base64url');};
    const config=path.join(dir,'postgrest.conf');fs.writeFileSync(config,`db-uri = "postgresql://authenticator@127.0.0.1:${pgport}/postgres"\ndb-schemas = "public"\ndb-anon-role = "anon"\nserver-host = "127.0.0.1"\nserver-port = ${restport}\njwt-secret = "${secret}"\n`);
    const restlog=fs.openSync(path.join(dir,'postgrest.log'),'a');rest=spawn(path.join(tools,'postgrest.exe'),[config],{cwd:dir,env,windowsHide:true,stdio:['ignore',restlog,restlog]});
    ready=false;for(let i=0;i<80;i++){try{const r=await fetch('http://127.0.0.1:'+restport+'/',{signal:AbortSignal.timeout(500)});await r.body?.cancel();if(r.ok){ready=true;break;}}catch{}await pause(250);}assert.ok(ready,'Local PostgREST did not start');
    gateway=http.createServer(async(req,res)=>{try{if(!req.url.startsWith('/rest/v1')){res.writeHead(404).end();return;}const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks);const headers={...req.headers};delete headers.host;delete headers.connection;delete headers['content-length'];const r=await fetch('http://127.0.0.1:'+restport+(req.url.slice('/rest/v1'.length)||'/'),{method:req.method,headers,...(body.length?{body}:{}),redirect:'error'});res.writeHead(r.status,Object.fromEntries(r.headers));res.end(Buffer.from(await r.arrayBuffer()));}catch{res.writeHead(502).end();}});await new Promise(r=>gateway.listen(gatewayport,'127.0.0.1',r));
    Object.assign(env,{LD_TEST_DB_URL:'postgres://postgres@127.0.0.1:'+pgport+'/postgres',LD_TEST_SUPABASE_URL:'http://127.0.0.1:'+gatewayport,LD_TEST_SERVICE_ROLE_KEY:jwt('service_role'),LD_TEST_ANON_KEY:jwt('anon')});
    const files=combined?['docs/lacak-domba-restoration/blocks-compatibility_test.ts']:process.argv.includes('--edge-compat-only')?['supabase/functions/tests/lacak-domba-nearby_test.ts']:['supabase/functions/tests/lacak-domba-db_test.ts','supabase/functions/tests/lacak-domba-nearby_test.ts'];
    for(const file of files){
      result.stage=file;const outputFile=path.join(__dirname,path.basename(file)+'.log'),fd=fs.openSync(outputFile,'w');
      const child=spawn(deno,['test','--cached-only','--no-lock','--no-config','--allow-env','--allow-net=127.0.0.1,localhost','--allow-read='+path.join(root,'supabase'),'--allow-sys',file],{cwd:root,env,windowsHide:true,stdio:['ignore',fd,fd]});
      const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});fs.closeSync(fd);
      const output=fs.readFileSync(outputFile,'utf8').replace(/\x1b\[[0-9;]*m/g,''),summary=output.match(/(\d+) passed \| (\d+) failed(?: \| (\d+) ignored)?/);
      result.tests.push({file,exitCode:code,passed:summary?Number(summary[1]):null,failed:summary?Number(summary[2]):null,ignored:summary?Number(summary[3]||0):null});console.log(JSON.stringify(result.tests[result.tests.length-1]));
      if(code!==0)throw Error('Existing isolated suite failed');
    }
    result.status='PASS';
  }catch(error){result.status='BLOCKED';result.category=error.code||'LOCAL_SUITE_GATE_FAILED';}
  finally{
    if(gateway)await new Promise(r=>gateway.close(r));if(rest&&rest.exitCode===null)rest.kill();
    if(pg&&pg.exitCode===null){try{run(path.join(pgbin,'pg_ctl.exe'),['-D',data,'-m','fast','-w','stop']);}catch{pg.kill();}}
    fs.writeFileSync(path.join(__dirname,process.argv.includes('--combined-check')?'COMBINED-PROPOSAL-RESULT.json':process.argv.includes('--edge-compat-only')?'EDGE-COMPAT-SUITES-RESULT.json':'LOCAL-SUITES-RESULT.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }
  if(result.status!=='PASS')process.exitCode=1;
}
main().catch(()=>{console.log('LOCAL_TEST_BOOTSTRAP_BLOCKED_NO_PRODUCTION_ACCESS');process.exitCode=1;});
