'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const baseline='docs/activation-restoration/release-check/2026-11-14T03-52-44-934Z/production-backup/firestore.pre-release.rules';
function build(){
  const production=fs.readFileSync(path.join(root,baseline),'utf8');
  const reviewed=fs.readFileSync(path.join(root,'docs/activation-restoration/firestore.proposed.rules'),'utf8');
  const start='    function ownsProfile(uid) {',end='    match /login_logs/';
  const p=production.indexOf(start),q=production.indexOf(end,p),a=reviewed.indexOf(start),b=reviewed.indexOf(end,a);
  assert.ok(p>0&&q>p&&a>0&&b>a);
  let scope=reviewed.slice(a,b);
  // Production's isAdminManager is role-only. Require active status HERE,
  // without changing that shared helper's behavior for unrelated modules.
  scope=scope.replace('return isAdminManager() && get(', 'return isActiveAdmin() && isAdminManager() && get(');
  scope=scope.replace('|| isAdminManager())','|| (isActiveAdmin() && isAdminManager()))');
  // Existing printable church label is editable metadata, never UID/NIJ region.
  scope=scope.replace('&& keepsRegistrationIdentity()',"&& keepsRegistrationIdentity()\n        && (!request.resource.data.diff(resource.data).affectedKeys().hasAny(['lokasi_berjemaat'])\n          || (request.resource.data.lokasi_berjemaat is string && request.resource.data.lokasi_berjemaat.size() <= 150))")
    .replace("'sub_jabatan','sub_bidang'","'lokasi_berjemaat','sub_jabatan','sub_bidang'");
  // Unused legacy linking remains denied implicitly; do not add policy for it.
  scope=scope.replace(/^    match \/(?:uid_ownership|member_identity|legacy_profile_owners|legacy_link_requests|legacy_link_approvals|family_link_consents|family_lookup_limits)\/.*\r?\n/gm,'');
  const rules=production.slice(0,p)+scope+production.slice(q);
  assert.equal(rules.slice(0,p),production.slice(0,p));
  assert.equal(rules.slice(rules.indexOf(end)),production.slice(q));
  return {rules,production,scope,baseline};
}
module.exports={build,baseline};
if(require.main===module){fs.writeFileSync(path.join(root,'docs/activation-restoration/firestore.minimal.rules'),build().rules);console.log('Minimal Rules generated locally; unrelated production policy preserved byte-for-byte.');}
