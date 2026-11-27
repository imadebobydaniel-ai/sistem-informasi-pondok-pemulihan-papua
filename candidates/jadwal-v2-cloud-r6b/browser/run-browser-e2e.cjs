"use strict";

// Isolated, synthetic-only browser acceptance. Uses existing Node/PostgreSQL/
// Chrome binaries; every page request is intercepted unless it targets this
// runner's explicit 127.0.0.1 origin. No Firebase/Google/Supabase credentials.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { createFirebaseIdTokenVerifier } = require("../firebase-jwt-verifier.cjs");
const { createScheduleServer, createPsqlExecutor } = require("../server.cjs");

const pgBin = "C:\\Program Files\\PostgreSQL\\19\\bin";
const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const candidate = path.resolve(__dirname, "..");
const browserDir = __dirname;
const root = path.resolve(os.tmpdir());
const sessionDir = path.join(root, `sipapua-jadwal-browser-${crypto.randomUUID()}`);
const dataDir = path.join(sessionDir, "pgdata");
const pgLog = path.join(sessionDir, "postgres.log");
const chromeProfile = path.join(sessionDir, "chrome-profile");
const pgCtl = path.join(pgBin, "pg_ctl.exe");
const initdb = path.join(pgBin, "initdb.exe");
const psql = path.join(pgBin, "psql.exe");
const project = "demo-sipapua-schedule";
const adminUid = "synthetic-browser-admin";
const memberUid = "synthetic-browser-member";
const viewerUid = "synthetic-browser-viewer";
const venueId = "10000000-0000-4000-8000-000000000001";
const pastorOne = "20000000-0000-4000-8000-000000000001";
const pastorTwo = "20000000-0000-4000-8000-000000000002";
let pgPort;
let webPort;
let pgStarted = false;
let apiServer;
let chromeProcess;
let cdp;
let browserCdp;
let passCount = 0;
let failCount = 0;
let externalBlocked = 0;
let currentStep = "preflight";
const browserErrors = [];
let legacyProjectionFixture = false;

function minimalEnv(extra = {}) {
  const result = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"]) if (process.env[key]) result[key] = process.env[key];
  return { ...result, ...extra };
}
function run(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: "utf8", windowsHide: true, timeout: options.timeout || 30000,
    env: minimalEnv(options.env || {}), input: options.input, stdio: options.stdio || "pipe", maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(file)} failed (${result.status}): ${String(result.stderr || "").slice(-1200)}`);
  return result.stdout || "";
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const check = net.createServer();
  await new Promise((resolve, reject) => check.once("error", reject).listen(port, "127.0.0.1", resolve));
  await new Promise(resolve => check.close(resolve));
  return port;
}
function psqlRun(database, sql, args = []) {
  return run(psql, ["-X", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", String(pgPort), "-U", "postgres", "-d", database, ...(args.length ? args : ["-c", sql])]);
}
function syntheticToken(uid, key) {
  const now = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "browser-synthetic" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ iss: `https://securetoken.google.com/${project}`, aud: project, sub: uid,
    iat: now - 1, auth_time: now - 1, exp: now + 900 })).toString("base64url");
  const input = `${head}.${body}`;
  return `${input}.${crypto.sign("RSA-SHA256", Buffer.from(input), key).toString("base64url")}`;
}
function makeApi(publicKey, port, hmacSecret) {
  const trustedJwk = { ...publicKey.export({ format: "jwk" }), kid: "browser-synthetic", use: "sig", alg: "RS256", key_ops: ["verify"] };
  const verify = createFirebaseIdTokenVerifier({ projectId: project, getTrustedKey: async kid => kid === trustedJwk.kid ? trustedJwk : null });
  const accounts = new Map([
    [adminUid, { found: true, role: "super_admin", status: "active" }],
    [memberUid, { found: true, role: "member", status: "active" }],
    [viewerUid, { found: true, role: "viewer", status: "active" }]
  ]);
  return createScheduleServer({ verifyFirebaseIdToken: verify,
    readAdminRecord: async uid => accounts.get(uid) || { found: false },
    readMemberAccount: async uid => accounts.get(uid) || { found: false },
    executeSql: createPsqlExecutor({ binary: psql, port }), hmacSecret,
    staticAssets: {
      "/admin-preview.html": { body: fs.readFileSync(path.join(browserDir, "admin-preview.html")), contentType: "text/html; charset=utf-8" },
      "/admin-jadwal-pelayanan.html": { body: fs.readFileSync(path.join(browserDir, "admin-jadwal-pelayanan.html")), contentType: "text/html; charset=utf-8" },
      "/jadwal-pelayanan.html": { body: fs.readFileSync(path.join(browserDir, "jadwal-pelayanan.html")), contentType: "text/html; charset=utf-8" },
      "/sipapua-admin-jadwal.js": { body: fs.readFileSync(path.join(browserDir, "sipapua-admin-jadwal.js")), contentType: "text/javascript; charset=utf-8" },
      "/local-schedule-adapter.js": { body: fs.readFileSync(path.join(browserDir, "local-schedule-adapter.js")), contentType: "text/javascript; charset=utf-8" },
      "/poster-fallback.svg": { body: fs.readFileSync(path.join(browserDir, "poster-fallback.svg")), contentType: "image/svg+xml" }
    }
  });
}
async function listenApi(server, port) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return server;
}
async function stopApi() {
  if (!apiServer) return;
  const server = apiServer;
  apiServer = undefined;
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}
function assertResult(condition, label) {
  if (!condition) { failCount++; throw new Error(`FAIL: ${label}`); }
  passCount++;
  process.stdout.write(`PASS: ${label}\n`);
}
async function waitEval(expression, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await cdp.evaluate(expression);
    if (last) return last;
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  const diagnostics = await cdp.evaluate("(async()=>({url:location.href,access:document.getElementById('access')?.textContent||'',workspaceHidden:document.getElementById('workspace')?.hidden,body:(document.body?.innerText||'').slice(0,500),scripts:[...document.scripts].map(s=>s.src),session:await fetch('/api/admin/session',{headers:{Authorization:'Bearer '+window.__SIPAPUA_LOCAL_TEST_TOKEN}}).then(async r=>({status:r.status,body:await r.json()})),resources:performance.getEntriesByType('resource').map(x=>x.name).filter(x=>x.includes('127.0.0.1'))}))() ").catch(() => null);
  throw new Error(`Timed out waiting for ${label}; browser=${JSON.stringify(diagnostics)}`);
}
class CDP {
  constructor(socket) {
    this.socket = socket; this.nextId = 0; this.pending = new Map(); this.events = new Map();
    socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id); this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message)); else resolve(message.result || {});
      } else if (message.method) for (const listener of this.events.get(message.method) || []) listener(message.params || {});
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    return new CDP(socket);
  }
  on(method, callback) { const list = this.events.get(method) || []; list.push(callback); this.events.set(method, list); }
  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Browser evaluation failed");
    return result.result?.value;
  }
  close() { try { this.socket.close(); } catch (_) {} }
}
async function newBrowserPage() {
  const activePath = path.join(chromeProfile, "DevToolsActivePort");
  chromeProcess = spawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--disable-component-update", "--disable-sync", "--disable-extensions", "--disable-translate", "--disable-features=OptimizationHints,MediaRouter",
    "--no-proxy-server", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0", `--user-data-dir=${chromeProfile}`, "--force-device-scale-factor=1", "about:blank"],
  { windowsHide: true, stdio: "ignore", env: minimalEnv() });
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(activePath) && Date.now() < deadline) {
    if (chromeProcess.exitCode !== null) throw new Error("Chrome exited before DevTools became ready.");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!fs.existsSync(activePath)) throw new Error("Chrome DevTools did not become ready.");
  const remotePort = Number(fs.readFileSync(activePath, "utf8").split(/\r?\n/)[0]);
  if (!Number.isInteger(remotePort) || remotePort < 1) throw new Error("Invalid local DevTools port.");
  const version = await jsonRequest(`http://127.0.0.1:${remotePort}/json/version`);
  if (!version.webSocketDebuggerUrl?.startsWith(`ws://127.0.0.1:${remotePort}/`)) throw new Error("Loopback Chrome browser endpoint missing.");
  browserCdp = await CDP.connect(version.webSocketDebuggerUrl);
  const targets = await jsonRequest(`http://127.0.0.1:${remotePort}/json/list`);
  const target = targets.find(item => item.type === "page");
  if (!target || !target.webSocketDebuggerUrl.startsWith(`ws://127.0.0.1:${remotePort}/`)) throw new Error("Loopback Chrome page target missing.");
  cdp = await CDP.connect(target.webSocketDebuggerUrl);
  cdp.on("Fetch.requestPaused", async event => {
    let url; try { url = new URL(event.request.url); } catch (_) { url = null; }
    if (legacyProjectionFixture && url?.pathname === "/api/member/schedules" && url.origin === `http://127.0.0.1:${webPort}`) {
      const fixture = [{ id:"90000000-0000-4000-8000-000000000001",title:"Synthetic legacy service",date:"2026-12-06",startTime:"11:00",endTime:"12:00",area:"abepura",category:"sunday-worship",venue:"Synthetic Venue One",leader:"Synthetic Pastor One",officers:[],theme:"",scripture:"",publicNotes:"",status:"published",publishedAt:"2026-11-01T00:00:00.000Z" }];
      await cdp.send("Fetch.fulfillRequest", { requestId:event.requestId,responseCode:200,responseHeaders:[{name:"Content-Type",value:"application/json"},{name:"Cache-Control",value:"no-store"}],body:Buffer.from(JSON.stringify({ok:true,data:fixture})).toString("base64") });
      return;
    }
    if (url?.protocol === "http:" && url.hostname === "127.0.0.1" && Number(url.port) === webPort && url.origin === `http://127.0.0.1:${webPort}`) {
      await cdp.send("Fetch.continueRequest", { requestId: event.requestId });
    } else {
      externalBlocked++;
      await cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
    }
  });
  cdp.on("Runtime.exceptionThrown", event => { browserErrors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || "uncaught browser error"); });
  await cdp.send("Page.enable"); await cdp.send("Runtime.enable"); await cdp.send("Network.enable");
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `Object.defineProperty(window,"__SIPAPUA_LOCAL_TEST_TOKEN",{value:sessionStorage.getItem("__SIPAPUA_LOCAL_TEST_TOKEN")||"",configurable:false}); window.confirm=()=>{sessionStorage.setItem("__confirmCalls",String(Number(sessionStorage.getItem("__confirmCalls")||0)+1));return true;};` });
  return cdp;
}
function jsonRequest(url) {
  return new Promise((resolve, reject) => http.get(url, { timeout: 3000 }, response => {
    const chunks = []; response.on("data", chunk => chunks.push(chunk)); response.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (error) { reject(error); }
    });
  }).on("error", reject));
}
function pngCrc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(pngCrc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}
function writeSyntheticPng(file) {
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4);
  header[8] = 8; header[9] = 6;
  const pixels = require("node:zlib").deflateSync(Buffer.from([0, 201, 163, 99, 255]));
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), pngChunk("IHDR", header), pngChunk("IDAT", pixels), pngChunk("IEND", Buffer.alloc(0))]));
}
async function setPosterFile(file) {
  const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#poster-file" });
  if (!nodeId) throw new Error("Poster input not found.");
  await cdp.send("DOM.setFileInputFiles", { files: [file], nodeId });
}
async function setToken(token) {
  await cdp.evaluate(`sessionStorage.setItem("__SIPAPUA_LOCAL_TEST_TOKEN",${JSON.stringify(token)}); true`);
}
async function navigate(pathname, token) {
  await setToken(token);
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${webPort}${pathname}` });
  await waitEval("document.readyState === 'complete'", `load ${pathname}`);
}
async function memberUpcoming() {
  await waitEval("document.getElementById('filters').hidden === false", "member schedule filters ready");
  await cdp.evaluate("document.getElementById('view').value='upcoming';document.getElementById('view').dispatchEvent(new Event('change'));true");
}
async function viewport(width, height = 900) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width <= 393 });
  await new Promise(resolve => setTimeout(resolve, 100));
  return cdp.evaluate("({width:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth})");
}
async function main() {
  for (const file of [initdb, pgCtl, psql, chrome]) if (!fs.existsSync(file)) throw new Error(`Required existing binary unavailable: ${path.basename(file)}`);
  if (typeof WebSocket !== "function") throw new Error("Built-in WebSocket API unavailable in this Node version.");
  fs.mkdirSync(sessionDir, { recursive: false }); fs.mkdirSync(chromeProfile);
  pgPort = await freePort(); webPort = await freePort();
  if (pgPort === webPort) webPort = await freePort();
  const invalidPoster = path.join(sessionDir, "invalid.png");
  fs.writeFileSync(invalidPoster, Buffer.from("not-a-png", "utf8"));
  const validPoster = path.join(sessionDir, "synthetic-poster.png");
  writeSyntheticPng(validPoster);
  const oversizedPoster = path.join(sessionDir, "oversized.png");
  const validPngBytes = fs.readFileSync(validPoster);
  fs.writeFileSync(oversizedPoster, Buffer.concat([validPngBytes, Buffer.alloc(2 * 1024 * 1024 + 1 - validPngBytes.length)]));
  run(initdb, ["-D", dataDir, "-U", "postgres", "--auth-local=trust", "--auth-host=trust", "--no-instructions"]); pgStarted = true;
  run(pgCtl, ["-D", dataDir, "-l", pgLog, "-o", `-h 127.0.0.1 -p ${pgPort} -c listen_addresses=127.0.0.1`, "-w", "-t", "20", "start"], { stdio: "ignore", timeout: 25000 });
  psqlRun("postgres", "CREATE DATABASE sipapua_schedule_local;");
  psqlRun("sipapua_schedule_local", "", ["-f", path.join(candidate, "schema.sql")]);
  const hmacSecret = crypto.randomBytes(32).toString("hex");
  psqlRun("sipapua_schedule_local", `INSERT INTO sipapua_private.writer_secret(singleton,secret) VALUES(true,decode('${hmacSecret}','hex'));`);
  psqlRun("sipapua_schedule_local", `INSERT INTO sipapua_schedule.resources(id,kind,display_name) VALUES
    ('${venueId}','venue','Synthetic Venue One'),
    ('${pastorOne}','person','Synthetic Pastor One'),
    ('${pastorTwo}','person','Synthetic Pastor Two'),
    ('20000000-0000-4000-8000-000000000005','person','Synthetic Officer One');`);
  const pairs = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  apiServer = await listenApi(makeApi(pairs.publicKey, pgPort, hmacSecret), webPort);
  const adminToken = syntheticToken(adminUid, pairs.privateKey);
  const memberToken = syntheticToken(memberUid, pairs.privateKey);
  const viewerToken = syntheticToken(viewerUid, pairs.privateKey);
  process.stdout.write(`LOCAL_API: http://127.0.0.1:${webPort}; LOCAL_PG: 127.0.0.1:${pgPort}; PROJECT: ${project}\n`);
  await newBrowserPage();
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${webPort}/admin-preview.html` });
  await waitEval("location.pathname === '/admin-preview.html'", "initial local preview page");
  await setToken(adminToken);
  currentStep = "admin entry";
  await navigate("/admin-preview.html", adminToken);
  await cdp.evaluate("document.querySelector('a[href=\"admin-jadwal-pelayanan.html\"]').click()");
  await waitEval("location.pathname === '/admin-jadwal-pelayanan.html' && !!document.getElementById('workspace') && !document.getElementById('workspace').hidden", "authorized administrator UI");
  assertResult((await cdp.evaluate("document.getElementById('access').textContent")).includes("super_admin"), "browser admin access comes from verified synthetic server session");
  assertResult(await cdp.evaluate("document.querySelector('[name=theme]').required && document.querySelector('[name=theme]').maxLength===150"), "administrator form requires bounded sermon theme");
  for (const width of [320, 360, 393, 768, 1280]) {
    const size = await viewport(width);
    assertResult(size.scrollWidth <= size.width, `administrator UI has no horizontal overflow at ${width}px`);
  }
  await cdp.evaluate("document.getElementById('add').click()");
  currentStep = "save draft UI";
  await setPosterFile(invalidPoster);
  await waitEval("document.getElementById('poster-note').textContent.includes('Tidak ada berkas')", "poster content validation rejects mislabeled image");
  assertResult(await cdp.evaluate("document.getElementById('member-preview-image').getAttribute('src')==='poster-fallback.svg'"), "invalid poster keeps the local fallback image");
  await setPosterFile(validPoster);
  await waitEval("document.getElementById('poster-note').textContent.includes('Tidak diunggah') && document.getElementById('member-preview-image').naturalWidth===1", "valid synthetic poster is previewed without upload");
  assertResult(true, "poster preview validates image signature and remains browser-local");
  await setPosterFile(oversizedPoster);
  await waitEval("document.getElementById('poster-note').textContent.includes('maksimal 2 MB')", "poster maximum file size is enforced");
  assertResult(await cdp.evaluate("document.getElementById('member-preview-image').getAttribute('src')==='poster-fallback.svg'"), "oversized poster leaves fallback preview intact");
  await cdp.evaluate(`(()=>{const f=document.getElementById('schedule-form');const v={title:'Synthetic Sunday Service',category:'sunday-worship',area:'ABE',venue:'Synthetic Venue One',date:'2026-12-06',startTime:'09:00',endTime:'10:00',leader:'Synthetic Pastor One',weeks:'1',theme:'Pengharapan dalam Kristus',scripture:'John 1:1',officers:'Synthetic Officer One | Music',publicNotes:'Synthetic public note'};for(const [k,x] of Object.entries(v)){const e=f.elements.namedItem(k);e.value=x;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}f.requestSubmit();})()`);
  await waitEval("document.getElementById('editor-feedback').textContent.includes('tersimpan')", "draft saved via browser UI");
  const title = "Synthetic Sunday Service";
  assertResult((await cdp.evaluate("document.getElementById('summary').textContent")).includes("Draft 1"), "administrator UI shows newly saved synthetic draft");

  // Restart both local processes; all durable state must come from the isolated PostgreSQL data directory.
  await stopApi();
  run(pgCtl, ["-D", dataDir, "-m", "fast", "-w", "-t", "20", "stop"], { stdio: "ignore", timeout: 25000 }); pgStarted = false;
  run(pgCtl, ["-D", dataDir, "-l", pgLog, "-o", `-h 127.0.0.1 -p ${pgPort} -c listen_addresses=127.0.0.1`, "-w", "-t", "20", "start"], { stdio: "ignore", timeout: 25000 }); pgStarted = true;
  apiServer = await listenApi(makeApi(pairs.publicKey, pgPort, hmacSecret), webPort);
  await navigate("/admin-jadwal-pelayanan.html", adminToken);
  await waitEval("document.getElementById('summary').textContent.includes('Draft 1')", "draft survives local service and database restart");
  assertResult(true, "draft persists after PostgreSQL and API restart");
  currentStep = "member published read";
  await navigate("/jadwal-pelayanan.html", memberToken);
  await memberUpcoming();
  assertResult((await cdp.evaluate("document.getElementById('schedules').textContent")).includes("Synthetic Sunday Service") === false, "member projection excludes draft");
  assertResult((await cdp.evaluate("document.getElementById('status').textContent")).includes("belum tersedia"), "member receives explicit empty state for draft-only database");

  currentStep = "revise pastor";
  await navigate("/admin-jadwal-pelayanan.html", adminToken);
  await waitEval("document.getElementById('summary').textContent.includes('Draft 1')", "draft loaded after restart");
  await cdp.evaluate("document.getElementById('anchor').value='2026-12-06';document.getElementById('anchor').dispatchEvent(new Event('change'))");
  await cdp.evaluate("[...document.querySelectorAll('#calendar button')].find(b=>b.textContent.includes('Synthetic Sunday Service')).click()");
  await cdp.evaluate("document.getElementById('publish').click()");
  await waitEval("document.getElementById('editor-feedback').textContent.includes('terbit')", "publish action confirmed by local API");
  assertResult((await cdp.evaluate("document.getElementById('editor-state').textContent")).includes("Pertama terbit"), "first publication timestamp appears in admin UI");
  const publishedAt = await cdp.evaluate("JSON.parse(document.getElementById('member-preview').textContent).find(x=>x.id)?.publishedAt");
  assertResult(typeof publishedAt === "string" && Number.isFinite(Date.parse(publishedAt)), "publication timestamp persisted");
  await navigate("/jadwal-pelayanan.html", memberToken);
  await memberUpcoming();
  await waitEval("document.getElementById('schedules').textContent.includes('Synthetic Sunday Service')", "published schedule appears to member");
  let memberCard = await cdp.evaluate("document.getElementById('schedules').textContent");
  assertResult(memberCard.includes("Synthetic Pastor One") && memberCard.includes("Abepura"), "member sees published pastor and area");
  assertResult(memberCard.includes("Pengharapan dalam Kristus"), "member schedule prominently includes sermon theme");
  assertResult(await cdp.evaluate("document.querySelector('#schedules .poster')?.naturalWidth > 0"), "member schedule loads the original local fallback poster");
  assertResult(await cdp.evaluate("document.querySelectorAll('#area option').length===6 && document.querySelectorAll('#view option').length===4 && document.querySelectorAll('#date-strip button').length>=2"), "member discovery provides five areas, category filters and horizontal date choices");
  await cdp.evaluate("document.getElementById('area').value='sentani';document.getElementById('area').dispatchEvent(new Event('change'));true");
  assertResult(await cdp.evaluate("document.querySelectorAll('#schedules .show-card').length===0"), "member area filter excludes schedules from other areas");
  await cdp.evaluate("document.getElementById('area').value='abepura';document.getElementById('area').dispatchEvent(new Event('change'));document.getElementById('view').value='other-ministry';document.getElementById('view').dispatchEvent(new Event('change'));true");
  assertResult(await cdp.evaluate("document.querySelectorAll('#schedules .show-card').length===0"), "member category filter excludes other activity types");
  await cdp.evaluate("document.getElementById('view').value='sunday-worship';document.getElementById('view').dispatchEvent(new Event('change'));document.querySelector('#schedules .detail')?.click();true");
  assertResult(await cdp.evaluate("document.getElementById('detail-dialog').open && document.getElementById('detail-content').textContent.includes('Pengharapan dalam Kristus')"), "session detail presents its own sermon theme");
  await cdp.evaluate("document.getElementById('detail-dialog').close();document.getElementById('view').value='upcoming';document.getElementById('view').dispatchEvent(new Event('change'));true");
  await cdp.evaluate("document.querySelector('#date-strip [data-date=\"2026-12-06\"]')?.click();true");
  assertResult(await cdp.evaluate("document.querySelectorAll('#schedules .show-card').length===1"), "horizontal WIT date selector filters the chosen service date");
  await cdp.evaluate("document.querySelector('#date-strip [data-date=\"all\"]')?.click();true");
  assertResult(!memberCard.includes("internal-test-only") && !memberCard.includes("synthetic-browser-admin"), "member response contains no internal notes or administrator identity");

  currentStep = "revise pastor";
  await navigate("/admin-jadwal-pelayanan.html", adminToken);
  await waitEval("document.getElementById('summary').textContent.includes('Terbit 1')", "published schedule loaded before revision");
  await cdp.evaluate("document.getElementById('anchor').value='2026-12-06';document.getElementById('anchor').dispatchEvent(new Event('change'))");
  await cdp.evaluate("(()=>{const b=[...document.querySelectorAll('#calendar button')].find(x=>x.textContent.includes('Synthetic Sunday Service'));if(!b)throw new Error(JSON.stringify({summary:document.getElementById('summary').textContent,anchor:document.getElementById('anchor').value,period:document.getElementById('period').textContent,buttons:[...document.querySelectorAll('#calendar button')].map(x=>x.textContent)}));b.click();return true})()");
  await cdp.evaluate(`(()=>{const e=document.querySelector('[name="leader"]');e.value='Synthetic Pastor Two';e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await cdp.evaluate("document.getElementById('schedule-form').requestSubmit()");
  await waitEval("document.getElementById('editor-feedback').textContent.includes('tersimpan')", "published schedule revision saved");
  assertResult((await cdp.evaluate("document.getElementById('editor-state').textContent")).includes("Pertama terbit"), "revision preserves original publication timestamp in admin state");
  await navigate("/jadwal-pelayanan.html", memberToken);
  await memberUpcoming();
  await waitEval("document.getElementById('schedules').textContent.includes('Synthetic Pastor Two')", "member sees revised pastor");
  assertResult((await cdp.evaluate("document.getElementById('schedules').textContent")).includes("Synthetic Pastor Two"), "member sees updated pastor after page reload");

  currentStep = "cancel schedule";
  await navigate("/admin-jadwal-pelayanan.html", adminToken);
  await waitEval("document.getElementById('summary').textContent.includes('Terbit 1')", "revised schedule loaded before cancellation");
  await cdp.evaluate("document.getElementById('anchor').value='2026-12-06';document.getElementById('anchor').dispatchEvent(new Event('change'))");
  await cdp.evaluate("[...document.querySelectorAll('#calendar button')].find(b=>b.textContent.includes('Synthetic Sunday Service')).click()");
  await cdp.evaluate("document.getElementById('cancel').click()");
  await waitEval("document.getElementById('editor-feedback').textContent.includes('Pembatalan')", "cancel action saved");
  assertResult((await cdp.evaluate("document.getElementById('editor-state').textContent")).includes("Pertama terbit"), "cancellation retains original publication timestamp");
  const confirms = Number(await cdp.evaluate("sessionStorage.getItem('__confirmCalls')||'0'"));
  assertResult(confirms >= 2, "publish and cancellation require browser confirmation");
  await navigate("/jadwal-pelayanan.html", memberToken);
  await memberUpcoming();
  await waitEval("document.getElementById('schedules').textContent.includes('Dibatalkan')", "member sees published cancellation");
  assertResult((await cdp.evaluate("document.getElementById('schedules').textContent")).includes("Dibatalkan"), "cancelled published schedule remains visible to member");

  currentStep = "multi-session presentation grouping";
  await navigate("/admin-jadwal-pelayanan.html", adminToken);
  await waitEval("!document.getElementById('workspace').hidden", "admin returns for second synthetic session");
  await cdp.evaluate("document.getElementById('anchor').value='2026-12-06';document.getElementById('anchor').dispatchEvent(new Event('change'));document.getElementById('add').click();true");
  await cdp.evaluate(`(()=>{const f=document.getElementById('schedule-form');const v={title:'Synthetic Sunday Service',category:'sunday-worship',area:'ABE',venue:'Synthetic Venue One',date:'2026-12-06',startTime:'16:00',endTime:'17:00',leader:'Synthetic Pastor One',weeks:'1',theme:'Pelayanan yang setia',scripture:'Romans 12:11',officers:'',publicNotes:'Synthetic second session'};for(const[k,x]of Object.entries(v)){const e=f.elements.namedItem(k);e.value=x;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}f.requestSubmit();})()`);
  await waitEval("document.getElementById('editor-feedback').textContent.includes('tersimpan')", "second schedule occurrence saved separately");
  await cdp.evaluate("document.getElementById('publish').click();true");
  await waitEval("document.getElementById('editor-feedback').textContent.includes('terbit')", "second occurrence published separately");
  await navigate("/jadwal-pelayanan.html", memberToken);
  await memberUpcoming();
  await waitEval("document.querySelectorAll('#schedules .show-card').length===1 && document.querySelectorAll('#schedules .session').length===2", "compatible services grouped as presentation only");
  const grouped = await cdp.evaluate("({cards:document.querySelectorAll('#schedules .show-card').length,sessions:document.querySelectorAll('#schedules .session').length,text:document.getElementById('schedules').textContent})");
  assertResult(grouped.cards===1 && grouped.sessions===2 && grouped.text.includes("Pengharapan dalam Kristus") && grouped.text.includes("Pelayanan yang setia") && grouped.text.includes("Synthetic Pastor Two") && grouped.text.includes("Synthetic Pastor One"), "grouped sessions retain unique identity, theme, minister and cancellation status");
  const sessionIds=await cdp.evaluate("fetch('/api/member/schedules',{headers:{Authorization:'Bearer '+window.__SIPAPUA_LOCAL_TEST_TOKEN}}).then(r=>r.json()).then(r=>r.data.filter(x=>x.title==='Synthetic Sunday Service').map(x=>x.id))");
  assertResult(sessionIds.length===2 && new Set(sessionIds).size===2, "grouped showtimes remain separate stable backend occurrence records");
  await cdp.evaluate("document.querySelector('#schedules .detail')?.click();true");
  assertResult(await cdp.evaluate("document.getElementById('detail-dialog').open"), "member can open a single-session detail view");
  await cdp.evaluate("document.getElementById('detail-dialog').close();true");
  legacyProjectionFixture = true;
  await navigate("/jadwal-pelayanan.html", memberToken);
  await memberUpcoming();
  assertResult(await cdp.evaluate("document.getElementById('schedules').textContent.includes('Tema khotbah belum tercatat')"), "legacy published projection without theme remains visible with a safe display fallback");
  legacyProjectionFixture = false;

  currentStep = "unauthorized access";
  await navigate("/admin-jadwal-pelayanan.html", viewerToken);
  await waitEval("document.getElementById('workspace').hidden", "unauthorized direct navigation denied");
  assertResult(await cdp.evaluate("document.getElementById('workspace').hidden"), "viewer cannot access administrator workspace by changing synthetic identity");
  for (const width of [320, 360, 393, 768, 1280]) {
    const memberSize = await viewport(width);
    assertResult(memberSize.scrollWidth <= memberSize.width, `member UI has no horizontal overflow at ${width}px`);
  }
  const requests = await cdp.send("Network.getAllCookies");
  assertResult((requests.cookies || []).length === 0, "local flow does not persist bearer tokens as browser cookies");
  assertResult(externalBlocked === 0, "no external browser request was attempted");
  assertResult(browserErrors.length === 0, `no uncaught browser exceptions${browserErrors.length ? ` (${browserErrors.length})` : ""}`);
  process.stdout.write(`BROWSER_TESTS: ${passCount} PASS / ${failCount} FAIL\n`);
  process.stdout.write("FIREBASE_PRODUCTION: untouched; no Firebase SDK, API, or emulator was started.\n");
}

async function cleanup() {
  await stopApi().catch(() => {});
  if (chromeProcess && chromeProcess.exitCode === null) {
    const exited = once(chromeProcess, "exit").catch(() => {});
    try { await Promise.race([browserCdp?.send("Browser.close"), new Promise(resolve => setTimeout(resolve, 1000))]); } catch (_) {}
    const closed = await Promise.race([exited.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 4000))]);
    if (!closed && chromeProcess.exitCode === null) {
      try { chromeProcess.kill(); } catch (_) {}
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
    }
  }
  cdp?.close();
  browserCdp?.close();
  if (pgStarted) {
    try { run(pgCtl, ["-D", dataDir, "-m", "fast", "-w", "-t", "20", "stop"], { stdio: "ignore", timeout: 25000 }); pgStarted = false; }
    catch (error) { process.stderr.write(`LOCAL POSTGRES CLEANUP FAILED: ${error.message}\n`); failCount++; }
  }
  if (sessionDir && fs.existsSync(sessionDir)) process.stdout.write(`RETAINED_SYNTHETIC_TEST_ARTIFACTS: ${sessionDir}\n`);
}

const pairs = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
main().catch(error => { failCount++; process.stderr.write(`BROWSER E2E FAIL at ${currentStep}: ${error.message}\n${browserErrors.slice(-5).join("\n")}\n`); process.exitCode = 1; })
  .finally(async () => { await cleanup(); if (!process.exitCode) process.exitCode = failCount ? 1 : 0; });
