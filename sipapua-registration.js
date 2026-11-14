/* SIPAPUA Spark registration facade. Legacy UID linking remains disabled. */
(function (root) {
    'use strict';
    const REGIONS = Object.freeze({ ABE: 'Abepura', STN: 'Sentani', DYO: 'Doyo', ARS1: 'ARS1', ARS2: 'ARS2' });
    const VERSION = 'original-spark-v1';
    function failure(code, message) { return Object.assign(new Error(message), { code }); }
    function emailKey(email) { return 'email_' + String(email).toLowerCase().replace(/%/g, '%25').replace(/\//g, '%2F'); }
    function phone(value) {
        const digits = String(value || '').replace(/\D/g, '');
        return digits.startsWith('0') ? '62' + digits.slice(1) : digits;
    }
    function number(value) { return Number.isSafeInteger(value) && value >= 0 && value < 1000000000; }
    function create(db, auth, serverTimestamp, functions) {
        const spark = root.SIPAPUA_SPARK_REGISTRATION.create(db,auth,serverTimestamp);
        const member = root.SIPAPUA_SPARK_MEMBER.create(db,auth,serverTimestamp);
        let acquire = null;
        if(root.firebase&&root.SIPAPUA_APP_CHECK)acquire=root.SIPAPUA_APP_CHECK.prepare(root.firebase);
        async function attestation() {
            if(root.firebase&&!acquire)throw new Error('App Check belum dikonfigurasi.');
            if(acquire)await acquire();
        }
        const state = db.collection('registration_control').doc('state');
        function counter(region) { return db.collection('nij_counters').doc(region); }
        async function registryStatus(tx) {
            const snapshot = await tx.get(state);
            if (!snapshot.exists) return 'legacy';
            const d = snapshot.data();
            if (d.version !== VERSION) throw failure('unknown-registry', 'Versi persiapan registrasi belum sesuai. Hubungi administrator.');
            return d.enabled === true ? 'ready' : 'preparing';
        }
        function assertSession(user) {
            if (!user || auth.currentUser?.uid !== user.uid) throw failure('session-changed', 'Sesi berubah. Periksa akun sebelum melanjutkan pendaftaran.');
        }
        async function preflight(region) {
            await attestation();
            return spark.preflight(region);
        }
        async function assertEditingReady() {
            assertSession(auth.currentUser);
            await attestation();
        }
        async function registerProfile(user, code, input) {
            await attestation();
            return spark.registerProfile(user,code,input);
        }
        async function ownProfile(user) {
            assertSession(user);
            const [profile, allocation] = await Promise.all([
                db.collection('users').doc(user.uid).get({source:'server'}),
                db.collection('nij_allocations').doc(user.uid).get({source:'server'})]);
            assertSession(user);
            for (const snapshot of [profile, allocation]) {
                if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) throw failure('unconfirmed-profile', 'Server belum mengonfirmasi data.');
            }
            if (!profile.exists && !allocation.exists) return null;
            const p = profile.data(), a = allocation.data();
            if (!p || !a || p.uid !== user.uid || a.uid !== user.uid ||
                p.email_normalized !== String(user.email || '').trim().toLowerCase() ||
                p.nij !== a.nij || p.nij_number !== a.nij_number || p.wilayah !== a.wilayah ||
                !REGIONS[a.lokasi] || REGIONS[a.lokasi] !== p.wilayah ||
                !Number.isSafeInteger(p.nij_number) || p.nij_number < 1 ||
                !new RegExp('^NIJ-PPP-' + a.lokasi + '-' + String(a.nij_number).padStart(3,'0') + '-[0-9]{4}$').test(p.nij)) {
                throw failure('inconsistent-registration', 'Profil dan alokasi tidak cocok. Hubungi pengurus; jangan membuat akun baru.');
            }
            return p;
        }
        function lifecycleCall(name, data) {
            const user = auth.currentUser; assertSession(user);
            return attestation().then(()=>{
                assertSession(user);
                return name==='updateSIPAPUAProfile'?member.updateProfile(data.docId,data.changes):member.deleteProfiles(data.docIds);
            }).then(data => { assertSession(user); return {data}; });
        }
        async function updateProfile(docId, changes) {
            const response = await lifecycleCall("updateSIPAPUAProfile", {docId, changes});
            if (response.data?.updated !== true) throw failure("unconfirmed-profile", "Perubahan belum dikonfirmasi server.");
        }
        async function deleteProfile(docId) { return deleteProfiles([docId]); }
        async function deleteProfiles(docIds) {
            const response = await lifecycleCall("deleteSIPAPUAProfiles", {docIds});
            if (response.data?.deleted !== true) throw failure("unconfirmed-profile", "Penghapusan belum dikonfirmasi server.");
        }
        return Object.freeze({ preflight, registerProfile, ownProfile, updateProfile, deleteProfile, deleteProfiles, assertEditingReady });
    }
    root.SIPAPUA_REGISTRATION = Object.freeze({ create, emailKey, normalizePhone: phone, regions: REGIONS, version: VERSION });
    if (typeof module === 'object' && module.exports) module.exports = root.SIPAPUA_REGISTRATION;
})(typeof window === 'object' ? window : globalThis);
