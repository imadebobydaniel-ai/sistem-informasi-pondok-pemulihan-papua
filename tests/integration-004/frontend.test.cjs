'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
function part(s,a,b){const i=s.indexOf(a),j=s.indexOf(b,i);assert.ok(i>=0&&j>i,a);return s.slice(i,j);}
const pages=['index.html','auth-handler.html','verify-success.html','edit-jemaat-administrator.html','database-jemaat.html','profil.html','setting.html','cetak-kartu.html','menu.html','baca-alkitab.html','call-center.html','games.html','halo-pope.html','informasi-email.html','kartu-digital.html','laporan-pelayanan.html','registrasi.html'];
test('every changed HTML inline script parses; no candidate/emulator runtime introduced',()=>{for(const p of pages){const html=read(p);for(const [,code]of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(code,{filename:p});assert.ok(!html.includes('candidate-runtime.js'),p);assert.ok(!html.includes('useEmulator('),p);}});
test('all audited own-email queries use authorized own-profile adapter',()=>{for(const p of pages){assert.ok(!/db\s*\.collection\(\s*["']users["']\s*\)\s*\.where\(\s*["']email["']/.test(read(p)),p);}});
for(const active of [true,false])test('actual login stores/navigates only after backend active='+active,async()=>{
    const stored=new Map(),events=[],user={uid:'member',email:'member@example.test'};
    const context=vm.createContext({memberLogin:{status:async()=>{events.push('backend');return {active,emailVerified:false};}},localStorage:{setItem:(k,v)=>stored.set(k,v),removeItem:k=>stored.delete(k)},window:{location:{replace:p=>events.push(p)}},openVerifyModal:()=>events.push('verify'),showBlockNotif:()=>{}});
    vm.runInContext(part(read('index.html'),'        async function confirmLogin','        auth.onAuthStateChanged'),context);
    context.user=user;await vm.runInContext('confirmLogin(user)',context);
    assert.equal(stored.has('userUid'),active);assert.equal(events.includes('menu.html'),active);assert.equal(events[0],'backend');
});
test('actual login backend error cannot establish local authorization',async()=>{const stored=new Map(),context=vm.createContext({memberLogin:{status:async()=>{throw Error('offline');}},localStorage:{setItem:(k,v)=>stored.set(k,v),removeItem:k=>stored.delete(k)}});vm.runInContext(part(read('index.html'),'        async function confirmLogin','        auth.onAuthStateChanged'),context);await assert.rejects(()=>vm.runInContext('confirmLogin({uid:"member"})',context));assert.equal(stored.size,0);});
test('session change during token refresh prevents status callable',async()=>{const api=require('../../sipapua-login.js');let called=0;const auth={currentUser:null},user={uid:'member',reload:async()=>{auth.currentUser={uid:'other'};},getIdToken:async()=>{}};auth.currentUser=user;await assert.rejects(()=>api.create(auth,{httpsCallable:()=>async()=>{called++;}}).status());assert.equal(called,0);});
test('existing activation form retains full editor/photo and sends exact audited contract',async()=>{
    const html=read('edit-jemaat-administrator.html');assert.ok(html.includes('upload-widget.cloudinary.com'));assert.ok(html.includes('await originalRegistrationService().updateProfile(userId, updateData)'));assert.ok(!html.includes('Editor lengkap belum tersedia'));
    const elements=new Map(),calls=[],get=id=>{if(!elements.has(id))elements.set(id,{value:'Aktif',checked:true,disabled:false,textContent:''});return elements.get(id);};
    const actor={uid:'actor',reload:async()=>{},getIdToken:async()=>{}},context=vm.createContext({document:{getElementById:get},auth:{currentUser:actor},userId:'target',db:{collection:()=>({doc:()=>({get:async()=>({exists:true,data:()=>({role:'master',status:'active',permissions:{canActivateMembers:true}})})})})},firebase:{},window:{SIPAPUA_MEMBER_SESSION:{create:()=>({callable:name=>async data=>{calls.push({name,...data});return {data:{active:true}};}})}}});
    vm.runInContext(part(html,'    async function activateMemberFromExistingEditor()','    function denyEditAccess'),context);await vm.runInContext('activateMemberFromExistingEditor()',context);
    assert.deepEqual(calls,[{name:'adminActivateSIPAPUAProfile',targetUid:'target',identityVerified:true}]);assert.match(get('existing_activation_result').textContent,/dikonfirmasi/);
});
test('actual activation form rejects missing identity attestation before backend',async()=>{
    let called=0;const elements={activate_existing_member:{disabled:false},existing_activation_result:{textContent:''},status_akun:{value:'Aktif'},activation_identity_confirmed:{checked:false}};
    const context=vm.createContext({document:{getElementById:id=>elements[id]},window:{SIPAPUA_MEMBER_SESSION:{create:()=>{called++;}}}});
    vm.runInContext(part(read('edit-jemaat-administrator.html'),'    async function activateMemberFromExistingEditor()','    function denyEditAccess'),context);await vm.runInContext('activateMemberFromExistingEditor()',context);assert.equal(called,0);assert.match(elements.existing_activation_result.textContent,/belum dikonfirmasi/);
});
test('callable session helper fails closed without production App Check key',async()=>{
    const context=vm.createContext({SIPAPUA_APP_CHECK:{prepare:()=>{throw Error('no key');}}});context.window=context;vm.runInContext(read('sipapua-member-session.js'),context);
    const user={uid:'member'},app={functions:()=>({httpsCallable:()=>{throw Error('must not be reached');}})},firebase={app:()=>app,auth:()=>({currentUser:user})};
    await assert.rejects(()=>context.SIPAPUA_MEMBER_SESSION.create(firebase).callable('memberLoginStatus')({}),/App Check/);
});
test('edit/delete helpers send backend requests and never write ledgers directly',async()=>{
    const api=require('../../sipapua-registration.js'),calls=[],user={uid:'member'},service=api.create({collection:()=>({doc:()=>({})})},{currentUser:user},()=>{}, {httpsCallable:name=>async data=>{calls.push({name,data});return {data:{updated:true,deleted:true}};}});
    await service.updateProfile('member',{nama:'Edited'});await service.deleteProfile('member');await service.deleteProfiles(['member','other']);assert.deepEqual(calls.map(c=>c.name),['updateSIPAPUAProfile','deleteSIPAPUAProfiles','deleteSIPAPUAProfiles']);
    const source=read('sipapua-registration.js');assert.ok(!source.includes('tx.delete('));assert.ok(!source.includes('tx.update('));assert.ok(!source.includes('tx.set('));
});
test('legacy own-email adapter waits for Auth restoration and rejects querying another account',async()=>{
    const user={uid:'member',email:'member@example.test'},calls=[],auth={currentUser:null,onAuthStateChanged:fn=>{queueMicrotask(()=>{auth.currentUser=user;fn(user);});return ()=>{};}};
    const app={functions:()=>({httpsCallable:name=>async data=>{calls.push(name);return {data:{id:'legacy-document',profile:{nama:'Legacy',email:user.email}}};}})};
    const context=vm.createContext({queueMicrotask,SIPAPUA_APP_CHECK:{prepare:()=>async()=>{calls.push('token');}}});context.window=context;
    vm.runInContext(read('sipapua-member-session.js'),context);
    const firebase={app:()=>app,auth:()=>auth,firestore:()=>({collection:()=>({doc:id=>({id})})})};
    const snapshot=await context.SIPAPUA_MEMBER_SESSION.query(firebase).where('email','==',user.email).get();
    assert.equal(snapshot.docs[0].id,'legacy-document');assert.deepEqual(calls,['token','getSIPAPUAOwnProfile']);
    await assert.rejects(()=>context.SIPAPUA_MEMBER_SESSION.query(firebase).where('email','==','other@example.test').get());assert.equal(calls.length,2);
});
test('unverified legacy override displays only backend-authorized snapshot, without direct email subscription',async()=>{
    const user={uid:'member',email:'member@example.test',emailVerified:false};let subscriptions=0,delivered;
    const auth={currentUser:user,onAuthStateChanged:fn=>{queueMicrotask(()=>fn(user));return ()=>{};}};
    const app={functions:()=>({httpsCallable:()=>async()=>({data:{id:'legacy-document',profile:{email:user.email,nama:'Legacy'}}})})};
    const firebase={app:()=>app,auth:()=>auth,firestore:()=>({collection:()=>({doc:()=>({onSnapshot:()=>{subscriptions++;throw Error('must not subscribe');}})})})};
    const context=vm.createContext({queueMicrotask,SIPAPUA_APP_CHECK:{prepare:()=>async()=>{}}});context.window=context;vm.runInContext(read('sipapua-member-session.js'),context);
    const stop=context.SIPAPUA_MEMBER_SESSION.query(firebase).where('email','==',user.email).onSnapshot(s=>{delivered=s;},e=>{throw e;});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(delivered.docs[0].id,'legacy-document');assert.equal(subscriptions,0);stop();
});
