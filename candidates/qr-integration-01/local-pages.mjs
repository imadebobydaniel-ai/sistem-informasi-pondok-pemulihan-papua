import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {startDemo} from '../qr-fix-01/server.mjs';

const names=['menu.html','kartu-digital.html','qrcode.html','bio-singkat-jemaat.html','sipapua-member-card.js'];
const folder=new URL('./',import.meta.url);
const appRoot=new URL('../../',folder);
const rc=new URL('../qr-rc-02/frontend/',folder);
const vendor=new URL('../qr-fix-02-web/public/assets/',folder);
const approved='https://qr.integration-fixture.workers.dev';
const syntheticConfig='{apiKey:"demo-key",projectId:"demo-sipapua-qr-integration",appId:"demo-app"}';

export async function startPages({paused=false}={}) {
  const scratch=await mkdtemp(join(tmpdir(),'sipapua-qr-integration-pages-'));
  for(const file of names) await copyFile(new URL(file,appRoot),join(scratch,file));
  execFileSync('git',['apply','--ignore-space-change',fileURLToPath(new URL('application.patch',folder))],{cwd:scratch});
  const backend=await startDemo();
  const requests=[];
  let offline=false;
  const backendPost=async(path, data, headers={})=>fetch(backend.url+path,{
    method:'POST',redirect:'error',headers:{Origin:backend.url,'Content-Type':'application/json',...headers},body:data
  });
  const logins={};
  for(const identity of ['issuer','scanner']) {
    const response=await backendPost('/mock/login',JSON.stringify({identity}));
    if(!response.ok) throw Error('Synthetic login failed');
    logins[identity]=(await response.json()).idToken;
  }
  const firebaseStub=`
  (() => {
    const users=Object.fromEntries(Object.entries(${JSON.stringify(logins)}).map(([uid,token])=>[uid,{
      uid,isAnonymous:false,getIdToken:async()=>token
    }]));
    const auth={get currentUser(){return users[sessionStorage.getItem("fixture-role")||"issuer"];},
      onAuthStateChanged(callback){queueMicrotask(()=>callback(this.currentUser));return ()=>{};}};
    const options=${syntheticConfig};
    window.firebase={apps:[],initializeApp(config){
      if(config.projectId!==options.projectId)throw Error("Only synthetic config allowed");
      this.apps.push({options});
    },app(){return this.apps[0]},auth(){return auth;}};
    const fetchLocal=window.fetch.bind(window);
    window.fetch=(target,opts)=>{
      const base=${JSON.stringify(approved)};
      if(target===base+"/v1/issue" || target===base+"/v1/lookup") {
        if(opts.method!=="POST" || opts.redirect!=="error" || opts.credentials!=="omit" ||
           !opts.headers.Authorization || !opts.headers["X-Firebase-AppCheck"]) throw Error("Rejected adapter contract");
        return fetchLocal("/__worker"+target.slice(base.length),opts);
      }
      if(target==="/__fixture/attest")return fetchLocal(target,opts);
      throw Error("Unexpected request target");
    };
  })();`;
  const scannerStub=`
  window.Html5Qrcode=class {
    async start(camera, options, callback){ window.fixtureScan=async png=>{
      const im=await createImageBitmap(await (await fetchImage(png)).blob());
      const canvas=Object.assign(document.createElement("canvas"),{width:im.width,height:im.height});
      const ctx=canvas.getContext("2d");ctx.drawImage(im,0,0);
      const decoded=jsQR(ctx.getImageData(0,0,im.width,im.height).data,im.width,im.height);
      if(!decoded) throw Error("QR could not be decoded");
      await callback(decoded.data);
    }; }
    async stop(){}
  };
  async function fetchImage(png) {
    if(!png.startsWith("data:image/png;base64,"))throw Error("Expected synthetic PNG");
    return new Response(Uint8Array.from(atob(png.split(",")[1]),c=>c.charCodeAt(0)),{headers:{"Content-Type":"image/png"}});
  }`;
  function send(res,status,content,type='text/javascript') {
    res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store',
      'Content-Security-Policy':"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"});
    res.end(content);
  }
  async function html(file) {
    let src=await readFile(join(scratch,file),'utf8');
    src=src.replace(/const firebaseConfig\s*=\s*\{[^}]+\};/g,'const firebaseConfig = '+syntheticConfig+';');
    src=src.replace(/<script\b[^>]*\bsrc="https:[^"]+"[^>]*><\/script>/g,tag=>{
      if(tag.includes('qrcodejs/'))return '<script src="/fixture-qrcode.js"></script>';
      if(tag.includes('html5-qrcode'))return '<script src="/fixture-jsqr.js"></script><script src="/fixture-scanner.js"></script>';
      if(tag.includes('/firebase-app-compat.js'))return '<script src="/fixture-firebase.js"></script>';
      return '';
    });
    return src;
  }
  const server=createServer(async(req,res)=>{
    const path=req.url;
    requests.push({path,method:req.method});
    try {
      if(req.method==='POST' && ['/__fixture/attest','/__worker/v1/issue','/__worker/v1/lookup'].includes(path)){
        const chunks=[];
        for await(const part of req) chunks.push(part);
        if(offline && path.startsWith('/__worker/'))return send(res,503,'{}','application/json');
        const headers={Authorization:req.headers.authorization||''};
        if(path.startsWith('/__worker/')) headers['X-Firebase-AppCheck']=req.headers['x-firebase-appcheck']||'';
        const response=await backendPost(path==='/__fixture/attest'?'/mock/app-check':path.slice('/__worker'.length),Buffer.concat(chunks),headers);
        return send(res,response.status,await response.text(),'application/json');
      }
      if(req.method!=='GET')return send(res,404,'');
      const file=path?.slice(1);
      if(names.includes(file)) {
        if(file.endsWith('.html'))return send(res,200,await html(file),'text/html');
        return send(res,200,await readFile(join(scratch,file)));
      }
      if(file==='sipapua-maintenance.js') {
        // Kept in fixture HTTP routing, never written to the candidate or active app.
        return send(res,200,`window.SIPAPUA_MAINTENANCE={isPaused:name=>name==="memberCard"?${paused} : true,message:()=>"Maintenance fixture"};`);
      }
      if(file==='sipapua-app-check.js') return send(res,200,'window.SIPAPUA_APP_CHECK={configuration:{provider:"recaptcha-enterprise",siteKey:"demo-site"}};');
      if(file==='fixture-firebase.js')return send(res,200,firebaseStub);
      if(file==='fixture-scanner.js')return send(res,200,scannerStub);
      if(file==='fixture-qrcode.js')return send(res,200,await readFile(new URL('qrcode.js',vendor)));
      if(file==='fixture-jsqr.js')return send(res,200,await readFile(new URL('jsQR.js',vendor)));
      if(file==='sipapua-qr-http.js') {
        const source=await readFile(new URL(file,rc),'utf8');
        return send(res,200,source.replace('const workerOrigin = null;','const workerOrigin = '+JSON.stringify(approved)+';'));
      }
      if(file==='bootstrap.mjs') {
        const source=await readFile(new URL(file,rc),'utf8');
        return send(res,200,source.replace(/https:\/\/www\.gstatic\.com\/firebasejs\/12\.18\.0\//g,'/fixture-sdk-'));
      }
      if(file==='limited-app-check.mjs')return send(res,200,await readFile(new URL(file,rc)));
      if(file==='fixture-sdk-firebase-app.js')return send(res,200,'export const initializeApp=options=>options;');
      if(file==='fixture-sdk-firebase-app-check.js')return send(res,200,`
        export class ReCaptchaEnterpriseProvider {}
        export const initializeAppCheck=()=>({});
        export async function getLimitedUseToken() {
          const response=await fetch("/__fixture/attest",{
            method:"POST",headers:{Authorization:"Bearer "+await firebase.auth().currentUser.getIdToken()},body:"{}"
          });
          if(!response.ok)throw Error("Synthetic attestation denied");
          return response.json();
        }`);
      return send(res,404,'');
    } catch {return send(res,503,'{}','application/json');}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {url:'http://127.0.0.1:'+server.address().port,requests,setOffline(){offline=true;},async close(){
    await new Promise(resolve=>{
      server.close(resolve);
      server.closeAllConnections();
    });
    await backend.close();
  }};
}
