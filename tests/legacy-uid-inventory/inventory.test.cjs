'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {analyze,collect,makeReader,PROJECT,PERMISSIONS,MASKS}=require('../../scripts/legacy-uid-inventory.cjs');
const key=Buffer.alloc(32,8),empty=()=>({auth:[],users:[],nij_allocations:[],member_identity:[],legacy_profile_owners:[]});
const report=d=>analyze({...empty(),...d},key);
test('separates canonical, canonical without field, random-ID field UID, UID-less and invalid formats',()=>{
    const r=report({auth:[{uid:'a'},{uid:'b'},{uid:'c'}],users:[{id:'a',uid:'a'},{id:'b'},{id:'random',uid:'c'},{id:'old'},{id:'bad',uid:4}]});
    assert.deepEqual(r.profileCategories,{canonicalWithMatchingUid:1,canonicalWithoutUidField:1,noncanonicalWithUidField:1,noUidAndNoAuthIdMatch:1,invalidUidField:1,docIdAndUidDisagree:0});
});
test('detects UID duplicated between canonical and historical random document',()=>{
    const r=report({auth:[{uid:'a'}],users:[{id:'a',uid:'a'},{id:'historical',uid:'a'}]});
    assert.equal(r.relations.uidsClaimingMultipleProfiles,1);assert.equal(r.conflictCounts.uid_claims_multiple_profiles,1);assert.equal(r.relations.unverifiedUidProfileRelations,2);
});
test('doc.id Auth collision with different field UID is not silently assigned',()=>{
    const r=report({auth:[{uid:'a'},{uid:'b'}],users:[{id:'a',uid:'b'}]});assert.equal(r.profileCategories.docIdAndUidDisagree,1);assert.equal(r.conflictCounts.doc_id_auth_uid_disagrees_with_field_uid,1);
});
test('missing and disabled Auth records are review flags, not ownership proof',()=>{
    const r=report({auth:[{uid:'a',disabled:true}],users:[{id:'x',uid:'missing'},{id:'a',uid:'a'}]});assert.equal(r.conflictCounts.uid_not_found_in_auth,1);assert.equal(r.relations.disabledUidsWithProfile,1);assert.equal(r.relations.identityAttestationVerifiedByThisTool,0);
});
test('allocation structure can match but never gives an automatic GO',()=>{
    const data={id:'a',uid:'a',nij:'N',nij_number:1,wilayah:'R'};
    const r=report({auth:[{uid:'a'}],users:[data],nij_allocations:[data]});assert.equal(r.relations.structurallyMatchedProfiles,1);assert.equal(r.decision,'NO-GO');assert.equal(r.relations.unverifiedUidProfileRelations,1);
});
test('detects allocation UID, NIJ and missing-profile conflicts',()=>{
    const r=report({auth:[{uid:'a'}],users:[{id:'a',uid:'a',nij:'N',nij_number:1}],nij_allocations:[{id:'a',uid:'wrong',nij:'OTHER',nij_number:2},{id:'lost',uid:'lost'}]});
    for(const c of ['allocation_key_uid_mismatch','allocation_profile_identity_mismatch','allocation_without_resolved_profile','allocation_uid_not_found_in_auth'])assert.equal(r.conflictCounts[c],1);
});
test('detects duplicate NIJ without emitting the NIJ',()=>{
    const r=report({users:[{id:'x',nij:'PRIVATE-NIJ'},{id:'y',nij:'PRIVATE-NIJ'}]});assert.equal(r.conflictCounts.nij_used_by_multiple_profiles,1);assert.ok(!JSON.stringify(r).includes('PRIVATE-NIJ'));
});
test('paired indexes are checked structurally without claiming audit validation',()=>{
    const b={uid:'a',profileId:'old',grantId:'g',linkedAt:'2026-01-01T00:00:00Z'};
    const r=report({auth:[{uid:'a'}],users:[{id:'old',nij:'N'}],member_identity:[{id:'a',...b}],legacy_profile_owners:[{id:'old',...b}]});
    assert.equal(r.relations.consistentBindingPairs,1);assert.equal(r.relations.identityAttestationVerifiedByThisTool,0);assert.equal(r.relations.structurallyUnverifiedProfiles,1);
});
test('orphan indexes and binding collision with noncanonical UID ownership are detected',()=>{
    const b={uid:'a',profileId:'old',grantId:'g',linkedAt:'2026-01-01T00:00:00Z'};
    const r=report({auth:[{uid:'a'}],users:[{id:'old'},{id:'random',uid:'a'}],member_identity:[{id:'a',...b}],legacy_profile_owners:[{id:'old',...b},{id:'orphan',uid:'z',profileId:'orphan'}]});
    assert.equal(r.conflictCounts.binding_uid_claims_another_profile,1);assert.equal(r.conflictCounts.reverse_index_orphan_or_mismatch,1);
});
test('all identifier output uses keyed pseudonyms; private fields and key never appear',()=>{
    const d={users:[{id:'private@example.test',uid:'SECRET_UID',nij:'SECRET_NIJ',nama:'SECRET_NAME',email:'private@example.test',whatsapp:'SECRET_PHONE'}]};
    const r=report(d),text=JSON.stringify(r);for(const secret of ['private@example.test','SECRET_UID','SECRET_NIJ','SECRET_NAME','SECRET_PHONE',key.toString('hex')])assert.ok(!text.includes(secret));
    assert.match(r.conflicts[0].profiles[0],/^p_[0-9a-f]{32}$/);
    assert.notEqual(JSON.stringify(analyze({...empty(),...d},crypto.randomBytes(32))),text);
});
test('transport rejects write endpoints, arbitrary hosts, wrong projects and redirects',async()=>{
    let calls=0;const read=makeReader(async()=>{calls++;return{ok:true,json:async()=>({})};},'NEVER_PRINT');
    for(const [url,options]of [
        [`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/users/a`,{method:'PATCH'}],
        ['https://attacker.test/',{}],['http://firestore.googleapis.com/',{}],
        ['https://identitytoolkit.googleapis.com/v1/projects/other/accounts:batchGet',{}],
        [`https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}:testIamPermissions`,{method:'POST',body:'{}'}]
    ])await assert.rejects(read(url,options),{code:'NON_READ_ONLY_REQUEST_BLOCKED'});
    assert.equal(calls,0);
});
test('IAM preflight failure prevents every member data read',async()=>{
    const calls=[];await assert.rejects(collect(async u=>{calls.push(u);return{permissions:[]};}),{code:'READ_PERMISSIONS_NOT_VERIFIED'});assert.equal(calls.length,1);
});
test('collector paginates, masks, and uses one Firestore readTime without retaining extra fields',async()=>{
    const calls=[];const result=await collect(async raw=>{
        const u=new URL(raw);calls.push(u);
        if(u.pathname.endsWith(':testIamPermissions'))return{permissions:PERMISSIONS};
        if(u.pathname.endsWith('accounts:batchGet'))return u.searchParams.has('nextPageToken')?{users:[{localId:'b',displayName:'PRIVATE'}]}:{users:[{localId:'a',email:'PRIVATE'}],nextPageToken:'AUTH_PAGE'};
        const c=u.pathname.split('/').pop();if(c==='users')return u.searchParams.has('pageToken')?{documents:[]}:{documents:[{name:`projects/${PROJECT}/databases/(default)/documents/users/a`,fields:{uid:{stringValue:'a'},email:{stringValue:'PRIVATE'}}}],nextPageToken:'DOC_PAGE'};
        return{};
    });
    assert.equal(result.data.auth.length,2);assert.deepEqual(result.data.users,[{id:'a',uid:'a'}]);
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
    const firestore=calls.filter(u=>u.hostname==='firestore.googleapis.com');assert.equal(new Set(firestore.map(u=>u.searchParams.get('readTime'))).size,1);
    for(const u of firestore)assert.deepEqual(u.searchParams.getAll('mask.fieldPaths'),MASKS[u.pathname.split('/').pop()]);
    assert.ok(calls.find(u=>u.hostname==='identitytoolkit.googleapis.com').searchParams.get('fields').includes('localId,disabled'));
});
test('pagination loops fail closed instead of reporting partial coverage',async()=>{
    await assert.rejects(collect(async u=>u.includes(':testIamPermissions')?{permissions:PERMISSIONS}:{nextPageToken:'LOOP'}),{code:'REPEATED_PAGE_TOKEN'});
});
test('HTTP and network errors do not print service bodies or token',async()=>{
    const read=makeReader(async()=>({ok:false,status:403,json:async()=>({message:'PRIVATE'})}),'SECRET_TOKEN');
    await assert.rejects(read(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:batchGet`),e=>e.code==='AUTH_READ_HTTP_403'&&!e.message.includes('SECRET'));
});
test('CLI without explicit Owner approval exits before authentication or networking',()=>{
    const run=spawnSync(process.execPath,[path.resolve(__dirname,'../../scripts/legacy-uid-inventory.cjs')],{encoding:'utf8'});assert.equal(run.status,1);assert.equal(run.stderr.trim(),'OWNER_READ_ONLY_APPROVAL_REQUIRED');
});
test('missing fields cannot make two malformed binding indexes count as consistent',()=>{
    const b={uid:'a',profileId:'old'};
    const r=report({auth:[{uid:'a'}],users:[{id:'old'}],member_identity:[{id:'a',...b}],legacy_profile_owners:[{id:'old',...b}]});
    assert.equal(r.relations.consistentBindingPairs,0);assert.equal(r.conflictCounts.binding_pair_invalid,1);
});
for(const [category,url,options]of [
    ['IAM',`https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}:testIamPermissions`,{method:'POST',body:JSON.stringify({permissions:PERMISSIONS})}],
    ['AUTH',`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:batchGet`,{}],
    ['FIRESTORE',`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/users`,{}]
])test(category+' HTTP diagnostic stays fixed when error body is unavailable; raw body never emitted',async()=>{
    let bodyReads=0;
    const read=makeReader(async()=>({ok:false,status:403,json:async()=>{bodyReads++;throw Error('PRIVATE_BODY');},text:async()=>{bodyReads++;return 'PRIVATE_BODY';}}),'PRIVATE_TOKEN');
    await assert.rejects(read(url,options),error=>{assert.equal(error.code,category+'_READ_HTTP_403');assert.equal(error.message,error.code);return true;});
    assert.equal(bodyReads,category==='AUTH'?1:0);
});
test('Auth pagination failure stops before any Firestore read and retains Auth category',async()=>{
    const calls=[];
    const read=makeReader(async raw=>{
        const u=new URL(raw);calls.push(u);
        if(u.hostname==='cloudresourcemanager.googleapis.com')return{ok:true,json:async()=>({permissions:PERMISSIONS})};
        if(!u.searchParams.has('nextPageToken'))return{ok:true,json:async()=>({users:[],nextPageToken:'PRIVATE_PAGE'})};
        return{ok:false,status:403};
    },'PRIVATE_TOKEN');
    await assert.rejects(collect(read),{code:'AUTH_READ_HTTP_403'});
    assert.equal(calls.length,3);assert.ok(!calls.some(u=>u.hostname==='firestore.googleapis.com'));
});
test('Firestore failure after successful IAM and Auth stops later collection reads',async()=>{
    const calls=[];
    const read=makeReader(async raw=>{
        const u=new URL(raw);calls.push(u);
        if(u.hostname==='cloudresourcemanager.googleapis.com')return{ok:true,json:async()=>({permissions:PERMISSIONS})};
        if(u.pathname.endsWith('/nij_allocations'))return{ok:false,status:403};
        return{ok:true,json:async()=>({})};
    },'PRIVATE_TOKEN');
    await assert.rejects(collect(read),{code:'FIRESTORE_READ_HTTP_403'});
    assert.deepEqual(calls.filter(u=>u.hostname==='firestore.googleapis.com').map(u=>u.pathname.split('/').pop()),['users','nij_allocations']);
});
test('malformed status cannot leak arbitrary data through the diagnostic',async()=>{
    const read=makeReader(async()=>({ok:false,status:'PRIVATE_STATUS_OR_DATA'}),'PRIVATE_TOKEN');
    await assert.rejects(read(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:batchGet`),{code:'AUTH_READ_HTTP_UNKNOWN'});
});
const authUrl=`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:batchGet`;
const errorInfo=reason=>({'@type':'type.googleapis.com/google.rpc.ErrorInfo',domain:'googleapis.com',reason,metadata:{consumer:'PRIVATE_CONSUMER',email:'PRIVATE_EMAIL',token:'PRIVATE_TOKEN'}});
for(const[reason,cause]of [
    ['ACCESS_TOKEN_SCOPE_INSUFFICIENT','OAUTH_SCOPE_INSUFFICIENT'],['USER_PROJECT_DENIED','QUOTA_PROJECT_DENIED'],
    ['CONSUMER_INVALID','CONSUMER_INVALID'],['SERVICE_DISABLED','SERVICE_DISABLED_FOR_CONSUMER'],
    ['BILLING_DISABLED','CONSUMER_BILLING_DISABLED'],['CREDENTIALS_MISSING','CREDENTIALS_MISSING'],
    ['ACCESS_TOKEN_TYPE_UNSUPPORTED','CREDENTIAL_TYPE_UNSUPPORTED'],['IAM_PERMISSION_DENIED','IAM_PERMISSION_DENIED'],
    ['SECURITY_POLICY_VIOLATED','SECURITY_POLICY_VIOLATED'],['RATE_LIMIT_EXCEEDED','RATE_LIMIT_EXCEEDED']
])test('Auth 403 maps structured '+reason+' to a fixed safe cause',async()=>{
    const read=makeReader(async()=>({ok:false,status:403,json:async()=>({error:{message:'PRIVATE_UID PRIVATE_NIJ PRIVATE_PASSWORD_HASH',details:[errorInfo(reason)]}})}),'PRIVATE_TOKEN');
    await assert.rejects(read(authUrl),e=>{assert.equal(e.code,'AUTH_READ_HTTP_403_CAUSE_'+cause);assert.equal(e.message,e.code);return true;});
});
test('unknown reasons, messages, and metadata never become output or guessed causes',async()=>{
    for(const details of [[errorInfo('PRIVATE_UID')],[{...errorInfo('SERVICE_DISABLED'),domain:'PRIVATE_DOMAIN'}],[]]){
        const read=makeReader(async()=>({ok:false,status:403,json:async()=>({error:{message:'ACCESS_TOKEN_SCOPE_INSUFFICIENT PRIVATE_EMAIL',status:'PERMISSION_DENIED',details}})}),'PRIVATE_TOKEN');
        await assert.rejects(read(authUrl),{code:'AUTH_READ_HTTP_403'});
    }
});
test('legacy accessNotConfigured stays ambiguous; structured reason takes priority',async()=>{
    for(const [details,suffix]of [[[],'CONSUMER_OR_SERVICE_CONFIGURATION'],[[errorInfo('SERVICE_DISABLED')],'SERVICE_DISABLED_FOR_CONSUMER']]){
        const read=makeReader(async()=>({ok:false,status:403,json:async()=>({error:{message:'PRIVATE_DATA',details,errors:[{domain:'usageLimits',reason:'accessNotConfigured',extendedHelp:'PRIVATE_URL'}]}})}),'PRIVATE_TOKEN');
        await assert.rejects(read(authUrl),{code:'AUTH_READ_HTTP_403_CAUSE_'+suffix});
    }
});
test('multiple structured causes are not arbitrarily reduced to one root cause',async()=>{
    const read=makeReader(async()=>({ok:false,status:403,json:async()=>({error:{details:[errorInfo('USER_PROJECT_DENIED'),errorInfo('SERVICE_DISABLED')]}})}),'PRIVATE_TOKEN');
    await assert.rejects(read(authUrl),{code:'AUTH_READ_HTTP_403_CAUSE_MULTIPLE_RECOGNIZED_CAUSES'});
});
test('Auth cause inspection makes no additional request and does not change read headers or masks',async()=>{
    let calls=0;
    const url=new URL(authUrl);url.searchParams.set('maxResults','1000');url.searchParams.set('fields','users(localId,disabled),nextPageToken');
    const read=makeReader(async(raw,options)=>{
        calls++;assert.equal(raw,url.href);assert.equal(options.method,'GET');assert.equal(options.redirect,'error');
        assert.deepEqual(options.headers,{Authorization:'Bearer PRIVATE_TOKEN','Content-Type':'application/json','X-Goog-User-Project':PROJECT});
        return{ok:false,status:403,json:async()=>({error:{details:[errorInfo('USER_PROJECT_DENIED')]}})};
    },'PRIVATE_TOKEN');
    await assert.rejects(read(url.href),{code:'AUTH_READ_HTTP_403_CAUSE_QUOTA_PROJECT_DENIED'});assert.equal(calls,1);
});
test('inventory ownership clear conflicting with a legacy UID is reported without raw identifiers',()=>{
    const r=report({auth:[{uid:'PRIVATE_UID'}],users:[{id:'PRIVATE_DOC',uid:'PRIVATE_UID'}],uid_ownership:[{id:'PRIVATE_UID',uid:'PRIVATE_UID',state:'clear',profileId:''}]});
    assert.equal(r.totals.ownershipRecords,1);assert.equal(r.ownershipStates.clear,1);assert.equal(r.conflictCounts.clear_review_conflicts_with_existing_ownership,1);
    assert.ok(!JSON.stringify(r).includes('PRIVATE_UID'));assert.ok(!JSON.stringify(r).includes('PRIVATE_DOC'));
});
test('inventory ownership state and allocation mismatches fail closed to review flags',()=>{
    const r=report({uid_ownership:[{id:'x',uid:'other',state:'allocated',profileId:'missing'},{id:'y',uid:'y',state:'PRIVATE_UNKNOWN_STATE'}]});
    assert.equal(r.conflictCounts.ownership_key_uid_mismatch,1);assert.equal(r.conflictCounts.allocated_ownership_inconsistent,1);assert.equal(r.ownershipStates.unknown,1);assert.ok(!JSON.stringify(r).includes('PRIVATE_UNKNOWN_STATE'));
});
