'use strict';
const assert=require('node:assert/strict');
async function legacyExploit({auth,authSDK,seed,reg,s}){
    const old=(await authSDK.createUserWithEmailAndPassword(auth,'legacy-current-contact@example.test','Synthetic-Password-18!')).user;
    await seed('users/historical-uid-profile',{uid:old.uid,nij:'NIJ-PPP-ABE-090-2020',nij_number:90,wilayah:'Abepura',email:'legacy-previous-contact@example.test',whatsapp:'6281234567800',status_akun:'Aktif'});
    await seed('registration_unique/email_legacy-previous-contact@example.test',{uid:'historical-uid-profile',createdAt:s.Timestamp.fromMillis(1)});
    await seed('registration_unique/phone_6281234567800',{uid:'historical-uid-profile',createdAt:s.Timestamp.fromMillis(1)});
    await assert.rejects(reg.registerProfile(old,'ABE',{uid:old.uid,email:old.email,email_normalized:old.email,nama:'Legacy identity fixture',wilayah:'Abepura',
        status_akun:'Menunggu Verifikasi',whatsapp:'6281234567811',whatsapp_normalized:'6281234567811'}));
    return old;
}
function clear(uid,s){const now=Date.now();return{uid,state:'clear',profileId:'',reviewId:'SYNTHETIC-REVIEW',reviewedAt:s.Timestamp.fromMillis(now-1000),expiresAt:s.Timestamp.fromMillis(now+3600000)};}
async function run(ctx){
    const {check,auth,authSDK,s,seed,inspect,reg,database,env,wrap}=ctx;
    let legacy;
    await check('original failing legacy UID second-NIJ exploit is rejected',async()=>{legacy=await legacyExploit(ctx);});
    const input=u=>({uid:u.uid,nama:'Synthetic fixture',email:u.email,email_normalized:u.email,wilayah:'Abepura',status_akun:'Menunggu Verifikasi',whatsapp:'6281234567822',whatsapp_normalized:'6281234567822'});
    async function raw(u,options={}){
        const counter=(await inspect('nij_counters/Abepura')).last,n=counter+1;
        const year=new Intl.DateTimeFormat('en',{timeZone:'Asia/Jayapura',year:'numeric'}).format(new Date());
        const nij=`NIJ-PPP-ABE-${String(n).padStart(3,'0')}-${year}`,stamp=s.serverTimestamp();
        const b=s.writeBatch(database),p=input(u);
        b.update(s.doc(database,'nij_counters/Abepura'),{last:n,updatedAt:stamp});
        b.set(s.doc(database,'users/'+u.uid),{...p,anak:[],jumlah_anak:0,nij,nij_number:n,createdAt:stamp});
        b.set(s.doc(database,'nij_allocations/'+u.uid),{uid:u.uid,lokasi:'ABE',wilayah:'Abepura',nij,nij_number:n,createdAt:stamp});
        b.set(s.doc(database,'registration_unique/email_'+u.email),{uid:u.uid,createdAt:stamp});
        b.set(s.doc(database,'registration_unique/phone_'+p.whatsapp_normalized),{uid:u.uid,createdAt:stamp});
        if(options.issue)b.set(s.doc(database,'uid_ownership/'+u.uid),{...clear(u.uid,s),state:'allocated',profileId:u.uid,nij,allocatedAt:stamp});
        else if(options.consume)b.update(s.doc(database,'uid_ownership/'+u.uid),{state:'allocated',profileId:u.uid,nij,allocatedAt:stamp});
        return b.commit();
    }
    await check('raw SDK bypass without ownership proof is denied and all existing data is retained',async()=>{
        const old=await inspect('users/historical-uid-profile'),count=await inspect('nij_counters/Abepura');
        await assert.rejects(raw(legacy),e=>e.code==='permission-denied');
        assert.deepEqual(await inspect('users/historical-uid-profile'),old);assert.deepEqual(await inspect('nij_counters/Abepura'),count);
        assert.equal(await inspect('users/'+legacy.uid),undefined);assert.equal(await inspect('nij_allocations/'+legacy.uid),undefined);
        assert.equal((await inspect('registration_unique/phone_6281234567800')).uid,'historical-uid-profile');
    });
    await check('indexed legacy ownership remains denied with changed Auth contacts',async()=>{
        await seed('uid_ownership/'+legacy.uid,{uid:legacy.uid,state:'owned',profileId:'historical-uid-profile'});
        await assert.rejects(raw(legacy),e=>e.code==='permission-denied');
    });
    await check('web master cannot mint eligibility or rewrite ownership as clear',async()=>{
        await seed('admin_users/web-master',{role:'master',status:'active',permissions:{canActivateMembers:true}});
        const d=env.authenticatedContext('web-master',{email:'synthetic@example.test'}).firestore();
        await assert.rejects(s.setDoc(s.doc(d,'uid_ownership/fake'),clear('fake',s)),e=>e.code==='permission-denied');
        await assert.rejects(s.setDoc(s.doc(d,'uid_ownership/'+legacy.uid),clear(legacy.uid,s)),e=>e.code==='permission-denied');
    });
    const fresh=(await authSDK.createUserWithEmailAndPassword(auth,'eligible-fixture@example.test','Synthetic-Password-19!')).user;
    await check('new unknown UID fails closed while ownership index is incomplete',async()=>{
        await assert.rejects(reg.registerProfile(fresh,'ABE',input(fresh)),e=>e.code==='uid-ownership-unverified');
        await assert.rejects(raw(fresh),e=>e.code==='permission-denied');
    });
    await check('self-issued eligibility in same batch cannot authorize registration',async()=>{
        await assert.rejects(s.setDoc(s.doc(database,'uid_ownership/'+fresh.uid),clear(fresh.uid,s)),e=>e.code==='permission-denied');
        await assert.rejects(raw(fresh,{issue:true}),e=>e.code==='permission-denied');
    });
    await check('expired or mismatched trusted review is rejected by Rules',async()=>{
        await seed('uid_ownership/'+fresh.uid,{...clear(fresh.uid,s),expiresAt:s.Timestamp.fromMillis(1)});
        await assert.rejects(raw(fresh,{consume:true}),e=>e.code==='permission-denied');
        await seed('uid_ownership/'+fresh.uid,{...clear(fresh.uid,s),uid:'another-uid'});
        await assert.rejects(raw(fresh,{consume:true}),e=>e.code==='permission-denied');
    });
    await seed('uid_ownership/'+fresh.uid,clear(fresh.uid,s));
    await check('valid review must be consumed atomically; old five-write bypass is denied',async()=>{
        await assert.rejects(raw(fresh),e=>e.code==='permission-denied');assert.equal((await inspect('uid_ownership/'+fresh.uid)).state,'clear');
    });
    await check('eligibility cannot be consumed without profile and NIJ transaction',async()=>{
        await assert.rejects(s.updateDoc(s.doc(database,'uid_ownership/'+fresh.uid),{state:'allocated',profileId:fresh.uid,nij:'FORGED',allocatedAt:s.serverTimestamp()}),e=>e.code==='permission-denied');
    });
    let result;
    await check('reviewed new UID registers through real Auth and Firestore SDK; ownership is permanent',async()=>{
        const before=(await inspect('nij_counters/Abepura')).last;
        result=await reg.registerProfile(fresh,'ABE',input(fresh));assert.equal(result.nij_number,before+1);
        const owned=await inspect('uid_ownership/'+fresh.uid);assert.equal(owned.state,'allocated');assert.equal(owned.profileId,fresh.uid);assert.equal(owned.nij,result.nij);
        assert.equal((await inspect('users/'+fresh.uid)).nij,result.nij);
    });
    await check('replay, eligibility reset, and deletion cannot open a second allocation',async()=>{
        const before=(await inspect('nij_counters/Abepura')).last;
        await assert.rejects(reg.registerProfile(fresh,'ABE',input(fresh)));
        await assert.rejects(s.updateDoc(s.doc(database,'uid_ownership/'+fresh.uid),{state:'clear'}),e=>e.code==='permission-denied');
        await assert.rejects(s.deleteDoc(s.doc(database,'uid_ownership/'+fresh.uid)),e=>e.code==='permission-denied');
        assert.equal((await inspect('nij_counters/Abepura')).last,before);
    });
    await check('concurrent reviewed UIDs each get exactly one distinct NIJ',async()=>{
        const candidate=require('../../sipapua-spark-registration');
        const pairs=await Promise.all(['concurrent-a','concurrent-b'].map(async(uid,i)=>{
            await seed('uid_ownership/'+uid,clear(uid,s));
            const u={uid,email:uid+'@example.test'},d=env.authenticatedContext(uid,{email:u.email}).firestore();
            const api=candidate.create(wrap(d),{currentUser:u},s.serverTimestamp);
            return {u,api,data:{...input(u),whatsapp:'628123456783'+i,whatsapp_normalized:'628123456783'+i}};
        }));
        const before=(await inspect('nij_counters/Abepura')).last;
        const results=await Promise.all(pairs.map(p=>p.api.registerProfile(p.u,'ABE',p.data)));
        assert.deepEqual(results.map(r=>r.nij_number).sort((a,b)=>a-b),[before+1,before+2]);
        for(const p of pairs)assert.equal((await inspect('uid_ownership/'+p.u.uid)).state,'allocated');
    });
    await check('legacy linking remains disabled after ownership gate changes',async()=>{
        for(const c of ['member_identity','legacy_profile_owners','legacy_link_requests','legacy_link_approvals'])await assert.rejects(s.setDoc(s.doc(database,c+'/fixture'),{uid:fresh.uid}),e=>e.code==='permission-denied');
    });
}
module.exports={legacyExploit,run,clear};
