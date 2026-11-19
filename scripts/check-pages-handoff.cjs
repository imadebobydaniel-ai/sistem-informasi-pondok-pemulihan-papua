'use strict';
// Public metadata/source GETs only; no GitHub/Firebase credentials or mutations.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const repo='imadebobydaniel-ai/sistem-informasi-pondok-pemulihan-papua';
const api='https://api.github.com/repos/'+repo,site='https://imadebobydaniel-ai.github.io/sistem-informasi-pondok-pemulihan-papua/';
async function get(url,json=true){
  const r=await fetch(url,{method:'GET',redirect:'error',headers:{Accept:json?'application/vnd.github+json':'text/plain','User-Agent':'SIPAPUA-readonly-handoff'},signal:AbortSignal.timeout(15000)});
  return {status:r.status,data:r.ok?(json?await r.json():await r.text()):null};
}
async function main(){
  const result={checkedAt:new Date().toISOString(),productionMutations:0};
  const [pages,build,deployments,maintenance]=await Promise.all([get(api+'/pages'),get(api+'/pages/builds/latest'),get(api+'/deployments?environment=github-pages&per_page=3'),get(site+'sipapua-maintenance.js',false)]);
  result.pages={httpStatus:pages.status,buildType:pages.data?.build_type,source:pages.data?.source,status:pages.data?.status};
  result.latestBuild={httpStatus:build.status,commit:build.data?.commit,status:build.data?.status};
  result.deploymentsHttpStatus=deployments.status;result.deployments=[];
  for(const d of deployments.data||[]){const statuses=await get(api+'/deployments/'+d.id+'/statuses?per_page=1');const s=statuses.data?.[0];
    result.deployments.push({id:d.id,sha:d.sha,ref:d.ref,statusHttp:statuses.status,state:s?.state,environmentUrl:s?.environment_url,logUrl:s?.log_url});}
  result.publicMaintenance={httpStatus:maintenance.status,registration:maintenance.data?/registration:\s*(true|false)/.exec(maintenance.data)?.[1]||'UNKNOWN':'UNKNOWN'};
  const sha=result.deployments.find(d=>d.state==='success'&&/^[a-f0-9]{40}$/.test(d.sha))?.sha||result.latestBuild.commit;
  result.publicSourceComparisons=[];
  if(/^[a-f0-9]{40}$/.test(sha||''))for(const file of ['index.html','registrasi.html','edit-jemaat-administrator.html','sipapua-maintenance.js']){
    const [live,source]=await Promise.all([get(site+file,false),get('https://raw.githubusercontent.com/'+repo+'/'+sha+'/'+file,false)]);
    const hash=x=>crypto.createHash('sha256').update(x.replace(/\r\n/g,'\n')).digest('hex');
    result.publicSourceComparisons.push({file,publicStatus:live.status,sourceStatus:source.status,equal:live.data!==null&&source.data!==null&&hash(live.data)===hash(source.data)});
  }
  const out=path.resolve(__dirname,'../docs/activation-restoration/PAGES-HANDOFF-EVIDENCE.json');
  fs.writeFileSync(out,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
main().catch(()=>{console.log('PAGES_READ_UNAVAILABLE_NO_RAW_DETAILS');process.exitCode=1;});
