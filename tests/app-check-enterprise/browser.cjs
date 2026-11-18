'use strict';
// Real Chrome + checksum-verified SDK. Every non-loopback request is BLOCKED.
// No account creation, callable invocation, emulator reset or real attestation.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {spawn}=require('node:child_process'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),delay=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
    const out=fs.mkdtempSync(path.join(__dirname,'_runtime-browser-'));
    const sdkRoot=path.join(__dirname,'_runtime-sdk'),manifest=JSON.parse(fs.readFileSync(path.join(sdkRoot,'manifest.json')));
    const sdk=new Map();for(const[name,hash]of Object.entries(manifest)){
        const file='firebase-'+name+'-compat.js',bytes=fs.readFileSync(path.join(sdkRoot,file));
        assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),hash);
        sdk.set('https://www.gstatic.com/firebasejs/12.18.0/'+file,bytes);
    }
    const report={sdkVersion:'12.18.0',checks:[],blockedRequests:[],backendRequests:0,
        realTokenAcquired:false,tokenStatus:'BLOCKED: external attestation intentionally unavailable in isolated harness',
        debugProviderUsed:false,productionMutations:0};
    const fixture='<!doctype html><html><body>'+[...sdk.keys()].map(url=>'<script src="'+url+'"></script>').join('')+
        '<script src="/sipapua-app-check.js"></script><script>firebase.initializeApp({apiKey:"demo-key",projectId:"demo-sipapua-enterprise",appId:"1:123456789012:web:synthetic"});window.tokenState="pending";SIPAPUA_APP_CHECK.prepare(firebase)().then(()=>{window.tokenState="unexpected-token"},()=>{window.tokenState="denied"});</script></body></html>';
    const pages=['registrasi.html','index.html','auth-handler.html','verify-success.html','edit-jemaat-administrator.html'];
    const allowed=new Set([...pages,'sipapua-app-check.js','sipapua-registration.js','sipapua-member-session.js','sipapua-login.js','sipapua-maintenance.js','menu-ui.js']);
    const server=http.createServer((req,res)=>{
        const file=new URL(req.url,'http://localhost').pathname.slice(1);
        if(file==='sdk-check.html'){res.setHeader('Content-Type','text/html');res.end(fixture);return;}
        if(!allowed.has(file)&&!/^assets\/wilayah\/v2\/(?:provinces\.json|(?:regencies|districts|villages)\/[0-9.]+\.json)$/.test(file)){res.writeHead(404).end();return;}
        const target=path.join(root,file);if(!fs.existsSync(target)){res.writeHead(404).end();return;}
        res.setHeader('Content-Type',file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.json')?'application/json':'application/javascript');res.end(fs.readFileSync(target));
    });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin='http://127.0.0.1:'+server.address().port;
    const chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',[
        '--headless=new','--disable-gpu','--disable-extensions','--disable-sync','--disable-background-networking','--disable-component-update',
        '--no-first-run','--no-default-browser-check','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
        '--remote-debugging-pipe','--no-startup-window','--user-data-dir='+path.join(out,'profile')
    ],{windowsHide:true,stdio:['ignore','ignore','pipe','pipe','pipe']});
    let sequence=0,buffer='',session,fatal,startError;const pending=new Map();
    chrome.on('error',e=>{startError=e;});chrome.stderr.pipe(fs.createWriteStream(path.join(out,'chrome-stderr.log')));
    function send(method,params={},sid){return new Promise((resolve,reject)=>{
        const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},15000);
        pending.set(id,{resolve,reject,timer});chrome.stdio[3].write(JSON.stringify({id,method,params,...(sid?{sessionId:sid}:{})})+'\0');
    });}
    chrome.stdio[3].on('error',()=>{});
    async function event(message){if(message.method!=='Fetch.requestPaused')return;
        const p=message.params,url=p.request.url,sid=message.sessionId;
        if(sdk.has(url)){await send('Fetch.fulfillRequest',{requestId:p.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/javascript'}],body:sdk.get(url).toString('base64')},sid);return;}
        const parsed=new URL(url);
        if(parsed.origin===origin){await send('Fetch.continueRequest',{requestId:p.requestId},sid);return;}
        // Record path only: never store token query parameters or request bodies.
        report.blockedRequests.push(parsed.origin+parsed.pathname);
        if(/cloudfunctions\.net$|firestore\.googleapis\.com$|identitytoolkit\.googleapis\.com$|securetoken\.googleapis\.com$/.test(parsed.hostname))report.backendRequests++;
        await send('Fetch.failRequest',{requestId:p.requestId,errorReason:'BlockedByClient'},sid);
    }
    chrome.stdio[4].on('data',bytes=>{buffer+=bytes;let at;while((at=buffer.indexOf('\0'))>=0){
        const raw=buffer.slice(0,at);buffer=buffer.slice(at+1);if(!raw)continue;const message=JSON.parse(raw);
        if(message.id){const p=pending.get(message.id);if(p){pending.delete(message.id);clearTimeout(p.timer);message.error?p.reject(Error(message.error.message)):p.resolve(message.result);}}
        else event(message).catch(e=>{fatal=e.message;});
    }});
    async function evaluate(expression){const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},session);if(result.exceptionDetails)throw Error(result.exceptionDetails.text);return result.result.value;}
    async function until(expression){for(let i=0;i<100;i++){if(fatal||startError)throw Error(fatal||startError.message);try{if(await evaluate(expression))return;}catch(_){}await delay(100);}throw Error('Browser condition timed out: '+expression);}
    async function check(name,fn){await fn();report.checks.push({name,status:'PASS'});console.log('PASS '+name);}
    // Test harness only: bind default apps to a demo project before application code runs.
    const bind='Object.defineProperty(window,"firebase",{configurable:true,get(){return undefined},set(sdk){Object.defineProperty(window,"firebase",{value:sdk,writable:true,configurable:true});const original=sdk.initializeApp;sdk.initializeApp=function(config,name){return original.call(sdk,{apiKey:"demo-key",projectId:"demo-sipapua-enterprise",authDomain:"localhost",appId:"1:123456789012:web:synthetic"},name)}}});';
    try{
        report.browser=(await send('Browser.getVersion')).product;
        const target=await send('Target.createTarget',{url:'about:blank'});
        session=(await send('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId;
        await send('Page.enable',{},session);await send('Runtime.enable',{},session);await send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]},session);
        await send('Page.addScriptToEvaluateOnNewDocument',{source:bind},session);
        await check('official compat SDK exports all namespaced APIs and Enterprise provider',async()=>{
            await send('Page.navigate',{url:origin+'/sdk-check.html'},session);
            await until('typeof window.tokenState==="string"');
            assert.equal(await evaluate('firebase.SDK_VERSION'),'12.18.0');
            assert.ok(await evaluate('typeof firebase.auth==="function" && typeof firebase.firestore.FieldValue.serverTimestamp==="function" && typeof firebase.app().functions("asia-southeast2").httpsCallable==="function" && typeof firebase.appCheck.ReCaptchaEnterpriseProvider==="function"'));
        });
        await check('real Enterprise script is requested; blocked attestation never yields a token',async()=>{
            for(let i=0;i<50&&!report.blockedRequests.some(url=>url.includes('/recaptcha/enterprise.js'));i++)await delay(100);
            assert.ok(report.blockedRequests.some(url=>url.includes('/recaptcha/enterprise.js')));
            assert.notEqual(await evaluate('window.tokenState'),'unexpected-token');
            report.blockedTokenState=await evaluate('window.tokenState');
            assert.ok(!report.blockedRequests.some(url=>url.includes('/recaptcha/api.js')));
        });
        await check('actual registration page initializes compat and preserves form and geography',async()=>{
            await send('Page.navigate',{url:origin+'/registrasi.html'},session);
            await until('typeof registrationFunctions!=="undefined" && document.getElementById("provinsi").options.length===39');
            assert.equal(await evaluate('firebase.SDK_VERSION'),'12.18.0');assert.ok(await evaluate('!!document.getElementById("formRegistrasi")'));
        });
        await check('actual registration callable remains blocked without attestation',async()=>{
            const state=await evaluate('Promise.race([registrationFunctions.httpsCallable("registrationReadiness")({code:"ABE"}).then(()=>"unexpected",()=>"denied"),new Promise(resolve=>setTimeout(()=>resolve("waiting-for-attestation"),1000))])');
            assert.ok(['denied','waiting-for-attestation'].includes(state));report.registrationGateState=state;
            assert.equal(report.backendRequests,0);
        });
        await check('actual login page initializes compat and retains existing login form',async()=>{
            await send('Page.navigate',{url:origin+'/index.html'},session);
            await until('typeof memberLogin!=="undefined" && !!document.getElementById("userLoginForm")');
            assert.equal(await evaluate('firebase.SDK_VERSION'),'12.18.0');assert.equal(await evaluate('auth.currentUser'),null);
        });
        assert.equal(report.backendRequests,0);report.status='PASS_SCOPED_BROWSER';
    }catch(error){report.status='FAIL';report.reason=fatal||error.message;process.exitCode=1;}
    finally{
        try{await send('Browser.close');}catch(_){if(chrome.exitCode===null)chrome.kill();}
        server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
        for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Browser test closed'));}pending.clear();
        const receipt=path.join(root,'docs/app-check-enterprise/BROWSER-RESULTS.json');fs.writeFileSync(receipt,JSON.stringify(report,null,2)+'\n');
        console.log(JSON.stringify({status:report.status,checks:report.checks.length,realTokenAcquired:false,backendRequests:report.backendRequests,reason:report.reason||report.tokenStatus}));
    }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
