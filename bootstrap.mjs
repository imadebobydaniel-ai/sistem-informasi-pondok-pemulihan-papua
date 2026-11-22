import { createLimitedUseAcquirer } from './limited-app-check.mjs';

// Import the public modular SDK only after the adapter accepts the reviewed origin.
const acquire = createLimitedUseAcquirer(async () => {
    if (globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN) throw new Error('QR App Check debug mode is unavailable.');
    const [app, appCheck] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/12.18.0/firebase-app-check.js')
    ]);
    return { ...app, ...appCheck };
});
window.SIPAPUA_QR_LIMITED_APP_CHECK = acquire;
