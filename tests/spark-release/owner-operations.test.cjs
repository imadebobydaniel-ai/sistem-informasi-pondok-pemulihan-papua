'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {execute,validate,transport,base}=require('../../scripts/owner-uid-clear.cjs');
const {PROJECT,PERMISSIONS}=require('../../scripts/legacy-uid-inventory.cjs');
const actor='owner@example.test';
const approval=()=>({project:PROJECT,uid:'synthetic-uid',reviewId:'SYNTHETIC-REVIEW',organizationIdentityVerified:true,privilegedWritersCoordinated:true,approveProductionClear:true,approvedAt:new Date().toISOString()});
function harness({existing,queryConflict,owner=true,active=true,permissions=true,commitFailure=false}={}){
    const calls=[];const request=async(url,body)=>{
        calls.push({url,body});
        if(url.includes(':testIamPermissions'))return{permissions:permissions?[...PERMISSIONS,'resourcemanager.projects.getIamPolicy','datastore.databases.get','datastore.entities.create']:[]};
        if(url.includes(':getIamPolicy'))return{bindings:owner?[{role:'roles/owner',members:['user:'+actor]}]:[]};
        if(url.includes('accounts:lookup'))return{users:[{localId:'synthetic-uid',disabled:!active}]};
        if(url.endsWith(':beginTransaction'))return{transaction:'SYNTHETIC_TRANSACTION'};
        if(url.endsWith(':batchGet'))return body.documents.map(name=>existing&&name.includes('/'+existing+'/')?{found:{name,fields:{uid:{stringValue:'PRIVATE_UID'}}}}:{missing:name});
        if(url.endsWith(':runQuery'))return queryConflict===body.structuredQuery.from[0].collectionId?[{document:{name:'PRIVATE_DOCUMENT'}}]:[{readTime:'synthetic'}];
        if(url.endsWith(':commit')){if(commitFailure)throw Error('SYNTHETIC_CREATE_CONFLICT');return{commitTime:'synthetic'};}
        if(url.endsWith(':rollback'))return{};
        return existing&&url.includes('/'+existing+'/')?{fields:{uid:{stringValue:'PRIVATE_UID'}}}:null;
    };return{calls,request};
}
test('preview performs complete ownership checks but never commits a clear',async()=>{
    const h=harness(),r=await execute(approval(),{actor,request:h.request});assert.equal(r.writes,0);assert.equal(r.decision,'ELIGIBLE_PREVIEW_ONLY');
    assert.equal(h.calls.filter(c=>c.url.endsWith(':runQuery')).length,5);assert.ok(!h.calls.some(c=>c.url.endsWith(':commit')));assert.ok(h.calls.some(c=>c.url.endsWith(':rollback')));
});
test('separate fresh approval creates only ownership and audit atomically with exists:false',async()=>{
    const h=harness(),r=await execute(approval(),{actor,request:h.request,issue:true});assert.equal(r.writes,2);
    const commit=h.calls.find(c=>c.url.endsWith(':commit')).body;assert.equal(commit.transaction,'SYNTHETIC_TRANSACTION');assert.equal(commit.writes.length,2);
    for(const w of commit.writes)assert.equal(w.currentDocument.exists,false);
    assert.ok(commit.writes[0].update.name.includes('/uid_ownership/'));assert.ok(commit.writes[1].update.name.includes('/registration_audit/'));
    assert.ok(!JSON.stringify(r).includes('synthetic-uid'));assert.ok(!JSON.stringify(r).includes(actor));
});
for(const existing of ['users','nij_allocations','member_identity','uid_ownership'])test('existing '+existing+' blocks issuance',async()=>{
    const h=harness({existing});await assert.rejects(execute(approval(),{actor,request:h.request,issue:true}),{code:'UID_ALREADY_OWNED_OR_REVIEWED'});assert.ok(!h.calls.some(c=>c.url.endsWith(':commit')));
});
for(const queryConflict of ['users','nij_allocations','member_identity','legacy_profile_owners','uid_ownership'])test('noncanonical UID in '+queryConflict+' blocks issuance',async()=>{
    const h=harness({queryConflict});await assert.rejects(execute(approval(),{actor,request:h.request,issue:true}),{code:'UID_ALREADY_OWNED_OR_REVIEWED'});assert.ok(!h.calls.some(c=>c.url.endsWith(':commit')));
});
test('disabled Auth and unverified Owner IAM binding fail closed',async()=>{
    for(const options of [{active:false},{owner:false},{permissions:false}]){const h=harness(options);await assert.rejects(execute(approval(),{actor,request:h.request,issue:true}));assert.ok(!h.calls.some(c=>c.url.endsWith(':commit')));}
});
test('missing, stale, future and bulk approvals never authorize writes',()=>{
    for(const a of [{...approval(),approveProductionClear:false},{...approval(),approvedAt:'invalid'},{...approval(),approvedAt:new Date(Date.now()-3600000).toISOString()},
        {...approval(),approvedAt:new Date(Date.now()+3600000).toISOString()},{...approval(),uid:['a','b']},{...approval(),organizationIdentityVerified:false},{...approval(),privilegedWritersCoordinated:false}])assert.throws(()=>validate(a,true));
});
test('duplicate create failure is not retried or converted to an upsert',async()=>{
    const h=harness({commitFailure:true});await assert.rejects(execute(approval(),{actor,request:h.request,issue:true}));assert.equal(h.calls.filter(c=>c.url.endsWith(':commit')).length,1);
});
test('transport blocks profile mutation even with privileged credentials',async()=>{
    let calls=0;const request=transport(async()=>{calls++;return{ok:true,json:async()=>({})};},'PRIVATE_TOKEN');
    await assert.rejects(request(base+':commit',{transaction:'t',writes:[{update:{name:'PRIVATE_PROFILE'}}]}),{code:'OWNER_WRITE_SCOPE_BLOCKED'});assert.equal(calls,0);
    await assert.rejects(request('https://other.example.test/',{}),{code:'OWNER_ENDPOINT_NOT_ALLOWED'});
});
test('official quota project is sent and error bodies never printed',async()=>{
    const request=transport(async(url,options)=>{assert.equal(options.headers['X-Goog-User-Project'],PROJECT);assert.equal(options.redirect,'error');return{ok:false,status:403,json:async()=>({error:{message:'PRIVATE_TOKEN PRIVATE_UID'}})};},'PRIVATE_TOKEN');
    await assert.rejects(request('https://identitytoolkit.googleapis.com/v1/projects/'+PROJECT+'/accounts:lookup',{localId:['synthetic-uid']}),{code:'OWNER_HTTP_403'});
});
test('public website verifier only GETs known public assets and never treats static hashes as attestation',async()=>{
    const fs=require('node:fs'),path=require('node:path'),{verify}=require('../../scripts/verify-spark-public.cjs');
    const result=await verify(async(raw,options)=>{
        const u=new URL(raw);assert.equal(u.origin,'https://imadebobydaniel-ai.github.io');assert.equal(options.method,'GET');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
        const file=u.pathname.split('/').pop();return{status:200,text:async()=>fs.readFileSync(path.join(__dirname,'../..',file),'utf8')};
    });assert.equal(result.publicAssetsMatched,13);assert.equal(result.appCheckAttestationVerified,false);
});
test('public verifier refuses a stale or missing website release',async()=>{
    const {verify}=require('../../scripts/verify-spark-public.cjs');
    await assert.rejects(verify(async()=>({status:404})),/PUBLIC_ASSET_UNAVAILABLE/);
    await assert.rejects(verify(async()=>({status:200,text:async()=>'STALE_RELEASE'})),/PUBLIC_RELEASE_HASH_MISMATCH/);
});
