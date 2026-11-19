'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
class HttpsError extends Error { constructor(code, message) { super(message); this.code=code; } }
function harness() {
    let docs=new Map(), accounts=new Map(), serial=0, fail=false, init=0;
    const ref=p=>({path:p,id:p.split('/').at(-1),get:async()=>snap(ref(p))}), stamp={toMillis:()=>123456};
    const snap=r=>({ref:r,id:r.id,exists:docs.has(r.path),data:()=>docs.get(r.path)});
    const db={doc:ref,collection:n=>({collection:n,doc:id=>ref(n+'/'+(id||'audit_'+ ++serial)),where:(field,op,value)=>({collection:n,field,op,value,limit(max){this.max=max;return this;},get(){return db.runTransaction(tx=>tx.get(this));}})}),runTransaction:async fn=>{
        const writes=[];let writing=false;
        const tx={get:async r=>{assert.equal(writing,false,'Firestore reads must precede writes');if(r.collection){const rows=[...docs].filter(([p,d])=>p.startsWith(r.collection+'/')&&p.split('/').length===2&&(!r.field||(r.op==='array-contains'?Array.isArray(d[r.field])&&d[r.field].includes(r.value):d[r.field]===r.value))).slice(0,r.max||Infinity).map(([p])=>snap(ref(p)));return {size:rows.length,empty:!rows.length,docs:rows};}return snap(r);}};
        for(const op of ['create','update','delete','set'])tx[op]=(r,d)=>{writing=true;writes.push([op,r,d]);};
        const result=await fn(tx);if(fail){fail=false;throw Error('Mock commit failure');}const next=new Map(docs);
        for(const [op,r,d]of writes){if(op==='create')assert.equal(next.has(r.path),false);if(op==='update')assert.equal(next.has(r.path),true);if(op==='delete')next.delete(r.path);else next.set(r.path,op==='update'?{...next.get(r.path),...d}:d);}docs=next;return result;
    }};
    const auth={getUser:async uid=>{if(!accounts.has(uid))throw Error('Mock account absent');return accounts.get(uid);},getUserByEmail:async email=>{const found=[...accounts.values()].find(a=>a.email===email);if(!found)throw Error('Mock email absent');return found;}};
    const deps={'node:crypto':require('node:crypto'),'firebase-functions/v2/https':{HttpsError,onCall:(options,handler)=>({options,handler})},'firebase-admin/firestore':{getFirestore:()=>db,FieldValue:{serverTimestamp:()=>stamp}},'firebase-admin/auth':{getAuth:()=>auth}};
    const modules={};function load(name){if(modules[name])return modules[name];const box={exports:{},Buffer,process:{env:{}},require:n=>deps[n]||load(n.replace('./','')+'.js')};modules[name]=box.exports;vm.runInNewContext(fs.readFileSync(path.join(root,'functions',name),'utf8'),box,{filename:name});return box.exports;}
    const registration=load('registration-paket-a.js'),lifecycle=load('member-lifecycle.js'),registry=load('registry-preparation.js');
    return {db,put:(p,d)=>docs.set(p,d),get:p=>docs.get(p),all:()=>[...docs],accounts,fail:()=>{fail=true;},registration,lifecycle,registry,call:(name,data={},uid='member')=>(registration[name]||lifecycle[name]||registry[name]).handler({data,...(uid?{auth:{uid,token:{auth_time:Math.floor(Date.now()/1000)}}}:{})})};
}
function input(uid='member'){return {uid,nama:'Mock Member',email:uid+'@example.test',email_normalized:uid+'@example.test',whatsapp:'081234567890',whatsapp_normalized:'6281234567890',wilayah:'Abepura',status_akun:'Menunggu Verifikasi',provinsi:'Mock',kabupaten_kota:'Mock',kecamatan:'Mock',desa_kelurahan:'Mock',alamat_detail:'Mock',provinsi_lahir:'Mock',kota_lahir:'Mock',kecamatan_lahir:'Mock',desa_lahir:'Mock',tgl_lahir:'2000-01-01',jenis_kelamin:'Perempuan',status_pernikahan:'Single',pekerjaan:'Mock',komsel:'Mock',jabatan:'Anggota Jemaat',sub_jabatan:'Jemaat Simpatisan',pelayanan:'',detail_pelayanan:'',jumlah_anak:0,anak:[]};}
function account(h,uid='member',verified=false){h.accounts.set(uid,{uid,email:uid+'@example.test',emailVerified:verified,disabled:false});}
async function registered(verified=false){const h=harness();account(h,'member',verified);h.put('registration_control/state',{enabled:true,maintenance:false,version:'original-spark-v1'});h.put('nij_counters/Abepura',{last:0});await h.call('registerSIPAPUAProfile',{code:'ABE',input:input()});return h;}
const denied=(fn,code)=>assert.rejects(fn,e=>e.code===code);


module.exports={harness,input,registered,account};
