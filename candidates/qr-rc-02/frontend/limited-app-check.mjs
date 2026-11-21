const requiredOptions = ['apiKey', 'appId', 'projectId'];
const appName = 'sipapua-qr-app-check';

export function createLimitedUseAcquirer(loadSdk) {
    let initialized;
    let configuration;
    return async (firebaseOptions, providerConfig) => {
        if (!requiredOptions.every(key => typeof firebaseOptions?.[key] === 'string' && firebaseOptions[key]) ||
            providerConfig?.provider !== 'recaptcha-enterprise' ||
            typeof providerConfig.siteKey !== 'string' || !providerConfig.siteKey.trim()) {
            throw new Error('QR App Check configuration is incomplete.');
        }
        const options = Object.fromEntries(requiredOptions.map(key => [key, firebaseOptions[key]]));
        const signature = JSON.stringify([options, providerConfig.siteKey]);
        if (configuration && signature !== configuration) throw new Error('QR App Check configuration changed.');
        if (!initialized) {
            configuration = signature;
            initialized = (async () => {
                const sdk = await loadSdk();
                const app = sdk.initializeApp(options, appName);
                const appCheck = sdk.initializeAppCheck(app, {
                    provider: new sdk.ReCaptchaEnterpriseProvider(providerConfig.siteKey),
                    isTokenAutoRefreshEnabled: false
                });
                return { sdk, appCheck };
            })().catch(error => { initialized = undefined; configuration = undefined; throw error; });
        }
        const { sdk, appCheck } = await initialized;
        const response = await sdk.getLimitedUseToken(appCheck);
        if (typeof response?.token !== 'string' || !response.token) throw new Error('QR App Check token is unavailable.');
        return response.token;
    };
}
