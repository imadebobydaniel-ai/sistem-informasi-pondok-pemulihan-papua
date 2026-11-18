'use strict';
// Actual main pages + checksum-verified official SDK, with emulator binding only
// in the isolated browser harness. App Check configuration is NOT replaced.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'../..');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
module.exports=async function browserCheck({ports,project,email,password,out}){
    fs.mkdirSync(out,{recursive:true});
    const sdkRoot=path.resolve(root,'../SIPAPUA-REG-INTEGRATION-CANDIDATE');
    const sdkManifest=JSON.parse(fs.readFileSync(path.join(sdkRoot,'local-sdk-manifest.json')));
    const sdk=new Map();
    for(const [name,entry]of Object.entries(sdkManifest.files)){
        const bytes=fs.readFileSync(path.join(sdkRoot,sdkManifest.directory,name));
        if(crypto.createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw Error('SDK checksum mismatch');
        sdk.set('https://www.gstatic.com/firebasejs/8.10.1/'+name,bytes);
    }
    const allowedFiles=new Set(['registrasi.html','index.html','menu.html','sipapua-maintenance.js','sipapua-registration.js','sipapua-app-check.js','sipapua-member-session.js','sipapua-login.js','menu-ui.js']);
    const server=http.createServer((req,res)=>{
        let route;try{route=decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\//,'');}catch(_){res.writeHead(400).end();return;}
        if(!allowedFiles.has(route)&&!/^assets\/wilayah\/v2\/(?:provinces\.json|(?:regencies|districts|villages)\/[0-9.]+\.json)$/.test(route)){res.writeHead(404).end();return;}
        const file=path.join(root,route);if(!fs.existsSync(file)){res.writeHead(404).end();return;}
        res.setHeader('Content-Type',route.endsWith('.html')?'text/html; charset=utf-8':route.endsWith('.json')?'application/json':'application/javascript');res.end(fs.readFileSync(file));
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin='http://127.0.0.1:'+server.address().port;
    const report={kind:'real Chrome, main pages and official SDK; emulator-only initialization',tests:[],blockedExternal:[],productionFirebaseRequests:0,positiveAppCheckFlow:'BLOCKED: legitimate site key/domain configuration unavailable'};
    const chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',[
        '--headless=new','--disable-gpu','--disable-extensions','--disable-sync','--disable-background-networking','--disable-component-update','--disable-default-apps',
        '--no-first-run','--no-default-browser-check','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
        '--remote-debugging-pipe','--no-startup-window','--user-data-dir='+path.join(out,'profile')
    ],{windowsHide:true,stdio:['ignore','ignore','pipe','pipe','pipe']});
    let sequence=0,buffer='',session,fatal;
    const pending=new Map(),sessions=new Map();
    chrome.stderr.pipe(fs.createWriteStream(path.join(out,'chrome-stderr.log')));
    function send(method,params={},sid){return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},12000);pending.set(id,{resolve,reject,timer});chrome.stdio[3].write(JSON.stringify({id,method,params,...(sid?{sessionId:sid}:{})})+'\0');});}
    chrome.stdio[3].on('error',()=>{});
    const bind='Object.defineProperty(window,"firebase",{configurable:true,get(){return undefined;},set(sdk){Object.defineProperty(window,"firebase",{value:sdk,writable:true,configurable:true});const original=sdk.initializeApp;sdk.initializeApp=function(config,name){const app=original.call(sdk,{apiKey:"demo-key",projectId:'+JSON.stringify(project)+',authDomain:"'+project+'.firebaseapp.com"},name);app.auth().useEmulator("http://127.0.0.1:'+ports.auth+'",{disableWarnings:true});app.firestore().useEmulator("127.0.0.1",'+ports.firestore+');app.functions("asia-southeast2").useEmulator("127.0.0.1",'+ports.functions+');return app;};}});';
    async function event(m){const p=m.params||{},sid=m.sessionId;
        if(m.method==='Target.attachedToTarget'){
            await send('Network.enable',{},p.sessionId);await send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]},p.sessionId);
            await send('Page.enable',{},p.sessionId);await send('Runtime.enable',{},p.sessionId);
            await send('Page.addScriptToEvaluateOnNewDocument',{source:bind},p.sessionId);
            await send('Runtime.runIfWaitingForDebugger',{},p.sessionId);sessions.set(p.targetInfo.targetId,p.sessionId);
        }
        if(m.method==='Fetch.requestPaused'){
            const url=p.request.url;
            if(sdk.has(url)){await send('Fetch.fulfillRequest',{requestId:p.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/javascript'}],body:sdk.get(url).toString('base64')},sid);return;}
            const u=new URL(url),allowed=u.hostname==='127.0.0.1'&&[Number(new URL(origin).port),...Object.values(ports)].includes(Number(u.port));
            if(allowed){await send('Fetch.continueRequest',{requestId:p.requestId},sid);return;}
            report.blockedExternal.push(u.origin+u.pathname);
            if((["identitytoolkit.googleapis.com","securetoken.googleapis.com","firestore.googleapis.com","firebaseappcheck.googleapis.com","firebaseinstallations.googleapis.com"].includes(u.hostname)||/firebaseio\.com$|firebaseapp\.com$/.test(u.hostname))){report.productionFirebaseRequests++;fatal='Unexpected non-emulator Firebase request was blocked';}
            await send('Fetch.failRequest',{requestId:p.requestId,errorReason:'BlockedByClient'},sid);
        }
        if(m.method==='Page.javascriptDialogOpening')await send('Page.handleJavaScriptDialog',{accept:true},sid);
    }
    chrome.stdio[4].on('data',bytes=>{buffer+=bytes;let i;while((i=buffer.indexOf('\0'))>=0){const raw=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!raw)continue;const m=JSON.parse(raw);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}}else event(m).catch(e=>{fatal=e.message;});}});
    chrome.on('error',e=>{fatal='Browser startup '+e.code;});
    chrome.on('exit',code=>{report.browserExit=code;for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Owned browser exited'));}pending.clear();});
    async function evaluate(expression){const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},session);if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
    async function until(expression){for(let i=0;i<80;i++){if(fatal)throw Error(fatal);try{if(await evaluate(expression))return;}catch(_){}await delay(100);}throw Error('Browser condition timed out: '+expression);}
    async function test(name,fn){try{await fn();if(fatal)throw Error(fatal);report.tests.push({name,status:'PASS'});}catch(e){report.tests.push({name,status:'BLOCKED',reason:e.message});throw e;}}
    try{
        await test('signed installed Chrome renderer and network interception',async()=>{
            report.browser=await send('Browser.getVersion');
            const target=await send('Target.createTarget',{url:'about:blank'});
            const attached=await send('Target.attachToTarget',{targetId:target.targetId,flatten:true});session=attached.sessionId;
            await send('Network.enable',{},session);await send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]},session);
            await send('Page.enable',{},session);await send('Runtime.enable',{},session);
            await send('Page.addScriptToEvaluateOnNewDocument',{source:bind},session);
            if(await evaluate('1+1')!==2)throw Error('Renderer evaluation failed');
        });
        await test('actual registration and national address/birthplace dropdowns',async()=>{
            await send('Page.navigate',{url:origin+'/registrasi.html'},session);await until('typeof firebase!=="undefined" && typeof loadKota==="function" && document.getElementById("provinsi").options.length===39');
            await evaluate('document.getElementById("provinsi").value="94";loadKota()');await evaluate('document.getElementById("kota").value="94.01";loadKecamatan()');await evaluate('document.getElementById("kecamatan").value="94.01.01";loadDesa()');
            if(!await evaluate('[...document.getElementById("desa").options].some(x=>x.text==="Wonorejo")'))throw Error('National dropdown failed');
            await evaluate('document.getElementById("provinsi_lahir").value="18";loadKota("lahir")');
        });
        await test('actual Simpatisan fields clear and readiness fails closed without site key',async()=>{
            await evaluate('document.getElementById("jabatan_jemaat").value="Anggota Jemaat";updateSubJabatan();document.getElementById("sub_jabatan").value="Jemaat Simpatisan";updateSpesifikPelayanan();document.getElementById("lokasi").value="ABE";updateKomsel()');
            if(!await evaluate('document.getElementById("pelayanan").disabled && document.getElementById("pelayanan_spesifik_non").value===""'))throw Error('Simpatisan contract failed');
            await until('document.getElementById("nij-display").value.includes("belum siap")');
        });
        await test('actual login uses synthetic Auth emulator identity but refuses authorization without App Check',async()=>{
            await send('Page.navigate',{url:origin+'/index.html'},session);await until('typeof auth!=="undefined" && typeof confirmLogin==="function"');
            await evaluate('document.getElementById("user_email").value='+JSON.stringify(email)+';document.getElementById("user_pass").value='+JSON.stringify(password)+';document.getElementById("userLoginForm").dispatchEvent(new Event("submit",{cancelable:true,bubbles:true}))');
            await until('auth.currentUser!==null && document.getElementById("btnMasuk").disabled===false');
            if(await evaluate('localStorage.getItem("userUid")')!==null)throw Error('App Check was bypassed');
        });
    }catch(e){report.reason=fatal||e.message;}
    finally{
        try{await send('Browser.close');}catch(_){if(chrome.exitCode===null)chrome.kill();}
        server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
        report.status='BLOCKED'; // Full positive flow requires legitimate App Check.
        fs.writeFileSync(path.join(out,'BROWSER-RESULTS.json'),JSON.stringify(report,null,2));
    }
    console.log('BROWSER '+JSON.stringify({status:report.status,tests:report.tests,reason:report.reason||report.positiveAppCheckFlow}));
    return report;
};
