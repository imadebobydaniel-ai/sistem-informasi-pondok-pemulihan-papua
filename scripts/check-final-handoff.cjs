'use strict';
// Local integrity/coverage check only; does not run registration/activation suites.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {inputs}=require('./check-activation-release.cjs');
const root=path.resolve(__dirname,'..'),base=path.join(root,'docs/activation-restoration');
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
function main(){
  const relative=fs.readFileSync(path.join(base,'LATEST-RELEASE-CHECK.txt'),'utf8').trim(),dir=path.resolve(root,relative);
  assert.ok(dir.startsWith(path.join(base,'release-check')+path.sep));
  const manifest=JSON.parse(fs.readFileSync(path.join(dir,'MANIFEST.json')));
  const listed=fs.readFileSync(path.join(dir,'FILES.txt'),'utf8').trim().split(/\r?\n/);
  assert.deepEqual(listed,[...inputs()].sort());assert.deepEqual(manifest.files.map(f=>f.file),listed);
  for(const f of manifest.files){
    assert.ok(!path.isAbsolute(f.file)&&!f.file.split(/[\\/]/).includes('..'));
    assert.equal(hash(fs.readFileSync(path.join(dir,'payload',f.file))),f.payloadSha256,f.file+' payload');
    assert.equal(hash(fs.readFileSync(path.join(root,f.file))),f.sourceSha256,f.file+' source drift');
  }
  const required=['registrasi.html','auth-handler.html','verify-success.html','index.html','database-jemaat.html','edit-jemaat-administrator.html'];
  for(const file of required)assert.ok(listed.includes(file));
  const editor=fs.readFileSync(path.join(dir,'payload/edit-jemaat-administrator.html'),'utf8');
  assert.ok(editor.includes('saveExistingAccountStatus(updateData.status_akun)'));
  assert.ok(editor.includes('activation_identity_confirmed'));
  const rules=fs.readFileSync(path.join(dir,'rules/firestore.proposed.rules'));
  assert.equal(hash(rules),hash(fs.readFileSync(path.join(base,'firestore.minimal.rules'))));
  const backup=fs.readFileSync(path.join(dir,'production-backup/firestore.pre-release.rules'));
  assert.equal(hash(backup),hash(fs.readFileSync(path.join(base,'release-check/2026-11-14T03-52-44-934Z/production-backup/firestore.pre-release.rules'))));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'production-backup/firebase.rollback.json'))).firestore.rules,'firestore.pre-release.rules');
  const archive=path.join(base,'handoff/pages-source-8fdc6cc65ab2ff112501b0f047ceaf509ea6f76a.zip');
  const paused=fs.readFileSync(path.join(root,'sipapua-maintenance.js'));
  assert.ok(paused.toString().includes('registration: true, memberCard: true'));
  const pausedPath=path.join(base,'handoff/sipapua-maintenance.paused.js');
  if(fs.existsSync(pausedPath))assert.equal(hash(fs.readFileSync(pausedPath)),hash(paused),'Existing phase file must be preserved');
  else fs.writeFileSync(pausedPath,paused,{flag:'wx'});
  const result={checkedAt:new Date().toISOString(),status:'READY',release:relative,releaseFileCount:listed.length,
    completeAllowlist:true,payloadHashesValid:true,sourceHashesUnchanged:true,requiredPages:required,statusDropdownIncluded:true,
    manifestSha256:hash(fs.readFileSync(path.join(dir,'MANIFEST.json'))),rulesSha256:hash(rules),productionRulesBackupSha256:hash(backup),
    rollbackSourceCommit:'8fdc6cc65ab2ff112501b0f047ceaf509ea6f76a',rollbackSourceArchiveSha256:hash(fs.readFileSync(archive)),
    pausedPhaseFileSha256:hash(paused),browserProbeSha256:hash(fs.readFileSync(path.join(base,'enterprise-browser-readonly.js'))),productionMutations:0};
  fs.writeFileSync(path.join(base,'FINAL-HANDOFF-CHECKS.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
main();
