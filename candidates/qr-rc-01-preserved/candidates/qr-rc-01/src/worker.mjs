// SIPAPUA QR Worker Free candidate. NOT PRODUCTION-READY.
// No Firebase service account or privileged Firestore access.
const AUTH_JWKS = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const APP_JWKS = 'https://firebaseappcheck.googleapis.com/v1/jwks';
const TOKEN_RE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const NIJ_RE = /^NIJ-PPP-(ABE|STN|DYO|ARS1|ARS2)-[0-9]{3,9}-[0-9]{4}$/;
const CORS_HEADERS = 'Content-Type, Authorization, X-Firebase-AppCheck';
const LIFETIME_MS = 5 * 60_000;
const WINDOW_MS = 60_000;
const GLOBAL_LIMIT = 60;
const MEMBER_LIMIT = 6;
const COOLDOWN_MS = 15_000;
const MAX_BODY_BYTES = 2048;
const CLEANUP_BATCH = 100;

function problem(status, code) { return new Response(JSON.stringify({ error: code }), {status, headers: {'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}}); }
function responseJson(data, status=200) { return new Response(JSON.stringify(data), {status, headers: {'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}}); }
function decodePart(part) {
  if (!/^[A-Za-z0-9_-]+$/.test(part) || part.length > 15000) throw Error('bad-jwt');
  const raw = atob(part.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(part.length/4)*4,'='));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(raw, x=>x.charCodeAt(0))));
}
function bytes(part) {
  const raw = atob(part.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(part.length/4)*4,'='));
  return Uint8Array.from(raw, x=>x.charCodeAt(0));
}
function b64url(buffer) { return btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,''); }
async function sha256(text) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(x=>x.toString(16).padStart(2,'0')).join(''); }

const jwksCache = new Map();
async function verifyJwt(token, endpoint, issuer, audience, now, fetcher=fetch) {
  if (typeof token !== 'string' || token.length>10000) throw Error('missing-token');
  const p=token.split('.'); if (p.length!==3 || p.some(part=>!part || !/^[A-Za-z0-9_-]+$/.test(part) || b64url(bytes(part))!==part)) throw Error('malformed-token');
  const header=decodePart(p[0]), claims=decodePart(p[1]);
  if(header.alg!=='RS256'||header.typ!=='JWT'||typeof header.kid!=='string') throw Error('invalid-header');
  let set=jwksCache.get(endpoint);
  if(!set || set.expires<now) {
    const res=await fetcher(endpoint, {redirect:'error'});
    if(!res.ok) throw Error('jwks-unavailable');
    const json=await res.json(); if(!Array.isArray(json.keys)) throw Error('bad-jwks');
    set={keys:json.keys,expires:now+3600_000}; jwksCache.set(endpoint,set);
  }
  const key=set.keys.find(k=>k.kid===header.kid&&k.kty==='RSA'&&k.use==='sig'&&(k.alg==null||k.alg==='RS256'));
  if(!key) throw Error('unknown-key');
  const publicKey=await crypto.subtle.importKey('jwk',key,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
  const signature=bytes(p[2]);
  if(!await crypto.subtle.verify('RSASSA-PKCS1-v1_5',publicKey,signature,new TextEncoder().encode(p[0]+'.'+p[1]))) throw Error('invalid-signature');
  if(claims.iss!==issuer || !(Array.isArray(claims.aud)?claims.aud.includes(audience):claims.aud===audience)) throw Error('wrong-project');
  const seconds=Math.floor(now/1000);
  if(!Number.isInteger(claims.exp)||claims.exp<=seconds||!Number.isInteger(claims.iat)||claims.iat>seconds+30||claims.iat<0) throw Error('token-expired');
  if(typeof claims.sub!=='string'||claims.sub.length<1||claims.sub.length>256) throw Error('invalid-subject');
  return claims;
}

function parseFirestoreValue(item) {
  if(item?.stringValue!==undefined) return item.stringValue;
  if(item?.integerValue!==undefined) return Number(item.integerValue);
  if(item?.booleanValue!==undefined) return item.booleanValue;
  return null;
}
async function getDoc(env, identityToken, path, fetcher=fetch) {
  const url=`https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
  const res=await fetcher(url,{headers:{Authorization:`Bearer ${identityToken}`},redirect:'error'});
  if(res.status===403||res.status===401||res.status===404) throw Error('firestore-access-denied');
  if(!res.ok) throw Error('firestore-unavailable');
  const doc=await res.json();
  const result={};for(const [key,value] of Object.entries(doc.fields||{})) result[key]=parseFirestoreValue(value);
  return result;
}
async function memberProfile(env, idToken, uid, fetcher=fetch) {
  // Canonical profile and NIJ allocation are mandatory. If current Firestore Rules
  // disallow either read, reject. Never use service-account bypasses.
  const profile=await getDoc(env,idToken,`users/${encodeURIComponent(uid)}`,fetcher);
  const allocation=await getDoc(env,idToken,`nij_allocations/${encodeURIComponent(uid)}`,fetcher);
  if(profile.status_akun!=='Aktif'||profile.uid!==uid||
    allocation.uid!==uid||allocation.nij!==profile.nij||!NIJ_RE.test(allocation.nij)) throw Error('identity-not-verified');
  return {nij:allocation.nij,nama:String(profile.nama||profile.nama_lengkap||'').slice(0,120),
    komsel:String(profile.komsel||'').slice(0,80)};
}
function assertConfig(env){
  if(!env.DB||typeof env.QR_INGRESS?.limit!=='function'||typeof env.QR_AUTHORITY?.authorize!=='function'||typeof env.QR_AUTHORITY?.owner!=='function'||env.FIREBASE_PROJECT_ID!=='boby-apps-project'||env.FIREBASE_PROJECT_NUMBER!=='125984859692'||
    typeof env.FIREBASE_APP_ID!=='string'||!/^1:125984859692:web:[a-zA-Z0-9]+$/.test(env.FIREBASE_APP_ID)||
    typeof env.ALLOWED_ORIGIN!=='string'||new URL(env.ALLOWED_ORIGIN).origin!==env.ALLOWED_ORIGIN||!env.ALLOWED_ORIGIN.startsWith('https://')) throw Error('configuration-incomplete');
}
async function authenticate(request,env,now,fetcher=fetch){
  const authHeader=request.headers.get('Authorization')||'';
  const idToken=/^Bearer ([A-Za-z0-9_.-]+)$/.exec(authHeader)?.[1];
  const appToken=request.headers.get('X-Firebase-AppCheck');
  const id=await verifyJwt(idToken,AUTH_JWKS,`https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,env.FIREBASE_PROJECT_ID,now,fetcher);
  const app=await verifyJwt(appToken,APP_JWKS,`https://firebaseappcheck.googleapis.com/${env.FIREBASE_PROJECT_NUMBER}`,`projects/${env.FIREBASE_PROJECT_NUMBER}`,now,fetcher);
  if(app.sub!==env.FIREBASE_APP_ID) throw Error('wrong-app');
  if(!Number.isSafeInteger(id.auth_time)||id.auth_time<1||id.auth_time>id.iat||!id.firebase?.sign_in_provider||id.firebase.sign_in_provider==='anonymous') throw Error('anonymous-denied');
  return {uid:id.sub,idToken,appToken,authTime:id.auth_time};
}
function cors(env,origin,headers){if(origin===env.ALLOWED_ORIGIN){headers.set('Access-Control-Allow-Origin',origin);headers.set('Vary','Origin');}return headers;}
async function readPayload(request) {
  if (!request.body) throw Error('invalid-json');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', {fatal:true});
  let size = 0, raw = '';
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw Error('too-large');
      raw += decoder.decode(value, {stream:true});
    }
    return JSON.parse(raw + decoder.decode());
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function deleteExpiredCards(db, now = Date.now()) {
  return db.prepare('DELETE FROM cards WHERE rowid IN (SELECT rowid FROM cards WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)')
    .bind(now, CLEANUP_BATCH).run();
}
async function sweep(db, now = Date.now()) {
  await deleteExpiredCards(db, now);
  await db.prepare('DELETE FROM qr_budget WHERE rowid IN (SELECT rowid FROM qr_budget WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)')
    .bind(now, CLEANUP_BATCH).run();
}
async function reserve(db, scope, key, now, limit) {
  const expiry = (Math.floor(now / WINDOW_MS) + 1) * WINDOW_MS;
  return !!(await db.prepare(`INSERT INTO qr_budget(scope, subject, expires_at, used) VALUES(?,?,?,1)
    ON CONFLICT(scope, subject, expires_at) DO UPDATE SET used=used+1 WHERE used < ? RETURNING used`)
    .bind(scope,key,expiry,limit).first());
}
function validProfile(value) {
  return value && typeof value.nij==='string' && NIJ_RE.test(value.nij) &&
    typeof value.nama==='string' && value.nama.length<=120 &&
    typeof value.komsel==='string' && value.komsel.length<=80;
}

export async function handle(request, env, helpers={}) {
  const fetcher=helpers.fetcher||fetch;
  const now=helpers.now??Date.now();
  const origin=request.headers.get('Origin');
  try{assertConfig(env);}catch{return problem(503,'not-configured');}
  if(origin!==env.ALLOWED_ORIGIN) return problem(403,'origin-not-allowed');
  const url = new URL(request.url);
  const path = url.pathname;
  const fail = (status,code) => withCors(problem(status,code),env,origin);
  if(url.search || !['/v1/issue','/v1/lookup'].includes(path)) return fail(404,'not-found');
  const peer = request.headers.get('CF-Connecting-IP');
  if (!peer || !/^[0-9a-f:.]{3,45}$/i.test(peer)) return fail(403,'ingress-required');
  try {
    if ((await env.QR_INGRESS.limit({key:peer})).success !== true) return fail(429,'rate-limit');
  } catch { return fail(503,'ingress-unavailable'); }
  if(request.method==='OPTIONS') {
    if(request.headers.get('Access-Control-Request-Method')!=='POST') return fail(405,'method-not-allowed');
    const allowed=CORS_HEADERS.toLowerCase().split(', ');
    if((request.headers.get('Access-Control-Request-Headers')||'').split(',').some(h=>h.trim()&&!allowed.includes(h.trim().toLowerCase()))) return fail(400,'invalid-headers');
    return new Response(null,{status:204,headers:cors(env,origin,new Headers({'Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':CORS_HEADERS,'Access-Control-Max-Age':'300'}))});
  }
  if(request.method!=='POST')return fail(405,'method-not-allowed');
  if(request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json')return fail(415,'invalid-content-type');
  if(Number(request.headers.get('Content-Length')||'0')>MAX_BODY_BYTES)return fail(413,'too-large');
  let identity;
  try {identity=await authenticate(request,env,now,fetcher);} catch {return withCors(problem(401,'invalid-credentials'),env,origin);}
  let data;
  try { data=await readPayload(request); }
  catch(error) { return withCors(error.message==='too-large' ? problem(413,'too-large') : problem(400,'invalid-json'),env,origin); }
  if(!data||typeof data!=='object'||Array.isArray(data))return withCors(problem(400,'invalid-payload'),env,origin);
  const issue=path==='/v1/issue';
  if(issue ? Object.keys(data).length!==0 : Object.keys(data).length!==1||typeof data.token!=='string'||!TOKEN_RE.test(data.token)) {
    return fail(400,'invalid-payload');
  }
  try {
    if (!await reserve(env.DB,'global','qr',now,GLOBAL_LIMIT) ||
        !await reserve(env.DB,'member',await sha256(identity.uid),now,MEMBER_LIMIT)) return fail(429,'quota');
    const authorization = await env.QR_AUTHORITY.authorize({
      idToken:identity.idToken, appToken:identity.appToken, uid:identity.uid,
      authTime:identity.authTime, appId:env.FIREBASE_APP_ID
    });
    if (authorization?.allowed !== true) return fail(401,'invalid-or-consumed-credentials');
    if (authorization.uid!==identity.uid || authorization.authTime!==identity.authTime ||
        authorization.appId!==env.FIREBASE_APP_ID) return fail(503,'authority-mismatch');
    const profile=await memberProfile(env,identity.idToken,identity.uid,fetcher);
    if(issue) {
      const token=b64url(crypto.getRandomValues(new Uint8Array(32)));
      const tokenHash=await sha256(token);
      const expiresAt=now+LIFETIME_MS;
      const saved=await env.DB.prepare(`INSERT INTO cards(uid, token_hash, issued_at, expires_at, auth_time)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(uid) DO UPDATE SET token_hash=excluded.token_hash, issued_at=excluded.issued_at,
       expires_at=excluded.expires_at, auth_time=excluded.auth_time, consumed_at=NULL
       WHERE cards.issued_at <= excluded.issued_at - ?
       RETURNING uid`).bind(identity.uid,tokenHash,now,expiresAt,identity.authTime,COOLDOWN_MS).first();
      if(!saved)return fail(429,'cooldown');
      return withCors(responseJson({token,expiresAt,profile}),env,origin);
    }

    const tokenHash=await sha256(data.token);
    const card=await env.DB.prepare('SELECT uid,auth_time,expires_at FROM cards WHERE token_hash=? AND consumed_at IS NULL AND expires_at>?')
      .bind(tokenHash,now).first();
    if(!card||card.uid===identity.uid)return fail(404,'card-not-found');
    const owner=await env.QR_AUTHORITY.owner({uid:card.uid,authTime:card.auth_time});
    if(owner?.active!==true||owner.uid!==card.uid||owner.authTime!==card.auth_time||!validProfile(owner.profile))return fail(404,'card-not-found');
    const usedAt=helpers.now??Date.now();
    const consumed=await env.DB.prepare('UPDATE cards SET consumed_at=? WHERE token_hash=? AND uid=? AND auth_time=? AND consumed_at IS NULL AND expires_at>? RETURNING uid')
      .bind(usedAt,tokenHash,card.uid,card.auth_time,usedAt).first();
    if(!consumed)return fail(404,'card-not-found');
    const {nij,nama,komsel}=owner.profile;
    return withCors(responseJson({profile:{nij,nama,komsel},verified:true}),env,origin);
  }catch(error){return error?.message==='identity-not-verified'||error?.message==='firestore-access-denied'
    ? fail(403,'identity-not-verified') : fail(503,'qr-dependency-unavailable');}
}
function withCors(response,env,origin){const headers=cors(env,origin,new Headers(response.headers));return new Response(response.body,{status:response.status,headers});}
export default {
  fetch:handle,
  scheduled(_event, env, context) { context.waitUntil(sweep(env.DB)); }
};
export const internal={verifyJwt,sha256,memberProfile};
