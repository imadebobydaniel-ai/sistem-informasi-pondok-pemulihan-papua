'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process');
const assert=require('node:assert/strict');
const {initializeTestEnvironment,assertFails}=require('@firebase/rules-unit-testing');
const s=require('firebase/firestore');s.setLogLevel('silent');
const linking=require('../../sipapua-legacy-linking');
const registration=require('../../sipapua-spark-registration');
const root=path.resolve(__dirname,'../..'),projectId='demo-sipapua-legacy-linking';
let pass=0,fail=0;
async function check(name,fn){try{await fn();pass++;console.log('PASS '+name);}catch(e){fail++;console.error('FAIL '+name);throw e;}}
function wrap(db){
    const snapshot=x=>({id:x.id,exists:x.exists(),data:()=>x.data(),metadata:x.metadata,ref:ref(x.ref)});
    const ref=x=>({id:x.id,raw:x,get:async()=>snapshot(await s.getDocFromServer(x))});
    return {doc:p=>ref(s.doc(db,p)),collection:p=>({doc:()=>ref(s.doc(s.collection(db,p)))}),
        runTransaction:fn=>s.runTransaction(db,tx=>fn({get:async r=>snapshot(await tx.get(r.raw)),set:(r,d)=>tx.set(r.raw,d),update:(r,d)=>tx.update(r.raw,d)}))};
}
async function main(){
    const jar=path.join(os.homedir(),'.cache/firebase/emulators/cloud-firestore-emulator-v1.22.0.jar');assert.ok(fs.existsSync(jar));
    const socket=net.createServer();await new Promise((r,j)=>{socket.once('error',j);socket.listen(0,'127.0.0.1',r);});
    const port=socket.address().port;await new Promise(r=>socket.close(r));
    const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'sipapua-legacy-link-'));
    const child=spawn('java',['-jar',jar,'--host','127.0.0.1','--port',String(port),'--webchannel_port','0','--websocket_port','0','--project_id',projectId,'--single_project_mode','--single_project_mode_error'],{cwd,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let log='',startup,env;
    child.on('error',e=>startup=e);for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{log=(log+b).slice(-20000);});
    try{
        let ready=false;for(let i=0;i<60;i++){
            if(startup)throw startup;if(child.exitCode!==null)throw Error(log);
            try{const r=await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(500)});await r.body?.cancel();if([200,404].includes(r.status)){ready=true;break;}}catch(_){}
            await new Promise(r=>setTimeout(r,500));
        }assert.ok(ready,log);
        env=await initializeTestEnvironment({projectId,firestore:{host:'127.0.0.1',port,rules:fs.readFileSync(path.join(root,'docs/spark-legacy-identity/firestore.proposed.rules'),'utf8')}});
        const db=uid=>env.authenticatedContext(uid,{email:'same@example.test',email_verified:true,firebase:{sign_in_provider:'password'}}).firestore();
        const api=uid=>linking.create(wrap(db(uid)),{currentUser:{uid}},s.serverTimestamp,s.Timestamp.fromMillis);
        const seed=async(p,d)=>env.withSecurityRulesDisabled(c=>s.setDoc(s.doc(c.firestore(),p),d));
        const inspect=async p=>{let value;await env.withSecurityRulesDisabled(async c=>{value=(await s.getDoc(s.doc(c.firestore(),p))).data();});return value;};
        const legacy={nama:'Synthetic legacy fixture',email:'same@example.test',nij:'NIJ-PPP-ABE-099-2020',status_akun:'Aktif',anak:[{nama:'Fixture',uid:'',nij:''}],customHistoricalField:'preserve'};
        const manager={role:'master',status:'active',permissions:{canActivateMembers:true}};
        await seed('admin_users/manager',manager);
        await seed('registration_control/state',{enabled:true,maintenance:false,version:'original-spark-v1'});
        await seed('nij_counters/Abepura',{last:99});
        await seed('registration_unique/email_same@example.test',{uid:'old-profile',createdAt:s.Timestamp.fromMillis(1)});
        async function fixture(uid,profileId='old-'+uid){await seed('users/'+profileId,legacy);await api(uid).requestLink();return api('manager').approve(uid,profileId,true);}
        const rawConfirm=async(uid,grantId,mutate=()=>{})=>{
            const g=await inspect('legacy_link_approvals/'+grantId),stamp=s.serverTimestamp();
            const r=await inspect('legacy_link_requests/'+uid);
            const data={uid,profileId:g.profileId,grantId,linkedAt:stamp};
            const w=new Map([
                ['member_identity/'+uid,data],['legacy_profile_owners/'+g.profileId,{...data}],
                ['legacy_link_requests/'+uid,{...r,status:'completed',grantId,completedAt:stamp}],
                ['registration_audit/legacy-link_'+grantId,{action:'legacy-identity-link',uid,profileId:g.profileId,nij:g.nij,grantId,approverUid:g.approverUid,actorUid:uid,identityVerified:true,approvedAt:g.approvedAt,createdAt:stamp}]
            ]);mutate(w);const clientDb=db(uid),b=s.writeBatch(clientDb);for(const[p,d]of w)b.set(s.doc(clientDb,p),d);return b.commit();
        };
        let successful;
        await check('real SDK request, administrator approval, claimant confirmation succeed',async()=>{
            successful=await fixture('member','old-profile');
            const result=await api('member').confirm(successful);assert.equal(result.profileId,'old-profile');
            assert.deepEqual(await inspect('member_identity/member'),await inspect('legacy_profile_owners/old-profile'));
        });
        await check('linked member resolves original document ID and can read profile',async()=>{
            const p=await api('member').ownProfile();assert.equal(p.id,'old-profile');assert.equal(p.data().nij,legacy.nij);
        });
        await check('legacy profile, NIJ, counter and permanent reservation unchanged',async()=>{
            assert.deepEqual(await inspect('users/old-profile'),legacy);assert.deepEqual(await inspect('nij_counters/Abepura'),{last:99});
            assert.equal((await inspect('registration_unique/email_same@example.test')).uid,'old-profile');
            assert.equal(await inspect('nij_allocations/member'),undefined);
        });
        await check('same verified email grants no access to unlinked legacy profile',async()=>{
            await seed('users/unlinked',legacy);await assertFails(s.getDoc(s.doc(db('email-attacker'),'users/unlinked')));
            await assertFails(s.getDoc(s.doc(db('email-attacker'),'users/old-profile')));
        });
        await check('confirmation without approval denied',async()=>{
            await api('unapproved').requestLink();await assertFails(s.setDoc(s.doc(db('unapproved'),'member_identity/unapproved'),{uid:'unapproved',profileId:'unlinked',grantId:'missing',linkedAt:s.serverTimestamp()}));
        });
        await check('different UID cannot confirm another approval',async()=>{
            const g=await fixture('intended');await api('intruder').requestLink();await assertFails(rawConfirm('intruder',g));
        });
        await check('expired approval denied',async()=>{
            const g=await fixture('expired');const before=await inspect('legacy_link_approvals/'+g);
            // Synthetic time fixture only; client cannot edit approvals.
            await seed('legacy_link_approvals/'+g,{...before,expiresAt:s.Timestamp.fromMillis(1)});
            await assertFails(rawConfirm('expired',g));
        });
        await check('approval replay denied',()=>assertFails(rawConfirm('member',successful)));
        await check('two UIDs racing for one legacy profile produce exactly one owner',async()=>{
            const g1=await fixture('race-one','race-profile');await api('race-two').requestLink();const g2=await api('manager').approve('race-two','race-profile',true);
            const outcomes=await Promise.allSettled([api('race-one').confirm(g1),api('race-two').confirm(g2)]);
            assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);
            const owner=await inspect('legacy_profile_owners/race-profile');assert.deepEqual(owner,await inspect('member_identity/'+owner.uid));
        });
        await check('revoked administrator permission invalidates outstanding approval',async()=>{
            const g=await fixture('revoked');await seed('admin_users/manager',{...manager,permissions:{canActivateMembers:false}});
            await assertFails(rawConfirm('revoked',g));await seed('admin_users/manager',manager);
        });
        for(const missing of ['member_identity','legacy_profile_owners','registration_audit'])await check('missing '+missing+' rolls back final transaction',async()=>{
            const uid='missing-'+missing,g=await fixture(uid);await assertFails(rawConfirm(uid,g,w=>{for(const p of w.keys())if(p.startsWith(missing+'/'))w.delete(p);}));
            assert.equal(await inspect('member_identity/'+uid),undefined);assert.equal((await inspect('legacy_link_requests/'+uid)).status,'pending');
        });
        await check('request must be consumed atomically',async()=>{
            const g=await fixture('not-consumed');await assertFails(rawConfirm('not-consumed',g,w=>w.delete('legacy_link_requests/not-consumed')));
        });
        await check('inconsistent reverse index and forged audit rejected',async()=>{
            const g=await fixture('inconsistent');await assertFails(rawConfirm('inconsistent',g,w=>{w.get('legacy_profile_owners/old-inconsistent').uid='victim';}));
            await assertFails(rawConfirm('inconsistent',g,w=>{w.get('registration_audit/legacy-link_'+g).approverUid='forged';}));
        });
        await check('existing canonical profile cannot claim a legacy profile',async()=>{
            const g=await fixture('has-profile');await seed('users/has-profile',{uid:'has-profile',nij:'EXISTING'});await assertFails(rawConfirm('has-profile',g));
        });
        await check('existing permanent allocation prevents linking',async()=>{
            const g=await fixture('allocated');await seed('nij_allocations/allocated',{uid:'allocated',nij:'EXISTING'});await assertFails(rawConfirm('allocated',g));
        });
        await check('one UID cannot claim a second legacy profile',async()=>{
            await seed('users/another-profile',legacy);await assert.rejects(api('manager').approve('member','another-profile',true));
        });
        await check('approval cannot be forged, edited, deleted or extended by claimant',async()=>{
            const g=await fixture('forger'),value=await inspect('legacy_link_approvals/'+g),d=s.doc(db('forger'),'legacy_link_approvals/'+g);
            await assertFails(s.setDoc(s.doc(db('forger'),'legacy_link_approvals/forged'),value));
            await assertFails(s.updateDoc(d,{expiresAt:s.Timestamp.fromMillis(Date.now()+86400000)}));await assertFails(s.deleteDoc(d));
        });
        await check('ordinary admin and viewer cannot approve; active super_admin can',async()=>{
            await api('role-target').requestLink();await seed('users/role-profile',legacy);
            for(const role of ['admin','viewer']){await seed('admin_users/role-actor',{...manager,role});await assert.rejects(api('role-actor').approve('role-target','role-profile',true));}
            await seed('admin_users/role-actor',{...manager,role:'super_admin'});await api('role-actor').approve('role-target','role-profile',true);
        });
        await check('permanent indexes and audit cannot be changed or removed',async()=>{
            for(const p of ['member_identity/member','legacy_profile_owners/old-profile','registration_audit/legacy-link_'+successful]){
                await assertFails(s.updateDoc(s.doc(db('member'),p),{uid:'other'}));await assertFails(s.deleteDoc(s.doc(db('manager'),p)));
            }
        });
        await check('bound UID cannot register a new canonical profile',async()=>{
            const user={uid:'member',email:'new@example.test'};
            const database=env.authenticatedContext('member',{email:user.email,email_verified:true}).firestore();
            await assert.rejects(registration.create(wrap(database),{currentUser:user},s.serverTimestamp).registerProfile(user,'ABE',{
                uid:'member',email:user.email,email_normalized:user.email,whatsapp:'6281234567890',whatsapp_normalized:'6281234567890',wilayah:'Abepura',status_akun:'Menunggu Verifikasi'}));
        });
        await check('unknown linked field cannot grant access and legacy document remains write-protected',async()=>{
            await assertFails(s.updateDoc(s.doc(db('member'),'users/old-profile'),{uid:'member'}));
            await assertFails(s.setDoc(s.doc(db('member'),'member_identity/other'),{uid:'other',profileId:'old-profile'}));
        });
        await check('UID already present in an unindexed noncanonical profile cannot claim another profile',async()=>{
            const g=await fixture('existing-field-uid');
            await seed('users/historical-random-id',{...legacy,uid:'existing-field-uid'});
            await assertFails(rawConfirm('existing-field-uid',g));
        });
        console.log(`RESULT ${pass} PASS, ${fail} FAIL. Local identity linking only.`);
    }catch(e){
        fs.writeFileSync(path.join(__dirname,'last-failure.log'),log);
        fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({passed:pass,failed:fail,status:'BLOCKED',integration:false,error:e.message},null,2));
        console.log(`RESULT ${pass} PASS, ${fail} FAIL. BLOCKED; UI integration stopped.`);
        throw e;
    }
    finally{if(env)await env.cleanup();child.kill();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
