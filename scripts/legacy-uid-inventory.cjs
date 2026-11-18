'use strict';
// Owner-run read-only REST inventory. No Firebase Admin SDK, deploy, or writer.
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const PROJECT='boby-apps-project';
const PERMISSIONS=['datastore.entities.get','datastore.entities.list','firebaseauth.users.get','serviceusage.services.use'];
const MASKS=Object.freeze({users:['uid','nij','nij_number','wilayah'],nij_allocations:['uid','nij','nij_number','wilayah','lokasi'],
    member_identity:['uid','profileId','grantId','linkedAt'],legacy_profile_owners:['uid','profileId','grantId','linkedAt'],
    uid_ownership:['uid','state','profileId','reviewId','reviewedAt','expiresAt']});
class InventoryError extends Error{constructor(code){super(code);this.code=code;}}
const validUid=x=>typeof x==='string'&&x.length>0&&x.length<=128&&!x.includes('/');
function analyze(data,key){
    if(!Buffer.isBuffer(key)||key.length!==32)throw new InventoryError('INVALID_REFERENCE_KEY');
    const ref=(kind,value)=>kind+'_'+crypto.createHmac('sha256',key).update(kind+'\0'+String(value)).digest('hex').slice(0,32);
    const profiles=data.users||[],allocations=data.nij_allocations||[],forward=data.member_identity||[],reverse=data.legacy_profile_owners||[],ownership=data.uid_ownership||[];
    const auth=new Map((data.auth||[]).map(a=>[a.uid,a]));
    const byProfile=new Map(profiles.map(p=>[p.id,p])),byAllocation=new Map(allocations.map(a=>[a.id,a]));
    const byForward=new Map(forward.map(b=>[b.id,b])),byReverse=new Map(reverse.map(b=>[b.id,b]));
    const categories={canonicalWithMatchingUid:0,canonicalWithoutUidField:0,noncanonicalWithUidField:0,
        noUidAndNoAuthIdMatch:0,invalidUidField:0,docIdAndUidDisagree:0};
    const conflicts=[],claims=new Map(),unverified=new Set(),problems=new Set(),conflictUids=new Set();
    function issue(category,profileIds=[],uids=[],other=[]){
        conflicts.push({category,profiles:[...new Set(profileIds)].map(x=>ref('p',x)),uids:[...new Set(uids)].map(x=>ref('u',x)),references:other});
        for(const p of profileIds)problems.add(p);
        for(const uid of uids)conflictUids.add(uid);
    }
    const claim=(uid,pid)=>{if(!claims.has(uid))claims.set(uid,new Set());claims.get(uid).add(pid);};
    for(const p of profiles){
        const has=p.uid!==undefined&&p.uid!==null&&p.uid!=='';
        const idKnown=auth.has(p.id);
        if(has&&!validUid(p.uid)){categories.invalidUidField++;issue('invalid_profile_uid',[p.id]);unverified.add(p.id);}
        else if(has&&p.id===p.uid)categories.canonicalWithMatchingUid++;
        else if(has)categories.noncanonicalWithUidField++;
        else if(idKnown)categories.canonicalWithoutUidField++;
        else {categories.noUidAndNoAuthIdMatch++;unverified.add(p.id);}
        if(idKnown)claim(p.id,p.id);
        if(validUid(p.uid)){
            claim(p.uid,p.id);
            if(!auth.has(p.uid)){issue('uid_not_found_in_auth',[p.id],[p.uid]);unverified.add(p.id);}
            if(p.id!==p.uid&&idKnown){categories.docIdAndUidDisagree++;issue('doc_id_auth_uid_disagrees_with_field_uid',[p.id],[p.id,p.uid]);unverified.add(p.id);}
        }
    }
    let multipleProfileUids=0,disabledUidsWithProfile=0;
    for(const[uid,ids]of claims){
        if(ids.size>1){multipleProfileUids++;issue('uid_claims_multiple_profiles',[...ids],[uid]);for(const p of ids)unverified.add(p);}
        if(auth.get(uid)?.disabled){disabledUidsWithProfile++;issue('disabled_auth_uid_has_profile',[...ids],[uid]);for(const p of ids)unverified.add(p);}
    }
    const nijOwners=new Map();
    for(const p of profiles)if(typeof p.nij==='string'&&p.nij){if(!nijOwners.has(p.nij))nijOwners.set(p.nij,[]);nijOwners.get(p.nij).push(p.id);}
    for(const[nij,ids]of nijOwners)if(ids.length>1)issue('nij_used_by_multiple_profiles',ids,[],[ref('n',nij)]);
    for(const a of allocations){
        const uid=a.id,p=byProfile.get(uid),linked=byForward.get(uid),target=linked?byProfile.get(linked.profileId):p;
        if(a.uid!==uid)issue('allocation_key_uid_mismatch',[],[uid,...(validUid(a.uid)?[a.uid]:[])]);
        if(!auth.has(uid))issue('allocation_uid_not_found_in_auth',[],[uid]);
        if(!target)issue('allocation_without_resolved_profile',[],[uid]);
        else if(a.nij!==target.nij||a.nij_number!==target.nij_number||a.wilayah!==target.wilayah)
            issue('allocation_profile_identity_mismatch',[target.id],[uid]);
        if(linked)issue('legacy_binding_and_allocation_coexist',[linked.profileId],[uid]);
    }
    function sameIndex(a,b){return a&&b&&validUid(a.uid)&&typeof a.profileId==='string'&&a.profileId.length>0
        &&typeof a.grantId==='string'&&a.grantId.length>0&&typeof a.linkedAt==='string'&&Number.isFinite(Date.parse(a.linkedAt))
        &&a.uid===b.uid&&a.profileId===b.profileId&&a.grantId===b.grantId&&a.linkedAt===b.linkedAt;}
    let consistentBindings=0;
    for(const b of forward){
        const p=byProfile.get(b.profileId),r=byReverse.get(b.profileId);
        if(b.id!==b.uid||!validUid(b.uid)||!p||!sameIndex(b,r)||r.id!==b.profileId){issue('binding_pair_invalid',p?[p.id]:[],validUid(b.uid)?[b.uid]:[],[ref('b',b.id)]);continue;}
        consistentBindings++;
        if(!auth.has(b.uid))issue('binding_uid_not_found_in_auth',[p.id],[b.uid]);
        if(auth.get(b.uid)?.disabled)issue('binding_auth_uid_disabled',[p.id],[b.uid]);
        if(validUid(p.uid)&&p.uid!==b.uid)issue('binding_conflicts_with_profile_uid',[p.id],[p.uid,b.uid]);
        if(byProfile.has(b.uid)&&b.uid!==p.id)issue('binding_uid_already_has_canonical_document',[p.id,b.uid],[b.uid]);
        for(const pid of claims.get(b.uid)||[])if(pid!==p.id)issue('binding_uid_claims_another_profile',[p.id,pid],[b.uid]);
        // Index consistency is not identity attestation. Audit/provenance is not
        // read in this minimal inventory and must be reviewed before trusting it.
        unverified.add(p.id);
    }
    for(const r of reverse){const b=byForward.get(r.uid);if(r.id!==r.profileId||!sameIndex(b,r))issue('reverse_index_orphan_or_mismatch',byProfile.has(r.profileId)?[r.profileId]:[],validUid(r.uid)?[r.uid]:[],[ref('b',r.id)]);}
    const ownershipStates={clear:0,allocated:0,owned:0,conflict:0,unknown:0};
    for(const o of ownership){
        if(Object.hasOwn(ownershipStates,o.state))ownershipStates[o.state]++;else ownershipStates.unknown++;
        if(!validUid(o.uid)||o.id!==o.uid)issue('ownership_key_uid_mismatch',[],validUid(o.uid)?[o.uid]:[],[ref('b',o.id)]);
        if(o.state==='clear'&&(claims.has(o.id)||byAllocation.has(o.id)||byForward.has(o.id)||reverse.some(r=>r.uid===o.id)))
            issue('clear_review_conflicts_with_existing_ownership',[...(claims.get(o.id)||[])],[o.id]);
        if(o.state==='allocated'){
            const p=byProfile.get(o.profileId),a=byAllocation.get(o.id);
            if(!a||o.profileId!==o.id||!p||p.uid!==o.id||p.nij!==a.nij)issue('allocated_ownership_inconsistent',p?[p.id]:[],[o.id]);
        }
    }
    let structurallyMatchedProfiles=0;
    for(const p of profiles){
        const uid=p.id===p.uid?p.uid:(validUid(p.uid)?p.uid:(auth.has(p.id)?p.id:null));
        const a=uid?byAllocation.get(uid):null;
        const good=uid&&auth.has(uid)&&!auth.get(uid).disabled&&claims.get(uid)?.size===1&&p.id===uid&&p.uid===uid&&a&&a.uid===uid
            &&typeof p.nij==='string'&&p.nij.length>0&&Number.isSafeInteger(p.nij_number)&&p.nij_number>0&&typeof p.wilayah==='string'&&p.wilayah.length>0
            &&a.nij===p.nij&&a.nij_number===p.nij_number&&a.wilayah===p.wilayah&&!problems.has(p.id);
        if(good)structurallyMatchedProfiles++;else unverified.add(p.id);
    }
    for(const p of problems)unverified.add(p);
    const conflictCounts={};for(const c of conflicts)conflictCounts[c.category]=(conflictCounts[c.category]||0)+1;
    const relations=new Set();for(const[uid,pids]of claims)for(const pid of pids)relations.add(JSON.stringify([uid,pid]));
    for(const b of forward)if(validUid(b.uid)&&typeof b.profileId==='string')relations.add(JSON.stringify([b.uid,b.profileId]));
    return {schemaVersion:1,project:PROJECT,decision:'NO-GO',scope:'read-only-structural-inventory-not-identity-proof',
        totals:{authAccounts:auth.size,profiles:profiles.length,allocations:allocations.length,forwardIndexes:forward.length,reverseIndexes:reverse.length,ownershipRecords:ownership.length},ownershipStates,
        profileCategories:categories,relations:{uidsWithProfileClaims:claims.size,uidsClaimingMultipleProfiles:multipleProfileUids,disabledUidsWithProfile,
            structurallyMatchedProfiles,structurallyUnverifiedProfiles:unverified.size,consistentBindingPairs:consistentBindings,
            uidsWithConflictOrReviewFlags:conflictUids.size,unverifiedUidProfileRelations:relations.size,
            profilesRequiringIdentityProvenanceReview:profiles.length,identityAttestationVerifiedByThisTool:0},
        conflictCounts,conflicts,
        limitations:['No email-based inference','No identity attestation or Auth-to-Firestore atomic snapshot','Existing index provenance not verified','Missing Auth account does not prove random document ID','No trusted index was created'],
        references:'HMAC-SHA256 truncated to 128 bits; no key or raw mapping in report'};
}
function tokenFromGcloud(){
    try{
        const command=process.platform==='win32'?'gcloud.cmd':'gcloud';
        // On Windows resolve the official executable through a fixed command;
        // no user-controlled shell interpolation and no token sent to stdout.
        const output=process.platform==='win32'
            ?execFileSync('cmd.exe',['/d','/s','/c','gcloud.cmd auth print-access-token'],{encoding:'utf8',stdio:['ignore','pipe','ignore'],windowsHide:true})
            :execFileSync(command,['auth','print-access-token'],{encoding:'utf8',stdio:['ignore','pipe','ignore']});
        const token=output.trim();if(!token||/\s/.test(token))throw new Error();return token;
    }catch(_){throw new InventoryError('OFFICIAL_GCLOUD_AUTH_UNAVAILABLE');}
}
async function auth403Cause(response){
    // Inspect structured error codes in memory only. Messages, metadata,
    // consumers, URLs and unknown strings must never become diagnostic output.
    const known=new Map([
        ['ACCESS_TOKEN_SCOPE_INSUFFICIENT','OAUTH_SCOPE_INSUFFICIENT'],
        ['USER_PROJECT_DENIED','QUOTA_PROJECT_DENIED'],
        ['CONSUMER_INVALID','CONSUMER_INVALID'],
        ['SERVICE_DISABLED','SERVICE_DISABLED_FOR_CONSUMER'],
        ['BILLING_DISABLED','CONSUMER_BILLING_DISABLED'],
        ['CREDENTIALS_MISSING','CREDENTIALS_MISSING'],
        ['ACCESS_TOKEN_TYPE_UNSUPPORTED','CREDENTIAL_TYPE_UNSUPPORTED'],
        ['IAM_PERMISSION_DENIED','IAM_PERMISSION_DENIED'],
        ['SECURITY_POLICY_VIOLATED','SECURITY_POLICY_VIOLATED'],
        ['RATE_LIMIT_EXCEEDED','RATE_LIMIT_EXCEEDED']
    ]);
    try{
        const body=await response.json(),error=body?.error,causes=new Set();
        for(const detail of Array.isArray(error?.details)?error.details.slice(0,20):[]){
            if(detail?.['@type']==='type.googleapis.com/google.rpc.ErrorInfo'&&detail.domain==='googleapis.com'&&known.has(detail.reason))causes.add(known.get(detail.reason));
        }
        if(causes.size===1)return [...causes][0];
        if(causes.size>1)return 'MULTIPLE_RECOGNIZED_CAUSES';
        // Legacy usageLimits cannot distinguish a missing quota project from
        // API activation on the wrong consumer. Never infer either as proven.
        if(Array.isArray(error?.errors)&&error.errors.slice(0,20).some(e=>e?.domain==='usageLimits'&&e.reason==='accessNotConfigured'))return 'CONSUMER_OR_SERVICE_CONFIGURATION';
    }catch(_){/* Non-JSON/empty/proxy errors retain the original safe code. */}
    return null;
}
function makeReader(fetchImpl,token){
    return async function read(url,options={}){
        const parsed=new URL(url),method=options.method||'GET';
        const allowedGet=method==='GET'&&(
            parsed.origin==='https://identitytoolkit.googleapis.com'&&parsed.pathname===`/v1/projects/${PROJECT}/accounts:batchGet`||
            parsed.origin==='https://firestore.googleapis.com'&&Object.keys(MASKS).some(c=>parsed.pathname===`/v1/projects/${PROJECT}/databases/(default)/documents/${c}`));
        const permissionCheck=method==='POST'&&parsed.origin==='https://cloudresourcemanager.googleapis.com'&&parsed.pathname===`/v1/projects/${PROJECT}:testIamPermissions`&&options.body===JSON.stringify({permissions:PERMISSIONS});
        if(parsed.protocol!=='https:'||parsed.username||parsed.password||(!allowedGet&&!permissionCheck))throw new InventoryError('NON_READ_ONLY_REQUEST_BLOCKED');
        // Fixed category only: never include the URL, response body, or token.
        const category=permissionCheck?'IAM':parsed.origin==='https://identitytoolkit.googleapis.com'?'AUTH':'FIRESTORE';
        let response;try{response=await fetchImpl(url,{...options,method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Goog-User-Project':PROJECT},redirect:'error',signal:AbortSignal.timeout(30000)});}catch(_){throw new InventoryError('READ_TRANSPORT_FAILED');}
        if(!response.ok){
            const code=category+'_READ_HTTP_'+(Number.isInteger(response.status)&&response.status>=100&&response.status<=599?response.status:'UNKNOWN');
            const cause=category==='AUTH'&&response.status===403?await auth403Cause(response):null;
            throw new InventoryError(code+(cause?'_CAUSE_'+cause:''));
        }
        try{return await response.json();}catch(_){throw new InventoryError('INVALID_READ_RESPONSE');}
    };
}
function scalar(v){if(v===undefined)return undefined;if('stringValue'in v)return v.stringValue;if('booleanValue'in v)return v.booleanValue;if('integerValue'in v)return Number(v.integerValue);if('timestampValue'in v)return v.timestampValue;if('nullValue'in v)return null;return {invalidType:true};}
async function collect(read){
    const permissions=await read(`https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}:testIamPermissions`,{method:'POST',body:JSON.stringify({permissions:PERMISSIONS})});
    if(!PERMISSIONS.every(p=>permissions.permissions?.includes(p)))throw new InventoryError('READ_PERMISSIONS_NOT_VERIFIED');
    const data={auth:[]},startedAt=new Date().toISOString();
    let next,seen=new Set();const authIds=new Set();
    do{
        const u=new URL(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:batchGet`);
        u.searchParams.set('maxResults','1000');u.searchParams.set('fields','users(localId,disabled),nextPageToken');if(next)u.searchParams.set('nextPageToken',next);
        const page=await read(u.href);for(const a of page.users||[]){if(!validUid(a.localId))throw new InventoryError('INVALID_AUTH_UID');if(authIds.has(a.localId))throw new InventoryError('DUPLICATE_AUTH_RESULT');authIds.add(a.localId);data.auth.push({uid:a.localId,disabled:a.disabled===true});}
        next=page.nextPageToken;if(next&&seen.has(next))throw new InventoryError('REPEATED_PAGE_TOKEN');seen.add(next);
    }while(next);
    // One Firestore readTime for all pages and collections. Auth has no shared
    // snapshot with Firestore; final decision remains NO-GO pending reconciliation.
    const readTime=new Date(Date.now()-5000).toISOString();
    for(const[c,fields]of Object.entries(MASKS)){
        data[c]=[];next=undefined;seen=new Set();const documentIds=new Set();
        do{
            const u=new URL(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/${c}`);
            u.searchParams.set('pageSize','300');u.searchParams.set('readTime',readTime);for(const f of fields)u.searchParams.append('mask.fieldPaths',f);if(next)u.searchParams.set('pageToken',next);
            const page=await read(u.href);
            const prefix=`projects/${PROJECT}/databases/(default)/documents/${c}/`;
            for(const d of page.documents||[]){if(typeof d.name!=='string'||!d.name.startsWith(prefix)||d.name.slice(prefix.length).includes('/'))throw new InventoryError('UNEXPECTED_DOCUMENT_PATH');
                const item={id:d.name.slice(prefix.length)};if(documentIds.has(item.id))throw new InventoryError('DUPLICATE_DOCUMENT_RESULT');documentIds.add(item.id);for(const f of fields)if(d.fields?.[f]!==undefined)item[f]=scalar(d.fields[f]);data[c].push(item);}
            next=page.nextPageToken;if(next&&seen.has(next))throw new InventoryError('REPEATED_PAGE_TOKEN');seen.add(next);
        }while(next);
    }
    return {data,coverage:{startedAt,completedAt:new Date().toISOString(),firestoreReadTime:readTime,collections:Object.keys(MASKS),authTenant:'default-only',permissionsVerified:true,complete:true}};
}
async function main(args=process.argv.slice(2)){
    const opts=new Map();for(let i=0;i<args.length;i+=2){if(!args[i].startsWith('--')||!args[i+1]||opts.has(args[i]))throw new InventoryError('INVALID_ARGUMENTS');opts.set(args[i],args[i+1]);}
    if([...opts.keys()].some(k=>!['--project','--owner-approved-read-only','--output'].includes(k))||opts.get('--project')!==PROJECT||opts.get('--owner-approved-read-only')!==PROJECT||!opts.get('--output'))throw new InventoryError('OWNER_READ_ONLY_APPROVAL_REQUIRED');
    if(process.env.FIRESTORE_EMULATOR_HOST||process.env.FIREBASE_AUTH_EMULATOR_HOST)throw new InventoryError('EMULATOR_ENV_NOT_ALLOWED');
    const output=path.resolve(opts.get('--output'));if(fs.existsSync(output))throw new InventoryError('OUTPUT_ALREADY_EXISTS');
    const token=tokenFromGcloud(),key=crypto.randomBytes(32);
    const {data,coverage}=await collect(makeReader(globalThis.fetch,token));
    const report=analyze(data,key);report.coverage=coverage;
    fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
    console.log('READ_ONLY_INVENTORY_COMPLETE; decision=NO-GO; sanitized local report created.');
}
module.exports={analyze,collect,makeReader,PROJECT,PERMISSIONS,MASKS,InventoryError,tokenFromGcloud,auth403Cause};
if(require.main===module)main().catch(e=>{console.error(e instanceof InventoryError?e.code:'INVENTORY_FAILED_NO_RAW_DETAILS');process.exitCode=1;});
