/* BLOCKED Spark identity linking candidate. Passive factory; no HTML integration.
 * Noncanonical unindexed UID ownership cannot yet be proved; see OWNER-REVIEW.
 * Never changes a legacy profile. Not authorized or ready for deployment.
 */
(function(root) {
    'use strict';
    function create(db, auth, stamp, timestampFromMillis) {
        const id = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('ID tidak valid.'); return value; };
        const session = () => { const u=auth.currentUser; if(!u)throw new Error('Masuk terlebih dahulu.');return u; };
        const same = user => { if(auth.currentUser?.uid!==user.uid)throw new Error('Sesi berubah.'); };
        const ref = path => db.doc(path);
        async function requestLink() {
            const user=session(), target=ref('legacy_link_requests/'+id(user.uid));
            await db.runTransaction(async tx=>{
                same(user); const existing=await tx.get(target);
                if(existing.exists) return;
                tx.set(target,{uid:user.uid,status:'pending',createdAt:stamp()});
            });
            same(user); return user.uid;
        }
        async function approve(uid, profileId, identityVerified) {
            const actor=session();id(uid);id(profileId);
            if(identityVerified!==true)throw new Error('Pemeriksaan identitas wajib dikonfirmasi.');
            const grant=db.collection('legacy_link_approvals').doc();
            await db.runTransaction(async tx=>{
                same(actor);
                const [request,profile]=await Promise.all([tx.get(ref('legacy_link_requests/'+uid)),tx.get(ref('users/'+profileId))]);
                if(!request.exists||request.data().status!=='pending'||!profile.exists)throw new Error('Permintaan atau profil tidak tersedia.');
                if(profile.data().uid)throw new Error('Profil sudah memiliki UID; perlu pemeriksaan pengurus.');
                same(actor);
                tx.set(grant,{uid,profileId,nij:profile.data().nij,approverUid:actor.uid,identityVerified:true,
                    approvedAt:stamp(),expiresAt:timestampFromMillis(Date.now()+10*60*1000)});
            });
            same(actor); return grant.id;
        }
        async function approval(grantId) {
            const user=session();id(grantId);
            const result=await ref('legacy_link_approvals/'+grantId).get({source:'server'});
            same(user);if(!result.exists)throw new Error('Persetujuan tidak ditemukan.');
            if(result.data().uid!==user.uid)throw new Error('Persetujuan bukan untuk sesi ini.');
            return result.data();
        }
        async function confirm(grantId) {
            const user=session();id(grantId);
            const grantRef=ref('legacy_link_approvals/'+grantId);
            await db.runTransaction(async tx=>{
                same(user);
                const [grant,request,binding]=await Promise.all([tx.get(grantRef),tx.get(ref('legacy_link_requests/'+user.uid)),tx.get(ref('member_identity/'+user.uid))]);
                const g=grant.data();
                if(!grant.exists||g.uid!==user.uid||!request.exists||request.data().status!=='pending'||binding.exists)throw new Error('Pengaitan tidak tersedia atau sudah selesai.');
                same(user);
                const linkedAt=stamp();
                const data={uid:user.uid,profileId:g.profileId,grantId,linkedAt};
                tx.set(ref('member_identity/'+user.uid),data);
                tx.set(ref('legacy_profile_owners/'+g.profileId),data);
                tx.update(ref('legacy_link_requests/'+user.uid),{status:'completed',grantId,completedAt:linkedAt});
                tx.set(ref('registration_audit/legacy-link_'+grantId),{action:'legacy-identity-link',uid:user.uid,profileId:g.profileId,
                    nij:g.nij,grantId,approverUid:g.approverUid,actorUid:user.uid,identityVerified:true,approvedAt:g.approvedAt,createdAt:linkedAt});
            });
            same(user);
            const saved=await ref('member_identity/'+user.uid).get({source:'server'});
            same(user);if(!saved.exists||saved.data().grantId!==grantId||saved.metadata.fromCache||saved.metadata.hasPendingWrites)throw new Error('Pengaitan belum dikonfirmasi server.');
            return saved.data();
        }
        async function ownProfile() {
            const user=session();
            const binding=await ref('member_identity/'+user.uid).get({source:'server'});same(user);
            const profileId=binding.exists?binding.data().profileId:user.uid;
            const profile=await ref('users/'+profileId).get({source:'server'});same(user);
            if(!profile.exists) return null;
            return profile;
        }
        return Object.freeze({requestLink,approve,approval,confirm,ownProfile});
    }
    const api=Object.freeze({create});root.SIPAPUA_LEGACY_LINKING=api;
    if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof window==='object'?window:globalThis);
