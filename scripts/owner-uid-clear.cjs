'use strict';
// PRIVATE OWNER CLI. Default is preview. No HTTP server, browser SDK, bulk mode,
// service-account key file or production operation on module import.
const fs=require('node:fs'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const {PROJECT,PERMISSIONS,InventoryError,tokenFromGcloud,auth403Cause}=require('./legacy-uid-inventory.cjs');
const base=`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const prefix=`projects/${PROJECT}/databases/(default)/documents/`;
const fail=code=>{throw new InventoryError(code);};
const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
function validate(a,issue){
    if(!a||a.project!==PROJECT||typeof a.uid!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(a.uid)
        ||typeof a.reviewId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(a.reviewId)
        ||a.organizationIdentityVerified!==true||a.privilegedWritersCoordinated!==true)fail('INVALID_OR_INCOMPLETE_OWNER_REVIEW');
    if(issue&&(a.approveProductionClear!==true||typeof a.approvedAt!=='string'||Date.now()-Date.parse(a.approvedAt)<0||Date.now()-Date.parse(a.approvedAt)>900000||!Number.isFinite(Date.parse(a.approvedAt))))fail('FRESH_SEPARATE_PRODUCTION_APPROVAL_REQUIRED');
}
function transport(fetchImpl,token){return async(url,body)=>{
    const u=new URL(url),method=body===undefined?'GET':'POST';
    const allowed=u.origin==='https://cloudresourcemanager.googleapis.com'&&u.pathname===`/v1/projects/${PROJECT}:testIamPermissions`
        ||u.origin==='https://cloudresourcemanager.googleapis.com'&&u.pathname===`/v1/projects/${PROJECT}:getIamPolicy`
        ||u.origin==='https://identitytoolkit.googleapis.com'&&u.pathname===`/v1/projects/${PROJECT}/accounts:lookup`
        ||u.origin==='https://firestore.googleapis.com'&&[base+':beginTransaction',base+':batchGet',base+':runQuery',base+':commit',base+':rollback'].some(v=>url===v);
    if(!allowed||u.protocol!=='https:'||u.username||u.password)fail('OWNER_ENDPOINT_NOT_ALLOWED');
    if(url===base+':commit'){
        const writes=body?.writes,first=writes?.[0],second=writes?.[1],uid=first?.update?.fields?.uid?.stringValue;
        if(typeof uid!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(uid)||writes.length!==2
            ||first.update.name!==prefix+'uid_ownership/'+uid||second?.update?.name!==prefix+'registration_audit/uid-clear_'+digest(uid)
            ||first.currentDocument?.exists!==false||second.currentDocument?.exists!==false
            ||first.update.fields.state?.stringValue!=='clear'||second.update.fields.action?.stringValue!=='uid-ownership-clear-issued'
            ||second.update.fields.uid?.stringValue!==uid
            ||writes.some(w=>Object.keys(w).some(k=>!['update','currentDocument'].includes(k))))fail('OWNER_WRITE_SCOPE_BLOCKED');
    }
    let r;try{r=await fetchImpl(url,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Goog-User-Project':PROJECT},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(30000)});}catch(_){fail('OWNER_TRANSPORT_FAILED');}
    if(!r.ok){if(r.status===404&&method==='GET')return null;const cause=u.hostname==='identitytoolkit.googleapis.com'&&r.status===403?await auth403Cause(r):null;fail('OWNER_HTTP_'+r.status+(cause?'_CAUSE_'+cause:''));}
    try{return await r.json();}catch(_){fail('OWNER_INVALID_RESPONSE');}
};}
async function execute(a,{request,actor,issue=false,now=()=>new Date()}={}){
    validate(a,issue);
    const permissions=[...PERMISSIONS,'resourcemanager.projects.getIamPolicy','datastore.databases.get',...(issue?['datastore.entities.create']:[])];
    const granted=await request(`https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}:testIamPermissions`,{permissions});
    if(!permissions.every(p=>granted.permissions?.includes(p)))fail('OWNER_PERMISSIONS_NOT_VERIFIED');
    const policy=await request(`https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}:getIamPolicy`,{options:{requestedPolicyVersion:3}});
    if(!policy.bindings?.some(b=>b.role==='roles/owner'&&!b.condition&&b.members?.includes('user:'+actor)))fail('DIRECT_OWNER_BINDING_NOT_VERIFIED');
    const auth=await request(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:lookup?fields=users(localId,disabled)`,{localId:[a.uid]});
    if(auth.users?.length!==1||auth.users[0].localId!==a.uid||auth.users[0].disabled===true)fail('AUTH_UID_NOT_CONFIRMED_ACTIVE');
    const transaction=(await request(base+':beginTransaction',{options:issue?{readWrite:{}}:{readOnly:{}}})).transaction;
    if(typeof transaction!=='string'||!transaction)fail('TRANSACTION_NOT_ESTABLISHED');
    let committed=false;
    try{
        const names=['users','nij_allocations','member_identity','uid_ownership'].map(c=>prefix+c+'/'+a.uid);
        const points=await request(base+':batchGet',{transaction,documents:names,mask:{fieldPaths:['uid']}});
        if(!Array.isArray(points)||points.filter(r=>r.found||r.missing).length!==names.length||!names.every(name=>points.some(r=>r.missing===name||r.found?.name===name)))fail('INVALID_OWNERSHIP_POINT_RESULT');
        if(points.some(r=>r.found))fail('UID_ALREADY_OWNED_OR_REVIEWED');
        for(const c of ['users','nij_allocations','member_identity','legacy_profile_owners','uid_ownership']){
            const rows=await request(base+':runQuery',{transaction,structuredQuery:{from:[{collectionId:c}],select:{fields:[{fieldPath:'uid'}]},
                where:{fieldFilter:{field:{fieldPath:'uid'},op:'EQUAL',value:{stringValue:a.uid}}},limit:1}});
            if(!Array.isArray(rows))fail('INVALID_OWNERSHIP_QUERY_RESULT');
            if(rows.some(r=>r.document))fail('UID_ALREADY_OWNED_OR_REVIEWED');
        }
        const reviewedAt=now(),expiresAt=new Date(reviewedAt.getTime()+3600000);
        const auditId='uid-clear_'+digest(a.uid),reviewHash=digest(a.reviewId+'\0'+a.uid+'\0'+reviewedAt.toISOString());
        const summary={decision:issue?'ISSUED':'ELIGIBLE_PREVIEW_ONLY',uidReference:digest(a.uid).slice(0,24),reviewReference:digest(a.reviewId).slice(0,24),writes:issue?2:0};
        if(!issue)return summary;
        // Exactly two creates, never update/upsert. Audit and eligibility commit
        // together. Existing records (including expired clear) are never replaced.
        const record={uid:{stringValue:a.uid},state:{stringValue:'clear'},profileId:{stringValue:''},reviewId:{stringValue:reviewHash},
            reviewedAt:{timestampValue:reviewedAt.toISOString()},expiresAt:{timestampValue:expiresAt.toISOString()}};
        const audit={action:{stringValue:'uid-ownership-clear-issued'},uid:{stringValue:a.uid},reviewId:{stringValue:reviewHash},
            actorReference:{stringValue:digest(actor)},organizationIdentityVerified:{booleanValue:true},createdAt:{timestampValue:reviewedAt.toISOString()}};
        await request(base+':commit',{transaction,writes:[{update:{name:prefix+'uid_ownership/'+a.uid,fields:record},currentDocument:{exists:false}},
            {update:{name:prefix+'registration_audit/'+auditId,fields:audit},currentDocument:{exists:false}}]});
        committed=true;return summary;
    }finally{if(!committed)try{await request(base+':rollback',{transaction});}catch(_){/* Original safe error retained; do not log server body. */}}
}
function actorFromGcloud(){
    function run(command){try{return execFileSync(process.platform==='win32'?'cmd.exe':'gcloud',process.platform==='win32'?['/d','/s','/c','gcloud.cmd '+command.replace('--format=value(account)','--format="value(account)"')]:command.split(' '),{encoding:'utf8',stdio:['ignore','pipe','ignore'],windowsHide:true}).trim();}catch(_){fail('OFFICIAL_OWNER_IDENTITY_UNAVAILABLE');}}
    const impersonation=run('config get-value auth/impersonate_service_account');
    if(impersonation&&impersonation!=='(unset)')fail('IMPERSONATION_NOT_SUPPORTED_BY_OWNER_TOOL');
    const actor=run('auth list --filter=status:ACTIVE --format=value(account)');
    if(!/^[A-Za-z0-9._+\-]+@[A-Za-z0-9.\-]+$/.test(actor))fail('SINGLE_OWNER_ACCOUNT_REQUIRED');return actor;
}
async function main(args=process.argv.slice(2)){
    const mode=args[0];if(!['--preview','--issue-approved'].includes(mode)||args.length!==2)fail('OWNER_REVIEW_FILE_REQUIRED');
    if(process.env.FIRESTORE_EMULATOR_HOST||process.env.FIREBASE_AUTH_EMULATOR_HOST||process.env.CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT)fail('UNSUPPORTED_OWNER_ENVIRONMENT');
    let approval;try{approval=JSON.parse(fs.readFileSync(args[1],'utf8').replace(/^\uFEFF/,''));}catch(_){fail('INVALID_OWNER_REVIEW_FILE');}
    validate(approval,mode==='--issue-approved');
    const actor=actorFromGcloud(),token=tokenFromGcloud();
    const result=await execute(approval,{actor,issue:mode==='--issue-approved',request:transport(globalThis.fetch,token)});
    console.log(JSON.stringify(result));
}
module.exports={execute,validate,transport,base};
if(require.main===module)main().catch(e=>{console.error(e instanceof InventoryError?e.code:'OWNER_OPERATION_FAILED_NO_RAW_DETAILS');process.exitCode=1;});
