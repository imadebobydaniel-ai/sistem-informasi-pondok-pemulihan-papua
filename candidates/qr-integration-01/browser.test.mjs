import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {startPages} from './local-pages.mjs';

async function until(check, label) {
  for (let i=0;i<100;i++) {
    try { const value=await check(); if (value) return value; }
    catch (error) { if (!/execution context|navigat/i.test(error.message)) throw error; }
    await sleep(100);
  }
  throw Error('Timeout: '+label);
}

test('patched SIPAPUA card renders Worker QR, scanner opens verified bio and rejects replay',{timeout:40000},async t=>{
  const executable=process.env.SIPAPUA_QR_CHROME;
  assert.ok(executable,'Set SIPAPUA_QR_CHROME to the installed Chrome executable');
  const demo=await startPages();
  const profile=await mkdtemp(join(tmpdir(),'sipapua-qr-fix-chrome-'));
  const browser=spawn(executable,['--headless','--disable-gpu','--disable-background-networking',
    '--disable-component-update','--disable-sync','--no-first-run',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',
    '--user-data-dir='+profile,demo.url+'/kartu-digital.html'],{windowsHide:true,stdio:'ignore'});
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
  await until(()=>js('typeof bukaKartuDigital==="function" && Boolean(window.SIPAPUA_QR_LIMITED_APP_CHECK)'),'Kartu Digital scripts');
  await js('document.querySelector(".icon-btn").click()');
  await until(()=>js('Boolean(document.querySelector("#qrcode canvas"))'),'QR canvas in actual card area');
  assert.equal(await js('document.querySelector("#cardModal").style.display'),'flex');
  assert.deepEqual(await js('["d-nama","d-nij","d-komsel"].map(id=>document.getElementById(id).textContent)'),
    ['Penerbit Sintetis','NIJ-PPP-ABE-001-2026','Komsel Demo']);
  const png=await js('document.querySelector("#qrcode canvas").toDataURL("image/png")');
  assert.match(png,/^data:image\/png;base64,/);
  await js('sessionStorage.setItem("fixture-role","scanner")');
  async function scan() {
    await command('Page.navigate',{url:demo.url+'/qrcode.html'});
    await until(()=>js('location.pathname==="/qrcode.html" && typeof fixtureScan==="function"'),'original QR scanner callback');
    await js(`{ void fixtureScan(${JSON.stringify(png)}); true }`);
    await until(()=>js('location.pathname==="/bio-singkat-jemaat.html" && document.readyState==="complete"'),'original bio navigation');
  }
  await scan();
  await until(()=>js('document.querySelector("#popupBio")?.style.display==="block"'),'verified bio visible');
  assert.deepEqual(await js('["p-nama","p-nij","p-komsel"].map(id=>document.getElementById(id).textContent)'),
    ['Penerbit Sintetis','NIJ-PPP-ABE-001-2026','Komsel Demo']);
  assert.equal(await js('document.querySelector("#btnAdd")'),null);
  assert.equal(await js('sessionStorage.getItem("sipapua_pending_card_scan")'),null);
  await scan();
  await until(()=>js('document.querySelector("#msg-error")?.style.display==="block"'),'replay denied');
  assert.match(await js('document.querySelector("#errorText").textContent'),/tidak ditemukan|kedaluwarsa/);
  assert.equal(await js('document.querySelector("#popupBio").style.display'),'');
  await command('Page.navigate',{url:demo.url+'/kartu-digital.html'});
  await until(()=>js('location.pathname==="/kartu-digital.html" && Boolean(window.SIPAPUA_QR_LIMITED_APP_CHECK)'),'card for expiry');
  // Advance only the visible card's timer. The Worker expiry boundary has its own test.
  await js(`(() => {
    const timer=window.setTimeout;
    window.setTimeout=(fn,ms,...args)=>timer(fn,ms>290000 && ms<=300000 ? 500 : ms,...args);
    document.querySelector(".icon-btn").click();
  })()`);
  await until(()=>js('Boolean(document.querySelector("#qrcode canvas"))'),'second card renders');
  await until(()=>js('/QR kedaluwarsa/.test(document.querySelector("#qrcode").textContent)'),'expired QR removed');
  assert.equal(await js('document.querySelector("#qrcode canvas")'),null);
  demo.setOffline();
  await command('Page.navigate',{url:demo.url+'/kartu-digital.html'});
  await until(()=>js('location.pathname==="/kartu-digital.html" && typeof bukaKartuDigital==="function"'),'card after outage');
  await js('document.querySelector(".icon-btn").click()');
  await until(()=>js('/Layanan QR tidak tersedia/.test(document.querySelector("#qrcode")?.textContent)'),'dependency outage displayed');
  assert.equal(await js('document.querySelector("#qrcode canvas")'),null);
  assert.equal(demo.requests.filter(r=>r.path==='/__worker/v1/issue').length,3);
  assert.equal(demo.requests.filter(r=>r.path==='/__worker/v1/lookup').length,2);
  assert.equal(demo.requests.filter(r=>r.path==='/__fixture/attest').length,5);

  const held=await startPages({paused:true});
  t.after(()=>held.close());
  await command('Page.navigate',{url:held.url+'/kartu-digital.html'});
  await until(()=>js(`location.origin===${JSON.stringify(held.url)} && typeof bukaKartuDigital==="function"`),'maintenance card');
  await js('document.querySelector(".icon-btn").click()');
  assert.equal(await js('document.querySelector("#qrcode").textContent'),'Maintenance fixture');
  await command('Page.navigate',{url:held.url+'/qrcode.html'});
  await until(()=>js('document.querySelector(".scanner-container [role=status]")?.textContent==="Maintenance fixture"'),'maintenance scanner');
  assert.equal(await js('typeof fixtureScan'),'undefined');
  assert.equal(held.requests.some(r=>r.method==='POST'),false);
});
