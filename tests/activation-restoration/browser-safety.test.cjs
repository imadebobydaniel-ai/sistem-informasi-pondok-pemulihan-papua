'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../../docs/activation-restoration/enterprise-browser-readonly.js'),'utf8');
async function run(mode){
  const output=[],calls=[],secret='SYNTHETIC_TOKEN_MUST_NOT_BE_LOGGED';
  const options={projectId:'boby-apps-project',appId:mode==='wrong-app'?'wrong':'1:125984859692:web:09f75df5d2e4b6e3bcd389'};
  const app={};const modules={
    'firebase-app.js':{initializeApp:(config,name)=>{assert.equal(config,options);assert.ok(name.startsWith('sipapua-readonly-gate-'));calls.push('initialize-client');return app;},deleteApp:async()=>calls.push('delete-client')},
    'firebase-app-check.js':{
      ReCaptchaEnterpriseProvider:class {constructor(key){assert.equal(key,'6LcepNEtAAAAAFuRFqJWbzCbkdWXzKYf_xr7kQ_i');}},
      initializeAppCheck:(a,config)=>{assert.equal(a,app);assert.equal(config.isTokenAutoRefreshEnabled,false);return {};},
      getToken:async(c,force)=>{assert.equal(force,true);calls.push('token-exchange');if(mode==='token-error')throw Error(secret);return {token:secret};}
    },
    'firebase-firestore.js':{setLogLevel:level=>assert.equal(level,'silent'),getFirestore:()=>({}),
      doc:(db,...parts)=>{assert.deepEqual(parts,['registration_control','state']);return {};},
      getDocFromServer:async()=>{calls.push('server-get');if(mode==='read-error')throw Error(secret);return {exists:()=>true};},terminate:async()=>calls.push('terminate-client')}
  };
  const context={location:{origin:mode==='wrong-origin'?'https://example.test':'https://imadebobydaniel-ai.github.io',pathname:'/sistem-informasi-pondok-pemulihan-papua/index.html'},
    firebase:{app:()=>({options})},console:{log:value=>output.push(value)},
    _import:async url=>{assert.ok(url.startsWith('https://www.gstatic.com/firebasejs/12.18.0/'));const module=modules[url.split('/').pop()];assert.ok(module);calls.push('load-sdk');return module;}};
  // Replace import ONLY in the synthetic VM; production Owner script unchanged.
  await vm.runInNewContext(source.replace(/\bimport\(/g,'_import('),context);
  assert.equal(output.length,1);assert.ok(!output[0].includes(secret));
  return {result:JSON.parse(output[0]),calls};
}
test('Owner probe obtains real-provider-shaped token then only the allowed document GET; logs no token',async()=>{
  const {result,calls}=await run('valid');assert.deepEqual(result,{enterpriseToken:true,clientServerRead:true,productionDataWrites:0,category:'PASS'});
  assert.equal(calls.filter(x=>x==='server-get').length,1);assert.ok(calls.indexOf('token-exchange')<calls.indexOf('server-get'));assert.ok(calls.includes('delete-client'));
});
test('wrong origin or Web App fails before any SDK or token request',async()=>{
  for(const mode of ['wrong-origin','wrong-app']){const {result,calls}=await run(mode);assert.equal(result.category,'ORIGIN_AND_APP_FAILED');assert.deepEqual(calls,[]);}
});
test('token failure is sanitized and cannot proceed to document read',async()=>{
  const {result,calls}=await run('token-error');assert.equal(result.category,'ENTERPRISE_ATTESTATION_FAILED');assert.equal(result.enterpriseToken,false);assert.ok(!calls.includes('server-get'));
});
test('server denial is sanitized without exposing token or response body',async()=>{
  const {result}=await run('read-error');assert.equal(result.enterpriseToken,true);assert.equal(result.clientServerRead,false);assert.equal(result.category,'CLIENT_SERVER_READ_FAILED');
});
