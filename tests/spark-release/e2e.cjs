'use strict';
// New loopback processes only. Real Firebase client Auth + Firestore, no Functions.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process'),assert=require('node:assert/strict');
const {initializeTestEnvironment,assertFails}=require('@firebase/rules-unit-testing');
const appSDK=require('firebase/app'),authSDK=require('firebase/auth'),s=require('firebase/firestore');s.setLogLevel('silent');
const candidate=require('../../sipapua-spark-registration'),memberFactory=require('../../sipapua-spark-member');
const root=path.resolve(__dirname,'../..'),project='demo-sipapua-spark-release';
let passed=0,failed=0;
async function check(name,fn){try{await fn();passed++;console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name);throw e;}}
function wrap(database){
    const snap=x=>({id:x.id,exists:x.exists(),data:()=>x.data(),metadata:x.metadata,ref:ref(x.ref)});
    const ref=r=>({id:r.id,raw:r,get:async()=>snap(await s.getDocFromServer(r)),update:d=>s.updateDoc(r,d),onSnapshot:(next,error)=>s.onSnapshot(r,x=>next(snap(x)),error)});
    return{doc:p=>ref(s.doc(database,p)),collection:p=>({doc:id=>ref(id?s.doc(database,p,id):s.doc(s.collection(database,p))),where:(f,op,v)=>({limit:n=>({get:async()=>{const q=await s.getDocs(s.query(s.collection(database,p),s.where(f,op,v),s.limit(n)));return{size:q.size,docs:q.docs.map(snap)};}})})}),
        runTransaction:fn=>s.runTransaction(database,tx=>fn({get:async r=>snap(await tx.get(r.raw)),set:(r,d)=>tx.set(r.raw,d),update:(r,d)=>tx.update(r.raw,d),delete:r=>tx.delete(r.raw)})),
        batch:()=>{const b=s.writeBatch(database);return{delete:r=>b.delete(r.raw),commit:()=>b.commit()};}};
}
async function main(){
    const jar=path.join(os.homedir(),'.cache/firebase/emulators/cloud-firestore-emulator-v1.22.0.jar');
    const cli=path.join(os.homedir(),'AppData/Roaming/npm/node_modules/firebase-tools/lib/bin/firebase.js');
    assert.ok(fs.existsSync(jar)&&fs.existsSync(cli),'Installed local JAR/CLI required; no downloads');
    const ports={},reserved=[];for(const k of ['firestore','auth','hub','logging']){const server=net.createServer();await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});ports[k]=server.address().port;reserved.push(server);}
    const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'sipapua-spark-release-'));
    const config={emulators:{auth:{host:'127.0.0.1',port:ports.auth},hub:{host:'127.0.0.1',port:ports.hub},logging:{host:'127.0.0.1',port:ports.logging},ui:{enabled:false},singleProjectMode:true}};
    fs.writeFileSync(path.join(temporary,'firebase.json'),JSON.stringify(config));
    for(const server of reserved)await new Promise(r=>server.close(r));
    const environment={};for(const k of ['SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','JAVA_HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','PATH'])if(process.env[k])environment[k]=process.env[k];
    Object.assign(environment,{CI:'true',FIREBASE_CLI_DISABLE_UPDATE_CHECK:'true',XDG_CONFIG_HOME:path.join(temporary,'config'),GCLOUD_PROJECT:project,GOOGLE_CLOUD_PROJECT:project,METADATA_SERVER_DETECTION:'none'});
    const children=[spawn('java',['-jar',jar,'--host','127.0.0.1','--port',String(ports.firestore),'--webchannel_port','0','--websocket_port','0','--project_id',project,'--single_project_mode','--single_project_mode_error'],{cwd:temporary,env:environment,windowsHide:true,stdio:['ignore','pipe','pipe']}),
        spawn(process.execPath,[cli,'emulators:start','--only','auth','--project',project,'--config',path.join(temporary,'firebase.json'),'--non-interactive'],{cwd:temporary,env:environment,windowsHide:true,stdio:['ignore','pipe','pipe']})];
    let log='',startup,env,app;for(const child of children){child.on('error',e=>startup=e);for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{log=(log+b).slice(-30000);});}
    try{
        let ready=false;for(let i=0;i<100;i++){
            if(startup)throw startup;if(children.some(c=>c.exitCode!==null))throw Error('New emulator startup failed: '+log);
            try{let ok=true;for(const port of [ports.auth,ports.firestore]){const r=await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(400)});await r.body?.cancel();ok=ok&&[200,404].includes(r.status);}if(ok){ready=true;break;}}catch(_){}
            await new Promise(r=>setTimeout(r,400));
        }assert.ok(ready,'New local emulators unavailable: '+log);
        env=await initializeTestEnvironment({projectId:project,firestore:{host:'127.0.0.1',port:ports.firestore,rules:fs.readFileSync(path.join(root,process.argv.includes('--minimal-release-only')?'docs/activation-restoration/firestore.minimal.rules':process.argv.includes('--activation-restoration-only')?'docs/activation-restoration/firestore.proposed.rules':'docs/spark-release/firestore.proposed.rules'),'utf8')}});
        const seed=async(p,d)=>env.withSecurityRulesDisabled(c=>s.setDoc(s.doc(c.firestore(),p),d));
        const inspect=async p=>{let d;await env.withSecurityRulesDisabled(async c=>{d=(await s.getDoc(s.doc(c.firestore(),p))).data();});return d;};
        await seed('registration_control/state',{enabled:true,maintenance:false,version:'original-spark-v1'});await seed('nij_counters/Abepura',{last:0});
        app=appSDK.initializeApp({projectId:project,apiKey:'fake-local-key',authDomain:project+'.firebaseapp.com'},'spark-release-e2e');
        const auth=authSDK.getAuth(app);authSDK.connectAuthEmulator(auth,`http://127.0.0.1:${ports.auth}`,{disableWarnings:true});
        const database=s.getFirestore(app);s.connectFirestoreEmulator(database,'127.0.0.1',ports.firestore);
        const db=wrap(database),member=memberFactory.create(db,auth,s.serverTimestamp),reg=candidate.create(db,auth,s.serverTimestamp);
        if(process.argv.includes('--minimal-release-only')){
            await require('../activation-restoration/minimal-flows.cjs')({check,auth,authSDK,s,seed,inspect,reg,database,env,wrap,member,ports,project,root});
            fs.writeFileSync(path.join(root,'tests/activation-restoration/minimal-result.json'),JSON.stringify({passed,failed,scope:'minimal-production-delta',functions:false,productionModified:false},null,2));
            console.log(`RESULT ${passed} PASS, ${failed} FAIL. Minimal delta only.`);return;
        }
        if(process.argv.includes('--activation-restoration-only')){
            await require('../activation-restoration/flows.cjs')({check,auth,authSDK,s,seed,inspect,reg,database,env,wrap,member,ports,project,root});
            fs.writeFileSync(path.join(root,'tests/activation-restoration/result.json'),JSON.stringify({passed,failed,scope:'original-registration-and-activation',functions:false,uidOwnershipRequired:false,productionModified:false},null,2));
            console.log(`RESULT ${passed} PASS, ${failed} FAIL. Original registration and activation restoration only.`);return;
        }
        if(process.argv.includes('--owner-operations-only')){
            await require('./owner-emulator.cjs')({ports,project,auth,authSDK,seed,inspect,check});
            fs.writeFileSync(path.join(__dirname,'owner-emulator-result.json'),JSON.stringify({passed,failed,scope:'owner-operations-only',iamAndAuthAuthorization:'synthetic',firestoreTransactions:'real-isolated-emulator'},null,2));
            console.log(`RESULT ${passed} PASS, ${failed} FAIL. Isolated Owner transaction tests only.`);return;
        }
        if(process.argv.includes('--ownership-only')){
            await require('./ownership-cases.cjs').run({check,auth,authSDK,s,seed,inspect,reg,database,env,wrap});
            const hash=file=>require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex');
            const report={passed,failed,scope:'ownership-blocker-only',originalFailingTestExecuted:true,securityBlockerClosed:true,productionIndexVerified:false,functions:false,
                rulesSha256:hash('docs/spark-release/firestore.proposed.rules'),clientSha256:hash('sipapua-spark-registration.js')};
            fs.writeFileSync(path.join(__dirname,'ownership-result.json'),JSON.stringify(report,null,2));
            console.log(`RESULT ${passed} PASS, ${failed} FAIL. Ownership blocker closed locally; production index not verified.`);return;
        }
        let user,allocation;
        await check('real Auth SDK signup and client registration create one NIJ',async()=>{
            user=(await authSDK.createUserWithEmailAndPassword(auth,'release-fixture@example.test','Synthetic-Password-17!')).user;
            await seed('uid_ownership/'+user.uid,require('./ownership-cases.cjs').clear(user.uid,s));
            allocation=await reg.registerProfile(user,'ABE',{uid:user.uid,nama:'Synthetic fixture',email:user.email,email_normalized:user.email,whatsapp:'6281234567890',whatsapp_normalized:'6281234567890',wilayah:'Abepura',status_akun:'Menunggu Verifikasi'});assert.equal(allocation.nij_number,1);
        });
        await check('unverified member cannot activate or forge status',async()=>{
            await assert.rejects(member.activate(user.uid,'verified-email'));await assertFails(s.updateDoc(s.doc(database,'users/'+user.uid),{status_akun:'Aktif'}));
        });
        await check('Firebase email action verifies, refreshes token and activates atomically',async()=>{
            await authSDK.sendEmailVerification(user);
            const response=await fetch(`http://127.0.0.1:${ports.auth}/emulator/v1/projects/${project}/oobCodes`);assert.equal(response.status,200);
            const actions=(await response.json()).oobCodes;const action=actions.find(x=>x.email===user.email&&x.requestType==='VERIFY_EMAIL');assert.ok(action);
            await authSDK.applyActionCode(auth,action.oobCode);await authSDK.reload(user);await authSDK.getIdToken(user,true);
            assert.equal(user.emailVerified,true);assert.equal((await member.status()).active,true);
            const p=await inspect('users/'+user.uid),audit=await inspect('registration_audit/'+p.activation.auditId);assert.equal(audit.actorUid,user.uid);assert.equal(audit.action,'activate-verified-email');assert.equal(p.nij,allocation.nij);
        });
        await check('real Auth signout and login resolve own active profile without Functions',async()=>{
            await authSDK.signOut(auth);await authSDK.signInWithEmailAndPassword(auth,'release-fixture@example.test','Synthetic-Password-17!');assert.equal((await member.status()).active,true);assert.equal((await member.ownProfile()).data().nij,allocation.nij);
        });
        await check('same account cannot allocate another NIJ',async()=>{
            await assert.rejects(reg.registerProfile(auth.currentUser,'ABE',{uid:user.uid,email:user.email,email_normalized:user.email,wilayah:'Abepura',whatsapp:'6281234567890',whatsapp_normalized:'6281234567890'}));assert.equal((await inspect('nij_counters/Abepura')).last,1);
        });
        await check('browser session dispatcher and login facade work with Functions unavailable',async()=>{
            const sessionFactory=require('../../sipapua-member-session'),loginFactory=require('../../sipapua-login');
            globalThis.SIPAPUA_APP_CHECK={prepare:()=>async()=>{}}; // Emulator-only stub, not production attestation evidence.
            const firestore=()=>db;firestore.FieldValue={serverTimestamp:s.serverTimestamp};
            const facade={app:()=>app,auth:()=>auth,firestore};
            app.functions=()=>{throw Error('Functions must never be used');};
            assert.equal((await loginFactory.create(auth,sessionFactory.create(facade)).status()).active,true);
        });
        await check('member cannot mutate NIJ, role, activation or status',async()=>{
            for(const patch of [{nij:'FORGED'},{nij_number:99},{role:'master'},{activation:{}},{status_akun:'Pending'}])await assertFails(s.updateDoc(s.doc(database,'users/'+user.uid),patch));
            await assertFails(s.setDoc(s.doc(database,'admin_users/'+user.uid),{role:'master',status:'active'}));
        });
        await check('cross-profile and private subcollection access denied',async()=>{
            await seed('users/other',{uid:'other',nij:'PRIVATE',email:user.email});await seed('users/other/private/fixture',{value:'private'});
            await assertFails(s.getDoc(s.doc(database,'users/other')));await assertFails(s.getDoc(s.doc(database,'users/other/private/fixture')));await assertFails(s.setDoc(s.doc(database,'users/other/private/forged'),{value:'forged'}));
        });
        await check('conflicting legacy doc ID and UID do not expose profile or private subcollections',async()=>{
            await seed('users/collision',{uid:'other-owner',nij:'COLLISION'});await seed('users/collision/private/fixture',{value:'PRIVATE'});
            const d=env.authenticatedContext('collision',{email:'collision@example.test'}).firestore();
            await assertFails(s.getDoc(s.doc(d,'users/collision')));await assertFails(s.getDoc(s.doc(d,'users/collision/private/fixture')));
            await assert.rejects(memberFactory.create(wrap(d),{currentUser:{uid:'collision'}},s.serverTimestamp).deleteProfiles(['collision']));
        });
        await check('profile photo and demographics update on own profile',async()=>{
            await member.updateProfile(user.uid,{nama:'Updated fixture',foto_profil:'data:image/jpeg;base64,Zml4dHVyZQ=='});assert.equal((await member.ownProfile()).data().nama,'Updated fixture');
        });
        const adminDb=env.authenticatedContext('manager',{email:'manager@example.test'}).firestore();
        const admin=memberFactory.create(wrap(adminDb),{currentUser:{uid:'manager'}},s.serverTimestamp);
        await seed('admin_users/manager',{role:'master',status:'active',permissions:{canActivateMembers:true}});
        await check('Database Jemaat admin listing and nonidentity edits retain original doc IDs',async()=>{
            await seed('users/legacy-random',{nama:'Legacy fixture',nij:'NIJ-PPP-ABE-099-2020',status_akun:'Pending'});
            const q=await s.getDocs(s.collection(adminDb,'users'));assert.ok(q.docs.some(p=>p.id==='legacy-random'));
            await admin.updateProfile('legacy-random',{nama:'Reviewed fixture'});assert.equal((await inspect('users/legacy-random')).nij,'NIJ-PPP-ABE-099-2020');
        });
        await check('manual activation of existing UID-bound profile requires approved role and audit',async()=>{
            await seed('users/existing-uid-profile',{uid:'existing-uid',nama:'Existing fixture',nij:'EXISTING-NIJ',status_akun:'Pending'});
            await admin.activate('existing-uid-profile','admin-override',true);const p=await inspect('users/existing-uid-profile');assert.equal(p.status_akun,'Aktif');assert.equal((await inspect('registration_audit/'+p.activation.auditId)).actorUid,'manager');
        });
        await check('legacy UID-less activation and linking remain disabled',async()=>{
            await assert.rejects(admin.activate('legacy-random','admin-override',true));
            for(const c of ['member_identity','legacy_profile_owners','legacy_link_requests','legacy_link_approvals'])await assertFails(s.setDoc(s.doc(adminDb,c+'/fixture'),{uid:user.uid}));
        });
        await check('existing UID-bound member resolves noncanonical profile without email lookup',async()=>{
            const existing=env.authenticatedContext('existing-uid',{email:'different@example.test'}).firestore();
            const service=memberFactory.create(wrap(existing),{currentUser:{uid:'existing-uid',emailVerified:false}},s.serverTimestamp);assert.equal((await service.ownProfile()).id,'existing-uid-profile');
        });
        await check('manual status without audit and inactive administrator denied',async()=>{
            await seed('users/target',{uid:'target',nij:'TARGET',status_akun:'Pending'});await assertFails(s.updateDoc(s.doc(adminDb,'users/target'),{status_akun:'Aktif'}));
            await seed('admin_users/manager',{role:'master',status:'inactive',permissions:{canActivateMembers:true}});await assert.rejects(admin.activate('target','admin-override',true));
        });
        await check('maximum thirty free-text children can register without directory lookup',async()=>{
            const u={uid:'family',email:'family@example.test'},d=env.authenticatedContext(u.uid,{email:u.email}).firestore();
            await seed('uid_ownership/'+u.uid,require('./ownership-cases.cjs').clear(u.uid,s));
            await candidate.create(wrap(d),{currentUser:u},s.serverTimestamp).registerProfile(u,'ABE',{uid:u.uid,email:u.email,email_normalized:u.email,
                nama:'Family fixture',wilayah:'Abepura',status_akun:'Menunggu Verifikasi',whatsapp:'6281234567891',whatsapp_normalized:'6281234567891',
                jumlah_anak:30,anak:Array.from({length:30},(_,i)=>({nama:'Child fixture '+i,uid:'',nij:''}))});
        });
        await check('self contact update reserves new phone and preserves old permanent claim',async()=>{
            await member.updateProfile(user.uid,{whatsapp:'081234567899',nama:'Contact fixture'});
            assert.equal((await inspect('registration_unique/phone_6281234567899')).uid,user.uid);
            assert.equal((await inspect('registration_unique/phone_6281234567890')).uid,user.uid);
            assert.equal((await inspect('users/'+user.uid)).nij,allocation.nij);
        });
        await check('contact duplicate and email impersonation denied',async()=>{
            await seed('registration_unique/phone_6289999999999',{uid:'other',createdAt:s.Timestamp.fromMillis(1)});
            await assert.rejects(member.updateProfile(user.uid,{whatsapp:'6289999999999'}));
            await assertFails(s.updateDoc(s.doc(database,'users/'+user.uid),{email:'other@example.test',email_normalized:'other@example.test'}));
        });
        await check('same normalized contact formatting does not break existing editor saves',async()=>{
            await member.updateProfile(user.uid,{whatsapp:'+62 812-3456-7899'});
            assert.equal((await inspect('users/'+user.uid)).whatsapp,'081234567899');
        });
        await check('email change follows refreshed Auth identity and keeps both reservations',async()=>{
            await authSDK.updateEmail(auth.currentUser,'changed-fixture@example.test');await member.updateProfile(user.uid,{email:'changed-fixture@example.test'});
            assert.equal((await inspect('registration_unique/email_changed-fixture@example.test')).uid,user.uid);
            assert.equal((await inspect('registration_unique/email_release-fixture@example.test')).uid,user.uid);
            assert.equal((await member.status()).active,false);
        });
        await check('family metadata cannot inject linked UID and administrator family editor remains usable',async()=>{
            await assertFails(s.updateDoc(s.doc(database,'users/'+user.uid),{anak:[{nama:'Forged',uid:'other',nij:'FORGED'}],jumlah_anak:1}));
            await seed('admin_users/manager',{role:'master',status:'active',permissions:{canActivateMembers:true}});
            await admin.updateProfile('legacy-random',{nama:'Editor fixture',nama_ayah:'Free text fixture',anak:[{nama:'Child fixture',uid:'',nij:''}],jumlah_anak:1});
            assert.equal((await inspect('users/legacy-random')).anak.length,1);
        });
        await check('self deletion requires audit and permanently retains NIJ allocation and claims',async()=>{
            await assertFails(s.deleteDoc(s.doc(database,'users/'+user.uid)));
            await member.deleteProfiles([user.uid]);assert.equal(await inspect('users/'+user.uid),undefined);
            assert.equal((await inspect('nij_allocations/'+user.uid)).nij,allocation.nij);
            assert.equal((await inspect('registration_unique/phone_6281234567890')).uid,user.uid);
            assert.equal((await inspect('registration_audit/profile-delete_'+user.uid)).actorUid,user.uid);
        });
        await check('legacy UID already owning a noncanonical profile cannot allocate a second NIJ',async()=>{
            await require('./ownership-cases.cjs').legacyExploit({auth,authSDK,seed,reg,s});
        });
        console.log(`RESULT ${passed} PASS, ${failed} FAIL. App Check attestation NOT tested by emulators.`);
        fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({passed,failed,authAndFirestoreClient:true,functions:false,productionAttestationVerified:false},null,2));
    }catch(e){
        fs.writeFileSync(path.join(__dirname,'last-failure.log'),log);
        fs.writeFileSync(process.argv.includes('--minimal-release-only')?path.join(root,'tests/activation-restoration/minimal-result.json'):process.argv.includes('--activation-restoration-only')?path.join(root,'tests/activation-restoration/result.json'):path.join(__dirname,process.argv.includes('--owner-operations-only')?'owner-emulator-result.json':process.argv.includes('--ownership-only')?'ownership-result.json':'result.json'),JSON.stringify({passed,failed,status:'BLOCKED',securityBlockerClosed:false,authAndFirestoreClient:true,functions:false,productionAttestationVerified:false,error:e.message},null,2));
        console.log(`RESULT ${passed} PASS, ${failed} FAIL. RELEASE BLOCKED.`);throw e;
    }
    finally{if(app)await appSDK.deleteApp(app);if(env)await env.cleanup();for(const child of children)child.kill();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
