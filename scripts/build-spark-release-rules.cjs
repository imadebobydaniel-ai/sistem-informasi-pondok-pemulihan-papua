'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
let rules=fs.readFileSync(path.join(root,'docs/spark-implementation/firestore.proposed.rules'),'utf8');
// Unknown/unindexed UIDs are never assumed new. Only an IAM-controlled review
// record can attest no prior ownership; no web role may issue that attestation.
rules=rules.replace('    function sparkReady() {',`    function trustedUidClear(uid) {
      let o = get(/databases/$(database)/documents/uid_ownership/$(uid)).data;
      return o.uid == uid && o.state == 'clear' && o.profileId == ''
        && o.reviewId is string && o.reviewId.size() > 0
        && o.reviewedAt is timestamp && o.expiresAt is timestamp
        && o.reviewedAt <= request.time && o.expiresAt > request.time
        && o.expiresAt <= o.reviewedAt + duration.value(24,'h');
    }
    function allocatedUid(uid, nij) {
      let before = get(/databases/$(database)/documents/uid_ownership/$(uid)).data;
      let after = getAfter(/databases/$(database)/documents/uid_ownership/$(uid)).data;
      return trustedUidClear(uid)
        && after.diff(before).affectedKeys().hasOnly(['state','profileId','nij','allocatedAt'])
        && after.state == 'allocated' && after.profileId == uid
        && after.nij == nij && after.allocatedAt == request.time;
    }
    match /uid_ownership/{uid} {
      allow get: if signedIn() && (request.auth.uid == uid || isActiveAdmin());
      allow list: if isActiveAdmin();
      allow create, delete: if false;
      allow update: if signedIn() && request.auth.uid == uid && trustedUidClear(uid)
        && !exists(/databases/$(database)/documents/users/$(uid))
        && getAfter(/databases/$(database)/documents/users/$(uid)).data.uid == uid
        && getAfter(/databases/$(database)/documents/users/$(uid)).data.createdAt == request.time
        && allocatedUid(uid,getAfter(/databases/$(database)/documents/users/$(uid)).data.nij);
    }
    function sparkReady() {`);
rules=rules.replace('request.auth.uid == uid && sparkReady()', 'request.auth.uid == uid && sparkReady() && trustedUidClear(uid)');
rules=rules.replace("&& a.uid == uid && a.wilayah == sparkRegion(a.lokasi)", "&& a.uid == uid && allocatedUid(uid,a.nij) && a.wilayah == sparkRegion(a.lokasi)");
// Reservations remain create-only with request.time and exact UID checks. Old
// reservations cannot satisfy a new timestamp or be overwritten by the client.
rules=rules.replace(/        && !exists\(\/databases\/\$\(database\)\/documents\/registration_unique\/.*\n/g,'');
const start=rules.indexOf('    function ownsProfile('),end=rules.indexOf('    function keepsRegistrationIdentity(',start);
rules=rules.slice(0,start)+`    function ownsProfile(uid) {
      return signedIn() && ((request.auth.uid == uid
        && (!exists(/databases/$(database)/documents/users/$(uid)) || resource.data.get('uid','') in ['',request.auth.uid]))
        || resource.data.get('uid','') == request.auth.uid);
    }
    function activationManager() {
      return isAdminManager() && get(/databases/$(database)/documents/admin_users/$(request.auth.uid)).data.get('permissions',{}).get('canActivateMembers',false) == true;
    }
    function finalActivation(profileId, before, after) {
      let audit = getAfter(/databases/$(database)/documents/registration_audit/$(after.activation.auditId)).data;
      let verified = request.auth.uid == before.uid && request.auth.token.get('email_verified',false) == true
        && before.get('email_normalized','') == request.auth.token.email.lower()
        && profileId == request.auth.uid
        && get(/databases/$(database)/documents/nij_allocations/$(profileId)).data.nij == before.nij;
      let manual = activationManager();
      return before.get('uid','') is string && before.get('uid','') != ''
        && before.status_akun in ['Pending','Menunggu Verifikasi'] && after.status_akun == 'Aktif'
        && after.diff(before).affectedKeys().hasOnly(['status_akun','activation','initial_verification_status'])
        && after.initial_verification_status == before.status_akun
        && after.activation.keys().hasOnly(['method','at','auditId']) && after.activation.at == request.time
        && ((verified && before.status_akun == 'Menunggu Verifikasi' && after.activation.method == 'verified-email')
          || (manual && after.activation.method == 'admin-override'))
        && !exists(/databases/$(database)/documents/registration_audit/$(after.activation.auditId))
        && audit == {'uid':before.uid,'targetUid':before.uid,'profileId':profileId,'actorUid':request.auth.uid,
          'action':after.activation.method == 'verified-email' ? 'activate-verified-email' : 'activate-admin-override',
          'activationPath':after.activation.method,'previousStatus':before.status_akun,'newStatus':'Aktif',
          'identityVerificationAttested':after.activation.method == 'admin-override','createdAt':request.time};
    }
    function safeProfileEdit(uid) {
      return (ownsProfile(uid) || isActiveAdmin()) && keepsRegistrationIdentity()
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly([
          'nama','nama_lengkap','tgl_lahir','tanggal_lahir','tanggal_lahir_murni','jenis_kelamin','sudah_dibaptis',
          'pemuridan_kd','pemuridan_kd_angkatan','sudah_alpha','alpha_angkatan','darah','provinsi','kabupaten_kota',
          'kota','kecamatan','desa_kelurahan','desa','alamat_detail','alamat','provinsi_lahir','kota_lahir',
          'kecamatan_lahir','desa_lahir','pekerjaan','status_pernikahan','nama_pasangan','komsel','jabatan',
          'sub_jabatan','sub_bidang','pelayanan','detail_pelayanan','foto_profil','last_update']);
    }
    function profileDelete(profileId, before) {
      return signedIn() && ((request.auth.uid == profileId && before.get('uid','') in ['',request.auth.uid]) || before.get('uid','') == request.auth.uid || isAdminManager())
        && !exists(/databases/$(database)/documents/registration_audit/$('profile-delete_' + profileId))
        && getAfter(/databases/$(database)/documents/registration_audit/$('profile-delete_' + profileId)).data == {
          'action':'profile-delete','actorUid':request.auth.uid,'targetUid':before.get('uid','') != '' ? before.uid : profileId,
          'profileId':profileId,'createdAt':request.time};
    }
    function familyProfileEdit(uid) {
      return (ownsProfile(uid) || isActiveAdmin()) && keepsRegistrationIdentity()
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly([
          'anak','jumlah_anak','nama_ayah','nama_ibu','orang_tua_berjemaat','wilayah_orang_tua'])
        && request.resource.data.get('jumlah_anak',0) == request.resource.data.get('anak',[]).size()
        && sparkAppend(resource.data.get('anak',[]),request.resource.data.get('anak',[]));
    }
    function contactProof(profileId, before, after) {
      let owner = before.get('uid','') != '' ? before.uid : profileId;
      let changedEmail = after.email.lower() != before.email.lower();
      let changedPhone = after.get('whatsapp_normalized','') != before.get('whatsapp_normalized','');
      return signedIn() && (request.auth.uid == owner || isActiveAdmin()) && (changedEmail || changedPhone)
        && !after.diff(before).affectedKeys().hasAny(['uid','nij','nij_number','wilayah','createdAt','status_akun','activation','initial_verification_status','role','permissions','isAdmin'])
        && after.diff(before).affectedKeys().hasOnly(['email','email_normalized','whatsapp','whatsapp_normalized','lastContactAuditId',
          'nama','nama_lengkap','tgl_lahir','tanggal_lahir','tanggal_lahir_murni','jenis_kelamin','sudah_dibaptis','pemuridan_kd',
          'pemuridan_kd_angkatan','sudah_alpha','alpha_angkatan','darah','provinsi','kabupaten_kota','kota','kecamatan','desa_kelurahan',
          'desa','alamat_detail','alamat','provinsi_lahir','kota_lahir','kecamatan_lahir','desa_lahir','pekerjaan','status_pernikahan',
          'nama_pasangan','komsel','jabatan','sub_jabatan','sub_bidang','pelayanan','detail_pelayanan','foto_profil','last_update'])
        && (!changedEmail || (request.auth.uid == owner && after.email_normalized == request.auth.token.email.lower()
          && after.email.lower() == after.email_normalized
          && getAfter(/databases/$(database)/documents/registration_unique/$(sparkEmailKey(after.email_normalized))).data.uid == owner))
        && (!changedPhone || (after.whatsapp_normalized.matches('^62[0-9]{8,13}$')
          && after.whatsapp.replace('[^0-9]','').replace('^0','62') == after.whatsapp_normalized
          && getAfter(/databases/$(database)/documents/registration_unique/$('phone_' + after.whatsapp_normalized)).data.uid == owner))
        && !exists(/databases/$(database)/documents/registration_audit/$(after.lastContactAuditId))
        && getAfter(/databases/$(database)/documents/registration_audit/$(after.lastContactAuditId)).data == {
          'action':'profile-contact-update','actorUid':request.auth.uid,'targetUid':owner,'profileId':profileId,'createdAt':request.time};
    }
    function contactClaim(id) {
      let profileId = request.resource.data.profileId;
      let before = get(/databases/$(database)/documents/users/$(profileId)).data;
      let after = getAfter(/databases/$(database)/documents/users/$(profileId)).data;
      let owner = before.get('uid','') != '' ? before.uid : profileId;
      return contactProof(profileId,before,after)
        && request.resource.data == {'uid':owner,'profileId':profileId,'createdAt':request.time}
        && ((after.email.lower() != before.email.lower() && id == sparkEmailKey(after.email_normalized))
          || (after.get('whatsapp_normalized','') != before.get('whatsapp_normalized','') && id == 'phone_' + after.whatsapp_normalized));
    }
`+rules.slice(end);
const fields=('uid nama email email_normalized whatsapp whatsapp_normalized wilayah provinsi kabupaten_kota kecamatan desa_kelurahan alamat_detail provinsi_lahir kota_lahir kecamatan_lahir desa_lahir komsel jabatan sub_jabatan pelayanan detail_pelayanan tgl_lahir jenis_kelamin sudah_dibaptis pemuridan_kd pemuridan_kd_angkatan sudah_alpha alpha_angkatan darah pekerjaan nama_pasangan jumlah_anak anak nama_ayah nama_ayah_uid nama_ayah_nij nama_ibu nama_ibu_uid nama_ibu_nij status_pernikahan orang_tua_berjemaat wilayah_orang_tua status_akun nij nij_number createdAt').split(' ');
const validFields=`    function sparkNewFields(p) { return p.keys().hasOnly(${JSON.stringify(fields)})
        && p.get('nama_ayah_uid','') == '' && p.get('nama_ayah_nij','') == ''
        && p.get('nama_ibu_uid','') == '' && p.get('nama_ibu_nij','') == ''
        && p.get('anak',[]) == [] && p.get('jumlah_anak',0) == 0; }\n`;
rules=rules.replace("&& !p.keys().hasAny(['activation','initial_verification_status','role','permissions','isAdmin'])",'&& true');
const children=`    function sparkChild(c) { return c == {'nama':c.nama,'uid':'','nij':''} && c.nama is string && c.nama.size() <= 150; }
    function sparkAppend(before, after) {
      let n = before.size(); let m = after.size();
      return after is list && m <= 30 && (after == before || after == []\n`+
    Array.from({length:5},(_,i)=>{const count=i+1;return`        || (m == n + ${count} && after == before.concat([${Array.from({length:count},(_,j)=>`after[n + ${j}]`).join(',')}])\n          && ${Array.from({length:count},(_,j)=>`sparkChild(after[n + ${j}])`).join(' && ')})`;}).join('\n')+'); }\n';
rules=rules.replace('    function sparkProof(uid) {',children+validFields+'    function sparkProof(uid) {');
rules=rules.replace('allow create: if sparkNew(uid) && sparkProof(uid);','allow create: if sparkNew(uid) && sparkProof(uid) && sparkNewFields(request.resource.data);');
// Validate the complete proof once on the mandatory new profile. Other writes
// must refer to that same newly-created profile, whose create rule validates
// their getAfter state. This avoids evaluating the full family schema five times.
rules=rules.replace('    function sparkProof(uid) {',`    function sparkAnchor(uid) {
      let p = getAfter(/databases/$(database)/documents/users/$(uid)).data;
      return signedIn() && request.auth.uid == uid
        && !exists(/databases/$(database)/documents/users/$(uid))
        && p.uid == uid && p.createdAt == request.time;
    }
    function sparkProof(uid) {`);
rules=rules.replace('allow create: if sparkNew(uid) && sparkProof(uid);','allow create: if sparkAnchor(uid);');
rules=rules.replaceAll('sparkNew(request.auth.uid) && sparkProof(request.auth.uid)','sparkAnchor(request.auth.uid)');
rules=rules.replace('allow read, write: if isActiveAdmin() || (signedIn() && request.auth.uid == uid);',
    "allow read, write: if isActiveAdmin() || (signedIn() && request.auth.uid == uid && get(/databases/$(database)/documents/users/$(uid)).data.get('uid','') in ['',request.auth.uid]);");
rules=rules.replace('      allow update, delete: if false;\n    }\n    match /users/{uid}/{subcollection}',`      allow update: if safeProfileEdit(uid) || familyProfileEdit(uid) || (signedIn() && (contactProof(uid,resource.data,request.resource.data) || finalActivation(uid,resource.data,request.resource.data)));
      allow delete: if profileDelete(uid,resource.data);
    }
    match /users/{uid}/{subcollection}`);
rules=rules.replace("&& request.resource.data == {'uid':request.auth.uid,'createdAt':request.time};", "&& request.resource.data == {'uid':request.auth.uid,'createdAt':request.time}\n        || (signedIn() && contactClaim(id));");
const a=rules.indexOf('    match /registration_audit/{id} {'),b=rules.indexOf('    match /family_link_consents/',a);assert.ok(a>0&&b>a);
rules=rules.slice(0,a)+`    match /registration_audit/{id} {
      allow read: if isActiveAdmin();
      allow create: if signedIn() && (
        (request.resource.data.get('action','') == 'profile-contact-update'
          && getAfter(/databases/$(database)/documents/users/$(request.resource.data.profileId)).data.lastContactAuditId == id
          && contactProof(request.resource.data.profileId,get(/databases/$(database)/documents/users/$(request.resource.data.profileId)).data,
            getAfter(/databases/$(database)/documents/users/$(request.resource.data.profileId)).data))
        ||
        (request.resource.data.get('action','') == 'profile-delete'
          && id == 'profile-delete_' + request.resource.data.profileId
          && !existsAfter(/databases/$(database)/documents/users/$(request.resource.data.profileId))
          && profileDelete(request.resource.data.profileId,get(/databases/$(database)/documents/users/$(request.resource.data.profileId)).data))
        || (
        request.resource.data.get('action','') in ['activate-verified-email','activate-admin-override']
        && getAfter(/databases/$(database)/documents/users/$(request.resource.data.profileId)).data.activation.auditId == id
        && finalActivation(request.resource.data.profileId,
          get(/databases/$(database)/documents/users/$(request.resource.data.profileId)).data,
          getAfter(/databases/$(database)/documents/users/$(request.resource.data.profileId)).data)));
      allow update, delete: if false;
    }
    match /member_identity/{id} { allow read, write: if false; }
    match /legacy_profile_owners/{id} { allow read, write: if false; }
    match /legacy_link_requests/{id} { allow read, write: if false; }
    match /legacy_link_approvals/{id} { allow read, write: if false; }
`+rules.slice(b);
fs.mkdirSync(path.join(root,'docs/spark-release'),{recursive:true});
fs.writeFileSync(path.join(root,'docs/spark-release/firestore.proposed.rules'),'// REVIEW CANDIDATE: unknown UID ownership fails closed; trusted per-UID review required.\n// Production index NOT provisioned. Not selected by firebase.json. Legacy linking DISABLED.\n'+rules);
console.log('Built Spark release candidate Rules; active Rules unchanged.');
