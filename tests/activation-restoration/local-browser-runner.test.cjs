'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const runner=require('../../scripts/check-appcheck-local-browser.cjs');
test('only the exact reviewed browser script can execute and only its sanitized return crosses CDP',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../../docs/activation-restoration/enterprise-browser-readonly.js'),'utf8');
  const expression=runner.probeExpression(source);assert.ok(expression.includes('return result;'));assert.ok(!expression.includes('console.log(JSON.stringify(result))'));
  assert.throws(()=>runner.probeExpression(source+'\n// changed'));
});
test('result allowlist strips extra token/body properties and rejects malformed reports',()=>{
  assert.deepEqual(runner.sanitize({enterpriseToken:true,clientServerRead:true,productionDataWrites:0,category:'PASS',token:'SECRET',body:'PRIVATE'}),{enterpriseToken:true,clientServerRead:true,productionDataWrites:0,category:'PASS'});
  assert.throws(()=>runner.sanitize({enterpriseToken:true,clientServerRead:true,productionDataWrites:1,category:'PASS'}));
  assert.throws(()=>runner.sanitize({enterpriseToken:true,clientServerRead:true,productionDataWrites:0,category:'SECRET'}));
});
test('debugger socket accepts only owned localhost page target on the exact ephemeral port',()=>{
  assert.equal(runner.localSocket('ws://127.0.0.1:1234/devtools/page/owned',1234),true);
  for(const url of ['ws://example.test:1234/devtools/page/a','ws://127.0.0.1:4321/devtools/page/a','ws://127.0.0.1:1234/devtools/browser/a'])assert.equal(runner.localSocket(url,1234),false);
});
test('recursive cleanup is restricted to the runner temporary profile boundary',()=>{
  assert.equal(runner.ownedProfile(path.join(os.tmpdir(),'sipapua-appcheck-cdp-fixture')),true);
  assert.equal(runner.ownedProfile(os.tmpdir()),false);
  assert.equal(runner.ownedProfile(path.join(os.tmpdir(),'other-profile')),false);
  assert.equal(runner.ownedProfile(path.join(os.tmpdir(),'sipapua-appcheck-cdp-fixture','nested')),false);
});
