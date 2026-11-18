'use strict';
// Builds a new local proposal; never touches firebase.json or active Rules.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'docs/spark-implementation/firestore.proposed.rules'),'utf8');
const fragment=fs.readFileSync(path.join(root,'docs/spark-legacy-identity/linking-fragment.rules'),'utf8');
const oldOwner=source.slice(source.indexOf('    function ownsProfile('),source.indexOf('    function keepsRegistrationIdentity('));
assert.ok(oldOwner.includes('email_verified'));
const owner=`    function ownsProfile(profileId) {
      return signedIn() && ((request.auth.uid == profileId
        && (!exists(/databases/$(database)/documents/users/$(profileId))
          || (get(/databases/$(database)/documents/users/$(profileId)).data.get('uid','') == request.auth.uid
            && get(/databases/$(database)/documents/nij_allocations/$(profileId)).data.nij == get(/databases/$(database)/documents/users/$(profileId)).data.nij)))
        || linkedOwner(profileId));
    }
`;
let proposal=source.replace(oldOwner,fragment+'\n'+owner);
proposal=proposal.replace("return signedIn() && request.auth.uid == uid && sparkReady()", "return signedIn() && request.auth.uid == uid && sparkReady()\n        && !exists(/databases/$(database)/documents/member_identity/$(uid))");
// Claims are create-only. Matching request.time below binds both claims to this
// commit; their update/delete denial prevents recycling an existing reservation.
proposal=proposal.replace(/        && !exists\(\/databases\/\$\(database\)\/documents\/registration_unique\/.*\n/g,'');
proposal=proposal.replace('allow read, write: if isActiveAdmin() || (signedIn() && request.auth.uid == uid);','allow read, write: if isActiveAdmin() || ownsProfile(uid);');
const auditStart=proposal.indexOf('    match /registration_audit/{id} {');
const auditEnd=proposal.indexOf('    match /family_link_consents/',auditStart);
assert.ok(auditStart>0&&auditEnd>auditStart);
proposal=proposal.slice(0,auditStart)+`    match /registration_audit/{id} {
      allow read: if isActiveAdmin();
      allow create: if signedIn() && id == 'legacy-link_' + request.resource.data.grantId
        && linkCore(request.resource.data.grantId,request.auth.uid)
        && linkAudit(request.resource.data,request.resource.data.grantId,request.auth.uid)
        && linkBoth(request.resource.data.grantId,request.auth.uid)
        && linkRequestAfter(request.auth.uid,request.resource.data.grantId);
      allow update, delete: if false;
    }
`+proposal.slice(auditEnd);
fs.writeFileSync(path.join(root,'docs/spark-legacy-identity/firestore.proposed.rules'),
    '// BLOCKED CANDIDATE. Unindexed noncanonical UID conflict test FAILS.\n'+
    '// DO NOT integrate or deploy. See OWNER-REVIEW.md and security.cjs.\n'+proposal);
console.log('Built local legacy identity proposal. Active Rules unchanged.');
