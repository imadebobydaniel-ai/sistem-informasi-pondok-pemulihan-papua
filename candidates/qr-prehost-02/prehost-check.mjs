#!/usr/bin/env node
// SIPAPUA QR-PREHOST-02: non-mutating local candidate verification.
// No network, cloud, credential, deployment, git write, or production action.
import { readFileSync, existsSync, readdirSync, statSync, realpathSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = resolve(process.argv[2] || '.');
const base = join(root, 'candidates');
const reportDir = mkdtempSync(join(tmpdir(), 'sipapua-prehost-02-'));
const results = { createdAt: new Date().toISOString(), root, scope: 'LOCAL_ONLY',
  manifest: [], checks: [], suites: [], safeguards: {
    cost: 'Rp0 additional', hostedStaging: 'BLOCKED', production: 'HOLD',
    registration: 'HOLD', memberCardMaintenance: 'ACTIVE', qrFriendship: 'DISABLED'
  }, physicalPhoneTest: 'NOT_RUN', googleCloudAPIProof: 'NOT_RUN', hostedD1Meter: 'NOT_RUN' };

function check(name, ok, detail) { results.checks.push({name, status:ok?'PASS':'FAIL', detail}); }
function within(path) { const rel=relative(root, path); return rel!=='' && rel!=='..' && !rel.startsWith('..'+sep) && !isAbsolute(rel); }
function isRegularFile(path) {
  try { return within(path) && existsSync(path) && within(realpathSync(path)) && statSync(path).isFile(); }
  catch { return false; }
}
function manifestAnchors(manifest, candidateRoot) {
  // Preserve archives may embed a repo-relative manifest below a nested root.
  // Never infer a unique anchor from the current directory alone.
  return [...new Set([dirname(manifest),candidateRoot,root].map(x=>resolve(x)))];
}
function hash(path){return createHash('sha256').update(readFileSync(path)).digest('hex');}
if(!existsSync(base)) {
  check('candidate directory', false, `Directory unavailable: ${base}`);
} else {
  for (const name of ['qr-rc-01-preserved','qr-rc-02','qr-rc-03','qr-rc-04','qr-rc-04a','qr-zero-cost-final']) {
    const p=join(base,name);
    if(!existsSync(p)) { results.manifest.push({candidate:name,status:'NOT_PRESENT',count:0,failures:[]});continue; }
    const manifests=[];
    function visit(d,depth){
      if(depth>4)return;
      for (const ent of readdirSync(d,{withFileTypes:true})) {
        if(ent.isSymbolicLink()) continue;
        const path=join(d,ent.name);
        if(ent.isDirectory())visit(path,depth+1);
        else if(ent.name==='SHA256SUMS.txt')manifests.push(path);
      }
    }
    visit(p,0);
    for(const manifest of manifests){
      let count=0;const failures=[];
      const content=readFileSync(manifest,'utf8').replace(/^\uFEFF/,'');
      for(const line of content.split(/\r?\n/)) {
        if(!line.trim()||line.startsWith('#'))continue;
        const match=/^([a-f\d]{64})\s+\*?(.+?)\s*$/i.exec(line);
        if(!match){failures.push({entry:line.slice(0,120),problem:'unrecognized manifest format'});continue;}
        const [,expected, filename]=match;
        const possible=manifestAnchors(manifest,p).map(anchor=>resolve(anchor,filename))
          .filter(isRegularFile);
        if(!possible.length){failures.push({entry:filename,problem:'missing/unresolvable path'});continue;}
        // Hash disambiguates an archived candidate from a same-named root file.
        // Never mark missing simply because the manifest was nested in preservation.
        const matched=possible.some(file=>hash(file).toLowerCase()===expected.toLowerCase());
        if(!matched) failures.push({entry:filename,problem:'sha256 mismatch across valid anchors'});
        else count++;
      }
      results.manifest.push({candidate:name,manifest:relative(root,manifest),status:failures.length?'FAIL':'PASS',count,failures});
    }
    if(manifests.length===0)results.manifest.push({candidate:name,status:'NO_MANIFEST',count:0,failures:[]});
  }
}
const worker=join(base,'qr-zero-cost-final','src','worker.mjs');
const wrangler=join(base,'qr-zero-cost-final','wrangler.staging.example.toml');
if(existsSync(worker)) {
  const w=readFileSync(worker,'utf8');
  check('no production ready declaration',w.includes('NOT PRODUCTION-READY'), 'Worker candidate disclaimer');
  check('daily budget gate',w.includes('REQUEST_DAILY_LIMIT')&&w.includes('reserveDaily('),'Candidate contains daily admission');
  check('fail closed verifier',w.includes('QR_AUTHORITY')&&w.includes('invalid-or-consumed-credentials'),'Reference to private authority');
  check('one-time conditional card consumption',/UPDATE cards SET consumed_at=.*consumed_at IS NULL/.test(w),'Atomic conditional consumption');
  check('expiry enforced at consumption',w.includes('expires_at>?'),'Expiry in redemption SQL');
  check('no production project ID in Worker',!w.includes('boby-apps-project'),'No literal production Firebase project in Worker');
} else check('worker candidate present',false,'Worker source is missing');
if(existsSync(wrangler)) {
  const t=readFileSync(wrangler,'utf8');
  const cadence=/crons\s*=\s*\[\s*"\*\/30 \* \* \* \*"/.test(t);
  results.checks.push({name:'cleanup cadence vs earlier 10-minute target',status:cadence?'REVIEW':'PASS',detail:cadence?'Configured 30 min; earlier target was 10 min. Requires owner decision, no automatic change.':'Inspect cadence manually'});
  check('staging disabled by default',/workers_dev\s*=\s*false/.test(t)&&/preview_urls\s*=\s*false/.test(t),'No public staging endpoint configured in example');
} else check('wrangler staging template present',false,'Template missing');

const suites=[
  ['QR zero-cost Worker', 'candidates/qr-zero-cost-final/test/worker.test.mjs', false],
  ['RC-04A contract','candidates/qr-rc-04a/prototype.test.mjs', false],
  ['RC-03 allocation rules','candidates/qr-rc-03/test/allocation-rules.test.mjs', true],
];
function isLocalJar(path) {
  try {
    // Installed emulator tooling may live outside the manifest root.
    if (!isAbsolute(path) || !path.toLowerCase().endsWith('.jar')) return false;
    const local = candidate => process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(candidate);
    return local(path) && local(realpathSync(path)) && statSync(path).isFile();
  } catch { return false; }
}

function emulatorPrerequisites() {
  const missing=[];
  const deps=process.env.SIPAPUA_TEST_DEPS;
  const authServer=process.env.SIPAPUA_TEST_AUTH_SERVER;
  if(!deps || !isRegularFile(join(resolve(deps||root),'package.json'))) missing.push('SIPAPUA_TEST_DEPS must point to installed local tooling (package.json)');
  if(!authServer) missing.push('SIPAPUA_TEST_AUTH_SERVER must name the local Auth emulator module');
  if(deps && isRegularFile(join(resolve(deps),'package.json'))) {
    try {
      const req=createRequire(join(resolve(deps),'package.json'));
      for(const spec of ['@firebase/rules-unit-testing','firebase/firestore','firebase/app','firebase/auth']) {
        try {req.resolve(spec);} catch {missing.push(`Local dependency missing: ${spec}`);}
      }
      if(authServer) {try {req.resolve(authServer);} catch {missing.push('Auth emulator module cannot be resolved from SIPAPUA_TEST_DEPS');}}
      try {createRequire(join(resolve(deps),'functions/package.json')).resolve('firebase-admin/auth');}
      catch {missing.push('Local dependency missing: firebase-admin/auth');}
    } catch {missing.push('Local dependency directory invalid'); }
  }
  // Check Java/JAR in preflight, not inside a test whose config error looks like FAIL.
  const jar=process.env.SIPAPUA_FIRESTORE_JAR||join(homedir(),'.cache','firebase','emulators','cloud-firestore-emulator-v1.22.0.jar');
  if(!isLocalJar(jar)) missing.push('Local Firestore emulator JAR unavailable; set SIPAPUA_FIRESTORE_JAR to an installed JAR');
  const java=spawnSync('java',['-version'],{encoding:'utf8',timeout:5000,windowsHide:true});
  if(java.error||java.status!==0) missing.push('Java runtime unavailable');
  return missing;
}
for(const [name,p,needsEmulator] of suites){
  const file=join(root,p);
  if(!isRegularFile(file)){results.suites.push({name,path:p,status:'NOT_PRESENT'});continue;}
  if(needsEmulator) {
    const missing=emulatorPrerequisites();
    if(missing.length) {
      results.suites.push({name,path:p,status:'BLOCKED',reason:'EMULATOR_PREREQUISITES_MISSING',missing});
      continue;
    }
  }
  const done=spawnSync(process.execPath,['--test','--test-reporter=tap',file],{
    cwd:root,encoding:'utf8',timeout:120000,maxBuffer:3*1024*1024,
    env:{...process.env, GOOGLE_APPLICATION_CREDENTIALS:'',FIREBASE_CONFIG:'',CLOUDFLARE_API_TOKEN:'',WRANGLER_SEND_METRICS:'false'}
  });
  const output=(done.stdout||'')+'\n'+(done.stderr||'');
  if (needsEmulator && done.error) {
    results.suites.push({name,path:p,status:'BLOCKED',reason:'EMULATOR_SUITE_COULD_NOT_RUN',
      missing:[done.error.code || 'Local process error']});
    continue;
  }
  results.suites.push({name,path:p,status:done.status===0?'PASS':'FAIL',exitCode:done.status,signal:done.signal||null,
    summary:output.split('\n').filter(x=>/^# (tests|pass|fail|cancelled|skipped)\s/.test(x)).slice(-6),
    error:done.status===0?undefined:output.slice(-2500)});
}
const failures=results.checks.some(x=>x.status==='FAIL')||results.manifest.some(x=>x.status==='FAIL')||results.suites.some(x=>x.status==='FAIL');
const missing=results.suites.some(x=>['NOT_PRESENT','BLOCKED'].includes(x.status))||!existsSync(worker)||results.manifest.some(x=>['NOT_PRESENT','NO_MANIFEST'].includes(x.status));
results.localDecision=failures?'FAIL':missing?'INCOMPLETE':'PASS_WITH_REVIEW';
results.hostedDecision='NO-GO';
const md=[
  '# SIPAPUA QR-PREHOST-02 — Offline Verification Report','',
  `Generated (UTC): ${results.createdAt}`,'',
  `**Local:** ${results.localDecision}  |  **Hosted staging/production:** NO-GO`,'',
  'This runner does not test phones, Google Cloud, live App Check, or hosted D1. Its findings never authorize release.','',
  '## Candidate manifests',...results.manifest.map(x=>`- ${x.candidate}: ${x.status}, ${x.count} matched; ${x.failures.length} issues`),'',
  '## Static gates',...results.checks.map(x=>`- ${x.status} — ${x.name}: ${x.detail}`),'',
  '## Test suites',...results.suites.map(x=>`- ${x.status} — ${x.name}${x.summary?' ('+x.summary.join(', ')+')':''}${x.missing?' — '+x.missing.join('; '):''}`),'',
  '## Physical-device test checklist (NOT RUN)',
  '- [ ] Two test identities and synthetic member records only',
  '- [ ] Issuer phone displays QR with 5-minute expiry',
  '- [ ] Different scanner phone redeems QR exactly once',
  '- [ ] Repeated scan rejects without returning member profile',
  '- [ ] Self-scan rejects',
  '- [ ] Expired QR rejects even when cleanup is late',
  '- [ ] Disabled/revoked account rejects issuer and owner',
  '- [ ] Offline/network loss fails closed, no fallback to unsafe cached identity',
  '- [ ] No secrets, raw tokens, or real personal data in screenshots/logs',
  '- [ ] Device screenshots and exact timestamps recorded without credentials','',
  '## Deferred hosted evidence',
  '- Workload identity/OAuth and privileged Auth + App Check consume + owner authorization: BLOCKED',
  '- Hosted D1 actual rows_written and rows_read including indexes and cleanup: NOT MEASURED',
  '- 30-minute cleanup cadence conflicts with earlier 10-minute target: OWNER REVIEW REQUIRED','',
  '## Governance',
  '- Additional cost Rp0. Do not enable billing, deploy, change IAM/Firebase/Cloudflare, or change production Rules.',
  '- Registration HOLD; QR maintenance ACTIVE; QR friendship DISABLED.',''
].join('\n');
writeFileSync(join(reportDir,'PREHOST-RESULT.json'),JSON.stringify(results,null,2)+'\n');
writeFileSync(join(reportDir,'PREHOST-RESULT.md'),md);
console.log(JSON.stringify({localDecision:results.localDecision,hostedDecision:results.hostedDecision,reportDir,manifest:results.manifest.length,suites:results.suites.map(x=>[x.name,x.status])},null,2));
// Exit 2 means inconclusive/missing tooling, NOT a test failure.
process.exitCode=failures?1:missing?2:0;
