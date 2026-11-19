'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
module.exports=async({check,auth,authSDK,s,seed,inspect,reg,database,env,wrap,member,root})=>{
  await check('unrelated production Rules remain byte-identical outside replacement scope',async()=>{
    const {build}=require('../../scripts/build-minimal-activation-rules.cjs');
    assert.equal(fs.readFileSync(path.join(root,'docs/activation-restoration/firestore.minimal.rules'),'utf8'),build().rules);
  });
  const user=(await authSDK.createUserWithEmailAndPassword(auth,'minimal-new@example.test','Synthetic-Password-48!')).user;
  const input={uid:user.uid,email:user.email,email_normalized:user.email,nama:'Synthetic',whatsapp:'6281234567881',whatsapp_normalized:'6281234567881',wilayah:'Abepura',status_akun:'Menunggu Verifikasi'};
  await check('minimal delta admits existing Firestore transaction with permanent NIJ and both claims',async()=>{
    const r=await reg.registerProfile(user,'ABE',input);assert.equal(r.nij_number,1);
    assert.equal((await inspect('nij_allocations/'+user.uid)).nij,r.nij);
    assert.equal((await inspect('registration_unique/email_'+user.email)).uid,user.uid);
    assert.equal((await inspect('registration_unique/phone_'+input.whatsapp)).uid,user.uid);
  });
  await check('delta still rejects NIJ role status and other-profile changes',async()=>{
    for(const data of [{nij:'forged'},{role:'master'},{status_akun:'Aktif'}])await assert.rejects(s.updateDoc(s.doc(database,'users/'+user.uid),data));
    await seed('users/other',{uid:'other',email:'other@example.test',status_akun:'Pending',nij:'KEEP'});
    await assert.rejects(s.getDocFromServer(s.doc(database,'users/other')));
    await assert.rejects(s.getDocs(s.query(s.collection(database,'users'),s.where('email','==','other@example.test'))));
    await seed('users/other/private/item',{synthetic:true});await assert.rejects(s.getDocFromServer(s.doc(database,'users/other/private/item')));
  });
  const adminDb=env.authenticatedContext('manager',{email:'manager@example.test'}).firestore();
  const adminAuth={currentUser:{uid:'manager',reload:async()=>{},getIdToken:async()=>''}};
  const admin=require('../../sipapua-spark-member').create(wrap(adminDb),adminAuth,s.serverTimestamp);
  await check('role-only inactive administrator cannot activate under production helper semantics',async()=>{
    await seed('admin_users/manager',{role:'master',status:'inactive',permissions:{canActivateMembers:true}});
    await assert.rejects(admin.activate(user.uid,'admin-override',true));
  });
  await check('active administrator without canActivateMembers cannot activate',async()=>{
    await seed('admin_users/manager',{role:'master',status:'active',permissions:{canActivateMembers:false}});
    await assert.rejects(admin.activate(user.uid,'admin-override',true));
  });
  await check('audited manual activation works under minimal delta without faking verified Auth',async()=>{
    await seed('admin_users/manager',{role:'master',status:'active',permissions:{canActivateMembers:true}});
    await assert.rejects(admin.activate(user.uid,'admin-override',false));
    await admin.activate(user.uid,'admin-override',true);
    assert.equal(user.emailVerified,false);assert.equal((await member.status()).active,true);
    const p=await inspect('users/'+user.uid),audit=await inspect('registration_audit/'+p.activation.auditId);
    assert.equal(audit.targetUid,user.uid);assert.equal(audit.identityVerificationAttested,true);
    await assert.rejects(s.updateDoc(s.doc(adminDb,'registration_audit/'+p.activation.auditId),{identityVerificationAttested:false}));
  });
  await check('menu/profile/settings compatibility facade resolves UID with real SDK and rejects another email',async()=>{
    globalThis.SIPAPUA_APP_CHECK={prepare:()=>async()=>{}}; // Local emulator only; no attestation claim.
    const firestore=()=>wrap(database);firestore.FieldValue={serverTimestamp:s.serverTimestamp};
    const fakeApp={},firebase={app:()=>fakeApp,auth:()=>auth,firestore};
    const session=require('../../sipapua-member-session');
    const snapshot=await session.query(firebase).where('email','==',user.email).get();
    assert.equal(snapshot.docs[0].id,user.uid);assert.equal((await session.create(firebase).callable('memberLoginStatus')({})).data.active,true);
    await assert.rejects(session.query(firebase).where('email','==','other@example.test').get());
    const listenFirebase={...firebase,auth:()=>({currentUser:user,onAuthStateChanged:next=>{queueMicrotask(()=>next(user));return()=>{};}})};
    const received=await new Promise((resolve,reject)=>{
      let stop;const timer=setTimeout(()=>{stop?.();reject(Error('Listener timeout'));},10000);
      stop=session.query(listenFirebase).where('email','==',user.email).onSnapshot(value=>{clearTimeout(timer);stop?.();resolve(value);},error=>{clearTimeout(timer);stop?.();reject(error);});
    });assert.equal(received.docs[0].id,user.uid);
  });
  await check('Database Jemaat administrator list and ordinary member own-profile read remain available',async()=>{
    assert.ok((await s.getDocs(s.collection(adminDb,'users'))).size>=2);
    assert.equal((await s.getDocFromServer(s.doc(database,'users/'+user.uid))).exists(),true);
  });
  await check('unchanged UMKM ratings agenda and telemetry access still follows actual production policy',async()=>{
    const publicDb=env.unauthenticatedContext().firestore();
    for(const collection of ['umkm_stores','rating_toko','agenda_tahunan','login_logs']){
      await s.setDoc(s.doc(publicDb,collection+'/synthetic'),{synthetic:true});
      assert.equal((await s.getDocFromServer(s.doc(publicDb,collection+'/synthetic'))).exists(),true);
    }
  });
  await check('verified email activates canonical legacy profile under the minimal delta with unchanged NIJ',async()=>{
    const uid='verified-canonical',email='verified-canonical@example.test';
    await seed('users/'+uid,{email,nij:'PERMANENT-KEEP',status_akun:'Pending'});
    const d=env.authenticatedContext(uid,{email,email_verified:true}).firestore();
    const service=require('../../sipapua-spark-member').create(wrap(d),{currentUser:{uid,email,emailVerified:true,reload:async()=>{},getIdToken:async()=>''}},s.serverTimestamp);
    assert.equal((await service.status()).active,true);
    assert.equal((await inspect('users/'+uid)).nij,'PERMANENT-KEEP');assert.equal(await inspect('nij_allocations/'+uid),undefined);
  });
  await check('missing maintenance boolean fails closed; counters and NIJ remain unchanged',async()=>{
    await seed('registration_control/state',{enabled:true,version:'original-spark-v1'});
    const next=(await authSDK.createUserWithEmailAndPassword(auth,'maintenance-test@example.test','Synthetic-Password-49!')).user;
    await assert.rejects(reg.registerProfile(next,'ABE',{...input,uid:next.uid,email:next.email,email_normalized:next.email,whatsapp:'6281234567882',whatsapp_normalized:'6281234567882'}));
    assert.equal((await inspect('nij_counters/Abepura')).last,1);
  });
};
