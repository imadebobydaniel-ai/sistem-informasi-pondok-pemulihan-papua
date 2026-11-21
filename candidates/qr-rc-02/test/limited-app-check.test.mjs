import test from 'node:test';
import assert from 'node:assert/strict';
import {getLimitedUseToken,initializeAppCheck,ReCaptchaEnterpriseProvider} from 'firebase/app-check';
import {createLimitedUseAcquirer} from '../frontend/limited-app-check.mjs';

const options = {apiKey:'demo-key',appId:'demo-app',projectId:'demo-sipapua-qr-rc02'};
const provider = {provider:'recaptcha-enterprise',siteKey:'synthetic-public-key'};
test('installed Firebase modular SDK exports the public limited-use API',()=>{
    for (const entry of [getLimitedUseToken,initializeAppCheck,ReCaptchaEnterpriseProvider]) assert.equal(typeof entry,'function');
});
test('coalesces initialization and requests a distinct limited-use token for each operation',async()=>{
    let initializations=0, calls=0;
    const acquirer=createLimitedUseAcquirer(async()=>({
        initializeApp(data,name){initializations++;assert.deepEqual(data,options);assert.equal(name,'sipapua-qr-app-check');return {};},
        initializeAppCheck(_app,settings){assert.equal(settings.isTokenAutoRefreshEnabled,false);return {};},
        ReCaptchaEnterpriseProvider:class {constructor(key){assert.equal(key,provider.siteKey);}},
        getLimitedUseToken:async()=>({token:'fixture-'+ ++calls})
    }));
    assert.deepEqual(await Promise.all([acquirer(options,provider),acquirer(options,provider)]),['fixture-1','fixture-2']);
    assert.equal(initializations,1);
    await assert.rejects(acquirer({...options,appId:'other'},provider),/changed/);
});
test('unavailable SDK or invalid configuration fails without cached-token fallback',async()=>{
    let calls=0;
    const acquire=createLimitedUseAcquirer(async()=>{calls++;throw Error('SDK unavailable');});
    await assert.rejects(acquire({},provider),/incomplete/);
    assert.equal(calls,0);
    await assert.rejects(acquire(options,provider),/SDK unavailable/);
    assert.equal(calls,1);
});
