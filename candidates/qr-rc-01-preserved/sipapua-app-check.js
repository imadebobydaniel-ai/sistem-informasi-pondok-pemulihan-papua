(function (root) {
    'use strict';
    // Existing SIPAPUA Web App public Enterprise site key supplied by Owner.
    // Registration/domain binding is managed in Firebase/Google Cloud Console.
    const configuration = Object.freeze({ provider: 'recaptcha-enterprise', siteKey: '6LcepNEtAAAAAFuRFqJWbzCbkdWXzKYf_xr7kQ_i' });
    const initialized = new WeakMap();

    function prepare(firebase, config = configuration) {
        if (config?.provider !== 'recaptcha-enterprise' ||
            typeof config.siteKey !== 'string' || !config.siteKey.trim()) {
            throw new Error('App Check belum dikonfigurasi.');
        }
        if (typeof firebase?.appCheck !== 'function') {
            throw new Error('SDK App Check belum tersedia.');
        }
        if (typeof firebase.appCheck.ReCaptchaEnterpriseProvider !== 'function') {
            throw new Error('SDK App Check belum mendukung reCAPTCHA Enterprise.');
        }
        const appCheck = firebase.appCheck();
        const previousKey = initialized.get(appCheck);
        if (previousKey && previousKey !== config.siteKey) {
            throw new Error('Konfigurasi App Check berubah. Muat ulang halaman.');
        }
        if (!previousKey) {
            appCheck.activate(new firebase.appCheck.ReCaptchaEnterpriseProvider(config.siteKey), true);
            initialized.set(appCheck, config.siteKey);
        }
        return async function acquireToken() {
            const result = await appCheck.getToken();
            if (typeof result?.token !== 'string' || !result.token.trim()) {
                throw new Error('Token App Check belum tersedia.');
            }
            return result.token;
        };
    }

    root.SIPAPUA_APP_CHECK = Object.freeze({ configuration, prepare });
    if (typeof module === 'object' && module.exports) module.exports = root.SIPAPUA_APP_CHECK;
})(typeof window === 'object' ? window : globalThis);
