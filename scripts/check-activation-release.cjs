'use strict';
// Release packaging and opt-in GET-only configuration/public-code reads.
// Never stages, deploys, invokes Functions, or reads member profiles.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm');
const {PROJECT,tokenFromGcloud}=require('./legacy-uid-inventory.cjs');
const root=path.resolve(__dirname,'..'),site='https://imadebobydaniel-ai.github.io/sistem-informasi-pondok-pemulihan-papua/';
const app='1:125984859692:web:09f75df5d2e4b6e3bcd389',number='125984859692',key='6LcepNEtAAAAAFuRFqJWbzCbkdWXzKYf_xr7kQ_i';
const entries=['registrasi.html','index.html','menu.html','profil.html','edit-jemaat-administrator.html','database-jemaat.html','setting.html','auth-handler.html','verify-success.html'];
const normalize=x=>x.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
function publishMaintenance(source){
    if(!source.includes('registration: true, memberCard: true'))throw Error('MAINTENANCE_SOURCE_NOT_EXPECTED');
    return source.replace('registration: true, memberCard: true','registration: false, memberCard: true');
}
function inputs(){
    const files=new Set(entries),queue=[...entries];
    // Shared profile reader helpers require their existing consumer pages to
    // ship together; otherwise a remaining email query can break with private Rules.
    for(const file of fs.readdirSync(root).filter(f=>f.endsWith('.html'))){const source=fs.readFileSync(path.join(root,file),'utf8');
        if((source.includes('sipapua-member-session.js')||source.includes('sipapua-registration.js'))&&!files.has(file)){files.add(file);queue.push(file);}}
    while(queue.length){const file=queue.shift(),source=fs.readFileSync(path.join(root,file),'utf8');
        for(const m of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
            const src=/\bsrc\s*=\s*["']([^"']+)["']/i.exec(m[1]);
            if(src){if(/^(https?:|\/\/)/.test(src[1]))continue;const name=path.posix.normalize(path.posix.join(path.posix.dirname(file),src[1].split('?')[0]));
                if(name.startsWith('../')||path.isAbsolute(name)||!fs.existsSync(path.join(root,name)))throw Error('MISSING_RELEASE_DEPENDENCY');
                if(!files.has(name)){files.add(name);queue.push(name);}
            }else if(!/application\/(ld\+)?json|type\s*=\s*["']module/i.test(m[1]))new vm.Script(m[2],{filename:file});
        }
    }
    // The existing registration form reads the already prepared geography assets.
    function walk(dir){for(const e of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){const f=dir+'/'+e.name;if(e.isDirectory())walk(f);else if(f.endsWith('.json'))files.add(f);}}
    if(fs.existsSync(path.join(root,'assets/wilayah/v2')))walk('assets/wilayah/v2');
    return [...files].sort();
}
async function cloudBackup(directory,fetchImpl,token){
    const statuses={};
    async function get(name,url){
        const u=new URL(url);if(!['firebaserules.googleapis.com','firebaseappcheck.googleapis.com','recaptchaenterprise.googleapis.com','firestore.googleapis.com'].includes(u.hostname)||u.protocol!=='https:')throw Error('METADATA_TARGET_NOT_ALLOWED');
        if(u.hostname==='firestore.googleapis.com'&&!/^\/v1\/projects\/boby-apps-project\/databases\/\(default\)\/documents\/(registration_control\/state|nij_counters\/(Abepura|Sentani|Doyo|ARS1|ARS2))$/.test(u.pathname))throw Error('METADATA_TARGET_NOT_ALLOWED');
        const r=await fetchImpl(url,{method:'GET',headers:{Authorization:'Bearer '+token,'X-Goog-User-Project':PROJECT},redirect:'error',signal:AbortSignal.timeout(15000)});
        statuses[name]=r.status;if(!r.ok)return null;return r.json();
    }
    const release=await get('rulesRelease',`https://firebaserules.googleapis.com/v1/projects/${PROJECT}/releases/cloud.firestore`);
    let rulesBackup=false,rulesMatch=false;
    if(release?.rulesetName&&new RegExp('^projects/'+PROJECT+'/rulesets/[A-Za-z0-9_-]+$').test(release.rulesetName)){
        const r=await get('ruleset','https://firebaserules.googleapis.com/v1/'+release.rulesetName),files=r?.source?.files;
        const source=Array.isArray(files)&&files.length===1?files[0]:null;
        if(typeof source?.content==='string'){
            const backup=path.join(directory,'production-backup');fs.mkdirSync(backup,{recursive:true});
            fs.writeFileSync(path.join(backup,'firestore.pre-release.rules'),source.content,{flag:'wx'});
            fs.writeFileSync(path.join(backup,'firebase.rollback.json'),JSON.stringify({firestore:{rules:'firestore.pre-release.rules'}},null,2),{flag:'wx'});
            rulesBackup=true;rulesMatch=normalize(source.content).trim()===normalize(fs.readFileSync(path.join(root,'docs/activation-restoration/firestore.proposed.rules'),'utf8')).trim();
        }
    }
    const binding=await get('enterpriseBinding',`https://firebaseappcheck.googleapis.com/v1/projects/${number}/apps/${encodeURIComponent(app)}/recaptchaEnterpriseConfig`);
    const recaptcha=await get('enterpriseDomains',`https://recaptchaenterprise.googleapis.com/v1/projects/${PROJECT}/keys/${key}`);
    const service=await get('firestoreEnforcement',`https://firebaseappcheck.googleapis.com/v1/projects/${number}/services/firestore.googleapis.com`);
    const state=await get('registrationState',`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/registration_control/state?mask.fieldPaths=enabled&mask.fieldPaths=maintenance&mask.fieldPaths=version`);
    const counters=[];for(const region of ['Abepura','Sentani','Doyo','ARS1','ARS2']){
        const c=await get('counter-'+region,`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/nij_counters/${region}?mask.fieldPaths=last`);
        const n=Number(c?.fields?.last?.integerValue);counters.push(c!==null&&Number.isSafeInteger(n)&&n>=0&&n<999999999);
    }
    return{httpStatuses:statuses,rulesBackupCaptured:rulesBackup,rulesIdenticalToProposal:rulesMatch,
        enterpriseBindingMatches:binding?.siteKey===key,pagesDomainAllowed:recaptcha?.webSettings?.allowedDomains?.includes('imadebobydaniel-ai.github.io')===true,
        enterpriseScoreBased:recaptcha?.webSettings?.integrationType==='SCORE',firestoreEnforcement:service?.enforcementMode||'UNKNOWN',
        registryStateReady:state?.fields?.enabled?.booleanValue===true&&state.fields.maintenance?.booleanValue===false&&state.fields.version?.stringValue==='original-spark-v1',
        countersPresentAndValid:counters.every(Boolean),realAttestationVerified:false,oldReaderCompatibilityVerified:false};
}
async function publicBackup(directory,fetchImpl){
    const backup=path.join(directory,'public-backup');fs.mkdirSync(backup,{recursive:true});const records=[];
    for(const file of [...entries,'sipapua-maintenance.js','sipapua-registration.js','sipapua-spark-member.js','sipapua-spark-registration.js','sipapua-member-session.js','sipapua-login.js','sipapua-app-check.js']){
        const r=await fetchImpl(new URL(file,site).href,{method:'GET',credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)});
        if(r.status!==200){records.push({file,status:r.status});continue;}
        const code=await r.text();fs.writeFileSync(path.join(backup,file),code,{flag:'wx'});
        records.push({file,status:200,sha256:hash(normalize(code)),sameAsLocal:hash(normalize(code))===hash(normalize(fs.readFileSync(path.join(root,file),'utf8'))),
            directEmailProfileQuery:/collection\s*\(\s*["']users["']\s*\)\s*\.\s*where\s*\(\s*["']email["']/.test(code),
            blocksUnverifiedLogin:file==='index.html'&&code.includes('if (!user.emailVerified)'),
            legacyStatusEditorWithoutAudit:file==='edit-jemaat-administrator.html'&&code.includes('status_akun')&&!code.includes('activateMemberFromExistingEditor')});
    }
    return{records,existingEntrypointBackupComplete:records.filter(r=>entries.includes(r.file)).every(r=>r.status===200),publicSourceBackupComplete:records.every(r=>r.status===200),liveUserFlowTested:false,publishedRevisionVerified:false};
}
async function main(){
    const args=process.argv.slice(2);if(args.some(x=>!['--cloud-read-only','--public-read-only','--reuse-evidence','--minimal-rules'].includes(x)))throw Error('UNKNOWN_RELEASE_CHECK_ARGUMENT');
    const latestFile=path.join(root,'docs/activation-restoration/LATEST-RELEASE-CHECK.txt');
    const previous=args.includes('--reuse-evidence')&&fs.existsSync(latestFile)?path.resolve(root,fs.readFileSync(latestFile,'utf8').trim()):null;
    const directory=path.join(root,'docs/activation-restoration/release-check',new Date().toISOString().replace(/[:.]/g,'-'));
    const payload=path.join(directory,'payload');fs.mkdirSync(payload,{recursive:true});const files=inputs(),manifest=[];
    for(const file of files){const raw=fs.readFileSync(path.join(root,file));const data=file==='sipapua-maintenance.js'?Buffer.from(publishMaintenance(raw.toString('utf8'))):raw;
        const out=path.join(payload,file);fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,data,{flag:'wx'});
        manifest.push({file,sourceSha256:hash(raw),payloadSha256:hash(data),sourceChanged:false,releaseOnlyMaintenanceOverride:file==='sipapua-maintenance.js'});
    }
    const report={createdAt:new Date().toISOString(),status:'BLOCKED',baseline:'ACTIVATION RESTORATION 19 PASS',files:manifest,
        sourceMaintenanceRemainsEnabled:true,payloadRegistrationMaintenance:false,memberCardMaintenanceUnchanged:true,
        cloud:{status:'NOT_READ'},public:{status:'NOT_READ'},live:false,mutations:0,blockers:[]};
    if(previous){
        const boundary=path.join(root,'docs/activation-restoration/release-check')+path.sep;
        if(!previous.startsWith(boundary))throw Error('EVIDENCE_PATH_NOT_ALLOWED');
        const saved=JSON.parse(fs.readFileSync(path.join(previous,'MANIFEST.json'),'utf8'));
        report.cloud=saved.cloud;report.public=saved.public;report.evidenceSource=path.relative(root,previous);report.evidenceRecordedAt=saved.evidenceRecordedAt||saved.createdAt;
        for(const name of ['public-backup','production-backup'])if(fs.existsSync(path.join(previous,name)))fs.cpSync(path.join(previous,name),path.join(directory,name),{recursive:true,errorOnExist:true,force:false});
    }
    if(args.includes('--cloud-read-only'))try{report.cloud=await cloudBackup(directory,globalThis.fetch,tokenFromGcloud());}catch(e){report.cloud={status:e.code==='OFFICIAL_GCLOUD_AUTH_UNAVAILABLE'?'OFFICIAL_AUTH_UNAVAILABLE':'METADATA_READ_UNAVAILABLE'};}
    if(args.includes('--public-read-only'))try{report.public=await publicBackup(directory,globalThis.fetch);}catch(_){report.public={status:'PUBLIC_NETWORK_UNAVAILABLE'};}
    if(!report.cloud.rulesBackupCaptured)report.blockers.push('CURRENT_PRODUCTION_RULES_NOT_BACKED_UP_OR_COMPARED');
    if(!report.cloud.realAttestationVerified)report.blockers.push('REAL_ENTERPRISE_TOKEN_AND_CLIENT_READ_NOT_VERIFIED');
    if(!report.cloud.registryStateReady||!report.cloud.countersPresentAndValid)report.blockers.push('REGISTRY_READINESS_NOT_CONFIRMED');
    if(!report.cloud.oldReaderCompatibilityVerified||!report.public.liveUserFlowTested)report.blockers.push('OLD_PUBLIC_READER_COMPATIBILITY_NOT_VERIFIED');
    const rulesInput=args.includes('--minimal-rules')?'docs/activation-restoration/firestore.minimal.rules':'docs/activation-restoration/firestore.proposed.rules';
    report.rulesInput=rulesInput;
    report.rulesSha256=hash(fs.readFileSync(path.join(root,rulesInput)));
    if(args.includes('--minimal-rules'))report.localCompatibility={resultFile:'tests/activation-restoration/minimal-result.json',productionRuntimeVerified:false};
    fs.writeFileSync(path.join(directory,'MANIFEST.json'),JSON.stringify(report,null,2));
    fs.writeFileSync(path.join(directory,'FILES.txt'),files.join('\n')+'\n');
    const frozenRules=fs.readFileSync(path.join(root,rulesInput));
    fs.mkdirSync(path.join(directory,'rules'),{recursive:true});fs.writeFileSync(path.join(directory,'rules/firestore.proposed.rules'),frozenRules,{flag:'wx'});
    fs.writeFileSync(path.join(directory,'firebase.release.json'),JSON.stringify({firestore:{rules:'rules/firestore.proposed.rules'}},null,2));
    fs.writeFileSync(latestFile,path.relative(root,directory));
    console.log(JSON.stringify({status:report.status,releaseFiles:files.length,cloud:report.cloud.status||'READ',public:report.public.status||'READ',blockers:report.blockers,productionMutations:0}));
}
module.exports={publishMaintenance,inputs,cloudBackup,publicBackup};
if(require.main===module)main().catch(()=>{console.error('RELEASE_CHECK_FAILED_NO_RAW_DETAILS');process.exitCode=1;});
