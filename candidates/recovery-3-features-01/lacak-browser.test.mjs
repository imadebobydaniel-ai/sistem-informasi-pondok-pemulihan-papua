import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {startLacakPages} from './lacak-pages.mjs';

async function until(check, label) {
  for (let i=0;i<100;i++) {
    try { const value=await check(); if (value) return value; }
    catch (error) { if (!/execution context|navigat/i.test(error.message)) throw error; }
    await sleep(100);
  }
  throw Error('Timeout: '+label);
}

test('Lacak Domba restores Auth, repairs legacy presence, asks location, scans, and disables on logout',{timeout:90000},async t=>{
  const executable=process.env.SIPAPUA_QR_CHROME;
  assert.ok(executable,'Set SIPAPUA_QR_CHROME to the installed Chrome executable');
  const demo=await startLacakPages(t);
  const profile=await mkdtemp(join(tmpdir(),'sipapua-qr-fix-chrome-'));
  const browser=spawn(executable,['--headless','--disable-gpu','--disable-background-networking',
    '--disable-component-update','--disable-sync','--no-first-run',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',
    '--user-data-dir='+profile,demo.url+'/baseline'],{windowsHide:true,stdio:'ignore'});
  let launchError;
  browser.on('error',error=>{launchError=error;});
  t.after(async()=>{browser.kill();await demo.close();});
  const port=await until(async()=>{
    if (launchError) throw launchError;
    try { return (await readFile(join(profile,'DevToolsActivePort'),'utf8')).split(/\r?\n/)[0]; }
    catch { return null; }
  },'Chrome debugging port');
  const page=await until(async()=>{
    const pages=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
    return pages.find(item=>item.type==='page' && item.url.startsWith(demo.url));
  },'demo page');
  const ws=new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{
    ws.addEventListener('open',resolve,{once:true});
    ws.addEventListener('error',reject,{once:true});
  });
  t.after(()=>ws.close());
  let sequence=0;
  const queue=new Map();
  ws.addEventListener('message',event=>{
    const result=JSON.parse(event.data);
    if (!queue.has(result.id)) return;
    queue.get(result.id)(result);
    queue.delete(result.id);
  });
  const command=(method,params)=>new Promise((resolve,reject)=>{
    const id=++sequence;
    const timeout=setTimeout(()=>{queue.delete(id);reject(Error("DevTools timed out: "+method));},6000);
    queue.set(id,response=>{
      clearTimeout(timeout);
      if(response.error) reject(Error(response.error.message));
      else resolve(response.result);
    });
    ws.send(JSON.stringify({id,method,params}));
  });
  async function js(expression) {
    const value=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if (value.exceptionDetails) throw Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
    return value.result.value;
  }
  await until(()=>js('typeof auth!=="undefined" && typeof firebase.auth().signInWithEmailAndPassword==="function"'),'baseline SDK');
  assert.equal(await js('document.querySelector("#scanButton").disabled'),true);
  await js(`auth.signInWithEmailAndPassword(${JSON.stringify(demo.email)},"Synthetic-only-42!").then(()=>true)`);
  await until(()=>js('/Presence belum dapat dimuat/.test(document.querySelector("#statusScan").textContent)'),'baseline presence failure');
  assert.equal(await js('document.querySelector("#scanButton").disabled'),true);
  assert.equal((await demo.ownPresence()).legacyFlag,true);
  assert.equal(await demo.ownLocation(),undefined);

  await command('Page.navigate',{url:demo.url+'/candidate'});
  await until(()=>js('location.pathname==="/candidate" && document.querySelector("#scanButton")?.disabled===false'),'restored Auth and enabled controls');
  const repaired=await demo.ownPresence();
  assert.equal(repaired.legacyFlag,undefined);
  assert.equal(repaired.discoverable,false);
  assert.equal(repaired.showOnline,false);
  assert.equal(await demo.ownLocation(),undefined);
  await command('Browser.grantPermissions',{origin:demo.url,permissions:['geolocation']});
  await command('Emulation.setGeolocationOverride',{latitude:-1,longitude:131,accuracy:20});
  await js(`(() => {
    const get=navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
    window.fixtureLocationRequests=0;
    navigator.geolocation.getCurrentPosition=(...args)=>{window.fixtureLocationRequests++; return get(...args);};
    document.querySelector("#discoverableToggle").click();
  })()`);
  await until(()=>js('/Bisa Ditemukan aktif/.test(document.querySelector("#discoveryNotice")?.textContent || "") || (document.querySelector("#discoverableToggle")?.checked && !document.querySelector("#discoverableToggle")?.disabled)'),'opt-in acknowledged');
  assert.equal((await demo.ownPresence()).discoverable,true);
  assert.equal(await js('window.fixtureLocationRequests'),1);
  const coords=await demo.ownLocation();
  assert.equal(coords.latitude,-1);
  assert.equal(coords.longitude,131);
  await js('document.querySelector("#scanButton").click()');
  await until(()=>js('/Tetangga Sintetis/.test(document.querySelector("#nearbyResults").textContent)'),'nearby result');
  assert.doesNotMatch(await js('document.querySelector("#nearbyResults").textContent'),/Profil Tersembunyi/);
  assert.ok(demo.actions.includes('discovery_start') && demo.actions.includes('scan'));
  await js('auth.signOut().then(()=>true)');
  await until(()=>js('["scanButton","discoverableToggle","showOnlineToggle","radiusSelect"].every(id=>document.getElementById(id)?.disabled)'),'logout controls disabled');
  assert.doesNotMatch(await js('document.querySelector("#nearbyResults").textContent'),/Tetangga Sintetis/);
});
