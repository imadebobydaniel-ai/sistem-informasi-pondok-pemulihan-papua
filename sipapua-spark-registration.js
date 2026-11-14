/* Spark client registration. No automatic initialization or callable.
 * Paired release Rules require separate Owner authorization before deployment.
 */
(function (root) {
    'use strict';
    const regions = Object.freeze({ABE:'Abepura',STN:'Sentani',DYO:'Doyo',ARS1:'ARS1',ARS2:'ARS2'});
    const emailKey = email => 'email_' + email.replace(/%/g, '%25').replace(/\//g, '%2F');
    function create(db, auth, serverTimestamp) {
        function same(user) {
            if (!user || auth.currentUser?.uid !== user.uid) throw new Error('Sesi berubah.');
        }
        async function preflight(region) {
            if (!Object.values(regions).includes(region)) throw new Error('Wilayah tidak valid.');
            const s = await db.doc('registration_control/state').get({source:'server'});
            const d = s.data();
            if (!s.exists || d.enabled !== true || d.maintenance !== false || d.version !== 'original-spark-v1') throw new Error('Registrasi belum siap.');
        }
        async function registerProfile(user, code, input) {
            same(user);
            if (!regions[code]) throw new Error('Wilayah tidak valid.');
            const email = String(user.email || '').trim().toLowerCase();
            if (!email || input.uid !== user.uid || input.email !== email || input.email_normalized !== email || input.wilayah !== regions[code]) throw new Error('Identitas tidak cocok.');
            const profile = db.doc('users/' + user.uid), allocation = db.doc('nij_allocations/' + user.uid);
            const counter = db.doc('nij_counters/' + regions[code]);
            const emailClaim = db.doc('registration_unique/' + emailKey(email));
            const phoneClaim = db.doc('registration_unique/phone_' + input.whatsapp_normalized);
            const children = Array.isArray(input.anak) ? input.anak : [];
            if(children.length>30||children.some(c=>!c||typeof c.nama!=='string'||c.nama.length>150||c.uid!==''||c.nij!==''))throw new Error('Data keluarga harus berupa nama tanpa tautan UID.');
            let observedLast;
            async function attempt() { return db.runTransaction(async tx => {
                same(user);
                const refs = [db.doc('registration_control/state'), counter, profile, allocation, emailClaim, phoneClaim];
                const [s,c,p,a,e,w] = await Promise.all(refs.map(ref => tx.get(ref)));
                const control = s.data(), count = c.data();
                if (!s.exists || control.enabled !== true || control.maintenance !== false || control.version !== 'original-spark-v1' || !c.exists || !Number.isSafeInteger(count.last) || count.last < 0 || count.last >= 999999999) throw new Error('Registrasi belum siap.');
                observedLast = count.last;
                if (p.exists || a.exists || e.exists || w.exists) throw new Error('Profil atau identitas sudah terdaftar.');
                const next = count.last + 1;
                // The server Rules independently check Jayapura year. A wrong local
                // clock fails closed; it never creates a different permanent NIJ.
                const year = new Intl.DateTimeFormat('en', {timeZone:'Asia/Jayapura',year:'numeric'}).format(new Date());
                const nij = `NIJ-PPP-${code}-${String(next).padStart(3,'0')}-${year}`;
                const createdAt = serverTimestamp();
                same(user);
                tx.update(counter, {last:next,updatedAt:createdAt});
                tx.set(allocation, {uid:user.uid,lokasi:code,wilayah:regions[code],nij,nij_number:next,createdAt});
                tx.set(emailClaim, {uid:user.uid,createdAt});
                tx.set(phoneClaim, {uid:user.uid,createdAt});
                // Identity allocation stays atomic. Family metadata is saved in
                // a separate authorized update to fit Firestore's expression cap.
                tx.set(profile, {...input,anak:[],jumlah_anak:0,nij,nij_number:next,createdAt});
            }); }
            for (let retry = 0; ; retry++) {
                try { await attempt(); break; }
                catch (error) {
                    same(user);
                    if (retry >= 2 || error.code !== 'permission-denied' || observedLast === undefined) throw error;
                    // A concurrent commit can invalidate Rules' current counter
                    // proof before the emulator checks transaction preconditions.
                    // Retry only if a server read confirms the counter advanced.
                    const latest = await counter.get({source:'server'});
                    same(user);
                    if (!latest.exists || latest.data().last <= observedLast) throw error;
                }
            }
            same(user);
            for(let count=5;count<children.length+5;count+=5){
                const savedChildren=children.slice(0,count);
                await profile.update({anak:savedChildren,jumlah_anak:savedChildren.length});same(user);
            }
            const [p,a] = await Promise.all([profile.get({source:'server'}),allocation.get({source:'server'})]);
            same(user);
            if (!p.exists || !a.exists || p.metadata.fromCache || a.metadata.fromCache || p.metadata.hasPendingWrites || a.metadata.hasPendingWrites || p.data().nij !== a.data().nij || p.data().nij_number !== a.data().nij_number) throw new Error('Registrasi belum dikonfirmasi server.');
            return {nij:p.data().nij,nij_number:p.data().nij_number};
        }
        return Object.freeze({preflight,registerProfile});
    }
    const api = Object.freeze({create,regions,emailKey});
    root.SIPAPUA_SPARK_REGISTRATION = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window === 'object' ? window : globalThis);
