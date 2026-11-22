import {createServer} from 'node:http';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {withRecoveryEmulators} from '../recovery-3-features-01/emulators.mjs';

export async function startLacakPages(t) {
  const e=await withRecoveryEmulators(t);
  const s=e.firestore;
  const env=await e.init(e.baseRules); // The Lacak Domba fix leaves Rules untouched.
  const account=await e.identity('recovery-lacak');
  const uid=account.uid;
  const unguarded=fn=>env.withSecurityRulesDisabled(c=>fn(c.firestore()));
  async function set(path,data){return unguarded(db=>s.setDoc(s.doc(db,path),data));}
  async function get(path){
    let result;
    await unguarded(async db=>{result=(await s.getDoc(s.doc(db,path))).data();});
    return result;
  }
  await set('users/'+uid,{uid,nama:'Pencari Sintetis',status_akun:'Aktif'});
  await set('presence/'+uid,{legacyFlag:true,showOnline:false});
  await set('presence/fixture-visible',{discoverable:true,showOnline:false,displayName:'Tetangga Sintetis'});
  await set('presence/fixture-hidden',{discoverable:false,showOnline:false,displayName:'Profil Tersembunyi'});
  await set('presence/fixture-friend',{discoverable:true,showOnline:false,displayName:'Teman Sintetis'});
  await set('presence/fixture-incoming',{discoverable:true,showOnline:false,displayName:'Pengirim Sintetis'});
  await set('contacts/'+uid+'/friends/fixture-friend',{friendUid:'fixture-friend'});
  function pair(other){return 'friend_requests/'+[uid,other].sort().join('_');}
  await set(pair('fixture-incoming'),{fromUid:'fixture-incoming',toUid:uid,status:'pending'});
  const original=readFileSync(join(e.root,'lacak-domba.html'),'utf8');
  writeFileSync(join(e.scratch,'lacak-domba.html'),original);
  execFileSync('git',['apply','--ignore-space-change',join(e.root,'candidates/recovery-3-features-01/lacak-domba.patch')],{cwd:e.scratch});
  execFileSync('git',['apply','--ignore-space-change',join(e.root,'candidates/sipapua-production-recovery/lacak-relationships.patch')],{cwd:e.scratch});
  const patched=readFileSync(join(e.scratch,'lacak-domba.html'),'utf8');
  const fsOrigin='http://127.0.0.1:'+e.port;
  const scripts={
    'firebase-app.js':'firebase-app-compat.js','firebase-auth.js':'firebase-auth-compat.js',
    'firebase-firestore.js':'firebase-firestore-compat.js'
  };
  function fixtureHtml(html) {
    html=html.replace(/const firebaseConfig\s*=\s*\{[^}]+\};/,
      'const firebaseConfig = '+JSON.stringify({projectId:e.projectId,apiKey:'demo-key'})+';');
    html=html.replace(/<script\b[^>]*\bsrc="https:[^"]+"[^>]*><\/script>/g,tag=>{
      const name=Object.keys(scripts).find(key=>tag.includes('/'+key+'"'));
      return name?'<script src="/sdk/'+scripts[name]+'"></script>':'';
    });
    html=html.replace('    const db = firebase.firestore();',`    const db = firebase.firestore();
    auth.useEmulator(${JSON.stringify(e.authOrigin)},{disableWarnings:true});
    db.settings({experimentalForceLongPolling:true});
    db.useEmulator("127.0.0.1",${e.port});`);
    html=html.replace(/const SUPABASE_URL = "[^"]+";/,'const SUPABASE_URL = location.origin;');
    html=html.replace(/const SUPABASE_PUBLISHABLE_KEY = "[^"]+";/,'const SUPABASE_PUBLISHABLE_KEY = "demo-publishable";');
    return html;
  }
  let discovery={active:false};
  const actions=[];
  function send(res,code,body,type='application/json') {
    res.writeHead(code,{'Content-Type':type,'Cache-Control':'no-store',
      'Content-Security-Policy':"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' "+fsOrigin+" "+e.authOrigin+"; frame-ancestors 'none'"});
    res.end(body);
  }
  const server=createServer(async(req,res)=>{
    try {
      const path=req.url;
      if(req.method==='GET' && ['/', '/baseline','/candidate'].includes(path)) {
        return send(res,200,fixtureHtml(path==='/candidate'?patched:original),'text/html; charset=utf-8');
      }
      if(req.method==='GET' && Object.values(scripts).includes(path.slice('/sdk/'.length)) && path.startsWith('/sdk/')){
        return send(res,200,readFileSync(join(process.env.SIPAPUA_TEST_DEPS,'node_modules/firebase',path.slice(5))),'text/javascript');
      }
      if(req.method==='GET' && /^\/notification\/(core|components)\/[a-z-]+\.js$|^\/notification\/index\.js$/.test(path)) {
        return send(res,200,readFileSync(join(e.root,path.slice(1))),'text/javascript');
      }
      if(req.method!=='POST' || path!=='/functions/v1/lacak-domba-nearby') return send(res,404,'{}');
      const token=(req.headers.authorization||'').replace(/^Bearer /,'');
      const lookup=await fetch(e.authOrigin+'/identitytoolkit.googleapis.com/v1/accounts:lookup?key=demo-key',{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idToken:token})
      });
      const session=(await lookup.json()).users?.[0];
      if(!lookup.ok||session?.localId!==uid)return send(res,401,'{"error":"invalid_token"}');
      const chunks=[];
      for await(const part of req)chunks.push(part);
      const action=JSON.parse(Buffer.concat(chunks)).action;
      actions.push(action);
      if(action==='discovery_start'){
        const [presence,position]=await Promise.all([get('presence/'+uid),get('presence_locations/'+uid)]);
        if(!presence?.discoverable||!position)return send(res,403,'{"error":"discovery_not_ready"}');
        discovery={active:true,sessionId:'550e8400-e29b-41d4-a716-446655440000',expiresInMs:850000,
          expiresAt:new Date(Date.now()+850000).toISOString()};
      }
      if(action==='scan'){
        if(!await get('presence_locations/'+uid))return send(res,403,'{"error":"location_missing"}');
        const results=[];
        for(const id of ['fixture-visible','fixture-hidden','fixture-friend','fixture-incoming']){
          const data=await get('presence/'+id);
          if(data?.discoverable)results.push({uid:id,displayName:data.displayName,distanceRange:'< 1 KM'});
        }
        return send(res,200,JSON.stringify({discovery,results}));
      }
      return send(res,200,JSON.stringify({discovery}));
    }catch{return send(res,503,'{"error":"service_unavailable"}');}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {url:'http://127.0.0.1:'+server.address().port,email:account.email,actions,
    ownPresence:()=>get('presence/'+uid), ownLocation:()=>get('presence_locations/'+uid), request:other=>get(pair(other)),
    close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}
