import {createServer} from 'node:http';
import {generateKeyPairSync, createSign, randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {handle} from '../qr-zero-cost-final/src/worker.mjs';
import {createQrAuthority} from '../qr-rc-02/src/authority.mjs';

const project = 'sipapua-qr-stg-synthetic';
const number = '123456789012';
const appId = '1:123456789012:web:synthetic';
const workerOrigin = 'https://qr-fixture.invalid';
const profiles = new Map([
  ['issuer', {uid:'issuer', nama:'Penerbit Sintetis', nij:'NIJ-PPP-ABE-001-2026', komsel:'Komsel Demo', status_akun:'Aktif'}],
  ['scanner', {uid:'scanner', nama:'Pemindai Sintetis', nij:'NIJ-PPP-ABE-002-2026', komsel:'Komsel Demo', status_akun:'Aktif'}]
]);
const assets = new Map([
  ['/', ['index.html','text/html']],
  ['/demo.js', ['demo.js','text/javascript']],
  ['/assets/qrcode.js', ['assets/qrcode.js','text/javascript']],
  ['/assets/jsQR.js', ['assets/jsQR.js','text/javascript']]
]);
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');

export async function startDemo({port=0}={}) {
  const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const key={...publicKey.export({format:'jwk'}),kid:'fixture',use:'sig',alg:'RS256'};
  const sessions=new Map(), minted=new Set(), consumed=new Set(), disabled=new Set(), revoked=new Set();
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../qr-zero-cost-final/schema.sql',import.meta.url),'utf8'));
  const DB={prepare(sql){
    const stmt=db.prepare(sql);
    return {bind:(...args)=>({first:async()=>stmt.get(...args),run:async()=>stmt.run(...args)})};
  }};
  function sign(claims) {
    const fields=b64({alg:'RS256',typ:'JWT',kid:key.kid})+'.'+b64(claims);
    return fields+'.'+createSign('RSA-SHA256').update(fields).sign(privateKey).toString('base64url');
  }
  function login(uid) {
    const iat=Math.floor(Date.now()/1000);
    const claims={uid,sub:uid,auth_time:iat,iat,exp:iat+3600,jti:randomUUID(),
      iss:'https://securetoken.google.com/'+project,aud:project,firebase:{sign_in_provider:'password'}};
    const idToken=sign(claims);
    sessions.set(idToken,claims);
    return {idToken};
  }
  function attest() {
    const iat=Math.floor(Date.now()/1000);
    const token=sign({iat,exp:iat+60,jti:randomUUID(),sub:appId,
      iss:'https://firebaseappcheck.googleapis.com/'+number,aud:['projects/'+number]});
    minted.add(token);
    return {token};
  }
  function account(idToken) {
    const session=sessions.get(idToken);
    if (!session || disabled.has(session.uid) || revoked.has(session.uid) || session.exp<=Date.now()/1000) {
      throw Object.assign(Error('Synthetic session denied'),{code:'auth/invalid-id-token'});
    }
    return session;
  }
  function readDoc(path) {
    const [collection,uid]=path.split('/');
    const member=profiles.get(uid);
    if (!member) return;
    if (collection==='users') return member;
    if (collection==='nij_allocations') return {uid,nij:member.nij};
  }
  const authority=createQrAuthority({
    expectedAppId:appId,
    auth:{
      async verifyIdToken(token,checkRevoked) {
        if (checkRevoked!==true) throw Error('Revocation check required');
        return account(token);
      },
      async getUser(uid) {
        if (!profiles.has(uid)) throw Object.assign(Error(),{code:'auth/user-not-found'});
        return {uid,disabled:disabled.has(uid),tokensValidAfterTime:new Date(revoked.has(uid)?Date.now()+1000:0).toISOString()};
      }
    },
    firestore:{doc:path=>path,async getAll(...paths){return paths.map(path=>({data:()=>readDoc(path)}));}},
    appCheck:{async verifyToken(token,options) {
      if (options.consume!==true || !minted.has(token)) throw Object.assign(Error(),{code:'app-check/invalid-token'});
      const alreadyConsumed=consumed.has(token);
      consumed.add(token);
      return {appId,alreadyConsumed};
    }}
  });
  const env={DB,QR_AUTHORITY:authority,QR_INGRESS:{limit:async()=>({success:true})},
    FIREBASE_PROJECT_ID:project,FIREBASE_PROJECT_NUMBER:number,FIREBASE_APP_ID:appId,ALLOWED_ORIGIN:workerOrigin};
  async function mockFetch(url,options) {
    if (url==='https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com' ||
        url==='https://firebaseappcheck.googleapis.com/v1/jwks') return Response.json({keys:[key]});
    const base='https://firestore.googleapis.com/v1/projects/'+project+'/databases/(default)/documents/';
    if (!url.startsWith(base)) throw Error('Unexpected dependency');
    const path=url.slice(base.length);
    const uid=path.split('/')[1];
    const bearer=options.headers.Authorization.slice(7);
    let user;
    try { user=account(bearer); } catch { return new Response(null,{status:403}); }
    if (user.uid!==uid) return new Response(null,{status:403});
    const data=readDoc(path);
    if (!data) return new Response(null,{status:404});
    return Response.json({fields:Object.fromEntries(Object.entries(data).map(([field,value])=>[field,{stringValue:value}]))});
  }
  function reply(res,status,body) {
    res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});
    res.end(JSON.stringify(body));
  }
  const server=createServer(async (req,res)=>{
    try {
      const host='127.0.0.1:'+server.address().port;
      if (req.headers.host!==host) return reply(res,403,{error:'loopback-only'});
      const asset=assets.get(req.url);
      if (req.method==='GET' && asset) {
        const data=readFileSync(new URL('./'+asset[0],import.meta.url));
        res.writeHead(200,{'Content-Type':asset[1],'Cache-Control':'no-store','Referrer-Policy':'no-referrer',
          'Content-Security-Policy':"default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' data: blob:; base-uri 'none'; frame-ancestors 'none'"});
        return res.end(data);
      }
      if (req.method!=='POST' || req.headers.origin!=='http://'+host ||
          !['/mock/login','/mock/app-check','/v1/issue','/v1/lookup'].includes(req.url)) return reply(res,404,{error:'not-found'});
      const chunks=[];
      let size=0;
      for await (const chunk of req) {
        size+=chunk.length;
        if (size>2048) return reply(res,413,{error:'too-large'});
        chunks.push(chunk);
      }
      const body=Buffer.concat(chunks).toString('utf8');
      if (req.url==='/mock/login') {
        const uid=JSON.parse(body).identity;
        return profiles.has(uid)?reply(res,200,login(uid)):reply(res,403,{error:'fixture-only'});
      }
      if (req.url==='/mock/app-check') {
        try { account((req.headers.authorization||'').slice(7)); }
        catch { return reply(res,401,{error:'invalid-session'}); }
        return reply(res,200,attest());
      }
      const request=new Request(workerOrigin+req.url,{method:'POST',body,headers:{
        Origin:workerOrigin,'CF-Connecting-IP':'192.0.2.20','Content-Type':req.headers['content-type']||'',
        Authorization:req.headers.authorization||'','X-Firebase-AppCheck':req.headers['x-firebase-appcheck']||''
      }});
      const response=await handle(request,env,{fetcher:mockFetch});
      res.writeHead(response.status,{'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(await response.text());
    } catch { if (!res.headersSent) reply(res,503,{error:'fixture-unavailable'}); else res.end(); }
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {url:'http://127.0.0.1:'+server.address().port,async close(){
    await new Promise(resolve=>server.close(resolve));
    db.close();
  }};
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const demo=await startDemo();
  console.log(demo.url);
}
