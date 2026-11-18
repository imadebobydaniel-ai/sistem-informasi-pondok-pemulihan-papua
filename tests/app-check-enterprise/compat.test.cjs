'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm');
const root=path.resolve(__dirname,'../..'),read=f=>fs.readFileSync(path.join(root,f),'utf8');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const baseline=JSON.parse(read('docs/app-check-enterprise/PATCH-BASELINE.json'));
const helper=require('../../sipapua-app-check.js');
function sdk(){const activations=[];const instance={activate:(...args)=>activations.push(args),getToken:async()=>({token:'mock-only'})};
    const firebase={appCheck:()=>instance};firebase.appCheck.ReCaptchaEnterpriseProvider=class{constructor(key){this.key=key;}};
    return {firebase,instance,activations};}
test('18 callers retain exact HTML/CSS/inline code except approved SDK imports',()=>{
    const normalize=s=>s.replace(/\r\n/g,'\n').replace(/https:\/\/www.gstatic.com\/firebasejs\/[^/]+\/firebase-([a-z-]+?)(?:-compat)?\.js/g,(_,name)=>'FIREBASE_SDK:'+name);
    for(const file of baseline.pages){const source=read(file);assert.equal(sha(normalize(source)),baseline.htmlWithoutSdkSha256[file],file);
        const urls=[...source.matchAll(/https:\/\/www.gstatic.com\/firebasejs\/[^"']+/g)].map(m=>m[0]);
        assert.ok(urls.length>=4,file);assert.ok(urls.every(u=>/^https:\/\/www.gstatic.com\/firebasejs\/12.18.0\/firebase-[a-z-]+-compat\.js$/.test(u)),file);
        for(const script of source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))if(script[1].trim())new vm.Script(script[1],{filename:file});
    }
});
test('backend, NIJ, active Rules, configuration and original untracked files preserved',()=>{
    for(const [file,hash]of Object.entries(baseline.beforeSha256)){
        if(baseline.pages.includes(file)||file==='sipapua-app-check.js')continue;
        assert.equal(sha(fs.readFileSync(path.join(root,file))),hash,file);
    }
});
test('existing public key uses Enterprise object with automatic refresh and idempotence',async()=>{
    const h=sdk();assert.equal(helper.configuration.provider,'recaptcha-enterprise');
    assert.equal(helper.configuration.siteKey,'6LcepNEtAAAAAFuRFqJWbzCbkdWXzKYf_xr7kQ_i');
    await helper.prepare(h.firebase)();await helper.prepare(h.firebase)();
    assert.equal(h.activations.length,1);assert.ok(h.activations[0][0] instanceof h.firebase.appCheck.ReCaptchaEnterpriseProvider);
    assert.equal(h.activations[0][0].key,helper.configuration.siteKey);assert.equal(h.activations[0][1],true);
    assert.throws(()=>helper.prepare(h.firebase,{...helper.configuration,siteKey:'different'}),/berubah/);
});
test('v3, missing Enterprise class, blank keys and missing SDK fail closed',()=>{
    const h=sdk();assert.throws(()=>helper.prepare(h.firebase,{provider:'recaptcha-v3',siteKey:'mock-only'}));
    for(const siteKey of ['',null,' '])assert.throws(()=>helper.prepare(h.firebase,{provider:'recaptcha-enterprise',siteKey}));
    delete h.firebase.appCheck.ReCaptchaEnterpriseProvider;assert.throws(()=>helper.prepare(h.firebase),/Enterprise/);
    assert.throws(()=>helper.prepare({}),/SDK/);
});
test('empty, invalid and rejected token responses fail closed',async()=>{
    const h=sdk(),acquire=helper.prepare(h.firebase);
    for(const token of ['',null,42,' ']){h.instance.getToken=async()=>({token});await assert.rejects(acquire);}
    h.instance.getToken=async()=>{throw Error('attestation denied');};await assert.rejects(acquire,/attestation denied/);
});
test('existing member session waits for Enterprise token and never forwards after rejection',async()=>{
    const h=sdk(),calls=[],user={uid:'synthetic-mock-only'};
    h.firebase.app=()=>({functions:region=>{assert.equal(region,'asia-southeast2');return{httpsCallable:name=>async()=>{calls.push(name);return{data:{active:true}};}};}});
    h.firebase.auth=()=>({currentUser:user});
    const context={SIPAPUA_APP_CHECK:helper};context.window=context;vm.createContext(context);vm.runInContext(read('sipapua-member-session.js'),context);
    const invoke=context.SIPAPUA_MEMBER_SESSION.create(h.firebase).callable('memberLoginStatus');
    await invoke({});assert.deepEqual(calls,['memberLoginStatus']);
    h.instance.getToken=async()=>{throw Error('attestation denied');};await assert.rejects(()=>invoke({}));assert.equal(calls.length,1);
});
