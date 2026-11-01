/* SIPAPUA original registration: Firestore-only protocol, no Cloud Functions.
 * REVIEW CANDIDATE. Requires the companion Rules and prepared legacy indexes.
 * Do not enable the maintenance flag before the release checks are complete.
 */
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
    function year() { return new Intl.DateTimeFormat('en', { timeZone: 'Asia/Jayapura', year: 'numeric' }).format(new Date()); }
    function number(value) { return Number.isSafeInteger(value) && value >= 0 && value < 1000000000; }
    function create(db, auth, serverTimestamp) {
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
            if (!Object.values(REGIONS).includes(region)) throw failure('invalid-region', 'Lokasi berjemaat tidak valid.');
            const [control, next] = await Promise.all([state.get({ source: 'server' }), counter(region).get({ source: 'server' })]);
            if (!control.exists || control.data().enabled !== true || control.data().version !== VERSION ||
                !next.exists || !number(next.data().last)) {
                throw failure('registration-not-ready', 'Pendaftaran belum dibuka. Persiapan nomor jemaat dan pemeriksaan duplikasi belum selesai.');
            }
            return next.data().last + 1;
        }
        async function assertEditingReady() {
            const snapshot = await state.get({ source: 'server' });
            if (snapshot.exists && (snapshot.data().version !== VERSION || snapshot.data().enabled !== true)) {
                throw failure('registration-preparing', 'Persiapan registrasi sedang berjalan. Perubahan identitas ditunda sampai persiapan selesai.');
            }
        }
        async function registerProfile(user, code, input) {
            assertSession(user);
            const region = REGIONS[code];
            if (!region) throw failure('invalid-region', 'Lokasi berjemaat tidak valid.');
            if (input.uid !== user.uid || input.email_normalized !== String(user.email || '').toLowerCase() ||
                input.email.trim().toLowerCase() !== input.email_normalized || input.whatsapp_normalized !== phone(input.whatsapp) ||
                !/^62[0-9]{8,13}$/.test(input.whatsapp_normalized) || input.wilayah !== region || input.status_akun !== 'Menunggu Verifikasi') {
                throw failure('invalid-profile', 'Data akun, WhatsApp, atau lokasi belum sesuai. Periksa kembali formulir.');
            }
            await preflight(region);
            assertSession(user);
            const profile = db.collection('users').doc(user.uid);
            const allocation = db.collection('nij_allocations').doc(user.uid);
            const email = db.collection('registration_unique').doc(emailKey(input.email_normalized));
            const whatsapp = db.collection('registration_unique').doc('phone_' + input.whatsapp_normalized);
            const count = counter(region);
            for (let attempt = 0; attempt < 3; attempt++) {
              let observedLast = null;
              try { return await db.runTransaction(async tx => {
                assertSession(user);
                // All reads precede writes. Unique keys are blind writes: Rules
                // reject updates to another account's reservation without exposing it.
                const oldProfile = await tx.get(profile);
                const oldAllocation = await tx.get(allocation);
                const oldCounter = await tx.get(count);
                if (oldProfile.exists || oldAllocation.exists) {
                    throw failure('already-registered', 'Akun ini sudah memiliki data registrasi. Gunakan halaman masuk; jangan membuat pendaftaran kedua.');
                }
                if (!oldCounter.exists || !number(oldCounter.data().last)) {
                    throw failure('counter-not-ready', 'Nomor jemaat belum disiapkan. Hubungi administrator.');
                }
                observedLast = oldCounter.data().last;
                const next = observedLast + 1;
                const nij = 'NIJ-PPP-' + code + '-' + String(next).padStart(3, '0') + '-' + year();
                const stamp = serverTimestamp();
                const result = { uid: user.uid, lokasi: code, wilayah: region, nij, nij_number: next, createdAt: stamp };
                tx.set(count, { last: next, updatedAt: stamp });
                tx.set(allocation, result);
                tx.set(email, { uid: user.uid, createdAt: stamp });
                tx.set(whatsapp, { uid: user.uid, createdAt: stamp });
                tx.set(profile, { ...input, nij, nij_number: next, createdAt: stamp });
                return { nij, nij_number: next };
              }); } catch (error) {
                // A concurrent counter commit can cause Rules to reject the
                // stale +1 before the SDK reports a retryable transaction conflict.
                // Retry only after proving the counter advanced and this account
                // still has neither profile nor allocation. Never relax the Rules.
                if (error.code !== 'permission-denied' || observedLast === null || attempt === 2) throw error;
                assertSession(user);
                const [latest, saved, allocated] = await Promise.all([
                    count.get({ source: 'server' }), profile.get({ source: 'server' }), allocation.get({ source: 'server' })
                ]);
                assertSession(user);
                if (!latest.exists || latest.data().last <= observedLast || saved.exists || allocated.exists) throw error;
              }
            }
        }
        async function ownProfile(user) {
            assertSession(user);
            const snapshot = await db.collection('users').doc(user.uid).get({ source: 'server' });
            assertSession(user);
            if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) throw failure('unconfirmed-profile', 'Penyimpanan belum terkonfirmasi oleh server.');
            return snapshot.exists ? snapshot.data() : null;
        }
        // Existing profile/admin pages must adopt this helper before release.
        // Rules preserve ordinary edits/activation but reject identity edits that
        // fail to maintain the reservations and the NIJ counter atomically.
        async function updateProfile(docId, changes) {
            const caller = auth.currentUser;
            assertSession(caller);
            const ref = db.collection('users').doc(docId);
            return db.runTransaction(async tx => {
                assertSession(caller);
                const mode = await registryStatus(tx);
                const snapshot = await tx.get(ref);
                if (!snapshot.exists) throw failure('profile-missing', 'Profil belum tersedia.');
                const before = snapshot.data(), after = { ...before, ...changes };
                const change = { ...changes };
                const differs = k => Object.hasOwn(changes, k) && changes[k] !== before[k];
                const contactChanged = ['email','email_normalized','whatsapp','whatsapp_normalized'].some(differs);
                const nijChanged = ['nij','nij_number'].some(differs);
                if (mode === 'preparing' && (contactChanged || nijChanged || differs('wilayah'))) {
                    throw failure('registration-preparing', 'Persiapan registrasi sedang berjalan. Perubahan identitas dapat dilanjutkan setelah persiapan selesai.');
                }
                if (mode !== 'ready') { tx.update(ref, change); return; }
                const oldEmail = before.email_normalized ?? String(before.email).trim().toLowerCase();
                const oldPhone = before.whatsapp_normalized ?? phone(before.whatsapp);
                if (contactChanged) {
                    after.email_normalized = String(after.email).trim().toLowerCase();
                    after.whatsapp_normalized = phone(after.whatsapp);
                    if (!/^62[0-9]{8,13}$/.test(after.whatsapp_normalized)) throw failure('invalid-phone', 'Nomor WhatsApp belum sesuai.');
                    change.email_normalized = after.email_normalized;
                    change.whatsapp_normalized = after.whatsapp_normalized;
                }
                let count = null, countData = null;
                if (nijChanged) {
                    if (!Object.values(REGIONS).includes(after.wilayah) || !number(after.nij_number) || after.nij_number < 1) throw failure('invalid-nij', 'Nomor atau wilayah NIJ belum sesuai.');
                    count = counter(after.wilayah); countData = await tx.get(count);
                    if (!countData.exists || !number(countData.data().last)) throw failure('counter-not-ready', 'Penghitung NIJ belum disiapkan.');
                }
                if (contactChanged) {
                    for (const [oldKey, newKey] of [[emailKey(oldEmail), emailKey(after.email_normalized)], ['phone_' + oldPhone, 'phone_' + after.whatsapp_normalized]]) {
                        if (oldKey !== newKey) {
                            tx.set(db.collection('registration_unique').doc(newKey), { uid: docId, createdAt: serverTimestamp() });
                            tx.delete(db.collection('registration_unique').doc(oldKey));
                        }
                    }
                }
                if (count && after.nij_number > countData.data().last) tx.set(count, { last: after.nij_number, updatedAt: serverTimestamp() });
                tx.update(ref, change);
            });
        }
        async function deleteProfile(docId) {
            return deleteProfiles([docId]);
        }
        async function deleteProfiles(docIds) {
            const ids = Array.from(new Set(docIds));
            if (!ids.length || ids.length > 4 || ids.some(id => typeof id !== 'string' || !id || id.includes('/'))) {
                throw failure('invalid-delete-batch', 'Hapus paling banyak empat profil dalam satu transaksi.');
            }
            const caller = auth.currentUser;
            assertSession(caller);
            return db.runTransaction(async tx => {
                assertSession(caller);
                const mode = await registryStatus(tx);
                if (mode === 'preparing') throw failure('registration-preparing', 'Persiapan registrasi sedang berjalan. Penghapusan profil ditunda sampai persiapan selesai.');
                const snapshots = [];
                for (const id of ids) snapshots.push(await tx.get(db.collection('users').doc(id)));
                for (const snapshot of snapshots) {
                    if (!snapshot.exists) continue;
                    const d = snapshot.data();
                    if (mode === 'ready') {
                        tx.delete(db.collection('registration_unique').doc(emailKey(d.email_normalized ?? String(d.email).trim().toLowerCase())));
                        tx.delete(db.collection('registration_unique').doc('phone_' + (d.whatsapp_normalized ?? phone(d.whatsapp))));
                    }
                    tx.delete(snapshot.ref);
                }
                // Never roll back the NIJ counter or recycle the allocation.
            });
        }
        return Object.freeze({ preflight, registerProfile, ownProfile, updateProfile, deleteProfile, deleteProfiles, assertEditingReady });
    }
    root.SIPAPUA_REGISTRATION = Object.freeze({ create, emailKey, normalizePhone: phone, regions: REGIONS, version: VERSION });
    if (typeof module === 'object' && module.exports) module.exports = root.SIPAPUA_REGISTRATION;
})(typeof window === 'object' ? window : globalThis);
