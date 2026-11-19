'use strict';
// Official configuration GETs only, using an existing unexpired CLI token.
// Never log/refresh tokens, authenticate a user, invoke mutations, or read profiles.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..');
const project='boby-apps-project',number='125984859692',app='1:125984859692:web:09f75df5d2e4b6e3bcd389';
const key='6LcepNEtAAAAAFuRFqJWbzCbkdWXzKYf_xr7kQ_i';
const required=['registrationReadiness','registerSIPAPUAProfile','activateVerifiedSIPAPUAProfile',
    'adminActivateSIPAPUAProfile','memberLoginStatus','lookupSIPAPUAFamily','getSIPAPUAOwnProfile',
    'updateSIPAPUAProfile','deleteSIPAPUAProfiles','auditSIPAPUARegistry','prepareSIPAPUARegistry',
    'enableSIPAPUARegistry','abortSIPAPUARegistry','searchSIPAPUAFamily'];
const report={checkedAt:new Date().toISOString(),decision:'NO-GO',project,webAppId:app,
    appCheckBinding:{status:'BLOCKED'},registry:{status:'BLOCKED'},functions:{status:'BLOCKED'},
    deployedRules:{status:'BLOCKED'},realTokenAcquired:false,productionMutations:0};
function save(){const dir=path.join(root,'docs/app-check-enterprise');fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'FINAL-GATE.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report,null,2));process.exitCode=2;}
async function main(){
    let accounts;
    try{accounts=require(path.join(os.homedir(),'AppData/Roaming/npm/node_modules/firebase-tools/lib/auth.js')).getAllAccounts();}
    catch(_){report.reason='Official CLI authorization metadata unavailable';save();return;}
    report.localCliAccountCount=accounts.length;
    const account=accounts.find(a=>a.tokens?.access_token&&Number(a.tokens.expires_at)>Date.now()+30000);
    if(!account){report.reason='No unexpired official CLI access token; no login/refresh or cloud GET attempted';save();return;}
    async function get(url){
        const parsed=new URL(url);if(parsed.protocol!=='https:'||!['firebaseappcheck.googleapis.com','firebase.googleapis.com',
            'recaptchaenterprise.googleapis.com','cloudfunctions.googleapis.com','firestore.googleapis.com','firebaserules.googleapis.com'].includes(parsed.hostname))throw Error('Unapproved metadata target');
        const response=await fetch(url,{method:'GET',headers:{Authorization:'Bearer '+account.tokens.access_token},redirect:'error',signal:AbortSignal.timeout(15000)});
        let data;try{data=await response.json();}catch(_){data={};}return{status:response.status,data};
    }
    const requests=[
        ['webApp','https://firebase.googleapis.com/v1beta1/projects/'+project+'/webApps/'+encodeURIComponent(app)],
        ['appCheck','https://firebaseappcheck.googleapis.com/v1/projects/'+number+'/apps/'+encodeURIComponent(app)+'/recaptchaEnterpriseConfig'],
        ['enterpriseKey','https://recaptchaenterprise.googleapis.com/v1/projects/'+project+'/keys/'+key],
        ['functions','https://cloudfunctions.googleapis.com/v2/projects/'+project+'/locations/asia-southeast2/functions?pageSize=1000'],
        ['registry','https://firestore.googleapis.com/v1/projects/'+project+'/databases/(default)/documents/registration_control/state?mask.fieldPaths=enabled&mask.fieldPaths=maintenance&mask.fieldPaths=version'],
        ['rulesRelease','https://firebaserules.googleapis.com/v1/projects/'+project+'/releases/cloud.firestore']
    ];
    const results={};await Promise.all(requests.map(async([name,url])=>{
        try{results[name]=await get(url);}catch(_){results[name]={status:'UNAVAILABLE',data:{}};}
    }));
    report.httpStatus=Object.fromEntries(Object.entries(results).map(([name,r])=>[name,r.status]));
    const w=results.webApp,c=results.appCheck,k=results.enterpriseKey;
    const domains=k.data.webSettings?.allowedDomains||[];
    report.appCheckBinding={status:w.status===200&&c.status===200&&k.status===200&&w.data.appId===app&&c.data.siteKey===key&&
        domains.includes('imadebobydaniel-ai.github.io')&&k.data.webSettings?.integrationType==='SCORE'&&k.data.webSettings?.allowAllDomains!==true?'PASS':'BLOCKED',
        appIdMatches:w.data.appId===app,siteKeyMatches:c.data.siteKey===key,
        pagesDomainListed:domains.includes('imadebobydaniel-ai.github.io'),scoreBased:k.data.webSettings?.integrationType==='SCORE',
        domainValidationDisabled:k.data.webSettings?.allowAllDomains===true};
    const deployed=results.functions.data.functions||[];
    report.functions={status:results.functions.status===200&&!results.functions.data.nextPageToken&&required.every(name=>deployed.some(f=>f.name?.endsWith('/'+name)&&f.state==='ACTIVE'))?'METADATA_PASS_ENFORCEMENT_UNVERIFIED':'BLOCKED',
        required:required.map(name=>{const f=deployed.find(f=>f.name?.endsWith('/'+name));return{name,present:!!f,state:f?.state||null,entryPointMatches:f?.buildConfig?.entryPoint===name};}),
        paginationIncomplete:!!results.functions.data.nextPageToken};
    const fields=results.registry.data.fields||{};
    report.registry={status:results.registry.status===200?'STATE_READ_COUNTERS_UNVERIFIED':'BLOCKED',
        enabled:fields.enabled?.booleanValue??null,maintenance:fields.maintenance?.booleanValue??null,
        expectedVersion:fields.version?.stringValue==='original-spark-v1',counterReadinessVerified:false};
    if(results.rulesRelease.status===200&&typeof results.rulesRelease.data.rulesetName==='string'&&
        results.rulesRelease.data.rulesetName.startsWith('projects/'+project+'/rulesets/')){
        const r=await get('https://firebaserules.googleapis.com/v1/'+results.rulesRelease.data.rulesetName);
        const files=r.data.source?.files||[],source=files.find(f=>f.name==='firestore.rules')||(files.length===1?files[0]:null);
        const normalize=s=>s.replace(/\r\n/g,'\n').trim();
        const proposal=fs.readFileSync(path.join(root,'docs/release-gate-005a/firestore.final-proposed.rules'),'utf8');
        report.deployedRules={status:r.status===200&&source?'READ':'BLOCKED',
            matchesLocalProposal:!!source&&normalize(source.content)===normalize(proposal),
            sourceSha256:source?crypto.createHash('sha256').update(normalize(source.content)).digest('hex'):null};
    }
    report.reason='Configuration GETs do not prove real attestation, deployed enforcement or positive browser E2E';save();
}
main().catch(()=>{report.reason='Read-only gate unavailable; credentials and payloads withheld';save();});
