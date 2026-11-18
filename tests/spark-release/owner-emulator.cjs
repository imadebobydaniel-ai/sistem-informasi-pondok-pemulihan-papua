'use strict';
const assert=require('node:assert/strict');
const {execute}=require('../../scripts/owner-uid-clear.cjs');
const {PROJECT,PERMISSIONS}=require('../../scripts/legacy-uid-inventory.cjs');
module.exports=async function({ports,project,auth,authSDK,seed,inspect,check}){
    const user=(await authSDK.createUserWithEmailAndPassword(auth,'owner-operation-fixture@example.test','Synthetic-Password-21!')).user;
    const approval={project:PROJECT,uid:user.uid,reviewId:'SYNTHETIC-OWNER-REVIEW',organizationIdentityVerified:true,privilegedWritersCoordinated:true,approveProductionClear:true,approvedAt:new Date().toISOString()};
    const actor='owner@example.test';
    async function request(raw,body){
        const u=new URL(raw);
        if(u.hostname==='cloudresourcemanager.googleapis.com')return u.pathname.endsWith(':testIamPermissions')?{permissions:[...PERMISSIONS,'resourcemanager.projects.getIamPolicy','datastore.databases.get','datastore.entities.create']}:{bindings:[{role:'roles/owner',members:['user:'+actor]}]};
        if(u.hostname==='identitytoolkit.googleapis.com'){assert.deepEqual(body.localId,[user.uid]);return{users:[{localId:user.uid,disabled:false}]};}
        assert.equal(u.hostname,'firestore.googleapis.com');
        const target=`http://127.0.0.1:${ports.firestore}`+u.pathname.replace('/projects/'+PROJECT+'/', '/projects/'+project+'/')+u.search;
        let r;try{r=await fetch(target,{method:body===undefined?'GET':'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:'Bearer owner'},
            ...(body===undefined?{}:{body:JSON.stringify(body).replaceAll('projects/'+PROJECT+'/','projects/'+project+'/')}),signal:AbortSignal.timeout(10000)});}catch(_){throw Error('OWNER_EMULATOR_'+(body?.structuredQuery?'QUERY_'+body.structuredQuery.from[0].collectionId:body===undefined?'DOCUMENT_READ':u.pathname.endsWith(':beginTransaction')?'BEGIN':u.pathname.endsWith(':rollback')?'ROLLBACK':'COMMIT')+'_FAILED');}
        if(r.status===404&&body===undefined)return null;
        if(!r.ok)throw Error('ISOLATED_OWNER_REST_HTTP_'+r.status);
        return JSON.parse(JSON.stringify(await r.json()).replaceAll('projects/'+project+'/','projects/'+PROJECT+'/'));
    }
    await check('Owner preview uses real Firestore snapshot queries without issuing documents',async()=>{
        const r=await execute(approval,{actor,request});assert.equal(r.writes,0);assert.equal(await inspect('uid_ownership/'+user.uid),undefined);
    });
    await check('Owner atomic issuance creates clear and permanent audit using real REST transaction',async()=>{
        const r=await execute(approval,{actor,request,issue:true});assert.equal(r.writes,2);assert.equal((await inspect('uid_ownership/'+user.uid)).state,'clear');
        const id=require('node:crypto').createHash('sha256').update(user.uid).digest('hex');
        assert.equal((await inspect('registration_audit/uid-clear_'+id)).action,'uid-ownership-clear-issued');
    });
    await check('Owner duplicate issuance is denied by real current ownership record',async()=>{
        await assert.rejects(execute(approval,{actor,request,issue:true}),{code:'UID_ALREADY_OWNED_OR_REVIEWED'});
    });
    await check('noncanonical legacy ownership discovered by real transactional UID query blocks clear',async()=>{
        // A second active Auth fixture with its legacy relationship in a random ID.
        const other=(await authSDK.createUserWithEmailAndPassword(auth,'owned-operation-fixture@example.test','Synthetic-Password-22!')).user;
        await seed('users/owner-operation-legacy',{uid:other.uid,nij:'LEGACY-FIXTURE'});
        const alternate=async(url,body)=>url.includes('accounts:lookup')?{users:[{localId:other.uid,disabled:false}]}:request(url,body);
        await assert.rejects(execute({...approval,uid:other.uid},{actor,request:alternate,issue:true}),{code:'UID_ALREADY_OWNED_OR_REVIEWED'});
        assert.equal(await inspect('uid_ownership/'+other.uid),undefined);
        assert.equal((await inspect('users/owner-operation-legacy')).nij,'LEGACY-FIXTURE');
    });
};
