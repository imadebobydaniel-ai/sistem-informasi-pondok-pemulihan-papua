import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync,readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {withRecoveryEmulators} from './emulators.mjs';

const require=createRequire(import.meta.url);

function service(s, account, factory) {
  const ref=path=>{
    const raw=s.doc(account.db,path);
    return {raw};
  };
  const compat={
    collection:name=>({doc:id=>ref(name+'/'+id)}),
    runTransaction:fn=>s.runTransaction(account.db,tx=>fn({
      get:async r=>{
        const snap=await tx.get(r.raw);
        return {exists:snap.exists(),data:()=>snap.data()};
      },
      set:(r,data)=>tx.set(r.raw,data),delete:r=>tx.delete(r.raw)
    }))
  };
  return factory.create(compat,account.auth,s.serverTimestamp);
}
function dashboardBulk(page,ids,service) {
  const start=page.indexOf('    async function bulkDelete()');
  const end=page.indexOf('    function generateMemberCards()',start);
  assert.ok(start>=0 && end>start);
  const messages=[];
  return {messages,execute:()=>runInNewContext(page.slice(start,end)+'\nbulkDelete()',{
    canDeleteAdminData:()=>true,confirm:()=>true,alert:value=>messages.push(value),
    updateActionMenu(){},originalRegistrationService:()=>service,console:{error(){}},
    document:{querySelectorAll:()=>ids.map(value=>({value})),getElementById:()=>null}
  })};
}

test('recovery: baseline denial and repaired audited deletion on Firebase Auth/Firestore Emulator',{timeout:90000},async t=>{
  const e=await withRecoveryEmulators(t);
  const s=e.firestore;
  const patch=join(e.root,'candidates/recovery-3-features-01/member-delete.patch');
  for(const file of ['sipapua-spark-member.js','database-jemaat.html'])copyFileSync(join(e.root,file),join(e.scratch,file));
  execFileSync('git',['apply','--ignore-space-change','--include=sipapua-spark-member.js','--include=database-jemaat.html',patch],{cwd:e.scratch});
  const original=require(join(e.root,'sipapua-spark-member.js'));
  const repaired=require(join(e.scratch,'sipapua-spark-member.js'));
  const master=await e.identity('recovery-master');
  const superAdmin=await e.identity('recovery-super');
  const ordinary=await e.identity('recovery-admin');
  const inactive=await e.identity('recovery-inactive');
  let env=await e.init(e.baseRules);
  async function unguarded(task) {return env.withSecurityRulesDisabled(context=>task(context.firestore()));}
  async function seed(path,data){return unguarded(db=>s.setDoc(s.doc(db,path),data));}
  async function get(path){
    let result;
    await unguarded(async db=>{result=(await s.getDoc(s.doc(db,path))).data();});
    return result;
  }
  async function profile(id){return seed('users/'+id,{uid:'synthetic-'+id,nama:'Fixture '+id});}
  for(const [account,role,status] of [[master,'master','active'],[superAdmin,'super_admin','active'],
    [ordinary,'admin','active'],[inactive,'super_admin','inactive']]) {
    await seed('admin_users/'+account.uid,{role,status});
  }
  await profile('baseline');
  await t.test('baseline rejects atomic profile deletion even with active SuperAdmin because audit path is denied',async()=>{
    await assert.rejects(service(s,superAdmin,original).deleteProfiles(['baseline']),{code:'permission-denied'});
    assert.ok(await get('users/baseline'));
    assert.equal(await get('registration_audit/profile-delete_baseline'),undefined);
  });
  await t.test('legacy presence merge fails against validPresence with missing flags or extra fields',async()=>{
    const path='presence/'+superAdmin.uid;
    await seed(path,{legacyField:true,showOnline:false});
    const ref=s.doc(superAdmin.db,path);
    const projection={online:true,lastSeen:s.serverTimestamp(),updatedAt:s.serverTimestamp(),
      displayName:'Synthetic',photoURL:'',komsel:'Demo',wilayah:'Demo'};
    await assert.rejects(s.setDoc(ref,projection,{merge:true}),{code:'permission-denied'});
    assert.deepEqual(await get(path),{legacyField:true,showOnline:false});
  });
  await t.test('private coordinates remain readable only by the authenticated owner',async()=>{
    const path='presence_locations/'+superAdmin.uid;
    await s.setDoc(s.doc(superAdmin.db,path),{latitude:-1,longitude:131,updatedAt:s.serverTimestamp()});
    assert.equal((await s.getDocFromServer(s.doc(superAdmin.db,path))).exists(),true);
    await assert.rejects(s.getDocFromServer(s.doc(ordinary.db,path)),{code:'permission-denied'});
    await assert.rejects(s.setDoc(s.doc(ordinary.db,path),{
      latitude:0,longitude:130,updatedAt:s.serverTimestamp()
    }),{code:'permission-denied'});
  });
  env=await e.init(e.proposedRules);
  await t.test('active SuperAdmin deletes one and Master deletes four with matching atomic audit',async()=>{
    const first=service(s,superAdmin,repaired);
    assert.equal((await first.deleteProfiles(['baseline'])).deleted,true);
    assert.equal(await get('users/baseline'),undefined);
    assert.equal((await get('registration_audit/profile-delete_baseline')).actorUid,superAdmin.uid);
    const ids=['m1','m2','m3','m4'];
    for(const id of ids) await profile(id);
    assert.equal((await service(s,master,repaired).deleteProfiles(ids)).deleted,true);
    for(const id of ids){
      assert.equal(await get('users/'+id),undefined);
      assert.equal((await get('registration_audit/profile-delete_'+id)).actorUid,master.uid);
    }
  });
  await t.test('ordinary or inactive admins, naked delete and orphan audit are denied',async()=>{
    await profile('protected');
    for(const user of [ordinary,inactive]){
      await assert.rejects(service(s,user,repaired).deleteProfiles(['protected']),{code:'permission-denied'});
    }
    await assert.rejects(s.deleteDoc(s.doc(master.db,'users/protected')),{code:'permission-denied'});
    await assert.rejects(s.setDoc(s.doc(master.db,'registration_audit/profile-delete_protected'),{
      action:'profile-delete',actorUid:master.uid,targetUid:'synthetic-protected',profileId:'protected',createdAt:s.serverTimestamp()
    }),{code:'permission-denied'});
    assert.ok(await get('users/protected'));
  });
  await t.test('actual dashboard bulk action reports only confirmed groups on a denied second group',async()=>{
    const ids=['b1','b2','b3','b4','blocked','also-blocked'];
    for(const id of ids) await profile(id);
    // Reusing an existing audit is not allowed; it makes only the second group abort.
    await seed('registration_audit/profile-delete_blocked',{action:'synthetic-preexisting'});
    const page=readFileSync(join(e.scratch,'database-jemaat.html'),'utf8');
    const base=service(s,master,repaired);
    const action=dashboardBulk(page,ids,{async deleteProfiles(group){
      assert.equal(action.messages.length,0);
      return base.deleteProfiles(group);
    }});
    await action.execute();
    assert.equal(action.messages.length,1);
    assert.match(action.messages[0],/terkonfirmasi: 4 dari 6/);
    for(const id of ids.slice(0,4)) assert.equal(await get('users/'+id),undefined);
    for(const id of ids.slice(4)) assert.ok(await get('users/'+id));
    assert.equal(await get('registration_audit/profile-delete_also-blocked'),undefined);
  });
  assert.deepEqual(readFileSync(join(e.root,'firestore.rules')),e.activeRules);
});
