'use strict';
// Local preparation only: no staging, commit, push, deploy, or Firebase requests.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),directory=path.join(root,'docs/spark-release');
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']});
const changed=git('diff','--name-only','-z').split('\0').filter(Boolean);
const untracked=git('ls-files','--others','--exclude-standard','-z').split('\0').filter(Boolean);
const source=['sipapua-spark-registration.js','sipapua-spark-member.js','sipapua-login.js','sipapua-member-session.js','sipapua-app-check.js'];
const release=[...new Set([...changed.filter(f=>!f.includes('/')&&/\.(html|js|css)$/.test(f)&&f!=='sipapua-registration-preparation.js'),...source,
    ...untracked.filter(f=>/^assets\/wilayah\/v2\/.*\.json$/.test(f)),
    'docs/spark-release/firestore.proposed.rules','docs/spark-release/firebase.json',
    'scripts/build-spark-release-rules.cjs','scripts/prepare-spark-release.cjs','tests/spark-release/e2e.cjs',
    'tests/spark-release/ownership-cases.cjs',
    'scripts/legacy-uid-inventory.cjs','scripts/owner-uid-clear.cjs','scripts/verify-spark-public.cjs',
    'tests/spark-release/owner-operations.test.cjs','tests/spark-release/owner-emulator.cjs',
    'tests/legacy-uid-inventory/inventory.test.cjs','docs/spark-release/OPERATIONAL-CLOSEOUT.md','docs/spark-release/OWNER-REVIEW-TEMPLATE.json',
    'docs/spark-release/FINAL-PILOT-DECISION.md','docs/spark-release/PRODUCTION-INVENTORY-BASELINE.json',
    'tests/spark-implementation/rules.cjs','docs/spark-implementation/firestore.proposed.rules',
    'docs/spark-release/RELEASE-STEPS.md'])].sort();
const missing=release.filter(f=>!fs.existsSync(path.join(root,f)));if(missing.length)throw Error('Missing explicit release inputs');
const hashes=Object.fromEntries(release.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex')]));
const entrypoints=['registrasi.html','index.html','auth-handler.html','verify-success.html','profil.html','edit-jemaat-administrator.html'];
for(const f of entrypoints){
    const code=fs.readFileSync(path.join(root,f),'utf8');
    if(!code.includes('sipapua-spark-member.js'))throw Error('Missing Spark lifecycle dependency: '+f);
    for(const m of code.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
        if(!/\bsrc\s*=|application\/ld\+json|application\/json|type\s*=\s*["']module/i.test(m[1]))new vm.Script(m[2],{filename:f});
    }
    for(const m of code.matchAll(/<script[^>]+src=["']([^"']+)["']/g)){
        if(!/^(https?:|\/\/)/.test(m[1])&&!fs.existsSync(path.join(root,m[1])))throw Error('Missing local script dependency: '+f);
    }
}
for(const f of ['registrasi.html','sipapua-registration.js','sipapua-member-session.js','sipapua-login.js','sipapua-spark-member.js','sipapua-spark-registration.js']){
    if(/\.httpsCallable\s*\(|\.functions\s*\(/.test(fs.readFileSync(path.join(root,f),'utf8')))throw Error('Functions dependency in new release path: '+f);
}
if(entrypoints.some(f=>fs.readFileSync(path.join(root,f),'utf8').includes('sipapua-legacy-linking.js')))throw Error('Unsafe legacy linking must remain unloaded');
const tested=JSON.parse(fs.readFileSync(path.join(root,'tests/spark-release/result.json'),'utf8'));
const resultBytes=fs.readFileSync(path.join(root,'tests/spark-release/registration-results.txt'));
const registrationResult=resultBytes.toString(resultBytes[0]===255&&resultBytes[1]===254?'utf16le':'utf8').match(/^RESULT (\d+) PASS;/m);
if(!registrationResult||Number(registrationResult[1])!==26)throw Error('Missing baseline registration evidence');
const closeoutPath=path.join(root,'tests/spark-release/ownership-result.json');
const closeout=fs.existsSync(closeoutPath)?JSON.parse(fs.readFileSync(closeoutPath,'utf8')):null;
const ownershipPass=closeout?.failed===0&&closeout.securityBlockerClosed===true
    &&closeout.rulesSha256===hashes['docs/spark-release/firestore.proposed.rules']
    &&closeout.clientSha256===hashes['sipapua-spark-registration.js'];
const securityPass=ownershipPass;
const ownerResultPath=path.join(root,'tests/spark-release/owner-emulator-result.json');
const ownerOperations=fs.existsSync(ownerResultPath)?JSON.parse(fs.readFileSync(ownerResultPath,'utf8')):null;
const productionBaseline=JSON.parse(fs.readFileSync(path.join(directory,'PRODUCTION-INVENTORY-BASELINE.json'),'utf8'));
fs.writeFileSync(path.join(directory,'COMMIT-PATHS.txt'),release.join('\n')+'\n');
fs.writeFileSync(path.join(directory,'MANIFEST.json'),JSON.stringify({generatedAt:new Date().toISOString(),head:git('rev-parse','HEAD').trim(),
    files:hashes,excludedUntracked:untracked.filter(f=>!release.includes(f)),excludedTrackedChanges:changed.filter(f=>!release.includes(f)),
    historicalLocalClientTests:tested,historicalRegistrationRulesTests:Number(registrationResult[1]),ownershipCloseout:closeout,ownerOperations,ownerReportedProductionBaseline:productionBaseline,
    securityGate:securityPass?'PASS_SCOPED_LOCAL':'FAIL',baselineSuitesRerunForCloseout:false,functionsNeededByNewPath:false,legacyLinkingEnabled:false,
    productionGates:{inventory:'OWNER_CONFIRMED_COMPLETE_READ_VERIFIED',uidOwnershipIndex:'INVENTORIED_EMPTY_NO_CLEAR_ISSUED',existingProfileReconciliation:'8_CASES_PENDING',pilotIdentity:'NOT_APPROVED',registryLedgerReadiness:'UNKNOWN',realEnterpriseAttestation:'NOT_VERIFIED',currentCloudRulesBackup:'NOT_CAPTURED',currentPagesRevision:'NOT_VERIFIED'},
    deploymentAuthorized:false,readyForGoLive:false},null,2)+'\n');
console.log('LOCAL REVIEW MANIFEST READY. Scoped security gate: '+(securityPass?'PASS':'FAIL')+'. Production GO LIVE BLOCKED; no Git or cloud mutations performed.');
