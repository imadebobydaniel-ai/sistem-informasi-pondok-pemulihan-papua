'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{execFileSync}=require('node:child_process');
const memberFactory=require('../../sipapua-spark-member');
module.exports=async function(ctx){
    const {check,auth,authSDK,s,seed,inspect,reg,database,env,wrap,member,ports,project,root}=ctx;
    const input=(u,phone)=>({uid:u.uid,email:u.email,email_normalized:u.email,nama:'Synthetic restoration fixture',whatsapp:phone,whatsapp_normalized:phone,wilayah:'Abepura',status_akun:'Menunggu Verifikasi'});
    const oldSource=execFileSync('git',['show','2a81de8:sipapua-registration.js'],{cwd:root,encoding:'utf8'});
    const legacyModule={exports:{}},previous=globalThis.SIPAPUA_REGISTRATION;
    new Function('module',oldSource)(legacyModule);globalThis.SIPAPUA_REGISTRATION=previous;
    const historic=legacyModule.exports.create(wrap(database),auth,s.serverTimestamp);
    const outputs={};let original,user;
    await check('historical 2a81de8 registration protocol actually commits through real client SDK under private proposal',async()=>{
        original=(await authSDK.createUserWithEmailAndPassword(auth,'historical-fixture@example.test','Synthetic-Password-31!')).user;
        const result=await historic.registerProfile(original,'ABE',input(original,'6281234567901'));assert.equal(result.nij_number,1);
        assert.equal((await inspect('users/'+original.uid)).nij,result.nij);outputs.historicalNij=result.nij;
    });
    await check('restored existing form service registers without Functions or uid_ownership clear',async()=>{
        user=(await authSDK.createUserWithEmailAndPassword(auth,'restored-fixture@example.test','Synthetic-Password-32!')).user;
        const result=await reg.registerProfile(user,'ABE',input(user,'6281234567902'));assert.equal(result.nij_number,2);
        assert.equal(await inspect('uid_ownership/'+user.uid),undefined);outputs.nij=result.nij;
    });
    await check('repeat registration and duplicate contact cannot allocate another NIJ',async()=>{
        const n=(await inspect('nij_counters/Abepura')).last;await assert.rejects(reg.registerProfile(user,'ABE',input(user,'6281234567902')));
        const u={uid:'duplicate',email:'duplicate@example.test'},d=env.authenticatedContext(u.uid,{email:u.email}).firestore();
        await assert.rejects(require('../../sipapua-spark-registration').create(wrap(d),{currentUser:u},s.serverTimestamp).registerProfile(u,'ABE',input(u,'6281234567902')));
        assert.equal((await inspect('nij_counters/Abepura')).last,n);
    });
    await check('invalid verification link leaves Auth unverified and profile waiting; login is rejected',async()=>{
        await assert.rejects(authSDK.applyActionCode(auth,'INVALID_SYNTHETIC_CODE'));await authSDK.reload(user);
        assert.equal(user.emailVerified,false);assert.equal((await member.status()).active,false);assert.equal((await inspect('users/'+user.uid)).status_akun,'Menunggu Verifikasi');
    });
    const adminDb=env.authenticatedContext('manager',{email:'manager@example.test'}).firestore();
    const adminAuth={currentUser:{uid:'manager',reload:async()=>{},getIdToken:async()=>''}};
    const service=memberFactory.create(wrap(adminDb),adminAuth,s.serverTimestamp);
    await seed('admin_users/manager',{role:'master',status:'active',permissions:{canActivateMembers:true}});
    const html=fs.readFileSync(path.join(root,'edit-jemaat-administrator.html'),'utf8');
    const source=html.slice(html.indexOf('    async function activateMemberFromExistingEditor('),html.indexOf('    function denyEditAccess('));
    const elements={activate_existing_member:{disabled:false},existing_activation_result:{textContent:''},status_akun:{value:'Aktif'},activation_identity_confirmed:{checked:false}};
    const dom={auth:adminAuth,db:wrap(adminDb),userId:user.uid,document:{getElementById:id=>elements[id]},firebase:{},window:{SIPAPUA_MEMBER_SESSION:{create:()=>({callable:()=>async data=>({data:await service.activate(data.targetUid,'admin-override',data.identityVerified)})})}}};
    vm.runInNewContext(source+'\nglobalThis.saveStatus=saveExistingAccountStatus;',dom);
    await check('existing dropdown Simpan requires identity checkbox before activation',async()=>{
        await assert.rejects(dom.saveStatus('Aktif'));assert.equal((await inspect('users/'+user.uid)).status_akun,'Menunggu Verifikasi');
        assert.ok(html.includes('await saveExistingAccountStatus(updateData.status_akun)'));
    });
    await check('dropdown Simpan cannot report success while another activation is still pending',async()=>{
        elements.activate_existing_member.disabled=true;elements.activation_identity_confirmed.checked=true;
        await assert.rejects(dom.saveStatus('Aktif'));assert.equal((await inspect('users/'+user.uid)).status_akun,'Menunggu Verifikasi');
        elements.activate_existing_member.disabled=false;
    });
    await check('existing dropdown Simpan activates with manager permission and matching immutable audit',async()=>{
        elements.activation_identity_confirmed.checked=true;await dom.saveStatus('Aktif');
        const p=await inspect('users/'+user.uid),a=await inspect('registration_audit/'+p.activation.auditId);
        assert.equal(p.status_akun,'Aktif');assert.equal(p.nij,outputs.nij);assert.equal(a.actorUid,'manager');assert.equal(a.targetUid,user.uid);assert.equal(a.identityVerificationAttested,true);
        await authSDK.reload(user);assert.equal(user.emailVerified,false);
    });
    await check('manual activated account logs in with emailVerified false and valid audit',async()=>{
        await authSDK.signOut(auth);await authSDK.signInWithEmailAndPassword(auth,'restored-fixture@example.test','Synthetic-Password-32!');
        assert.equal(auth.currentUser.emailVerified,false);const status=await member.status();assert.equal(status.active,true);assert.equal(status.activationPath,'admin-override');
    });
    await check('existing login facade accepts audited manual activation with no Functions SDK',async()=>{
        globalThis.SIPAPUA_APP_CHECK={prepare:()=>async()=>{}}; // Emulator-only token stub, not attestation evidence.
        const firestore=()=>wrap(database);firestore.FieldValue={serverTimestamp:s.serverTimestamp};
        const fakeApp={functions:()=>{throw Error('Functions are forbidden');}},firebase={app:()=>fakeApp,auth:()=>auth,firestore};
        const session=require('../../sipapua-member-session').create(firebase),login=require('../../sipapua-login').create(auth,session);
        assert.equal((await login.status()).active,true);assert.equal(auth.currentUser.emailVerified,false);
    });
    await check('forged legacy manual flag without valid audit never enables unverified login',async()=>{
        const bad=(await authSDK.createUserWithEmailAndPassword(auth,'unaudited-fixture@example.test','Synthetic-Password-33!')).user;
        await seed('users/'+bad.uid,{uid:bad.uid,email:bad.email,nij:'LEGACY-UNAUDITED',status_akun:'Aktif',activation:{method:'admin-override',auditId:'fake-audit',at:s.Timestamp.fromMillis(1)}});
        // A malformed synthetic record exists, but no trusted audit accompanies it.
        await assert.rejects(member.status());
    });
    await check('verified email automatically activates historical canonical Pending profile without rewriting NIJ or creating allocation',async()=>{
        const u=(await authSDK.createUserWithEmailAndPassword(auth,'verified-legacy-fixture@example.test','Synthetic-Password-34!')).user;
        await seed('users/'+u.uid,{email:u.email,nij:'NIJ-PPP-ABE-050-2020',status_akun:'Pending',historicalField:'preserve'});
        outputs.canonicalWithoutAllocation=u.uid;
        await authSDK.sendEmailVerification(u);const response=await fetch(`http://127.0.0.1:${ports.auth}/emulator/v1/projects/${project}/oobCodes`);
        const action=(await response.json()).oobCodes.find(x=>x.email===u.email&&x.requestType==='VERIFY_EMAIL');assert.ok(action);
        await authSDK.applyActionCode(auth,action.oobCode);await authSDK.reload(u);await authSDK.getIdToken(u,true);
        assert.equal((await member.status()).active,true);const p=await inspect('users/'+u.uid);assert.equal(p.nij,'NIJ-PPP-ABE-050-2020');assert.equal(p.historicalField,'preserve');assert.equal(p.uid,undefined);assert.equal(await inspect('nij_allocations/'+u.uid),undefined);
    });
    await check('existing canonical profile without uid can be manually activated and accepted without faking Auth',async()=>{
        const u=(await authSDK.createUserWithEmailAndPassword(auth,'manual-legacy-fixture@example.test','Synthetic-Password-35!')).user;
        await seed('users/'+u.uid,{email:u.email,nij:'NIJ-PPP-ABE-051-2020',status_akun:'Pending',historicalField:'retain'});
        await service.activate(u.uid,'admin-override',true);assert.equal((await member.status()).active,true);await authSDK.reload(u);assert.equal(u.emailVerified,false);
        const p=await inspect('users/'+u.uid);assert.equal(p.uid,undefined);assert.equal(p.historicalField,'retain');assert.equal(p.nij,'NIJ-PPP-ABE-051-2020');
    });
    await check('active historical unverified profile may be re-attested by authorized manager with audit',async()=>{
        const u=auth.currentUser;await service.activate(u.uid,'admin-override',true);assert.equal((await member.status()).active,true);
        const p=await inspect('users/'+u.uid);assert.equal((await inspect('registration_audit/'+p.activation.auditId)).previousStatus,'Aktif');
    });
    await check('viewer, missing permission and inactive manager cannot bypass UI to activate',async()=>{
        await seed('users/target',{uid:'target',email:'target@example.test',nij:'TARGET',status_akun:'Pending'});
        for(const data of [{role:'viewer',status:'active',permissions:{canActivateMembers:true}},{role:'master',status:'active',permissions:{}},{role:'master',status:'inactive',permissions:{canActivateMembers:true}}]){
            await seed('admin_users/manager',data);await assert.rejects(service.activate('target','admin-override',true));
        }await seed('admin_users/manager',{role:'super_admin',status:'active',permissions:{canActivateMembers:true}});await service.activate('target','admin-override',true);
    });
    await check('profile NIJ, self status, role and audit are protected; other profiles and private subcollections are denied',async()=>{
        const u=auth.currentUser;for(const patch of [{nij:'FORGED'},{nij_number:999},{status_akun:'Pending'},{role:'master'},{activation:{method:'admin-override',auditId:'fake'}}])await assert.rejects(s.updateDoc(s.doc(database,'users/'+u.uid),patch));
        await assert.rejects(s.getDoc(s.doc(database,'users/'+user.uid)));await seed('users/'+user.uid+'/private/fixture',{value:'private'});await assert.rejects(s.getDoc(s.doc(database,'users/'+user.uid+'/private/fixture')));
        const p=await inspect('users/'+u.uid);await assert.rejects(s.updateDoc(s.doc(database,'registration_audit/'+p.activation.auditId),{actorUid:u.uid}));
    });
    await check('Database Jemaat still lists original IDs and edits demographics without allocating NIJ',async()=>{
        const before=(await inspect('nij_counters/Abepura')).last,q=await s.getDocs(s.collection(adminDb,'users'));assert.ok(q.docs.some(d=>d.id===user.uid));
        await service.updateProfile(user.uid,{nama:'Reviewed fixture'});assert.equal((await inspect('users/'+user.uid)).nij,outputs.nij);assert.equal((await inspect('nij_counters/Abepura')).last,before);
    });
    await check('normal registration form data and valid verification activate the new account without changing its NIJ',async()=>{
        const u=(await authSDK.createUserWithEmailAndPassword(auth,'verified-new-fixture@example.test','Synthetic-Password-36!')).user;
        const data={...input(u,'6281234567906'),alamat_detail:'Synthetic address',komsel:'Synthetic group',jumlah_anak:2,anak:[{nama:'Child one',uid:'',nij:''},{nama:'Child two',uid:'',nij:''}]};
        const allocated=await reg.registerProfile(u,'ABE',data);const before=await inspect('users/'+u.uid);assert.equal(before.anak.length,2);assert.equal(before.alamat_detail,data.alamat_detail);
        await authSDK.sendEmailVerification(u);const response=await fetch(`http://127.0.0.1:${ports.auth}/emulator/v1/projects/${project}/oobCodes`);
        const code=(await response.json()).oobCodes.find(x=>x.email===u.email&&x.requestType==='VERIFY_EMAIL');assert.ok(code);
        await authSDK.applyActionCode(auth,code.oobCode);await authSDK.reload(u);await authSDK.getIdToken(u,true);
        assert.equal((await member.status()).active,true);assert.equal(u.emailVerified,true);
        const after=await inspect('users/'+u.uid);assert.equal(after.nij,allocated.nij);assert.equal(after.activation.method,'verified-email');assert.deepEqual(after.anak,before.anak);
    });
    await check('existing canonical UID cannot register a second profile and forged noncanonical create is denied',async()=>{
        const u=auth.currentUser,n=(await inspect('nij_counters/Abepura')).last;
        await assert.rejects(reg.registerProfile(u,'ABE',input(u,'6281234567999')));
        await assert.rejects(s.setDoc(s.doc(database,'users/noncanonical-forgery'),input(u,'6281234567999')));
        assert.equal((await inspect('nij_counters/Abepura')).last,n);
    });
    await check('historical NIJ without allocation cannot be erased to reopen registration',async()=>{
        await assert.rejects(service.deleteProfiles([outputs.canonicalWithoutAllocation]));
        assert.equal((await inspect('users/'+outputs.canonicalWithoutAllocation)).nij,'NIJ-PPP-ABE-050-2020');
    });
};
