'use strict';
// Prepare ONLY a separate, clean checkout for review. No commit, push or deploy.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),execution=path.join(root,'docs/activation-restoration/deployment-20261114');
const release=path.join(root,'docs/activation-restoration/release-check/2026-11-14T04-09-56-748Z');
const checkout=path.join(execution,'candidate-review'),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function git(args,dir=root){return execFileSync('git',args,{cwd:dir,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});}
function main(){
  assert.ok(!fs.existsSync(checkout),'Preserve existing review checkout');
  git(['clone','--shared','--no-checkout','--no-hardlinks',root,checkout]);
  git(['checkout','-b','review/minimal-activation-release','8fdc6cc65ab2ff112501b0f047ceaf509ea6f76a'],checkout);
  const manifest=JSON.parse(fs.readFileSync(path.join(release,'MANIFEST.json'))),allow=new Set(manifest.files.map(f=>f.file));
  for(const f of manifest.files){
    const data=fs.readFileSync(path.join(release,'payload',f.file));assert.equal(hash(data),f.payloadSha256);
    const dest=path.resolve(checkout,f.file);assert.ok(dest.startsWith(checkout+path.sep));fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,data);
  }
  fs.copyFileSync(path.join(root,'docs/activation-restoration/handoff/sipapua-maintenance.paused.js'),path.join(checkout,'sipapua-maintenance.js'));
  const pathspec=path.join(execution,'release-allowlist.nul');fs.writeFileSync(pathspec,manifest.files.map(f=>f.file+'\0').join(''));
  git(['add','--pathspec-from-file='+pathspec,'--pathspec-file-nul'],checkout);
  const changed=git(['diff','--cached','--name-only','-z'],checkout).split('\0').filter(Boolean);
  assert.ok(changed.length>0&&changed.every(f=>allow.has(f)));
  git(['diff','--cached','--check'],checkout);
  const review={base:'8fdc6cc65ab2ff112501b0f047ceaf509ea6f76a',changedFileCount:changed.length,changedFiles:changed,allChangesAllowlisted:true,registrationRemainsPaused:true,commits:0,pushes:0,productionMutations:0};
  fs.writeFileSync(path.join(execution,'RELEASE-DIFF-REVIEW.json'),JSON.stringify(review,null,2));
  git(['diff','--cached','--binary','--output='+path.join(execution,'RELEASE-DIFF.patch')],checkout);
  console.log(JSON.stringify({changedFileCount:changed.length,allChangesAllowlisted:true,commits:0,pushes:0,productionMutations:0}));
}
main();
