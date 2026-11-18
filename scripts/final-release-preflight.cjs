'use strict';
// Offline inventory only. Never stages, copies, deploys, logs credentials or calls Firebase.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const git = (...args) => execFileSync('git', args, {cwd:root,encoding:'utf8'});
const hash = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex');
const list = args => git(...args).split('\0').filter(Boolean);
const tracked = list(['ls-files','-z']);
const untracked = list(['ls-files','--others','--exclude-standard','-z']);
const changed = list(['diff','HEAD','--name-only','-z']);
const staged = list(['diff','--cached','--name-only','-z']);
const all = [...new Set([...tracked,...untracked])].filter(f=>fs.existsSync(path.join(root,f)) && fs.statSync(path.join(root,f)).isFile());
// Public projection: preserve existing root UI/media and add only validated geography.
// No backend source, tests, review docs, configs, runtimes or synthetic fixtures.
const publicFiles = all.filter(f => (!f.includes('/') && /\.(html|js|css|png|jpe?g|webp|svg|ico|mp3|wav|woff2?|ttf)$/i.test(f)) ||
    /^notification\/(?:adapters\/|components\/|core\/|styles\/)?[a-z-]+\.(js|css)$/.test(f) ||
    /^assets\/wilayah\/v2\/(manifest\.json|provinces\.json|(regencies|districts|villages)\/[0-9.]+\.json)$/.test(f));
const backend = [...new Set([...changed,...untracked])].filter(f=>/^functions\/[^/]+\.(js|json)$/.test(f));
const newApplication = untracked.filter(f=>publicFiles.includes(f) || backend.includes(f));
const findings=[];
const secretPatterns=[['private-key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['github-token',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
    ['google-refresh-token',/\b1\/\/[A-Za-z0-9_-]{30,}/],
    ['bearer-jwt',/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
    ['service-account',/"type"\s*:\s*"service_account"/],
    ['literal-password-review',/\b(?:password|api_secret|client_secret)\s*[:=]\s*['"][^'"]+['"]/i]];
for(const file of [...publicFiles,...backend]) {
    if(!/\.(html|js|css|json)$/.test(file) || file.startsWith('assets/')) continue;
    const lines=fs.readFileSync(path.join(root,file),'utf8').split(/\r?\n/);
    lines.forEach((line,i)=>{for(const [kind,pattern] of secretPatterns)if(pattern.test(line))findings.push({file,line:i+1,kind});});
}
const flow=['registrasi.html','index.html','informasi-email.html','verify-success.html','auth-handler.html',
    'edit-jemaat-administrator.html','profil.html','chat-umkm.html','chat-dashboard-umkm.html','dashboard-umkm.html'];
const missingReferences=[];
for(const file of flow){
    const source=fs.readFileSync(path.join(root,file),'utf8');
    for(const match of source.matchAll(/\s(?:src|href)\s*=\s*["']([^"']+)["']/gi)){
        const ref=match[1];
        if(/^(?:[a-z]+:|\/\/|#)/i.test(ref) || /[{}<>]/.test(ref))continue;
        const target=decodeURIComponent(ref.split(/[?#]/)[0]);if(!target)continue;
        if(!fs.existsSync(path.resolve(root,path.dirname(file),target)))missingReferences.push({file,reference:ref});
    }
}
const geo=JSON.parse(fs.readFileSync(path.join(root,'assets/wilayah/v2/manifest.json'),'utf8'));
const badGeography=[];
for(const [endpoint,entry] of Object.entries(geo.entries)){
    const file='assets/wilayah/v2/'+endpoint;
    if(!publicFiles.includes(file)||hash(file)!==entry.sha256)badGeography.push(endpoint);
}
const previous=JSON.parse(fs.readFileSync(path.join(root,'docs/release-blocker-closeout/EVIDENCE.json'),'utf8'));
const changedSinceCloseout=Object.entries(previous.sha256).filter(([f,h])=>hash(f)!==h).map(([f])=>f);
const excluded=untracked.filter(f=>!newApplication.includes(f));
const manifest={recordedAt:new Date().toISOString(),branch:git('branch','--show-current').trim(),head:git('rev-parse','HEAD').trim(),
    origin:git('remote','get-url','origin').trim(),staged,changedTracked:changed,newApplicationFiles:newApplication,
    backendFiles:backend,publicFiles,reviewOnlyUntracked:excluded,
    deploymentRulesCandidate:'docs/release-gate-005a/firestore.final-proposed.rules',
    activeRulesSelection:'firestore.rules — still NOT approved for deployment',
    productionDeploymentAllowed:false};
const result={recordedAt:manifest.recordedAt,decision:'NO-GO',publicFileCount:publicFiles.length,
    geographyEndpointCount:Object.keys(geo.entries).length,badGeography,missingReferences,secretFindings:findings,
    secretScanScope:'public projection and changed backend; pattern scan is not a full historical or member-data audit',
    changedSinceCloseout,activeRulesUnchanged:hash('firestore.rules')===previous.sha256['firestore.rules'],
    configUnchanged:hash('firebase.json')===previous.sha256['firebase.json'],
    priorTestsRetained:changedSinceCloseout.length===0,registrationBasePath:'./assets/wilayah/v2',
    publicProjectionExcludesTestsFixturesBackends:true};
const output=path.join(root,'docs/final-release');fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(path.join(output,'MANIFEST.json'),JSON.stringify(manifest,null,2)+'\n');
fs.writeFileSync(path.join(output,'LOCAL-PREFLIGHT.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
if(badGeography.length||missingReferences.length||findings.length||changedSinceCloseout.length)process.exitCode=2;
