'use strict';
const {execFileSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
async function main(){
  const result={checkedAt:new Date().toISOString(),status:'BLOCKED',productionMutations:0};
  try{
    const credential=execFileSync('git',['-c','credential.interactive=never','credential','fill'],{input:'protocol=https\nhost=github.com\nusername=imadebobydaniel-ai\n\n',encoding:'utf8',windowsHide:true,timeout:20000,env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never'},stdio:['pipe','pipe','ignore']});
    const token=credential.split(/\r?\n/).find(line=>line.startsWith('password='))?.slice(9);if(!token)throw Error();
    const response=await fetch('https://api.github.com/repos/imadebobydaniel-ai/sistem-informasi-pondok-pemulihan-papua',{method:'GET',redirect:'error',headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','User-Agent':'SIPAPUA-approved-release'},signal:AbortSignal.timeout(15000)});
    const metadata=response.ok?await response.json():{};result.httpStatus=response.status;result.canPush=metadata.permissions?.push===true;
    if(result.canPush)result.status='PASS';else result.category='GITHUB_WRITE_ACCESS_UNAVAILABLE';
  }catch{result.category='OFFICIAL_GIT_CREDENTIAL_UNAVAILABLE';}
  fs.writeFileSync(path.resolve(__dirname,'../docs/activation-restoration/deployment-20261114/GITHUB-AUTH.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
main().catch(()=>{console.log('GITHUB_AUTH_CHECK_UNAVAILABLE_NO_RAW_DETAILS');process.exitCode=1;});
