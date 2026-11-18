'use strict';
// Source/configuration GETs only. No member, message, friendship or location reads.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..'),site='https://imadebobydaniel-ai.github.io/sistem-informasi-pondok-pemulihan-papua/';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),normal=s=>s.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n');
async function main(){
  const report={checkedAt:new Date().toISOString(),productionMutations:0,pages:[]};
  for(const file of ['lacak-domba.html','chat.html','kontak.html']){
    const r=await fetch(site+file,{method:'GET',redirect:'error',headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(20000)});
    const source=r.ok?await r.text():'';
    report.pages.push({file,httpStatus:r.status,sha256:hash(source),matchesLocal:r.ok&&normal(source)===normal(fs.readFileSync(path.join(root,file),'utf8')),
      usesSupabaseDiscoveryEndpoint:source.includes('lacak-domba-nearby'),usesLegacyNearbyCallable:source.includes('findNearbyMembers'),
      usesMutualChats:source.includes('mutual_chats'),usesContacts:source.includes('contacts'),usesFriendRequests:source.includes('friend_requests')});
    if(r.ok)fs.writeFileSync(path.join(__dirname,'public-'+file+'.snapshot'),source,{flag:'wx'});
  }
  process.env.PATH=path.join(process.env.LOCALAPPDATA,'Google/Cloud SDK/google-cloud-sdk/bin')+path.delimiter+process.env.PATH;
  const token=require(path.join(root,'scripts/legacy-uid-inventory.cjs')).tokenFromGcloud();
  async function get(url){const r=await fetch(url,{method:'GET',redirect:'error',headers:{Authorization:'Bearer '+token,'X-Goog-User-Project':'boby-apps-project'},signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error();return r.json();}
  const release=await get('https://firebaserules.googleapis.com/v1/projects/boby-apps-project/releases/cloud.firestore');
  if(!/^projects\/boby-apps-project\/rulesets\/[A-Za-z0-9_-]+$/.test(release.rulesetName))throw Error();
  const rules=await get('https://firebaserules.googleapis.com/v1/'+release.rulesetName);if(rules.source.files.length!==1)throw Error();
  const content=rules.source.files[0].content;fs.writeFileSync(path.join(__dirname,'firebase.production.rules'),content,{flag:'wx'});
  report.firebaseRulesSha256=hash(content);report.firebaseRulesUnchangedSinceRelease=report.firebaseRulesSha256==='e75a7ca471ed8eae101cbfe229ef8f992efb9abc0979edfae9048369a4f19525';
  fs.writeFileSync(path.join(__dirname,'PUBLIC-CONTRACT.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
main().catch(()=>{console.log('PUBLIC_CONTRACT_READ_UNAVAILABLE_NO_RAW_DETAILS');process.exitCode=1;});
