'use strict';
// Metadata GETs only. Never refresh or persist credentials; no data APIs.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const root=path.resolve(__dirname,'../..');
async function main(){
    const result={checkedAt:new Date().toISOString(),localSiteKeyConfigured:false,status:'BLOCKED',productionMutations:0};
    const source=fs.readFileSync(path.join(root,'sipapua-app-check.js'),'utf8');
    result.localSiteKeyConfigured=!/siteKey:\s*null/.test(source);
    let accounts;
    try{accounts=require(path.join(os.homedir(),'AppData/Roaming/npm/node_modules/firebase-tools/lib/auth.js')).getAllAccounts();}
    catch(error){result.reason=error.code==='EPERM'?'CLI credential metadata is not readable in sandbox':'CLI authorization unavailable';console.log(JSON.stringify(result));process.exitCode=2;return;}
    result.localCliAccountCount=accounts.length;
    const account=accounts.find(a=>a.tokens?.access_token&&Number(a.tokens.expires_at)>Date.now()+30000);
    if(!account){result.reason='No unexpired cached CLI access token; no refresh/login or production change attempted';console.log(JSON.stringify(result));process.exitCode=2;return;}
    const project='125984859692',app='1:125984859692:web:09f75df5d2e4b6e3bcd389';
    const urls=[['recaptcha','https://firebaseappcheck.googleapis.com/v1/projects/'+project+'/apps/'+encodeURIComponent(app)+'/recaptchaV3Config'],['services','https://firebaseappcheck.googleapis.com/v1/projects/'+project+'/services']];
    result.metadata={};
    for(const [name,url]of urls){
        const response=await fetch(url,{method:'GET',redirect:'error',headers:{Authorization:'Bearer '+account.tokens.access_token},signal:AbortSignal.timeout(15000)});
        const data=await response.json();
        result.metadata[name]={httpStatus:response.status};
        if(response.ok&&name==='recaptcha')result.metadata[name].siteSecretSet=data.siteSecretSet===true;
        if(response.ok&&name==='services')result.metadata[name].services=(data.services||[]).map(s=>({name:s.name,enforcementMode:s.enforcementMode}));
    }
    result.reason='Read-only cloud metadata checked; a legitimate client site key and domain validation are still required';
    console.log(JSON.stringify(result));process.exitCode=2;
}
main().catch(()=>{console.log(JSON.stringify({status:'BLOCKED',reason:'Read-only App Check metadata request unavailable; no production mutations attempted'}));process.exitCode=2;});
