'use strict';
// Scoped restoration proposal; leaves active and previous review Rules intact.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
let rules=fs.readFileSync(path.join(root,'docs/spark-release/firestore.proposed.rules'),'utf8');
const start=rules.indexOf('    function trustedUidClear(uid) {'),end=rules.indexOf('    function sparkReady() {',start);
assert.ok(start>0&&end>start,'Expected reviewed ownership block');
rules=rules.slice(0,start)+rules.slice(end);
rules=rules.replace(' && trustedUidClear(uid)','').replace(' && allocatedUid(uid,a.nij)','');
assert.ok(!rules.includes('trustedUidClear(')&&!rules.includes('allocatedUid('));
rules=rules.replace('      let verified = request.auth.uid == before.uid',
    "      let targetUid = before.get('uid','') != '' ? before.uid : profileId;\n      let verified = request.auth.uid == targetUid");
rules=rules.replace("before.get('email_normalized','') == request.auth.token.email.lower()", "before.get('email_normalized',before.email.lower()) == request.auth.token.email.lower()");
rules=rules.replace("        && profileId == request.auth.uid\n        && get(/databases/$(database)/documents/nij_allocations/$(profileId)).data.nij == before.nij;", "        && profileId == request.auth.uid;");
rules=rules.replace("verified && before.status_akun == 'Menunggu Verifikasi'", "verified && before.status_akun in ['Pending','Menunggu Verifikasi']");
rules=rules.replace("return before.get('uid','') is string && before.get('uid','') != ''", "return targetUid is string && targetUid.size() > 0");
rules=rules.replace("before.status_akun in ['Pending','Menunggu Verifikasi']", "before.status_akun in ['Pending','Menunggu Verifikasi','Aktif']");
rules=rules.replace("audit == {'uid':before.uid,'targetUid':before.uid", "audit == {'uid':targetUid,'targetUid':targetUid");
// A historical profile with no matching permanent allocation must not lose
// its only NIJ record through deletion. No allocation/backfill is fabricated.
rules=rules.replace("&& !exists(/databases/$(database)/documents/registration_audit/$('profile-delete_' + profileId))",
    "&& get(/databases/$(database)/documents/nij_allocations/$(profileId)).data.nij == before.nij\n        && !exists(/databases/$(database)/documents/registration_audit/$('profile-delete_' + profileId))");
rules=rules.replace('    match /registration_audit/{id} {\n      allow read: if isActiveAdmin();',`    match /registration_audit/{id} {
      allow read: if isActiveAdmin();
      allow get: if signedIn() && resource.data.get('targetUid','') == request.auth.uid
        && resource.data.get('action','') == 'activate-admin-override';`);
rules=rules.replace('    match /member_identity/{id}',"    match /uid_ownership/{id} { allow read, write: if false; }\n    match /member_identity/{id}");
rules=rules.replace(/^\/\/ REVIEW CANDIDATE[^\n]*\n\/\/ Production index[^\n]*\n/,'');
const directory=path.join(root,'docs/activation-restoration');fs.mkdirSync(directory,{recursive:true});
fs.writeFileSync(path.join(directory,'firestore.proposed.rules'),
    '// Scoped activation restoration. Owner baseline: all existing profiles canonical.\n// No uid_ownership requirement, no email ownership lookup, no public profile reads. Not deployed.\n'+rules);
console.log('Built activation restoration proposal only; active Rules unchanged.');
