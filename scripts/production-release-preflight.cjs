'use strict';
// Owner-approved deployment preflight. Credentials stay in trusted helper/process memory.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const {cloudBackup}=require('./check-activation-release.cjs'),{tokenFromGcloud}=require('./legacy-uid-inventory.cjs');
const root=path.resolve(__dirname,'..'),project='boby-apps-project';
const directory=path.join(root,'docs/activation-restoration/deployment-20261114');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function main(){
  const report={checkedAt:new Date().toISOString(),status:'BLOCKED',productionMutations:0};
  try{
    const env={...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never'};
    try{
      const credential=execFileSync('git',['-c','credential.interactive=never','credential','fill'],{input:'protocol=https\nhost=github.com\n\n',encoding:'utf8',env,windowsHide:true,timeout:20000,stdio:['pipe','pipe','ignore']});
      const password=credential.split(/\r?\n/).find(line=>line.startsWith('password='))?.slice(9);
      if(!password)throw Error();
      const r=await fetch('https://api.github.com/repos/imadebobydaniel-ai/sistem-informasi-pondok-pemulihan-papua',{method:'GET',redirect:'error',headers:{Authorization:'Bearer '+password,Accept:'application/vnd.github+json','User-Agent':'SIPAPUA-approved-release'},signal:AbortSignal.timeout(15000)});
      const metadata=r.ok?await r.json():{};report.gitCredentialHttpStatus=r.status;report.gitCredentialCanPush=metadata.permissions?.push===true;
    }catch{report.gitCredentialCanPush=false;}
    const gcloudBin=path.join(process.env.LOCALAPPDATA,'Google/Cloud SDK/google-cloud-sdk/bin');process.env.PATH=gcloudBin+path.delimiter+process.env.PATH;
    const token=tokenFromGcloud();
    report.cloud=await cloudBackup(path.join(directory,'predeploy-cloud'),globalThis.fetch,token);
    const actual=fs.readFileSync(path.join(directory,'predeploy-cloud/production-backup/firestore.pre-release.rules'));
    report.productionRulesUnchanged=hash(actual)==='ffd1e91aa3c15657715e5695a0cc9687634cbb6639222c992c1af141ff404e17';
    const requested=['firebaserules.rulesets.create','firebaserules.releases.update','firebaserules.releases.get','datastore.entities.get','datastore.entities.update'];
    const iam=await fetch('https://cloudresourcemanager.googleapis.com/v1/projects/'+project+':testIamPermissions',{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Goog-User-Project':project},body:JSON.stringify({permissions:requested}),signal:AbortSignal.timeout(15000)});
    const permissions=iam.ok?(await iam.json()).permissions||[]:[];report.iamPreflightHttpStatus=iam.status;report.requiredIamPermissionsPresent=requested.every(p=>permissions.includes(p));
    try{
      const cli=path.join(process.env.APPDATA,'npm/node_modules/firebase-tools/lib/bin/firebase.js');
      const output=execFileSync(process.execPath,[cli,'projects:list','--json','--non-interactive'],{encoding:'utf8',windowsHide:true,timeout:60000,stdio:['ignore','pipe','ignore']});
      const result=JSON.parse(output);report.firebaseCliProjectVisible=Array.isArray(result.result)&&result.result.some(p=>p.projectId===project&&String(p.projectNumber)==='125984859692');
    }catch{report.firebaseCliProjectVisible=false;}
    if(report.gitCredentialCanPush&&report.productionRulesUnchanged&&report.requiredIamPermissionsPresent&&report.firebaseCliProjectVisible&&report.cloud.countersPresentAndValid&&report.cloud.enterpriseBindingMatches&&report.cloud.pagesDomainAllowed)report.status='PASS';
  }catch{report.category='PREFLIGHT_UNAVAILABLE_NO_RAW_DETAILS';}
  fs.writeFileSync(path.join(directory,'PREDEPLOY.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
main().catch(()=>{console.log('PREFLIGHT_FAILED_NO_RAW_DETAILS');process.exitCode=1;});
