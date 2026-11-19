'use strict';
// Starts and stops ONLY its own new emulator. No Firebase CLI, production,
// existing emulator, credentials, Auth accounts, imports, or exports.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const {spawn} = require('node:child_process');
const assert = require('node:assert/strict');
const {initializeTestEnvironment,assertFails} = require('@firebase/rules-unit-testing');
const sdk = require('firebase/firestore');
const candidate = require('../../sipapua-spark-registration');
sdk.setLogLevel('silent');
const root = path.resolve(__dirname,'../..');
const projectId = 'demo-sipapua-spark-isolated';
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let passed=0;
async function check(name,fn){await fn(); passed++; console.log('PASS '+name);}
function wrap(db) {
    const ref = name => sdk.doc(db,name);
    const snapshot = s => ({exists:s.exists(),data:()=>s.data(),metadata:s.metadata});
    return {
        doc:name=>({raw:ref(name),get:async()=>snapshot(await sdk.getDocFromServer(ref(name))),update:data=>sdk.updateDoc(ref(name),data)}),
        runTransaction:fn=>sdk.runTransaction(db,tx=>fn({
            get:async r=>snapshot(await tx.get(r.raw)),
            set:(r,d)=>tx.set(r.raw,d),update:(r,d)=>tx.update(r.raw,d)
        }))
    };
}
async function main(){
    const jar=path.join(os.homedir(),'.cache/firebase/emulators/cloud-firestore-emulator-v1.22.0.jar');
    assert.ok(fs.existsSync(jar),'Local emulator JAR required');
    const socket=net.createServer();
    await new Promise((r,j)=>{socket.once('error',j);socket.listen(0,'127.0.0.1',r);});
    const port=socket.address().port;await new Promise(r=>socket.close(r));
    const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'sipapua-spark-'));
    const child=spawn('java',['-jar',jar,'--host','127.0.0.1','--port',String(port),'--webchannel_port','0','--websocket_port','0','--project_id',projectId,'--single_project_mode','--single_project_mode_error'],{cwd:temporary,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let log='',startupError,env;
    child.on('error',e=>startupError=e);
    for(const stream of [child.stdout,child.stderr]) stream.on('data',b=>{log=(log+b).slice(-16000);});
    try{
        let ready=false;
        for(let i=0;i<60;i++){
            if(startupError)throw startupError;
            if(child.exitCode!==null)throw Error(log);
            try{const r=await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(500)});await r.body?.cancel();if([200,404].includes(r.status)){ready=true;break;}}catch(_){}
            await sleep(500);
        }
        assert.ok(ready,log);
        env=await initializeTestEnvironment({projectId,firestore:{host:'127.0.0.1',port,rules:fs.readFileSync(path.join(root,process.env.SIPAPUA_TEST_RULES || 'docs/spark-release/firestore.proposed.rules'),'utf8')}});
        async function seed(name,data){await env.withSecurityRulesDisabled(c=>sdk.setDoc(sdk.doc(c.firestore(),name),data));}
        await seed('registration_control/state',{version:'original-spark-v1',enabled:true,maintenance:false});
        for(const region of Object.values(candidate.regions))await seed('nij_counters/'+region,{last:0});
        const input=(uid,phone='6281234567890')=>({uid,email:uid.toLowerCase()+'@example.test',email_normalized:uid.toLowerCase()+'@example.test',whatsapp:phone,whatsapp_normalized:phone,wilayah:'Abepura',status_akun:'Menunggu Verifikasi',nama:'Synthetic fixture'});
        const dbFor=uid=>env.authenticatedContext(uid,{email:uid.toLowerCase()+'@example.test',email_verified:false}).firestore();
        const client=uid=>{const user={uid,email:uid.toLowerCase()+'@example.test'};return {user,api:candidate.create(wrap(dbFor(uid)),{currentUser:user},sdk.serverTimestamp)};};
        async function eligibility(uid){await env.withSecurityRulesDisabled(async context=>{
            const db=context.firestore(),ref=sdk.doc(db,'uid_ownership/'+uid),existing=await sdk.getDoc(ref);
            if(!existing.exists())await sdk.setDoc(ref,require('../spark-release/ownership-cases.cjs').clear(uid,sdk));
        });}
        async function register(uid,phone){await eligibility(uid);const c=client(uid);return c.api.registerProfile(c.user,'ABE',input(uid,phone));}
        async function raw(uid,mutate=()=>{},code='ABE'){
            await eligibility(uid);
            const db=dbFor(uid),p=input(uid,'628'+String(1000000000+sequence++));
            p.wilayah=candidate.regions[code];
            const counter=await sdk.getDoc(sdk.doc(db,'nij_counters/'+p.wilayah));
            const n=counter.data().last+1;
            const year=new Intl.DateTimeFormat('en',{timeZone:'Asia/Jayapura',year:'numeric'}).format(new Date());
            const nij=`NIJ-PPP-${code}-${String(n).padStart(3,'0')}-${year}`,stamp=sdk.serverTimestamp();
            const writes=new Map([
                ['nij_counters/'+p.wilayah,{last:n,updatedAt:stamp}],
                ['nij_allocations/'+uid,{uid,lokasi:code,wilayah:p.wilayah,nij,nij_number:n,createdAt:stamp}],
                ['registration_unique/'+candidate.emailKey(p.email),{uid,createdAt:stamp}],
                ['registration_unique/phone_'+p.whatsapp_normalized,{uid,createdAt:stamp}],
                ['users/'+uid,{...p,nij,nij_number:n,createdAt:stamp}]
            ]);
            mutate(writes,p);
            const batch=sdk.writeBatch(db);
            for(const [key,value]of writes)batch.set(sdk.doc(db,key),value);
            batch.update(sdk.doc(db,'uid_ownership/'+uid),{state:'allocated',profileId:uid,nij,allocatedAt:stamp});
            return batch.commit();
        }
        let sequence=0;
        await check('real client adapter atomically registers identity documents and consumes eligibility',async()=>{
            const r=await register('member');assert.equal(r.nij_number,1);assert.match(r.nij,/^NIJ-PPP-ABE-001-/);
        });
        await check('same-account retry cannot allocate another NIJ',()=>assert.rejects(register('member')));
        await check('second sequential allocation succeeds with existing counter timestamp',()=>register('second','6281234567893'));
        await check('concurrent clients get distinct sequential NIJs',async()=>{
            const r=await Promise.all([register('raceA','6281234567891'),register('raceB','6281234567892')]);
            assert.deepEqual(r.map(x=>x.nij_number).sort(),[3,4]);
        });
        await check('duplicate phone cannot be reserved by a different UID',()=>assert.rejects(register('duplicate','6281234567890')));
        for(const code of ['STN','DYO','ARS1','ARS2'])await check('region '+code+' keeps counter and format bound',()=>raw('region'+code,()=>{},code));
        await check('counter increment without allocation denied',()=>assertFails(sdk.updateDoc(sdk.doc(dbFor('orphan'),'nij_counters/Abepura'),{last:4,updatedAt:sdk.serverTimestamp()})));
        await check('skipped counter denied',()=>assertFails(raw('skip',w=>{w.get('nij_counters/Abepura').last+=20;})));
        await check('forged NIJ denied even when profile and allocation agree',()=>assertFails(raw('forged',w=>{w.get('users/forged').nij='NIJ-PPP-ABE-999-2020';w.get('nij_allocations/forged').nij='NIJ-PPP-ABE-999-2020';})));
        await check('active status injection denied',()=>assertFails(raw('active',w=>{w.get('users/active').status_akun='Aktif';})));
        await check('email impersonation denied',()=>assertFails(raw('imposter',w=>{w.get('users/imposter').email='member@example.test';})));
        await check('missing reservation rolls back all writes',async()=>{
            await assertFails(raw('missing',w=>w.delete('registration_unique/email_missing@example.test')));
            assert.equal((await sdk.getDoc(sdk.doc(dbFor('missing'),'users/missing'))).exists(),false);
        });
        await check('foreign reservation UID denied',()=>assertFails(raw('foreign',w=>{w.get('registration_unique/email_foreign@example.test').uid='victim';})));
        await check('extra reservation denied',()=>assertFails(raw('extra',w=>w.set('registration_unique/phone_6289999999999',{uid:'extra',createdAt:sdk.serverTimestamp()}))));
        await check('permanent allocation cannot be edited or deleted',async()=>{
            const d=sdk.doc(dbFor('member'),'nij_allocations/member');
            await assertFails(sdk.updateDoc(d,{nij_number:900}));await assertFails(sdk.deleteDoc(d));
        });
        await check('reservation cannot be transferred or deleted',async()=>{
            const d=sdk.doc(dbFor('member'),'registration_unique/email_member@example.test');
            await assertFails(sdk.updateDoc(d,{uid:'other'}));await assertFails(sdk.deleteDoc(d));
        });
        await check('profile NIJ mutation denied',()=>assertFails(sdk.updateDoc(sdk.doc(dbFor('member'),'users/member'),{nij_number:999})));
        await check('unverified email cannot read UID-less legacy identity',async()=>{
            await seed('users/legacy-id',{email:'legacy@example.test',nij:'NIJ-PPP-ABE-050-2020',status_akun:'Pending'});
            await assertFails(sdk.getDoc(sdk.doc(dbFor('legacy'),'users/legacy-id')));
        });
        await check('activation manager still cannot invent a legacy UID binding',async()=>{
            await seed('admin_users/manager',{role:'master',status:'active',permissions:{canActivateMembers:true}});
            await assertFails(sdk.updateDoc(sdk.doc(dbFor('manager'),'users/legacy-id'),{uid:'guessed-uid',status_akun:'Aktif'}));
            await assertFails(sdk.setDoc(sdk.doc(dbFor('manager'),'registration_audit/invented'),{targetUid:'guessed-uid',actorUid:'manager',action:'activate-admin-override'}));
        });
        await check('preexisting permanent allocation prevents profile recreation',async()=>{
            await seed('nij_allocations/retired',{uid:'retired',lokasi:'ABE',wilayah:'Abepura',nij:'NIJ-PPP-ABE-080-2020',nij_number:80,createdAt:sdk.Timestamp.fromMillis(1)});
            await assertFails(raw('retired'));
        });
        await check('preexisting legacy email reservation cannot be reclaimed',async()=>{
            await seed('registration_unique/email_reserved@example.test',{uid:'legacy-owner',createdAt:sdk.Timestamp.fromMillis(1)});
            await assertFails(raw('reserved'));
        });
        await check('client cannot enable registry',()=>assertFails(sdk.updateDoc(sdk.doc(dbFor('manager'),'registration_control/state'),{enabled:true})));
        await check('maintenance fails closed',async()=>{
            await seed('registration_control/state',{version:'original-spark-v1',enabled:true,maintenance:true});
            await assertFails(raw('paused'));
        });
        console.log(`RESULT ${passed} PASS; creation candidate only. Lifecycle integration remains blocked.`);
    }catch(error){fs.writeFileSync(path.join(__dirname,'last-emulator-failure.log'),log);throw error;}
    finally{if(env)await env.cleanup();child.kill();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
