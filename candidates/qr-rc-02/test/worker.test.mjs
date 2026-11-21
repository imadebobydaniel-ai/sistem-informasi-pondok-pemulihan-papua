import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createSign} from 'node:crypto';
import {webcrypto} from 'node:crypto';
import {handle,internal} from '../src/worker.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const now=1795030000000;
const project='boby-apps-project',number='125984859692';
const appId='1:125984859692:web:09f75df5d2e4b6e3bcd389';
const origin='https://example.github.io';
const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const key={...publicKey.export({format:'jwk'}),kid:'test-rsa-key',use:'sig',alg:'RS256'};
const base64=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(claims){const h=base64({alg:'RS256',typ:'JWT',kid:key.kid}),p=base64(claims);const sign=createSign('RSA-SHA256');sign.update(`${h}.${p}`);sign.end();return `${h}.${p}.${sign.sign(privateKey).toString('base64url')}`;}
const base={iat:Math.floor(now/1000)-30,exp:Math.floor(now/1000)+3600};
function token(uid){return jwt({...base,auth_time:base.iat,sub:uid,iss:`https://securetoken.google.com/${project}`,aud:project,firebase:{sign_in_provider:'password'}})}
let sequence=0;
function check(){return jwt({...base,jti:String(++sequence),sub:appId,iss:`https://firebaseappcheck.googleapis.com/${number}`,aud:[`projects/${number}`]})}
const nij='NIJ-PPP-ABE-001-2026';
const docs=new Map([['users/u1',{status_akun:'Aktif',uid:'u1',nij,nama:'Synthetic One',komsel:'JC Alpha'}],['nij_allocations/u1',{uid:'u1',nij}],['users/u2',{status_akun:'Aktif',uid:'u2',nij:'NIJ-PPP-ABE-002-2026',nama:'Synthetic Two'}],['nij_allocations/u2',{uid:'u2',nij:'NIJ-PPP-ABE-002-2026'}]]);
function fval(v){if(typeof v==='string')return {stringValue:v};if(typeof v==='number')return {integerValue:String(v)};return {booleanValue:v};}
async function fetcher(url,init={}) {
  if(url.includes('/jwk'))return new Response(JSON.stringify({keys:[key]}),{status:200,headers:{'Content-Type':'application/json'}});
  if(url.startsWith('https://firestore.googleapis.com/')) {
    const path=url.split('/documents/')[1];
    const uid=path.split('/')[1];
    const header=init.headers?.Authorization||'';
    if(!header.includes(token(uid)))return new Response('',{status:403});
    const d=docs.get(path);if(!d)return new Response('',{status:404});
    return Response.json({fields:Object.fromEntries(Object.entries(d).map(([k,v])=>[k,fval(v)]))});
  }
  throw Error('unexpected URL '+url);
}
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker,{deleteExpiredCards} from '../src/worker.mjs';
import {createQrAuthority} from '../src/authority.mjs';

function fixture(t) {
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  t.after(()=>db.close());
  const DB={prepare(sql){
    const stmt=db.prepare(sql);
    return {bind:(...args)=>({first:async()=>stmt.get(...args),run:async()=>stmt.run(...args)})};
  }};
  const consumed=new Set(), revoked=new Set(), disabled=new Set();
  const auth={
    async verifyIdToken(id,checkRevoked) {
      assert.equal(checkRevoked,true);
      const uid=['u1','u2'].find(u=>token(u)===id);
      if (!uid) throw Object.assign(Error(),{code:'auth/invalid-id-token'});
      if (revoked.has(uid)||disabled.has(uid)) throw Object.assign(Error(),{code:'auth/id-token-revoked'});
      return {uid,auth_time:base.iat,firebase:{sign_in_provider:'password'}};
    },
    async getUser(uid) {
      return {uid,disabled:disabled.has(uid),tokensValidAfterTime:new Date(revoked.has(uid)?now:0).toISOString()};
    }
  };
  const authority=createQrAuthority({auth,expectedAppId:appId,
    firestore:{doc:path=>path,getAll:async(...paths)=>paths.map(path=>({data:()=>docs.get(path)}))},
    appCheck:{async verifyToken(value,options){
      assert.deepEqual(options,{consume:true});
      const alreadyConsumed=consumed.has(value);
      consumed.add(value);
      return {appId,alreadyConsumed};
    }}
  });
  const e={DB,QR_AUTHORITY:authority,QR_INGRESS:{limit:async()=>({success:true})},
    FIREBASE_PROJECT_ID:project,FIREBASE_PROJECT_NUMBER:number,FIREBASE_APP_ID:appId,ALLOWED_ORIGIN:origin};
  const send=(uid,path,data={},options={})=>handle(new Request('https://worker.example'+path,{
    method:options.method||'POST',headers:{Origin:options.origin||origin,'CF-Connecting-IP':'192.0.2.10',
      Authorization:'Bearer '+(options.id||token(uid)),'X-Firebase-AppCheck':options.app||check(),
      'Content-Type':'application/json',...options.headers},...((options.method||'POST')==='POST'?{body:JSON.stringify(data)}:{})
  }),e,{fetcher,now:options.time??now});
  return {e,send,db,revoked,disabled};
}

test('fails closed without authority and ingress, filters origin and route before credentials',async t=>{
  const {e,send}=fixture(t);
  assert.equal((await send('u1','/v1/issue',{}, {origin:'https://unapproved.example'})).status,403);
  assert.equal((await send('u1','/v1/issue?token=unused')).status,404);
  delete e.QR_AUTHORITY;
  assert.equal((await send('u1','/v1/issue')).status,503);
});

test('local JWT verification denies invalid Auth, wrong App Check and missing auth_time',async t=>{
  const {send}=fixture(t);
  assert.equal((await send('u1','/v1/issue',{}, {id:'abc.def.ghi'})).status,401);
  assert.equal((await send('u1','/v1/issue',{}, {app:'abc.def.ghi'})).status,401);
  const id=jwt({...base,sub:'u1',iss:'https://securetoken.google.com/'+project,aud:project,firebase:{sign_in_provider:'password'}});
  assert.equal((await send('u1','/v1/issue',{}, {id})).status,401);
});

test('exact CORS preflight and security headers on normal responses',async t=>{
  const {send}=fixture(t);
  const good=await send('u1','/v1/issue',{}, {method:'OPTIONS',headers:{
    'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization, x-firebase-appcheck'}});
  assert.equal(good.status,204);
  assert.equal(good.headers.get('Access-Control-Allow-Origin'),origin);
  assert.equal((await send('u1','/v1/issue',{}, {method:'OPTIONS',headers:{
    'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'x-unapproved'}})).status,400);
  const response=await send('u1','/v1/issue');
  assert.equal(response.status,200);
  assert.equal(response.headers.get('Cache-Control'),'no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');
  assert.equal(response.headers.get('Referrer-Policy'),'no-referrer');
});

test('real SQL handles atomic issue cooldown, self-scan and exactly one concurrent redemption',async t=>{
  const {send,db}=fixture(t);
  const issuances=await Promise.all([send('u1','/v1/issue'),send('u1','/v1/issue')]);
  assert.deepEqual(issuances.map(r=>r.status).sort(),[200,429]);
  const issued=await issuances.find(r=>r.ok).json();
  assert.equal(db.prepare('SELECT token_hash FROM cards').get().token_hash,await internal.sha256(issued.token));
  assert.deepEqual(db.prepare('PRAGMA table_info(cards)').all().map(r=>r.name),
    ['uid','token_hash','issued_at','expires_at','auth_time','consumed_at']);
  const payload={token:issued.token};
  assert.equal((await send('u1','/v1/lookup',payload)).status,404);
  const scans=await Promise.all([send('u2','/v1/lookup',payload),send('u2','/v1/lookup',payload)]);
  assert.deepEqual(scans.map(r=>r.status).sort(),[200,404]);
  assert.deepEqual(await scans.find(r=>r.ok).json(),{profile:{nij,nama:'Synthetic One',komsel:'JC Alpha'},verified:true});
  assert.equal((await send('u2','/v1/lookup',payload)).status,404);
  assert.equal((await send('u1','/v1/issue')).status,429);
});

test('replayed App Check fails even when the caller changes',async t=>{
  const {send}=fixture(t);
  const app=check();
  assert.equal((await send('u1','/v1/issue',{}, {app})).status,200);
  assert.equal((await send('u2','/v1/issue',{}, {app})).status,401);
});

test('revoked issuer and scanner are rejected and existing card owner is checked at scan',async t=>{
  const {send,revoked,disabled}=fixture(t);
  const {token:card}=await (await send('u1','/v1/issue')).json();
  revoked.add('u2');
  assert.equal((await send('u2','/v1/lookup',{token:card})).status,401);
  revoked.delete('u2');
  revoked.add('u1');
  assert.equal((await send('u1','/v1/issue')).status,401);
  assert.equal((await send('u2','/v1/lookup',{token:card})).status,404);
  revoked.delete('u1');
  disabled.add('u1');
  assert.equal((await send('u2','/v1/lookup',{token:card})).status,404);
  disabled.delete('u1');
  docs.get('users/u1').status_akun='Pending';
  try { assert.equal((await send('u2','/v1/lookup',{token:card})).status,404); }
  finally { docs.get('users/u1').status_akun='Aktif'; }
});

test('expiry, ingress failure, per-UID quota and scheduled purge',async t=>{
  const {send,db,e}=fixture(t);
  const {token:card}=await (await send('u1','/v1/issue')).json();
  assert.equal((await send('u2','/v1/lookup',{token:card},{time:now+300000})).status,404);
  assert.equal((await deleteExpiredCards(e.DB,now+300000)).changes,1);
  for(let i=0;i<6;i++)assert.equal((await send('u2','/v1/lookup',{token:'A'.repeat(43)})).status,404);
  assert.equal((await send('u2','/v1/lookup',{token:'A'.repeat(43)})).status,429);
  e.QR_INGRESS.limit=async()=>({success:false});
  assert.equal((await send('u1','/v1/issue')).status,429);
  db.prepare('UPDATE qr_budget SET expires_at=-rowid WHERE scope=?').run('member');
  db.prepare('DELETE FROM qr_budget WHERE scope=?').run('global');
  await new Promise(resolve=>worker.scheduled({},e,{waitUntil(p){resolve(p);}}));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM qr_budget').get().n,0);
});

test('global quota denies work before the authority and rolls over',async t=>{
  const {send,db,e}=fixture(t);
  const expiry=(Math.floor(now/60000)+1)*60000;
  db.prepare('INSERT INTO qr_budget VALUES (?,?,?,?)').run('global','qr',expiry,60);
  const original=e.QR_AUTHORITY;
  e.QR_AUTHORITY={...original,authorize:async()=>assert.fail('authority called over budget')};
  assert.equal((await send('u1','/v1/issue')).status,429);
  e.QR_AUTHORITY=original;
  assert.equal((await send('u1','/v1/issue',{}, {time:expiry})).status,200);
});

test('rotation while owner verification is pending invalidates the scanned card',async t=>{
  const {send,e}=fixture(t);
  const {token:card}=await (await send('u1','/v1/issue')).json();
  const original=e.QR_AUTHORITY;
  let pending, release;
  const started=new Promise(resolve=>{pending=resolve;});
  const barrier=new Promise(resolve=>{release=resolve;});
  e.QR_AUTHORITY={...original,async owner(input){
    pending();
    await barrier;
    return original.owner(input);
  }};
  const scan=send('u2','/v1/lookup',{token:card});
  await started;
  try { assert.equal((await send('u1','/v1/issue',{}, {time:now+15000})).status,200); }
  finally { release(); }
  assert.equal((await scan).status,404);
});

test('installed adapter contract works with RC issue and lookup using synthetic fresh attestations',async t=>{
  const {runInNewContext}=await import('node:vm');
  const {send}=fixture(t);
  const root=new URL('../../../',import.meta.url);
  const source=readFileSync(new URL('../frontend/sipapua-qr-http.js',import.meta.url),'utf8');
  const marker='const workerOrigin = null;';
  assert.equal(source.split(marker).length,2);
  const approved='https://qr.contract-fixture.workers.dev';
  const auth={currentUser:{getIdToken:async()=>token('u1')}};
  const requests=[];
  const window={setTimeout,clearTimeout,SIPAPUA_APP_CHECK:{configuration:{}},SIPAPUA_QR_LIMITED_APP_CHECK:async()=>check(),
    fetch:async(endpoint,options)=>{
      const url=new URL(endpoint);
      assert.equal(url.origin,approved);
      assert.equal(url.search,'');
      assert.equal(options.credentials,'omit');
      assert.equal(options.redirect,'error');
      requests.push(url.pathname);
      return send('u1',url.pathname,JSON.parse(options.body),{id:options.headers.Authorization.slice(7),
        app:options.headers['X-Firebase-AppCheck']});
    }};
  runInNewContext(source.replace(marker,'const workerOrigin = '+JSON.stringify(approved)+';'),
    {window,URL,AbortController,Date:class extends Date{static now(){return now;}}});
  const call=(name,data)=>window.SIPAPUA_QR_HTTP.call(name,data,{app:()=>({options:{}})},auth,auth.currentUser,()=>false,()=>'-');
  const issued=await call('getMyCardToken',{});
  auth.currentUser={getIdToken:async()=>token('u2')};
  const found=await call('lookupMemberCard',{token:issued.token});
  assert.equal(found.profile.nij,nij);
  assert.equal(found.verified,true);
  assert.deepEqual(requests,['/v1/issue','/v1/lookup']);
});

test('expired ID and App Check tokens stop at the Worker before the authority',async t=>{
  const {send,e}=fixture(t);
  e.QR_AUTHORITY={...e.QR_AUTHORITY,authorize:async()=>assert.fail('expired credentials reached authority')};
  const id=jwt({...base,exp:Math.floor(now/1000),auth_time:base.iat,sub:'u1',
    iss:'https://securetoken.google.com/'+project,aud:project,firebase:{sign_in_provider:'password'}});
  const app=jwt({...base,exp:Math.floor(now/1000),sub:appId,iss:'https://firebaseappcheck.googleapis.com/'+number,
    aud:['projects/'+number]});
  assert.equal((await send('u1','/v1/issue',{}, {id})).status,401);
  assert.equal((await send('u1','/v1/issue',{}, {app})).status,401);
});

test('authority outage fails closed without exposing errors or changing card state',async t=>{
  const {send,db,e}=fixture(t);
  const saved=await (await send('u1','/v1/issue')).json();
  const original=e.QR_AUTHORITY;
  e.QR_AUTHORITY={...original,owner:async()=>{throw new Error('private upstream detail');}};
  const lookup=await send('u2','/v1/lookup',{token:saved.token});
  assert.equal(lookup.status,503);
  assert.deepEqual(await lookup.json(),{error:'qr-dependency-unavailable'});
  assert.equal(db.prepare('SELECT consumed_at FROM cards').get().consumed_at,null);
  e.QR_AUTHORITY={...original,authorize:async()=>{throw new Error('private upstream detail');}};
  assert.equal((await send('u2','/v1/issue')).status,503);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cards').get().n,1);
});
