'use strict';
// Isolated local Chrome CDP; no attachment to personal profiles, Network capture,
// cookies, Auth login, token export, Firestore writes or configuration mutations.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const SITE='https://imadebobydaniel-ai.github.io/sistem-informasi-pondok-pemulihan-papua/index.html';
const PROBE_SHA='e436c16aef562e30c36fc174429c7db1f7c8baac4c1c91b2b02abb3457fe61a0';
const CATEGORIES=new Set(['PASS','REGISTRY_NOT_FOUND','ORIGIN_AND_APP_FAILED','OFFICIAL_SDK_LOAD_FAILED','ENTERPRISE_ATTESTATION_FAILED','CLIENT_SERVER_READ_FAILED']);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function probeExpression(source){
  if(crypto.createHash('sha256').update(source).digest('hex')!==PROBE_SHA)throw Error('REVIEWED_PROBE_HASH_MISMATCH');
  const marker='console.log(JSON.stringify(result));';
  if(source.split(marker).length!==2)throw Error('REVIEWED_PROBE_HASH_MISMATCH');
  // Return ONLY the already sanitized result rather than writing to DevTools.
  return source.replace(marker,'return result;');
}
function sanitize(value){
  if(!value||typeof value.enterpriseToken!=='boolean'||typeof value.clientServerRead!=='boolean'||value.productionDataWrites!==0||!CATEGORIES.has(value.category))throw Error('PROBE_RESULT_INVALID');
  return {enterpriseToken:value.enterpriseToken,clientServerRead:value.clientServerRead,productionDataWrites:0,category:value.category};
}
function ownedProfile(profile){
  return path.dirname(path.resolve(profile))===path.resolve(os.tmpdir())&&path.basename(profile).startsWith('sipapua-appcheck-cdp-');
}
function localSocket(url,port){
  const u=new URL(url);return u.protocol==='ws:'&&u.hostname==='127.0.0.1'&&u.port===String(port)&&u.pathname.startsWith('/devtools/page/');
}
async function connect(url){
  const socket=new WebSocket(url);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',()=>reject(Error('LOCAL_DEBUGGER_UNAVAILABLE')),{once:true});});
  let id=0;const pending=new Map();
  socket.addEventListener('message',event=>{
    let message;try{message=JSON.parse(event.data);}catch{return;}
    const waiter=pending.get(message.id);if(!waiter)return;
    pending.delete(message.id);clearTimeout(waiter.timer);
    if(message.error)waiter.reject(Error('CDP_COMMAND_FAILED'));else waiter.resolve(message.result);
  });
  socket.addEventListener('close',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('LOCAL_DEBUGGER_CLOSED'));}pending.clear();});
  return {close:()=>socket.close(),send:(method,params={},timeout=60000)=>new Promise((resolve,reject)=>{
    if(!['Runtime.evaluate','Browser.close'].includes(method))return reject(Error('CDP_METHOD_NOT_ALLOWED'));
    const key=++id,timer=setTimeout(()=>{pending.delete(key);reject(Error('BROWSER_PROBE_TIMEOUT'));},timeout);
    pending.set(key,{resolve,reject,timer});socket.send(JSON.stringify({id:key,method,params}));
  })};
}
async function main(){
  const report={checkedAt:new Date().toISOString(),status:'BLOCKED',enterpriseToken:false,clientServerRead:false,productionDataWrites:0,tokensExported:false,isolatedBrowserProfile:true};
  let browser,profile,cdp;
  try{
    if(process.argv.length!==2||process.platform!=='win32')throw Error('LOCAL_BROWSER_CONFIGURATION_UNSUPPORTED');
    const expression=probeExpression(fs.readFileSync(path.join(root,'docs/activation-restoration/enterprise-browser-readonly.js'),'utf8'));
    const executable=[path.join(process.env.ProgramFiles||'C:/Program Files','Google/Chrome/Application/chrome.exe'),path.join(process.env['ProgramFiles(x86)']||'C:/Program Files (x86)','Microsoft/Edge/Application/msedge.exe')].find(p=>fs.existsSync(p));
    if(!executable)throw Error('LOCAL_BROWSER_NOT_FOUND');
    profile=fs.mkdtempSync(path.join(os.tmpdir(),'sipapua-appcheck-cdp-'));
    if(!ownedProfile(profile))throw Error('PROFILE_BOUNDARY_REJECTED');
    browser=spawn(executable,['--user-data-dir='+profile,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--no-first-run','--no-default-browser-check',SITE],{windowsHide:true,stdio:'ignore'});
    let launchError=false;browser.on('error',()=>{launchError=true;});
    const activePort=path.join(profile,'DevToolsActivePort');let port;
    for(let i=0;i<80;i++){
      if(launchError||browser.exitCode!==null)throw Error('LOCAL_BROWSER_START_FAILED');
      if(fs.existsSync(activePort)){port=Number(fs.readFileSync(activePort,'utf8').split(/\r?\n/)[0]);break;}await pause(250);
    }
    if(!Number.isInteger(port)||port<1||port>65535)throw Error('LOCAL_DEBUGGER_UNAVAILABLE');
    const targetResponse=await fetch('http://127.0.0.1:'+port+'/json/list',{redirect:'error',signal:AbortSignal.timeout(5000)});
    const targets=targetResponse.ok?await targetResponse.json():[];
    const page=targets.find(p=>p.type==='page'&&p.url===SITE);
    if(!page||!localSocket(page.webSocketDebuggerUrl,port))throw Error('OFFICIAL_PAGE_NOT_AVAILABLE');
    cdp=await connect(page.webSocketDebuggerUrl);
    let ready=false;
    for(let i=0;i<80;i++){
      const state=await cdp.send('Runtime.evaluate',{expression:'location.href === '+JSON.stringify(SITE)+' && !!globalThis.firebase?.apps?.length',returnByValue:true},5000);
      if(state.result?.value===true){ready=true;break;}await pause(250);
    }
    if(!ready)throw Error('OFFICIAL_PAGE_SDK_NOT_READY');
    const evaluated=await cdp.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:false});
    if(evaluated.exceptionDetails)throw Error('BROWSER_PROBE_EXECUTION_FAILED');
    Object.assign(report,sanitize(evaluated.result?.value));
    if(report.enterpriseToken&&report.clientServerRead&&report.category==='PASS')report.status='PASS';
  }catch(error){
    // Never serialize CDP messages, exceptions, stdout, page objects or tokens.
    const known=new Set(['REVIEWED_PROBE_HASH_MISMATCH','LOCAL_BROWSER_CONFIGURATION_UNSUPPORTED','LOCAL_BROWSER_NOT_FOUND','PROFILE_BOUNDARY_REJECTED','LOCAL_BROWSER_START_FAILED','LOCAL_DEBUGGER_UNAVAILABLE','OFFICIAL_PAGE_NOT_AVAILABLE','OFFICIAL_PAGE_SDK_NOT_READY','CDP_COMMAND_FAILED','LOCAL_DEBUGGER_CLOSED','BROWSER_PROBE_TIMEOUT','BROWSER_PROBE_EXECUTION_FAILED','PROBE_RESULT_INVALID']);
    report.category=known.has(error.message)?error.message:'LOCAL_BROWSER_CHECK_UNAVAILABLE';
  }finally{
    try{if(cdp)await cdp.send('Browser.close',{},3000);}catch{}
    try{cdp?.close();}catch{}
    if(browser&&browser.exitCode===null){await pause(500);if(browser.exitCode===null)browser.kill();}
    if(profile&&ownedProfile(profile)){
      try{await fs.promises.rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:300});report.temporaryProfileRemoved=true;}
      catch{report.temporaryProfileRemoved=false;}
    }
    fs.writeFileSync(path.join(root,'docs/activation-restoration/APP-CHECK-LOCAL-BROWSER-RESULT.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
  }
}
module.exports={probeExpression,sanitize,ownedProfile,localSocket,SITE};
if(require.main===module)main().catch(()=>{console.log('APP_CHECK_BLOCKED_NO_RAW_DETAILS');process.exitCode=1;});
