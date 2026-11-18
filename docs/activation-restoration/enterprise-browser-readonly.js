// Owner: paste this entire IIFE in DevTools on the existing SIPAPUA Pages page.
// No Auth changes, document writes, debug provider, or configuration changes.
// Output contains booleans/categories only. Do not share Network/token contents.
(async () => {
  const result = { enterpriseToken: false, clientServerRead: false, productionDataWrites: 0 };
  let stage = 'ORIGIN_AND_APP', app, terminate, deleteApp, db;
  try {
    if (location.origin !== 'https://imadebobydaniel-ai.github.io' ||
        !location.pathname.startsWith('/sistem-informasi-pondok-pemulihan-papua/') ||
        globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN !== undefined) throw Error();
    const options = globalThis.firebase?.app().options;
    if (options?.projectId !== 'boby-apps-project' ||
        options?.appId !== '1:125984859692:web:09f75df5d2e4b6e3bcd389') throw Error();
    stage = 'OFFICIAL_SDK_LOAD';
    const base = 'https://www.gstatic.com/firebasejs/12.18.0/';
    const [apps, checks, store] = await Promise.all([
      import(base + 'firebase-app.js'), import(base + 'firebase-app-check.js'),
      import(base + 'firebase-firestore.js')
    ]);
    deleteApp = apps.deleteApp; terminate = store.terminate;
    store.setLogLevel('silent');
    app = apps.initializeApp(options, 'sipapua-readonly-gate-' + Date.now());
    stage = 'ENTERPRISE_ATTESTATION';
    const check = checks.initializeAppCheck(app, {
      provider: new checks.ReCaptchaEnterpriseProvider('6LcepNEtAAAAAFuRFqJWbzCbkdWXzKYf_xr7kQ_i'),
      isTokenAutoRefreshEnabled: false
    });
    const tokenResult = await checks.getToken(check, true);
    if (typeof tokenResult.token !== 'string' || !tokenResult.token) throw Error();
    result.enterpriseToken = true;
    stage = 'CLIENT_SERVER_READ';
    db = store.getFirestore(app);
    const snapshot = await store.getDocFromServer(store.doc(db, 'registration_control', 'state'));
    result.clientServerRead = snapshot.exists();
    result.category = result.clientServerRead ? 'PASS' : 'REGISTRY_NOT_FOUND';
  } catch (_) { result.category = stage + '_FAILED'; }
  finally {
    try { if (db) await terminate(db); if (app) await deleteApp(app); } catch (_) {}
    console.log(JSON.stringify(result));
  }
})();
