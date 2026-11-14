(function (root) {
    'use strict';
    function create(auth, session) {
        async function status(user = auth.currentUser) {
            const uid = user?.uid;
            const same = () => { if (!uid || auth.currentUser?.uid !== uid) throw new Error('Sesi berubah. Masuk kembali.'); };
            same(); await user.reload(); same(); await user.getIdToken(true); same();
            const response = await session.operation('memberLoginStatus')({}); same();
            if (typeof response.data?.active !== 'boolean') throw new Error('Status akun belum dikonfirmasi server.');
            return response.data;
        }
        return Object.freeze({ status });
    }
    root.SIPAPUA_LOGIN = Object.freeze({ create });
    if (typeof module === 'object' && module.exports) module.exports = root.SIPAPUA_LOGIN;
})(typeof window === 'object' ? window : globalThis);
