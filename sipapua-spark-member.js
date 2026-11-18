/* Spark client lifecycle. No Functions dependency and no legacy UID linking. */
(function(root){
    'use strict';
    function create(db,auth,stamp){
        const same=u=>{if(!u||auth.currentUser?.uid!==u.uid)throw new Error('Sesi berubah.');};
        async function ownProfile(){
            const user=auth.currentUser;same(user);
            let p=await db.collection('users').doc(user.uid).get({source:'server'});same(user);
            if(p.exists&&p.data().uid&&p.data().uid!==user.uid)throw new Error('Identitas profil tidak cocok.');
            if(!p.exists){
                const q=await db.collection('users').where('uid','==',user.uid).limit(2).get({source:'server'});same(user);
                if(q.size!==1)throw new Error('Profil belum tersedia atau memerlukan pemeriksaan pengurus. Pengaitan legacy dinonaktifkan.');
                p=q.docs[0];
            }
            if(p.metadata.fromCache||p.metadata.hasPendingWrites)throw new Error('Profil belum dikonfirmasi server.');
            return p;
        }
        async function activate(profileId,method,identityVerified){
            const user=auth.currentUser;same(user);
            if(method==='admin-override'&&identityVerified!==true)throw new Error('Konfirmasi pemeriksaan identitas diperlukan.');
            const ref=db.collection('users').doc(profileId),audit=db.collection('registration_audit').doc();
            await db.runTransaction(async tx=>{
                same(user);const p=await tx.get(ref),d=p.data();
                if(!p.exists)throw new Error('Profil tidak ditemukan.');
                const targetUid=d.uid||profileId;
                if(typeof targetUid!=='string'||!targetUid)throw new Error('Identitas profil belum sesuai.');
                if(d.status_akun==='Aktif'&&method!=='admin-override')return;
                const at=stamp();
                tx.update(ref,{status_akun:'Aktif',activation:{method,at,auditId:audit.id},initial_verification_status:d.status_akun});
                tx.set(audit,{uid:targetUid,targetUid,profileId,actorUid:user.uid,action:method==='verified-email'?'activate-verified-email':'activate-admin-override',
                    activationPath:method,previousStatus:d.status_akun,newStatus:'Aktif',identityVerificationAttested:method==='admin-override',createdAt:at});
            });
            same(user);const saved=await ref.get({source:'server'});same(user);
            if(!saved.exists||saved.data().status_akun!=='Aktif'||saved.metadata.fromCache||saved.metadata.hasPendingWrites)throw new Error('Aktivasi belum dikonfirmasi server.');
            return {active:true};
        }
        async function status(){
            const user=auth.currentUser;same(user);
            const p=await ownProfile(),d=p.data();
            if(user.emailVerified&&['Pending','Menunggu Verifikasi'].includes(d.status_akun))await activate(p.id,'verified-email');
            const saved=await p.ref.get({source:'server'});same(user);
            const current=saved.data();
            let manual=false;
            if(current.status_akun==='Aktif'&&current.activation?.method==='admin-override'&&typeof current.activation.auditId==='string'){
                const audit=await db.collection('registration_audit').doc(current.activation.auditId).get({source:'server'});same(user);
                const a=audit.data(),at=current.activation.at;
                manual=audit.exists&&!audit.metadata.fromCache&&!audit.metadata.hasPendingWrites&&a.uid===user.uid&&a.targetUid===user.uid&&a.profileId===p.id
                    &&a.action==='activate-admin-override'&&a.activationPath==='admin-override'&&a.identityVerificationAttested===true
                    &&a.newStatus==='Aktif'&&['Pending','Menunggu Verifikasi','Aktif'].includes(a.previousStatus)&&typeof a.actorUid==='string'&&a.actorUid.length>0
                    &&typeof at?.toMillis==='function'&&typeof a.createdAt?.toMillis==='function'&&at.toMillis()===a.createdAt.toMillis();
            }
            return {active:current.status_akun==='Aktif'&&(user.emailVerified===true||manual),emailVerified:user.emailVerified===true,activationPath:manual?'admin-override':current.activation?.method||null};
        }
        async function updateProfile(docId,changes){
            const user=auth.currentUser;same(user);
            const ref=db.collection('users').doc(docId),before=await ref.get({source:'server'});same(user);
            if(!before.exists)throw new Error('Profil tidak ditemukan.');
            const familyKeys=['anak','jumlah_anak','nama_ayah','nama_ibu','orang_tua_berjemaat','wilayah_orang_tua'];
            const normal={},family={};
            for(const[k,v]of Object.entries(changes)){
                if(JSON.stringify(v)===JSON.stringify(before.data()[k]))continue;
                (familyKeys.includes(k)?family:normal)[k]=v;
            }
            const children=family.anak;delete family.anak;delete family.jumlah_anak;
            if(children&&(!Array.isArray(children)||children.length>30||children.some(c=>!c||typeof c.nama!=='string'||c.nama.length>150||c.uid||c.nij)))throw new Error('Perubahan tautan keluarga memerlukan pemeriksaan pengurus.');
            const email=x=>String(x||'').trim().toLowerCase();
            const phone=x=>{const n=String(x||'').replace(/\D/g,'');return n.startsWith('0')?'62'+n.slice(1):n;};
            if('email'in normal){normal.email=email(normal.email);normal.email_normalized=normal.email;}
            if('whatsapp'in normal)normal.whatsapp_normalized=phone(normal.whatsapp);
            if('email'in normal&&normal.email===email(before.data().email)){delete normal.email;delete normal.email_normalized;}
            if('whatsapp'in normal&&normal.whatsapp_normalized===phone(before.data().whatsapp)){delete normal.whatsapp;delete normal.whatsapp_normalized;}
            const emailChanged='email'in normal&&normal.email!==email(before.data().email);
            const phoneChanged='whatsapp'in normal&&normal.whatsapp_normalized!==phone(before.data().whatsapp);
            if(emailChanged||phoneChanged){
                if(emailChanged){await user.reload();await user.getIdToken(true);same(user);if(email(user.email)!==normal.email)throw new Error('Email Authentication belum sesuai.');}
                const claims=[];
                if(emailChanged)claims.push(db.collection('registration_unique').doc('email_'+normal.email.replace(/%/g,'%25').replace(/\//g,'%2F')));
                if(phoneChanged)claims.push(db.collection('registration_unique').doc('phone_'+normal.whatsapp_normalized));
                const audit=db.collection('registration_audit').doc();
                await db.runTransaction(async tx=>{
                    const current=await tx.get(ref);const snapshots=await Promise.all(claims.map(c=>tx.get(c)));same(user);
                    const owner=current.data().uid||docId;
                    if(snapshots.some(c=>c.exists&&c.data().uid!==owner))throw new Error('Identitas sudah digunakan.');
                    for(let i=0;i<claims.length;i++)if(!snapshots[i].exists)tx.set(claims[i],{uid:owner,profileId:docId,createdAt:stamp()});
                    tx.update(ref,{...normal,lastContactAuditId:audit.id});
                    tx.set(audit,{action:'profile-contact-update',actorUid:user.uid,targetUid:owner,profileId:docId,createdAt:stamp()});
                });
            }else if(Object.keys(normal).length)await ref.update(normal);same(user);
            if(children){
                await ref.update({...family,anak:[],jumlah_anak:0});same(user);
                for(let n=5;n<children.length+5;n+=5){const part=children.slice(0,n);await ref.update({anak:part,jumlah_anak:part.length});same(user);}
            }else if(Object.keys(family).length)await ref.update(family);
            same(user);
            return {updated:true};
        }
        async function deleteProfiles(docIds){
            const user=auth.currentUser;same(user);
            if(!Array.isArray(docIds)||docIds.length<1||docIds.length>4)throw new Error('Hapus paling banyak empat profil.');
            await db.runTransaction(async tx=>{
                const refs=docIds.map(id=>db.collection('users').doc(id));
                const profiles=await Promise.all(refs.map(ref=>tx.get(ref)));same(user);
                for(let i=0;i<profiles.length;i++)if(profiles[i].exists){
                    tx.delete(refs[i]);
                    tx.set(db.collection('registration_audit').doc('profile-delete_'+docIds[i]),{
                        action:'profile-delete',actorUid:user.uid,targetUid:profiles[i].data().uid||docIds[i],profileId:docIds[i],createdAt:stamp()});
                }
            });same(user);return{deleted:true};
        }
        return Object.freeze({ownProfile,status,activate,updateProfile,deleteProfiles});
    }
    root.SIPAPUA_SPARK_MEMBER=Object.freeze({create});
    if(typeof module==='object'&&module.exports)module.exports=root.SIPAPUA_SPARK_MEMBER;
})(typeof window==='object'?window:globalThis);
