"use strict";
const {onCall,HttpsError}=require("firebase-functions/v2/https");
const {getFirestore,FieldValue}=require("firebase-admin/firestore");
const {getAuth}=require("firebase-admin/auth");
const {createHash}=require("node:crypto");
const regions={ABE:"Abepura",STN:"Sentani",DYO:"Doyo",ARS1:"ARS1",ARS2:"ARS2"};
const version="original-spark-v1";
const options={region:"asia-southeast2",enforceAppCheck:process.env.FUNCTIONS_EMULATOR!=="true",timeoutSeconds:120};
const fail=(code,message)=>{throw new HttpsError(code,message);};
const emailKey=e=>"email_"+e.replace(/%/g,"%25").replace(/\//g,"%2F");
const phone=value=>{const n=String(value||"").replace(/\D/g,"");return n.startsWith("0")?"62"+n.slice(1):n;};
function plan(data){
    const issues=[],writes=[],counters=Object.fromEntries(Object.values(regions).map(r=>[r,0]));
    const claims=new Map(data.claims.map(r=>[r.id,r.data.uid])),wanted=new Map(),numbers=new Map();
    const issue=(code,id)=>issues.push({code,id});
    function nij(row,profile){
        const d=row.data,m=/^NIJ-PPP-(ABE|STN|DYO|ARS1|ARS2)-(\d{3,9})-\d{4}$/.exec(String(d.nij||""));
        if(!m||!Number.isSafeInteger(Number(m[2]))||Number(m[2])<1||Number(m[2])>=999999999){issue("NIJ_REVIEW_REQUIRED",row.id);return;}
        const n=Number(m[2]),region=regions[m[1]],key=m[1]+"/"+n;
        counters[region]=Math.max(counters[region],n);
        if(d.nij_number!==undefined&&d.nij_number!==n)issue("NIJ_NUMBER_MISMATCH",row.id);
        const owner=d.uid||row.id;
        if(numbers.has(key)&&numbers.get(key)!==owner)issue("DUPLICATE_PERMANENT_NIJ",row.id);
        numbers.set(key,owner);
        if(!profile&&d.uid!==undefined&&d.uid!==row.id)issue("ALLOCATION_UID_MISMATCH",row.id);
    }
    for(const row of data.users){
        const d=row.data,e=String(d.email||"").trim().toLowerCase(),p=phone(d.whatsapp),uid=d.uid||row.id;
        if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))issue("EMAIL_REVIEW_REQUIRED",row.id);
        if(!/^62[0-9]{8,13}$/.test(p))issue("PHONE_REVIEW_REQUIRED",row.id);
        if(d.email_normalized!==undefined&&d.email_normalized!==e)issue("EMAIL_NORMALIZATION_MISMATCH",row.id);
        if(d.whatsapp_normalized!==undefined&&d.whatsapp_normalized!==p)issue("PHONE_NORMALIZATION_MISMATCH",row.id);
        for(const key of [emailKey(e),"phone_"+p]){
            if(wanted.has(key)&&wanted.get(key)!==uid)issue("DUPLICATE_CONTACT",row.id);
            wanted.set(key,uid);
        }
        nij(row,true);
    }
    for(const row of data.allocations)nij(row,false);
    for(const row of data.counters){
        if(!Object.hasOwn(counters,row.id)||!Number.isSafeInteger(row.data.last)||row.data.last<0||row.data.last>=999999999||Object.keys(row.data).some(k=>!["last","updatedAt"].includes(k)))issue("COUNTER_REVIEW_REQUIRED",row.id);
        else counters[row.id]=Math.max(counters[row.id],row.data.last);
    }
    for(const [key,uid]of wanted){
        if(claims.has(key)&&claims.get(key)!==uid)issue("IDENTITY_RESERVATION_CONFLICT",key);
        else if(!claims.has(key))writes.push({collection:"registration_unique",id:key,data:{uid}});
    }
    const existing=new Map(data.counters.map(r=>[r.id,r.data.last]));
    for(const [region,last]of Object.entries(counters))if(existing.get(region)!==last)writes.push({collection:"nij_counters",id:region,data:{last}});
    // Retain old/deleted identities and all permanent allocation documents.
    const canonical=Object.entries(data).sort().map(([kind,rows])=>[kind,rows.map(r=>({id:r.id,data:Object.fromEntries(Object.entries(r.data).filter(([k])=>!["createdAt","updatedAt"].includes(k)).sort())})).sort((a,b)=>a.id.localeCompare(b.id))]);
    return {issues,writes,counters,profileCount:data.users.length,fingerprint:createHash("sha256").update(JSON.stringify(canonical)).digest("hex")};
}
async function execute(request,action){
    if(!request.auth?.uid)fail("unauthenticated","Login diperlukan.");
    const user=await getAuth().getUser(request.auth.uid);
    if(user.disabled)fail("permission-denied","Akun dinonaktifkan.");
    const input=request.data||{},keys=action==="audit"?[]:["fingerprint"];
    if(Object.keys(input).some(k=>!keys.includes(k))||(action!=="audit"&&!/^[a-f0-9]{64}$/.test(input.fingerprint||"")))fail("invalid-argument","Fingerprint audit diperlukan.");
    const db=getFirestore();
    return db.runTransaction(async tx=>{
        const admin=await tx.get(db.doc("admin_users/"+user.uid)),a=admin.data();
        if(!admin.exists||a.status!=="active"||!["master","super_admin"].includes(a.role))fail("permission-denied","Pengelola aktif diperlukan.");
        const data={};
        for(const [kind,collection]of Object.entries({users:"users",allocations:"nij_allocations",counters:"nij_counters",claims:"registration_unique"})){
            const snapshot=await tx.get(db.collection(collection));
            data[kind]=snapshot.docs.map(p=>({id:p.id,data:p.data()}));
        }
        const control=db.doc("registration_control/state"),state=await tx.get(control),s=state.data(),p=plan(data);
        if(state.exists&&s.version!==version)fail("failed-precondition","Versi registry perlu diperiksa.");
        const report={projectId:db.projectId,fingerprint:p.fingerprint,profileCount:p.profileCount,issues:p.issues,warnings:[],counters:p.counters,
            claimWrites:p.writes.filter(w=>w.collection==="registration_unique").length,claimRemovals:0,counterWrites:p.writes.filter(w=>w.collection==="nij_counters").length,
            pendingWrites:p.writes.length,prepared:!p.issues.length&&!p.writes.length,enabled:state.exists&&s.enabled===true&&s.maintenance===false};
        if(action==="audit")return report;
        if(input.fingerprint!==p.fingerprint)fail("failed-precondition","Data berubah. Tinjau audit kembali.");
        if(s?.enabled===true)fail("failed-precondition","Registry sudah dibuka. Tidak ada persiapan ulang otomatis.");
        if(action!=="abort"&&p.issues.length)fail("failed-precondition","Konflik data harus ditinjau. Tidak ada migrasi otomatis.");
        if(action==="enable"&&(!state.exists||!report.prepared))fail("failed-precondition","Persiapan belum dikonfirmasi.");
        if(action==="prepare"&&p.writes.length>450)fail("failed-precondition","Rencana terlalu besar untuk transaksi atomik; perlu review batch terpisah.");
        const stamp=FieldValue.serverTimestamp();
        if(action==="prepare")for(const item of p.writes){
            const ref=db.collection(item.collection).doc(item.id);
            if(item.collection==="registration_unique")tx.create(ref,{...item.data,createdAt:stamp});
            else tx.set(ref,{...item.data,updatedAt:stamp});
        }
        tx.set(control,{enabled:action==="enable",maintenance:action!=="enable",version,preparedAt:stamp});
        tx.create(db.collection("registration_audit").doc(),{action:"registry-"+action,actorUid:user.uid,fingerprint:p.fingerprint,createdAt:stamp});
        return {acknowledged:true,action};
    });
}
exports.auditSIPAPUARegistry=onCall(options,r=>execute(r,"audit"));
exports.prepareSIPAPUARegistry=onCall(options,r=>execute(r,"prepare"));
exports.enableSIPAPUARegistry=onCall(options,r=>execute(r,"enable"));
exports.abortSIPAPUARegistry=onCall(options,r=>execute(r,"abort"));
exports.planForTests=plan;
