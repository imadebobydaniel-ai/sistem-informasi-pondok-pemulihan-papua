import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,copyFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
const project='demo-sipapua-distance';
const origin='http://127.0.0.1:5500';
const edge='supabase/functions/lacak-domba-nearby';
const migrationNames=['20261010000000_lacak_domba.sql','20261017000000_lacak_domba_discovery_session.sql'];
const args={
  lacak_domba_discovery_start:['p_uid','p_row'],
  lacak_domba_discovery_extend:['p_uid','p_session_id','p_row'],
  lacak_domba_discovery_refresh:['p_uid','p_row','p_read_at'],
  lacak_domba_discovery_end:['p_uid','p_mode','p_session_id'],
  lacak_domba_purge_stale:['p_location_max_age_seconds'],
  lacak_domba_replace_own_blocks:['p_blocker_uid','p_blocked_uids'],
  lacak_domba_take_scan_slot:['p_firebase_uid','p_min_interval_seconds'],
  lacak_domba_scan_candidates:['p_uid','p_min_lat','p_max_lat','p_presence_max_age_seconds','p_location_max_age_seconds','p_limit']
};
const arrayResult=new Set(['lacak_domba_discovery_start','lacak_domba_discovery_extend',
  'lacak_domba_discovery_refresh','lacak_domba_discovery_end','lacak_domba_scan_candidates']);
const fields=(values)=>Object.fromEntries(Object.entries(values).map(([name,value])=>[
  name,typeof value==='number'?{doubleValue:value}:typeof value==='boolean'?{booleanValue:value}:
    /At$|Seen$/.test(name)?{timestampValue:value}:{stringValue:value}
]));

function dependency(name) {
  const p=process.env[name];
  assert.ok(p && isAbsolute(p), 'Set '+name+' to the installed module file');
  return pathToFileURL(p).href;
}

async function handlerFor(folder,variant,joseUrl) {
  const base=join(folder,variant);
  const dir=join(base,edge);
  await mkdir(dir,{recursive:true});
  for(const name of ['index.ts','discovery.ts'])await copyFile(join(root,edge,name),join(dir,name));
  if(variant==='candidate') {
    execFileSync('git',['apply','--ignore-space-change',join(root,'candidates/lacak-domba-real-distance/edge-distance.patch')],{cwd:base});
  }
  const file=join(dir,'index.ts');
  const original=await readFile(file,'utf8');
  const source=original.replace('"npm:jose@5.9.6"',JSON.stringify(joseUrl))
    .replace('import { createClient } from "npm:@supabase/supabase-js@2.116.0";','const createClient = globalThis.__fixtureClient;')
    .replace('const PROJECT_ID = "boby-apps-project";','const PROJECT_ID = '+JSON.stringify(project)+';');
  assert.ok(source!==original && !source.includes('npm:') && !source.includes('boby-apps-project'));
  let handler;
  globalThis.Deno={
    env:{get:key=>({SUPABASE_URL:'http://127.0.0.1:1',SUPABASE_SERVICE_ROLE_KEY:'synthetic-role'})[key]},
    serve:fn=>{handler=fn;}
  };
  await writeFile(file,source);
  await import(pathToFileURL(file).href);
  assert.equal(typeof handler,'function');
  return handler;
}

test('real Edge handler and PostgreSQL migrations with synthetic Firebase transport',{timeout:120000},async t=>{
  const joseUrl=dependency('SIPAPUA_DISTANCE_JOSE');
  const {PGlite}=await import(dependency('SIPAPUA_DISTANCE_PGLITE'));
  const {generateKeyPair,exportJWK,SignJWT}=await import(joseUrl);
  const db=new PGlite();
  t.after(()=>db.close());
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;');
  for(const name of migrationNames)await db.exec(await readFile(join(root,'supabase/migrations',name),'utf8'));
  const keyPair=await generateKeyPair('RS256');
  const jwk={...await exportJWK(keyPair.publicKey),kid:'fixture'};
  const users=new Map();
  const credentials=new Map();
  function user(uid, active=true) {
    const record={uid,active,optIn:false,online:true,latitude:0,longitude:135,blocks:new Set()};
    users.set(uid,record);
    return record;
  }
  const caller=user('synthetic-caller');
  const target=user('synthetic-target');
  const disabled=user('synthetic-inactive',false);
  async function sign(account) {
    const token=await new SignJWT({})
      .setProtectedHeader({alg:'RS256',kid:'fixture'})
      .setIssuer('https://securetoken.google.com/'+project).setAudience(project)
      .setSubject(account.uid).setIssuedAt().setExpirationTime('5m').sign(keyPair.privateKey);
    credentials.set(token,account);
    return token;
  }
  const tokens=new Map();
  for(const account of users.values())tokens.set(account.uid,await sign(account));
  const originalFetch=globalThis.fetch;
  t.after(()=>{
    globalThis.fetch=originalFetch;
    delete globalThis.__fixtureClient;
    delete globalThis.Deno;
  });
  globalThis.fetch=async(input,init)=>{
    const url=new URL(input instanceof Request?input.url:input);
    if(url.href==='https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com') {
      return Response.json({keys:[jwk]});
    }
    assert.equal(url.origin,'https://firestore.googleapis.com');
    const base='/v1/projects/'+project+'/databases/(default)/documents/';
    assert.ok(url.pathname.startsWith(base));
    const [collection,uid]=url.pathname.slice(base.length).split('/').map(decodeURIComponent);
    const headers=new Headers(init?.headers || (input instanceof Request?input.headers:undefined));
    const account=credentials.get(headers.get('authorization')?.slice(7));
    if(!account || uid!==account.uid)return new Response(null,{status:403});
    const now=new Date().toISOString();
    if(collection==='users') return Response.json({fields:fields({status_akun:account.active?'Aktif':'Nonaktif'})});
    if(collection==='presence')return Response.json({fields:fields({discoverable:account.optIn,online:account.online,
      showOnline:false,lastSeen:now,displayName:'Fixture '+account.uid})});
    if(collection==='presence_locations')return Response.json({fields:fields({
      latitude:account.latitude,longitude:account.longitude,updatedAt:now
    })});
    if(collection==='user_blocks')return Response.json({documents:[...account.blocks].map(id=>({name:'synthetic/blocked/'+id}))});
    return new Response(null,{status:404});
  };
  const calls=[];
  globalThis.__fixtureClient=(url,key)=>{
    assert.equal(url,'http://127.0.0.1:1');
    assert.equal(key,'synthetic-role');
    return {async rpc(name,values){
      assert.deepEqual(Object.keys(values).sort(),[...args[name]].sort());
      calls.push(name);
      const params=args[name].map(k=>k==='p_row' && values[k]!==null?JSON.stringify(values[k]):values[k]);
      await db.exec('SET ROLE service_role');
      try{
        const {rows}=await db.query('SELECT * FROM public.'+name+'('+params.map((_,i)=>'$'+(i+1)).join(',')+')',params);
        return {data:arrayResult.has(name)?rows:rows[0]?.[name],error:null};
      }catch(error){return {error:{message:error.message}};}finally{await db.exec('RESET ROLE');}
    }};
  };
  const scratch=await mkdtemp(join(tmpdir(),'sipapua-distance-test-'));
  const baseline=await handlerFor(scratch,'baseline',joseUrl);
  const repaired=await handlerFor(scratch,'candidate',joseUrl);
  async function invoke(handler,account,body,expected=200) {
    const response=await handler(new Request('http://127.0.0.1:5500/function',{
      method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Authorization:'Bearer '+tokens.get(account.uid)},
      body:JSON.stringify(body)
    }));
    const data=await response.json();
    assert.equal(response.status,expected,JSON.stringify(data));
    return data;
  }
  function move(km) { target.longitude=caller.longitude+km/6371*180/Math.PI; }
  async function scan(radius,handler=repaired,scanner=caller) {
    // Simulate elapsed cooldown in the isolated database only.
    await db.query("UPDATE lacak_domba_scan_limits SET last_scan_at=now()-interval '16 seconds' WHERE firebase_uid=$1",[scanner.uid]);
    const result=await invoke(handler,scanner,{action:'scan',radiusKm:radius});
    for(const row of result.results) {
      assert.equal(Object.hasOwn(row,'latitude'),false);
      assert.equal(Object.hasOwn(row,'longitude'),false);
      assert.equal(Object.hasOwn(row,'distanceKm'),false);
    }
    return result.results;
  }
  async function sync() {return invoke(repaired,target,{action:'sync'});}
  async function found(km,radius,expected) {
    move(km);
    assert.equal((await sync()).discovery.active,true);
    const result=await scan(radius);
    assert.equal(result.some(row=>row.uid===target.uid),expected);
    if(expected){
      assert.equal(result[0].distanceRange,km<1?'< 1 KM':km<5?'1–5 KM':'5–10 KM');
      assert.equal(result[0].online,false); // The fixture opts in to discovery but withholds its online indicator.
    }
  }

  await t.test('explicit start persists a 15-minute session and heartbeat preserves its expiry',async()=>{
    target.optIn=true;
    move(0.5);
    const result=await invoke(repaired,target,{action:'discovery_start'});
    assert.equal(result.discovery.active,true);
    assert.ok(result.discovery.expiresInMs>=895000 && result.discovery.expiresInMs<=900000);
    const again=await sync();
    assert.equal(again.discovery.sessionId,result.discovery.sessionId);
    assert.equal(again.discovery.expiresAt,result.discovery.expiresAt);
    const {rows}=await db.query('SELECT discoverable,online FROM lacak_domba_presence WHERE firebase_uid=$1',[target.uid]);
    assert.deepEqual(rows,[{discoverable:true,online:true}]);
    assert.ok(calls.includes('lacak_domba_discovery_start') && calls.includes('lacak_domba_discovery_refresh'));
  });
  for(const [km,radius,expected] of [[0.5,1,true],[3,1,false],[3,5,true],[8,5,false],[8,10,true]]) {
    await t.test(km+' km at radius '+radius+' km '+(expected?'included':'excluded'),()=>found(km,radius,expected));
  }
  await t.test('baseline longitude estimate drops an in-radius point; candidate finds it',async()=>{
    move(0.9995);
    await sync();
    assert.deepEqual(await scan(1,baseline),[]);
    assert.equal((await scan(1))[0]?.uid,target.uid);
  });
  await t.test('both directions of blocking prevent discovery with server-side filtering',async()=>{
    move(0.5);
    await sync();
    caller.blocks.add(target.uid);
    assert.deepEqual(await scan(1),[]);
    caller.blocks.clear();
    target.blocks.add(caller.uid);
    await sync();
    assert.deepEqual(await scan(1),[]);
    target.blocks.clear();
    await sync();
    assert.equal((await scan(1))[0]?.uid,target.uid);
  });
  await t.test('expired location, stale heartbeat and lost consent are excluded',async()=>{
    await db.query("UPDATE lacak_domba_presence SET location_updated_at=now()-interval '16 minutes' WHERE firebase_uid=$1",[target.uid]);
    assert.deepEqual(await scan(1),[]);
    await invoke(repaired,target,{action:'discovery_start'});
    await db.query("UPDATE lacak_domba_presence SET last_seen=now()-interval '4 minutes' WHERE firebase_uid=$1",[target.uid]);
    assert.deepEqual(await scan(1),[]);
    assert.equal((await sync()).discovery.active,true);
    assert.equal((await scan(1))[0]?.uid,target.uid);
    target.optIn=false;
    assert.equal((await sync()).discovery.active,false);
    assert.deepEqual(await scan(1),[]);
  });
  await t.test('inactive caller and inactive opt-in receive 403',async()=>{
    disabled.optIn=true;
    for(const body of [{action:'scan',radiusKm:1},{action:'discovery_start'}]) {
      assert.equal((await invoke(repaired,disabled,body,403)).error,'account_not_active');
    }
  });
  await t.test('both online opt-in sessions find each other; offline participant is excluded',async()=>{
    caller.optIn=target.optIn=true;
    move(0.5);
    await invoke(repaired,caller,{action:'discovery_start'});
    await invoke(repaired,target,{action:'discovery_start'});
    assert.deepEqual((await scan(1)).map(row=>row.uid),[target.uid]);
    assert.deepEqual((await scan(1,repaired,target)).map(row=>row.uid),[caller.uid]);
    target.online=false;
    await sync();
    assert.deepEqual(await scan(1),[]);
    target.online=true;
    caller.optIn=false;
    await invoke(repaired,caller,{action:'sync'});
    await sync();
  });
  await t.test('expired discovery is excluded and inactive target refresh clears its prior session',async()=>{
    target.optIn=true;
    move(0.5);
    await invoke(repaired,target,{action:'discovery_start'});
    await db.query(`UPDATE lacak_domba_presence SET
      session_started_at=now()-interval '16 minutes',
      discoverable_until=now()-interval '1 minute' WHERE firebase_uid=$1`,[target.uid]);
    assert.deepEqual(await scan(1),[]);
    await invoke(repaired,target,{action:'discovery_start'});
    assert.equal((await scan(1))[0]?.uid,target.uid);
    target.active=false;
    assert.equal((await invoke(repaired,target,{action:'sync'},403)).error,'account_not_active');
    assert.deepEqual(await scan(1),[]);
  });
  await t.test('candidate RPC stays service-role-only on the real SQL runtime',async()=>{
    const {rows}=await db.query(`SELECT
      has_function_privilege('anon',p.oid,'EXECUTE') AS anon,
      has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated,
      has_function_privilege('service_role',p.oid,'EXECUTE') AS service
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='lacak_domba_scan_candidates'`);
    assert.deepEqual(rows,[{anon:false,authenticated:false,service:true}]);
  });
});
