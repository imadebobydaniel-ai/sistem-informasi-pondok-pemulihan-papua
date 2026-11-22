import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {createServer} from 'node:http';

async function serveDemo() {
  const root=new URL('./public/',import.meta.url);
  const routes=new Map([
    ['/', ['index.html','text/html']],
    ['/scanner.html',['scanner.html','text/html']],
    ['/demo.css',['demo.css','text/css']],
    ...['card.mjs','scanner.mjs','demo-core.mjs','assets/qrcode.js','assets/jsQR.js']
      .map(name=>['/'+name,[name,'text/javascript']])
  ]);
  const requests=[];
  const server=createServer(async(req,res)=>{
    requests.push({method:req.method,url:req.url});
    const asset=routes.get(req.url);
    if (!asset || req.method!=='GET') { res.writeHead(404); return res.end(); }
    try {
      const bytes=await readFile(new URL(asset[0],root));
      res.writeHead(200,{'Content-Type':asset[1]});
      res.end(bytes);
    } catch { res.writeHead(500);res.end(); }
  });
  await new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',resolve);
  });
  return {url:'http://127.0.0.1:'+server.address().port,requests,
    close:()=>new Promise(resolve=>server.close(resolve))};
}

async function until(check, label) {
  for (let i=0;i<100;i++) {
    const value=await check();
    if (value) return value;
    await sleep(100);
  }
  throw Error('Timeout: '+label);
}

test('static QR renders and synthetic camera decodes it without backend requests',async t=>{
  const executable=process.env.SIPAPUA_QR_CHROME;
  assert.ok(executable,'Set SIPAPUA_QR_CHROME to the installed Chrome executable');
  const demo=await serveDemo();
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
  const requests=[];
  const queue=new Map();
  ws.addEventListener('message',event=>{
    const result=JSON.parse(event.data);
    if (result.method==='Network.requestWillBeSent') requests.push(result.params.request.url);
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
    if (value.exceptionDetails) throw Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
    return value.result.value;
  }
  const status=()=>js('document.querySelector("#status").textContent');
  await command('Network.enable',{});
  await until(()=>js('document.readyState==="complete" && typeof document.querySelector("#issue")?.onclick==="function"'),'card module');
  await js('document.querySelector("#issue").click()');
  await until(async()=>await status()==='QR demo siap dipindai.','rendered card');
  const image=await js('document.querySelector("#qr canvas").toDataURL("image/png")');
  assert.match(image,/^data:image\/png;base64,/);
  await command('Page.navigate',{url:demo.url+'/scanner.html'});
  await until(()=>js('document.readyState==="complete" && typeof jsQR==="function" && typeof document.querySelector("#camera")?.onclick==="function"'),'scanner module');
  assert.equal(await js('isSecureContext && typeof navigator.mediaDevices?.getUserMedia==="function"'),true);
  await js(`(async()=>{
    const bytes=Uint8Array.from(atob(${JSON.stringify(image.split(',')[1])}),c=>c.charCodeAt(0));
    const bitmap=await createImageBitmap(new Blob([bytes],{type:"image/png"}));
    const source=Object.assign(document.createElement("canvas"),{width:bitmap.width,height:bitmap.height});
    const ctx=source.getContext("2d");
    window.requestedCamera=[];
    window.tracks=[];
    window.BarcodeDetector=undefined;
    navigator.mediaDevices.getUserMedia=async settings=>{
      window.requestedCamera.push(settings);
      ctx.drawImage(bitmap,0,0);
      const stream=source.captureStream(10);
      const track=stream.getVideoTracks()[0];
      window.tracks.push(track);
      const frame=setInterval(()=>{
        if (track.readyState==="ended") clearInterval(frame);
        else ctx.drawImage(bitmap,0,0);
      },80);
      return stream;
    };
  })()`);
  const scan=()=>js('document.querySelector("#camera").click()');
  await scan();
  await until(async()=>await status()==='Identitas sintetis cocok.','QR decoded from simulated camera PNG');
  assert.deepEqual(await js('window.requestedCamera[0]'),{audio:false,video:{facingMode:{ideal:'environment'}}});
  assert.deepEqual(await js('["name","nij","group"].map(id=>document.getElementById(id).textContent)'),
    ['Nara Demo','DEMO-NIJ-001','Komsel Demo']);
  assert.equal(await js('window.tracks[0].readyState'),'ended');
  const launchNativeMock=payload=>js(`(() => {
    window.BarcodeDetector=class {
      static async getSupportedFormats(){return ["qr_code"];}
      async detect(){return [{rawValue:${JSON.stringify(payload)}}];}
    };
  })()`);
  await launchNativeMock('SIPAPUA-STATIC-DEMO-V1:sample-001:'+(Date.now()-1000));
  await scan();
  await until(async()=>await status()==='QR demo kedaluwarsa.','expired payload declined');
  await launchNativeMock('SIPAPUA-CARD '+'A'.repeat(43));
  await scan();
  await until(async()=>await status()==='Format QR tidak valid untuk demo.','non-demo format declined');
  await js('navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException("Denied","NotAllowedError")};');
  await scan();
  await until(async()=>/Izin kamera ditolak/.test(await status()),'permission denied safely');
  assert.equal(await js('document.querySelector("#preview").srcObject'),null);
  assert.equal(await js('document.querySelector("#profile").hidden'),true);
  assert.ok(requests.length>0);
  assert.ok(requests.every(value=>{
    const url=new URL(value);
    return url.protocol==='data:' || url.origin===demo.url;
  }),'Browser requested a resource outside the static demo origin');
  assert.ok(demo.requests.every(record=>record.method==='GET'));
});
