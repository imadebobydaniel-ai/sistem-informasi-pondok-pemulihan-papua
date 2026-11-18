'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {harness,registered,account}=require('./helpers.cjs');
const root=path.resolve(__dirname,'../..');
const denied=(fn,code)=>assert.rejects(fn,e=>e.code===code);
test('registry audit is read-only; active master prepare/enable is atomic and fingerprint-bound',async()=>{
    const h=harness();account(h);h.put('admin_users/member',{role:'master',status:'active'});
    const before=JSON.stringify(h.all()),audit=await h.call('auditSIPAPUARegistry');assert.equal(JSON.stringify(h.all()),before);
    await denied(()=>h.call('prepareSIPAPUARegistry',{fingerprint:'0'.repeat(64)}),'failed-precondition');
    assert.equal((await h.call('prepareSIPAPUARegistry',{fingerprint:audit.fingerprint})).acknowledged,true);
    const prepared=await h.call('auditSIPAPUARegistry');assert.equal(prepared.prepared,true);assert.equal(h.get('registration_control/state').maintenance,true);
    await h.call('enableSIPAPUARegistry',{fingerprint:prepared.fingerprint});assert.equal(h.get('registration_control/state').maintenance,false);
    for(const region of ['Abepura','Sentani','Doyo','ARS1','ARS2'])assert.equal(h.get('nij_counters/'+region).last,0);
    await denied(()=>h.call('prepareSIPAPUARegistry',{fingerprint:prepared.fingerprint}),'failed-precondition');
});
test('registry preparation denies anonymous, inactive, admin/viewer and unexpected fields',async()=>{
    const h=harness();account(h);await denied(()=>h.call('auditSIPAPUARegistry',{},null),'unauthenticated');
    for(const role of ['admin','viewer']){h.put('admin_users/member',{role,status:'active'});await denied(()=>h.call('auditSIPAPUARegistry'),'permission-denied');}
    h.put('admin_users/member',{role:'master',status:'inactive'});await denied(()=>h.call('auditSIPAPUARegistry'),'permission-denied');
    h.put('admin_users/member',{role:'master',status:'active'});await denied(()=>h.call('auditSIPAPUARegistry',{enabled:true}),'invalid-argument');
});
test('registry plan never decreases counters, deletes reservations, or creates NIJ allocations',()=>{
    const p=harness().registry.planForTests({users:[{id:'member',data:{uid:'member',email:'member@example.test',whatsapp:'081234567890',nij:'NIJ-PPP-ABE-005-2026',nij_number:5}}],allocations:[{id:'deleted',data:{nij:'NIJ-PPP-ABE-007-2025',nij_number:7}}],counters:[{id:'Abepura',data:{last:20}}],claims:[{id:'email_deleted@example.test',data:{uid:'deleted'}}]});
    assert.equal(p.counters.Abepura,20);assert.ok(p.writes.every(w=>['registration_unique','nij_counters'].includes(w.collection)));assert.ok(!p.writes.some(w=>w.id==='email_deleted@example.test'));
});
test('reservation conflict, invalid NIJ and transaction failure cannot partially prepare registry',async()=>{
    const h=await registered();h.put('admin_users/member',{role:'master',status:'active'});h.put('registration_control/state',{enabled:false,maintenance:true,version:'original-spark-v1'});
    h.put('registration_unique/email_member@example.test',{uid:'other'});const audit=await h.call('auditSIPAPUARegistry'),before=JSON.stringify(h.all());
    assert.ok(audit.issues.some(i=>i.code==='IDENTITY_RESERVATION_CONFLICT'));await denied(()=>h.call('prepareSIPAPUARegistry',{fingerprint:audit.fingerprint}),'failed-precondition');assert.equal(JSON.stringify(h.all()),before);
    const empty=harness();account(empty);empty.put('admin_users/member',{role:'super_admin',status:'active'});const a=await empty.call('auditSIPAPUARegistry');const original=JSON.stringify(empty.all());empty.fail();await assert.rejects(()=>empty.call('prepareSIPAPUARegistry',{fingerprint:a.fingerprint}));assert.equal(JSON.stringify(empty.all()),original);
});
test('client preparation facade has no database write path; retains public method names',async()=>{
    const api=require('../../sipapua-registration-preparation.js'),calls=[],user={uid:'manager'};
    const facade=api.create(new Proxy({},{get(){throw Error('No client database access allowed');}}),{currentUser:user},()=>{}, {httpsCallable:name=>async data=>{calls.push({name,data});return {data:{fingerprint:'a'.repeat(64),prepared:true}};}});
    await facade.audit();await facade.prepare('a'.repeat(64));await facade.enable('a'.repeat(64));await facade.abort();
    assert.ok(calls.some(c=>c.name==='prepareSIPAPUARegistry'));assert.ok(calls.some(c=>c.name==='enableSIPAPUARegistry'));assert.ok(calls.some(c=>c.name==='abortSIPAPUARegistry'));
    const source=fs.readFileSync(path.join(root,'sipapua-registration-preparation.js'),'utf8');assert.ok(!source.includes('db.runTransaction'));assert.ok(!source.includes('batch.commit'));
});
test('family search requires Auth and limits members to consent-bound minimal projection',async()=>{
    const h=await registered();h.put('users/relative',{uid:'relative',nama:'Synthetic Parent',nij:'FIXTURE-NOT-ALLOCATED',email:'private@example.test'});
    await denied(()=>h.call('searchSIPAPUAFamily',{query:'Synthetic'},null),'unauthenticated');
    assert.equal((await h.call('searchSIPAPUAFamily',{query:'Synthetic'})).results.length,0);
    h.put('family_link_consents/relative',{enabled:true,allowedUids:['member']});const found=await h.call('searchSIPAPUAFamily',{query:'Synthetic'});
    assert.equal(found.results.length,1);assert.deepEqual(Object.keys(found.results[0]).sort(),['nama','nij','uid']);
    h.put('family_link_consents/relative',{enabled:false,allowedUids:['member']});assert.equal((await h.call('searchSIPAPUAFamily',{query:'Synthetic'})).results.length,0);
});
test('family search quota, invalid input, and UI have no public users fallback',async()=>{
    const h=await registered();await denied(()=>h.call('searchSIPAPUAFamily',{query:'x'}),'invalid-argument');
    for(let i=0;i<5;i++)await h.call('searchSIPAPUAFamily',{query:'Synthetic'});await denied(()=>h.call('searchSIPAPUAFamily',{query:'Synthetic'}),'resource-exhausted');
    const html=fs.readFileSync(path.join(root,'registrasi.html'),'utf8'),a=html.indexOf('    async function findFamilyReferenceUsers'),b=html.indexOf('    function renderFamilyReferenceResults',a),source=html.slice(a,b);
    assert.ok(!source.includes('.collection('));assert.ok(source.includes('searchSIPAPUAFamily'));assert.ok(source.includes('if(!auth.currentUser)return []'));
    for(const [,code]of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(code);
});
test('all new callable exports retain production App Check enforcement',()=>{
    const h=harness();for(const value of Object.values(h.registry))if(value?.options)assert.equal(value.options.enforceAppCheck,true);assert.equal(h.registration.searchSIPAPUAFamily.options.enforceAppCheck,true);
});
test('duplicate permanent allocations and unknown counter schema block preparation rather than overwrite',()=>{
    const p=harness().registry.planForTests({users:[],claims:[],allocations:[
        {id:'first',data:{uid:'first',nij:'NIJ-PPP-ABE-005-2025',nij_number:5}},
        {id:'second',data:{uid:'second',nij:'NIJ-PPP-ABE-005-2026',nij_number:5}}
    ],counters:[{id:'Abepura',data:{last:10,unknown:'must not be removed'}}]});
    assert.ok(p.issues.some(i=>i.code==='DUPLICATE_PERMANENT_NIJ'));assert.ok(p.issues.some(i=>i.code==='COUNTER_REVIEW_REQUIRED'));
});
test('authorized legacy family names remain searchable; own alias links cannot be forged',async()=>{
    const h=await registered();h.put('users/relative',{uid:'relative',nama_lengkap:'Synthetic Parent',nij:'FIXTURE-NOT-ALLOCATED',email:'parent@example.test'});
    h.put('family_link_consents/relative',{enabled:true,allowedUids:['member']});
    h.put('users/self-alias',{uid:'member',nama:'Synthetic Self',nij:'SELF-FIXTURE',email:'member@example.test'});
    h.put('family_link_consents/self-alias',{enabled:true,allowedUids:['member']});
    const found=await h.call('searchSIPAPUAFamily',{query:'Synthetic'});assert.equal(found.results.length,1);assert.equal(found.results[0].nama,'Synthetic Parent');
    const base={uid:'member',email_normalized:'member@example.test',anak:[],nama_ayah:'Synthetic Parent',nama_ayah_uid:'relative',nama_ayah_nij:'FIXTURE-NOT-ALLOCATED'};
    await h.db.runTransaction(tx=>h.registration.__validationForTests.validateFamily(h.db,base,tx));
    await denied(()=>h.db.runTransaction(tx=>h.registration.__validationForTests.validateFamily(h.db,{...base,nama_ayah:'Synthetic Self',nama_ayah_uid:'self-alias',nama_ayah_nij:'SELF-FIXTURE'},tx)),'permission-denied');
});
test('Cloudinary existing widget callback remains compatible with synthetic HTTPS photo',()=>{
    const source=fs.readFileSync(path.join(root,'edit-jemaat-administrator.html'),'utf8');
    const code=source.slice(source.indexOf('    let profilePhotoUrl = "";'),source.indexOf("    document.getElementById('editForm').onsubmit"));
    let callback,config;const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,{style:{},textContent:''});return elements.get(id);};
    const context=vm.createContext({document:{getElementById:get},cloudinary:{createUploadWidget:(options,fn)=>{config=options;callback=fn;return {open(){}};}},console});context.window=context;
    vm.runInContext(code,context);vm.runInContext('initializeProfilePhotoWidget()',context);assert.equal(config.multiple,false);assert.equal(config.maxFiles,1);
    callback(null,{event:'success',info:{secure_url:'https://res.cloudinary.com/synthetic-only/image/upload/fixture.jpg'}});
    assert.equal(vm.runInContext('profilePhotoUrl',context),'https://res.cloudinary.com/synthetic-only/image/upload/fixture.jpg');assert.match(get('foto_profil_status').textContent,/siap disimpan/);
});
