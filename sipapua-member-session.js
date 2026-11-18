(function (root) {
    'use strict';
    const instances = new WeakMap();
    function create(firebase) {
        const app = firebase.app();
        if (instances.has(app)) return instances.get(app);
        const auth = firebase.auth();
        const member=root.SIPAPUA_SPARK_MEMBER.create(firebase.firestore(),auth,()=>firebase.firestore.FieldValue.serverTimestamp());
        let acquire = null;
        try { acquire = root.SIPAPUA_APP_CHECK.prepare(firebase); } catch (_) { /* Fail closed on invocation. */ }
        function same(user) {
            if (!user || auth.currentUser?.uid !== user.uid) throw new Error('Sesi berubah. Masuk kembali.');
        }
        function callable(name) {
            return async data => {
                const user = auth.currentUser; same(user);
                if (!acquire) throw new Error('App Check belum dikonfigurasi. Hubungi pengurus.');
                await acquire(); same(user);
                let result;
                if(name==='memberLoginStatus')result=await member.status();
                else if(name==='getSIPAPUAOwnProfile'){const p=await member.ownProfile();result={id:p.id,profile:p.data()};}
                else if(name==='updateSIPAPUAProfile')result=await member.updateProfile(data.docId,data.changes);
                else if(name==='deleteSIPAPUAProfiles')result=await member.deleteProfiles(data.docIds);
                else if(name==='adminActivateSIPAPUAProfile')result=await member.activate(data.targetUid,'admin-override',data.identityVerified);
                else throw new Error('Operasi tidak tersedia pada rilis Spark.');
                same(user);return {data:result};
            };
        }
        async function ownProfile() {
            const user=auth.currentUser;same(user);
            if(!acquire)throw new Error('App Check belum dikonfigurasi.');
            await acquire();same(user);
            return member.ownProfile();
        }
        const api = Object.freeze({ operation:callable, callable, ownProfile }); instances.set(app, api); return api;
    }
    function query(firebase) {
        const auth = firebase.auth();
        let requestedEmail;
        async function restoredUser() {
            if (auth.currentUser) return auth.currentUser;
            return new Promise((resolve, reject) => {
                let off;
                off = auth.onAuthStateChanged(user => {
                    queueMicrotask(() => { if (off) off(); });
                    resolve(user);
                }, reject);
            });
        }
        function check(user) {
            if (!user || String(user.email || '').trim().toLowerCase() !== String(requestedEmail || '').trim().toLowerCase()) {
                throw new Error('Query hanya tersedia untuk profil akun sendiri.');
            }
        }
        const snapshot = doc => ({ empty: false, size: 1, docs: [doc], forEach: fn => fn(doc) });
        const facade = {
            where(field, operator, value) {
                if (field !== 'email' || operator !== '==') throw new Error('Query profil tidak didukung.');
                requestedEmail = value; return facade;
            },
            limit() { return facade; },
            async get() { check(await restoredUser()); return snapshot(await create(firebase).ownProfile()); },
            onSnapshot(next, onError) {
                let unsubscribe = () => {}, disposed = false, generation = 0;
                const offAuth = auth.onAuthStateChanged(async user => {
                    const current = ++generation; unsubscribe(); unsubscribe = () => {};
                    try {
                        check(user);
                        const profile = await create(firebase).ownProfile();
                        if (disposed || current !== generation) return;
                        if (profile.id !== user.uid && !profile.data().uid && !user.emailVerified) {
                            // Ownership of an unverified legacy identity is proved
                            // by its backend activation audit, never by email Rules.
                            next(snapshot(profile));
                            return;
                        }
                        unsubscribe = profile.ref.onSnapshot(doc => {
                            if (!disposed && current === generation) next(doc.exists ? snapshot(doc) : { empty: true, size: 0, docs: [], forEach() {} });
                        }, onError);
                    } catch (error) { if (!disposed && current === generation && onError) onError(error); }
                });
                return () => { disposed = true; generation++; unsubscribe(); offAuth(); };
            }
        };
        return facade;
    }
    root.SIPAPUA_MEMBER_SESSION = Object.freeze({ create, query });
    if (typeof module === 'object' && module.exports) module.exports = root.SIPAPUA_MEMBER_SESSION;
})(typeof window === 'object' ? window : globalThis);
