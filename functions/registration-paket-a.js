"use strict";
// REVIEW CANDIDATE. Callable registration write; not authorized for deployment.
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const REGIONS = Object.freeze({ABE:"Abepura",STN:"Sentani",DYO:"Doyo",ARS1:"ARS1",ARS2:"ARS2"});
const VERSION = "original-spark-v1";
const FIELDS = new Set(["uid","nama","email","email_normalized","whatsapp","whatsapp_normalized","wilayah","provinsi","kabupaten_kota","kecamatan","desa_kelurahan","alamat_detail","provinsi_lahir","kota_lahir","kecamatan_lahir","desa_lahir","komsel","jabatan","sub_jabatan","pelayanan","detail_pelayanan","tgl_lahir","jenis_kelamin","sudah_dibaptis","pemuridan_kd","pemuridan_kd_angkatan","sudah_alpha","alpha_angkatan","darah","pekerjaan","nama_pasangan","jumlah_anak","anak","nama_ayah","nama_ayah_uid","nama_ayah_nij","nama_ibu","nama_ibu_uid","nama_ibu_nij","status_pernikahan","orang_tua_berjemaat","wilayah_orang_tua","status_akun"]);
function normalizePhone(raw){const digits=String(raw||"").replace(/\D/g,"");return digits.startsWith("0")?"62"+digits.slice(1):digits;}
function emailKey(e){return "email_"+e.replace(/%/g,"%25").replace(/\//g,"%2F");}
const REQUIRED = ['nama','email','whatsapp','provinsi','kabupaten_kota','kecamatan','desa_kelurahan','alamat_detail',
 'provinsi_lahir','kota_lahir','kecamatan_lahir','desa_lahir','tgl_lahir','jenis_kelamin',
 'status_pernikahan','pekerjaan','komsel','jabatan','sub_jabatan'];
function oldEnough(value, now = new Date()) {
 if(typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const birth=new Date(value+'T00:00:00.000Z');
 if(!Number.isFinite(birth.getTime())||birth.toISOString().slice(0,10)!==value)return false;
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jayapura',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
 const part=k=>Number(parts.find(p=>p.type===k).value);
 const [y,m,d]=value.split('-').map(Number);
 return part('year')-y-((part('month')<m||(part('month')===m&&part('day')<d))?1:0)>=12;
}
function requiredContract(input) {
 if(!REQUIRED.every(k=>typeof input[k]==='string'&&input[k].trim()&&(k==='sub_jabatan'||input[k]!=='-')&&input[k].length<=2000))return false;
 if(!oldEnough(input.tgl_lahir))return false;
 if(!['Laki-laki','Perempuan'].includes(input.jenis_kelamin)||!['Menikah','Single','Duda','Janda'].includes(input.status_pernikahan))return false;
 for(const [k,v] of Object.entries(input)) {
  if(k==='anak'||k==='jumlah_anak')continue;
  if(typeof v!=='string'||v.length>2000)return false;
 }
 if(input.status_pernikahan==='Menikah'&&!input.nama_pasangan?.trim())return false;
 if(input.orang_tua_berjemaat==='Ya'&&![...Object.values(REGIONS),'Arso 1','Arso 2'].includes(input.wilayah_orang_tua))return false;
 return true;
}
function assertReady(s,c) {
 if(!s.exists||s.data().enabled!==true||s.data().maintenance!==false||s.data().version!==VERSION)
  throw new HttpsError('failed-precondition','Registrasi belum siap.');
 if(!c.exists||!Number.isSafeInteger(c.data().last)||c.data().last<0||c.data().last>=999999999)
  throw new HttpsError('failed-precondition','Penghitung NIJ tidak valid.');
}
const options={region:'asia-southeast2',enforceAppCheck:process.env.FUNCTIONS_EMULATOR!=='true',timeoutSeconds:60,memory:'256MiB'};
exports.registrationReadiness=onCall(options,async request=>{
 const code=request.data?.code;
 if(!Object.hasOwn(REGIONS,code))throw new HttpsError('invalid-argument','Lokasi tidak valid.');
 const db=getFirestore();
 return db.runTransaction(async tx=>{
  const [s,c]=await Promise.all([tx.get(db.doc('registration_control/state')),tx.get(db.collection('nij_counters').doc(REGIONS[code]))]);
  assertReady(s,c);
  return {ready:true};
 });
});
function validInput(input,uid,email,code){
 if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).some(k=>!FIELDS.has(k)))return false;
 if(!Object.hasOwn(REGIONS,code)||!requiredContract(input)||input.uid!==uid||input.wilayah!==REGIONS[code]||input.status_akun!=="Menunggu Verifikasi")return false;
 if(input.sub_jabatan==="Jemaat Simpatisan"&&
    (input.pelayanan!==""||input.detail_pelayanan!==""))return false;
 const normalized=String(email||"").trim().toLowerCase();
 if(!normalized||input.email_normalized!==normalized||String(input.email||"").trim().toLowerCase()!==normalized)return false;
 if(typeof input.whatsapp_normalized!=="string"||!/^62[0-9]{8,13}$/.test(input.whatsapp_normalized)||normalizePhone(input.whatsapp)!==input.whatsapp_normalized)return false;
 if(typeof input.nama!=="string"||!input.nama.trim()||input.nama.length>150)return false;
 if(!Number.isInteger(input.jumlah_anak)||input.jumlah_anak<0||input.jumlah_anak>30||!Array.isArray(input.anak)||input.anak.length!==input.jumlah_anak)return false;
 if(input.anak.some(c=>!c||typeof c!=="object"||Array.isArray(c)||Object.keys(c).some(k=>!["nama","uid","nij"].includes(k))||typeof c.nama!=="string"||!c.nama.trim()||c.nama.length>150||typeof c.uid!=="string"||typeof c.nij!=="string"))return false;
 return true;
}
const familyReferenceError=()=>new HttpsError('permission-denied','Referensi keluarga tidak tersedia. Gunakan nama tanpa tautan atau hubungi pengurus.');
async function validateFamily(db,input,tx){
 const refs=[{nama:input.nama_ayah,uid:input.nama_ayah_uid,nij:input.nama_ayah_nij},{nama:input.nama_ibu,uid:input.nama_ibu_uid,nij:input.nama_ibu_nij},...input.anak];
 const seen=new Set();
 for(const r of refs){
  const uid=String(r.uid||''),nij=String(r.nij||'');
  if(!uid&&!nij)continue; // Existing contract supports free-text, unlinked family.
  if(!uid||!nij||uid===input.uid||seen.has(uid)||uid.includes('/')||uid.length>160)throw familyReferenceError();
  seen.add(uid);
  // Check authorization before looking at private profile contents.
  const consent=await tx.get(db.collection('family_link_consents').doc(uid)),c=consent.data();
  if(!consent.exists||c.enabled!==true||!Array.isArray(c.allowedUids)||!c.allowedUids.includes(input.uid))throw familyReferenceError();
  const snap=await tx.get(db.collection('users').doc(uid));
  if(!snap.exists||snap.data().nij!==nij||(snap.data().nama||snap.data().nama_lengkap)!==r.nama||snap.data().uid===input.uid||String(snap.data().email||'').trim().toLowerCase()===input.email_normalized)throw familyReferenceError();
 }
}
exports.registerSIPAPUAProfile=onCall({region:"asia-southeast2",enforceAppCheck:process.env.FUNCTIONS_EMULATOR!=="true",timeoutSeconds:60,memory:"256MiB"},async request=>{
 if(!request.auth?.uid)throw new HttpsError("unauthenticated","Login diperlukan.");
 const uid=request.auth.uid,code=request.data?.code,input=request.data?.input;
 const authUser=await getAuth().getUser(uid);
 if(authUser.disabled)throw new HttpsError('permission-denied','Akun dinonaktifkan.');
 if(!validInput(input,uid,authUser.email,code))throw new HttpsError("invalid-argument","Data registrasi tidak valid.");
 const db=getFirestore();
 const state=db.doc("registration_control/state"),count=db.collection("nij_counters").doc(REGIONS[code]);
 const profile=db.collection("users").doc(uid),allocation=db.collection("nij_allocations").doc(uid);
 const emailClaim=db.collection("registration_unique").doc(emailKey(input.email_normalized));
 const phoneClaim=db.collection("registration_unique").doc("phone_"+input.whatsapp_normalized);
 return db.runTransaction(async tx=>{
  const [s,c,p,a,e,w]=await Promise.all([tx.get(state),tx.get(count),tx.get(profile),tx.get(allocation),tx.get(emailClaim),tx.get(phoneClaim)]);
  assertReady(s,c);
  if(p.exists||a.exists)throw new HttpsError("already-exists","Akun sudah terdaftar.");
  if(e.exists||w.exists)throw new HttpsError("already-exists","Email atau WhatsApp telah digunakan.");
  if(!c.exists||!Number.isSafeInteger(c.data().last)||c.data().last<0||c.data().last>=999999999)throw new HttpsError("failed-precondition","Penghitung NIJ tidak valid.");
  await validateFamily(db,input,tx);
  const next=c.data().last+1;
  const year=new Intl.DateTimeFormat("en",{timeZone:"Asia/Jayapura",year:"numeric"}).format(new Date());
  const nij=`NIJ-PPP-${code}-${String(next).padStart(3,"0")}-${year}`;
  const stamp=FieldValue.serverTimestamp();
  tx.update(count,{last:next,updatedAt:stamp});
  tx.create(allocation,{uid,lokasi:code,wilayah:REGIONS[code],nij,nij_number:next,createdAt:stamp});
  tx.create(emailClaim,{uid,createdAt:stamp});
  tx.create(phoneClaim,{uid,createdAt:stamp});
  tx.create(profile,{...input,nij,nij_number:next,createdAt:stamp});
  return {nij,nij_number:next};
 });
});
function onlyKeys(data, keys) {
 return data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).every(k=>keys.includes(k));
}
function safeUid(uid) { return typeof uid==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(uid); }
async function registrationProof(tx,db,user) {
 const uid=user.uid;
 const [p,a]=await Promise.all([tx.get(db.doc('users/'+uid)),tx.get(db.doc('nij_allocations/'+uid))]);
 if(!p.exists||!a.exists)throw new HttpsError('failed-precondition','Registrasi belum lengkap.');
 const d=p.data(),n=a.data();
 if(d.uid!==uid||n.uid!==uid||d.nij!==n.nij||d.nij_number!==n.nij_number||
    !Object.hasOwn(REGIONS,n.lokasi)||REGIONS[n.lokasi]!==n.wilayah||!Number.isSafeInteger(n.nij_number)||n.nij_number<1||
    !new RegExp('^NIJ-PPP-'+n.lokasi+'-'+String(n.nij_number).padStart(3,'0')+'-[0-9]{4}$').test(n.nij)||
    typeof d.email_normalized!=='string'||d.email_normalized!==String(user.email||'').trim().toLowerCase()||
    String(d.email||'').trim().toLowerCase()!==d.email_normalized||
    typeof d.whatsapp_normalized!=='string'||!/^62[0-9]{8,13}$/.test(d.whatsapp_normalized)||normalizePhone(d.whatsapp)!==d.whatsapp_normalized)
  throw new HttpsError('failed-precondition','Registrasi tidak cocok.');
 const [e,w]=await Promise.all([
  tx.get(db.collection('registration_unique').doc(emailKey(d.email_normalized))),
  tx.get(db.collection('registration_unique').doc('phone_'+d.whatsapp_normalized))]);
 if(!e.exists||!w.exists||e.data().uid!==uid||w.data().uid!==uid)throw new HttpsError('failed-precondition','Reservasi tidak cocok.');
 return d;
}
function activateTransaction(tx,db,uid,d,actorUid,path,profileId=uid) {
 if(d.status_akun==='Aktif')return {active:true};
 if(d.status_akun!=='Menunggu Verifikasi'&&!(path==='admin-override'&&d.status_akun==='Pending'))throw new HttpsError('failed-precondition','Akun tidak memenuhi syarat aktivasi.');
 const stamp=FieldValue.serverTimestamp(),audit=db.collection('registration_audit').doc();
 tx.update(db.doc('users/'+profileId),{status_akun:'Aktif',activation:{method:path,at:stamp,auditId:audit.id},initial_verification_status:d.status_akun});
 tx.create(audit,{
  uid,targetUid:uid,actorUid,action:path==='verified-email'?'activate-verified-email':'activate-admin-override',
  previousStatus:d.status_akun,newStatus:'Aktif',createdAt:stamp,activationPath:path,
  ...(path==='admin-override'?{identityVerificationAttested:true}:{})
 });
 return {active:true};
}
async function currentAuth(request) {
 if(!request.auth?.uid)throw new HttpsError('unauthenticated','Login diperlukan.');
 const user=await getAuth().getUser(request.auth.uid);
 if(user.disabled)throw new HttpsError('permission-denied','Akun dinonaktifkan.');
 return user;
}
exports.activateVerifiedSIPAPUAProfile=onCall(options,async request=>{
 const user=await currentAuth(request);
 if(!onlyKeys(request.data||{},[]))throw new HttpsError('invalid-argument','Parameter tidak valid.');
 if(!user.emailVerified)throw new HttpsError('failed-precondition','Email belum terverifikasi.');
 const db=getFirestore();
 return db.runTransaction(async tx=>activateTransaction(tx,db,user.uid,await registrationProof(tx,db,user),user.uid,'verified-email'));
});
exports.adminActivateSIPAPUAProfile=onCall(options,async request=>{
 const actor=await currentAuth(request),data=request.data;
 if(!onlyKeys(data,['targetUid','identityVerified'])||!safeUid(data.targetUid)||data.identityVerified!==true)
  throw new HttpsError('invalid-argument','Konfirmasi pemeriksaan identitas diperlukan.');
 const db=getFirestore();
 // Re-read authorization in the same transaction as the status and audit write.
 return db.runTransaction(async tx=>{
  const a=await tx.get(db.doc('admin_users/'+actor.uid)),d=a.data();
  if(!a.exists||d.status!=='active'||!['master','super_admin'].includes(d.role)||d.permissions?.canActivateMembers!==true)
   throw new HttpsError('permission-denied','Izin aktivasi diperlukan.');
  const requested=await tx.get(db.doc('users/'+data.targetUid));
  if(!requested.exists)throw new HttpsError('not-found','Profil tidak ditemukan.');
  const rd=requested.data();
  const target=rd.uid?await getAuth().getUser(rd.uid):await getAuth().getUserByEmail(rd.email);
  if(target.disabled||String(rd.email||'').trim().toLowerCase()!==String(target.email||'').trim().toLowerCase())throw new HttpsError('failed-precondition','Identitas target tidak cocok.');
  const allocation=await tx.get(db.doc('nij_allocations/'+target.uid));
  const profile=allocation.exists?await registrationProof(tx,db,target):rd;
  return activateTransaction(tx,db,target.uid,profile,actor.uid,'admin-override',requested.id);
 });
});
// Login refresh supports a recorded override without claiming that email is verified.
exports.memberLoginStatus=onCall(options,async request=>{
 const user=await currentAuth(request);
 if(!onlyKeys(request.data||{},[]))throw new HttpsError('invalid-argument','Parameter tidak valid.');
 const db=getFirestore();
 return db.runTransaction(async tx=>{
  const owned=await require('./member-lifecycle').resolveOwnedProfile(db,user,tx);
  const allocation=await tx.get(db.doc('nij_allocations/'+user.uid));
  if(!allocation.exists||owned.id!==user.uid){
   const legacy=owned.data();
   // Read-only legacy access. No NIJ, profile migration or automatic activation.
   if(user.emailVerified)return {active:legacy.status_akun==='Aktif',emailVerified:true,legacy:true};
   if(legacy.status_akun==='Aktif'&&legacy.activation?.method==='admin-override'&&typeof legacy.activation.auditId==='string'&&safeUid(legacy.activation.auditId)){
    const audit=await tx.get(db.doc('registration_audit/'+legacy.activation.auditId)),a=audit.data();
    const approved=audit.exists&&a.targetUid===user.uid&&a.uid===user.uid&&a.action==='activate-admin-override'&&a.activationPath==='admin-override'&&a.identityVerificationAttested===true&&
     ['Pending','Menunggu Verifikasi'].includes(a.previousStatus)&&a.newStatus==='Aktif'&&typeof a.actorUid==='string'&&a.actorUid.length>0&&typeof a.createdAt?.toMillis==='function'&&typeof legacy.activation.at?.toMillis==='function'&&a.createdAt.toMillis()===legacy.activation.at.toMillis();
    return {active:approved,emailVerified:false,legacy:true,activationPath:approved?'admin-override':null};
   }
   return {active:false,emailVerified:false,legacy:true};
  }
  const d=await registrationProof(tx,db,user);
  if(user.emailVerified)return activateTransaction(tx,db,user.uid,d,user.uid,'verified-email');
  let approved=false;
  if(d.status_akun==='Aktif'&&d.activation?.method==='admin-override'){
   // Also accept Gate 003 audit records, which predate the auditId link.
   const records=typeof d.activation.auditId==='string'&&safeUid(d.activation.auditId)
    ? [await tx.get(db.doc('registration_audit/'+d.activation.auditId))]
    : (await tx.get(db.collection('registration_audit').where('targetUid','==',user.uid).limit(10))).docs;
   approved=records.some(r=>{
    const a=r.data();return r.exists&&a?.targetUid===user.uid&&a.uid===user.uid&&typeof a.actorUid==='string'&&a.actorUid.length>0&&
     a.action==='activate-admin-override'&&a.activationPath==='admin-override'&&['Pending','Menunggu Verifikasi'].includes(a.previousStatus)&&
     a.newStatus==='Aktif'&&a.identityVerificationAttested===true&&typeof a.createdAt?.toMillis==='function'&&
     typeof d.activation.at?.toMillis==='function'&&a.createdAt.toMillis()===d.activation.at.toMillis();
   });
  }
  return {active:approved,emailVerified:false,activationPath:approved?'admin-override':null};
 });
});
// Exact NIJ lookup, one result, consent-bound. No name-prefix search or pagination.
exports.lookupSIPAPUAFamily=onCall(options,async request=>{
 const user=await currentAuth(request),data=request.data;
 if(!onlyKeys(data,['nij'])||typeof data.nij!=='string'||!/^NIJ-PPP-(ABE|STN|DYO|ARS1|ARS2)-[0-9]{3,9}-[0-9]{4}$/.test(data.nij))
  throw new HttpsError('invalid-argument','Masukkan NIJ lengkap.');
 const db=getFirestore(),now=Date.now(),quota=db.doc('family_lookup_limits/'+user.uid);
 return db.runTransaction(async tx=>{
  const q=await tx.get(quota),v=q.data(),fresh=!q.exists||now-v.windowStart>=60000;
  if(!fresh&&v.count>=5)throw new HttpsError('resource-exhausted','Batas pencarian tercapai. Coba lagi nanti.');
  const matches=await tx.get(db.collection('users').where('nij','==',data.nij).limit(1));
  let result=[];
  if(!matches.empty){
   const p=matches.docs[0],consent=await tx.get(db.doc('family_link_consents/'+p.id)),c=consent.data(),d=p.data();
   if(p.id!==user.uid&&d.uid===p.id&&d.nij===data.nij&&consent.exists&&c.enabled===true&&Array.isArray(c.allowedUids)&&c.allowedUids.includes(user.uid))
    result=[{uid:p.id,nij:d.nij,nama:d.nama}];
  }
  tx.set(quota,{windowStart:fresh?now:v.windowStart,count:fresh?1:v.count+1});
  return {results:result};
 });
});
// Name lookup is restricted to explicit consent, or existing active admin access.
exports.searchSIPAPUAFamily=onCall(options,async request=>{
 const user=await currentAuth(request),data=request.data;
 if(!onlyKeys(data,["query"])||typeof data.query!=="string"||data.query.trim().length<2||data.query.length>100)
  throw new HttpsError("invalid-argument","Masukkan sedikitnya dua karakter.");
 const db=getFirestore(),now=Date.now(),query=data.query.trim(),normalized=query.toLowerCase();
 return db.runTransaction(async tx=>{
  const quota=db.doc("family_lookup_limits/"+user.uid),limit=await tx.get(quota),v=limit.data();
  const fresh=!limit.exists||now-v.windowStart>=60000;
  if(!fresh&&v.count>=5)throw new HttpsError("resource-exhausted","Batas pencarian tercapai. Coba lagi nanti.");
  const admin=await tx.get(db.doc("admin_users/"+user.uid)),a=admin.data();
  const manager=admin.exists&&a.status==="active"&&["master","super_admin","admin","viewer"].includes(a.role);
  const found=new Map();
  const add=p=>{const d=p.data(),name=d.nama||d.nama_lengkap;
   const self=p.id===user.uid||d.uid===user.uid||String(d.email||"").trim().toLowerCase()===String(user.email||"").trim().toLowerCase();
   if(!self&&typeof name==="string"&&typeof d.nij==="string"&&
   (name.toLowerCase().includes(normalized)||String(d.nama_lengkap||"").toLowerCase().includes(normalized)||d.nij.toLowerCase().includes(normalized)))found.set(p.id,{uid:p.id,nama:name,nij:d.nij});};
  if(manager){
   const variants=[...new Set([query,normalized,query.toUpperCase(),normalized.replace(/\b\w/g,c=>c.toUpperCase())])];
   for(const field of ["nama","nama_lengkap","nij"])for(const variant of variants){
    const matches=await tx.get(db.collection("users").orderBy(field).startAt(variant).endAt(variant+"\uf8ff").limit(10));
    for(const p of matches.docs)add(p);
   }
   // Preserve the old substring fallback ONLY for an authenticated active admin
   // who already has private-directory access. Never expose this query to members.
   if(found.size===0){const matches=await tx.get(db.collection("users"));for(const p of matches.docs)add(p);}
  }else{
   const consents=await tx.get(db.collection("family_link_consents").where("allowedUids","array-contains",user.uid).limit(50));
   for(const consent of consents.docs){if(consent.data().enabled!==true)continue;
    const p=await tx.get(db.collection("users").doc(consent.id));if(p.exists)add(p);
   }
  }
  tx.set(quota,{windowStart:fresh?now:v.windowStart,count:fresh?1:v.count+1});
  return {results:[...found.values()].slice(0,10),scope:manager?"administrator":"consent"};
 });
});
exports.__validationForTests={validInput,normalizePhone,emailKey,oldEnough,assertReady,validateFamily};
