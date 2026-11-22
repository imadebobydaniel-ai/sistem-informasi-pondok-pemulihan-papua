import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {startDemo} from './server.mjs';

async function until(check, label) {
  for (let i=0;i<100;i++) {
    const value=await check();
    if (value) return value;
    await sleep(100);
  }
  throw Error('Timeout: '+label);
}

test('Chrome renders and decodes QR, rejects replay, removes expired QR and reports outages',async t=>{
  const executable=process.env.SIPAPUA_QR_CHROME;
  assert.ok(executable,'Set SIPAPUA_QR_CHROME to the installed Chrome executable');
  const demo=await startDemo();
  t.after(()=>demo.close());
  const profile=await mkdtemp(join(tmpdir(),'sipapua-qr-fix-chrome-'));
  const browser=spawn(executable,['--headless','--disable-gpu','--disable-background-networking',
    '--disable-component-update','--disable-sync','--no-first-run',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',
    '--user-data-dir='+profile,demo.url],{windowsHide:true,stdio:'ignore'});
  let launchError;
  browser.on('error',error=>{launchError=error;});
  t.after(()=>browser.kill());
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
    queue.set(id,response=>response.error?reject(Error(response.error.message)):resolve(response.result));
    ws.send(JSON.stringify({id,method,params}));
  });
  async function js(expression) {
    const value=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if (value.exceptionDetails) throw Error(value.exceptionDetails.text);
    return value.result.value;
  }
  const status=()=>js('document.querySelector("#status").textContent');
  await until(()=>js('document.readyState==="complete" && typeof jsQR==="function"'),'offline QR assets');
  await js('document.querySelector("#member").click()');
  await until(async()=>await status()==='Sesi sintetis aktif.','issuer login');
  await js('document.querySelector("#issue").click()');
  await until(async()=>await status()==='QR siap dipindai.','QR issuance');
  assert.match(await js('document.querySelector("#profile").textContent'),/Penerbit Sintetis.*NIJ-PPP-ABE-001-2026.*Komsel Demo/);
  const image=await js('document.querySelector("#qr canvas").toDataURL("image/png")');
  assert.match(image,/^data:image\/png;base64,/);
  await js('document.querySelector("#scanner").click()');
  await until(async()=>await status()==='Sesi sintetis aktif.','scanner login');
  async function scan() {
    await js(`(async()=>{
      const bytes=Uint8Array.from(atob(${JSON.stringify(image.split(',')[1])}), c=>c.charCodeAt(0));
      const transfer=new DataTransfer();
      transfer.items.add(new File([bytes],"synthetic.png",{type:"image/png"}));
      const input=document.querySelector("#scan");
      input.files=transfer.files;
      input.dispatchEvent(new Event("change"));
    })()`);
  }
  await scan();
  await until(async()=>await status()==='Kartu terverifikasi.','image decoded and owner verified');
  assert.match(await js('document.querySelector("#profile").textContent'),/Penerbit Sintetis.*NIJ-PPP-ABE-001-2026.*Komsel Demo/);
  await scan();
  await until(async()=>/sudah dipakai/.test(await status()),'replay rejected');
  assert.equal(await js('document.querySelector("#profile").textContent'),'');
  // Accelerate only the UI timer. The Worker expiry boundary is tested separately.
  await js(`(() => {
    const timer = window.setTimeout;
    window.setTimeout = (fn, delay, ...args) =>
      timer(fn, delay > 290000 && delay <= 300000 ? 200 : delay, ...args);
    document.querySelector("#issue").click();
  })()`);
  await until(async()=>/QR kedaluwarsa/.test(await status()),'expired QR removed');
  assert.equal(await js('document.querySelector("#qr").children.length'),0);
  await js(`(() => {
    const localFetch = window.fetch;
    window.fetch = (path, options) => path === "/v1/issue"
      ? Promise.reject(new TypeError("Simulated disconnection"))
      : localFetch(path, options);
    document.querySelector("#issue").click();
  })()`);
  await until(async()=>await status()==='Layanan QR tidak tersedia.','clear outage message');
  assert.equal(await js('document.querySelector("#qr").children.length'),0);
});
