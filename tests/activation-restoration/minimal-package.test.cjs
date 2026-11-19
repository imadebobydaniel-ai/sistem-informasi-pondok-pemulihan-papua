'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),read=f=>fs.readFileSync(path.join(root,f),'utf8');
const {inputs}=require('../../scripts/check-activation-release.cjs');
test('every packaged session consumer loads matching Firebase compat App Auth Firestore and Enterprise SDK before use',()=>{
  for(const file of inputs().filter(f=>f.endsWith('.html'))){
    const html=read(file);if(!html.includes('sipapua-member-session.js'))continue;
    const sdk=[...html.matchAll(/firebasejs\/([^/]+)\/([^"']+)/g)];
    assert.ok(sdk.length,file);assert.ok(sdk.every(m=>m[1]==='12.18.0'),file);
    for(const name of ['firebase-app-compat.js','firebase-auth-compat.js','firebase-firestore-compat.js','firebase-app-check-compat.js']){
      assert.ok(html.indexOf(name)>=0&&html.indexOf(name)<html.indexOf('sipapua-member-session.js'),file+' '+name);
    }
  }
});
test('Enterprise helper uses public bound key and provider without debug or fallback provider',()=>{
  const source=read('sipapua-app-check.js');assert.ok(source.includes('ReCaptchaEnterpriseProvider'));
  assert.ok(source.includes('6LcepNEtAAAAAFuRFqJWbzCbkdWXzKYf_xr7kQ_i'));
  assert.ok(!source.includes('FIREBASE_APPCHECK_DEBUG_TOKEN'));assert.ok(!source.includes('ReCaptchaV3Provider'));
  for(const file of ['registrasi.html','index.html','auth-handler.html','verify-success.html','edit-jemaat-administrator.html'])assert.ok(read(file).includes('1:125984859692:web:09f75df5d2e4b6e3bcd389'),file+' bound Web App');
});
test('own-profile resolver has UID reads only; old reader facades do not issue email queries',()=>{
  const member=read('sipapua-spark-member.js'),facade=read('sipapua-member-session.js');
  assert.ok(member.includes("where('uid','==',user.uid)"));assert.ok(!/where\(['"]email/.test(member));
  assert.ok(facade.includes('create(firebase).ownProfile()'));assert.ok(!/\.collection\(/.test(facade));
  for(const file of ['menu.html','profil.html','setting.html'])assert.ok(!/db\.collection\(["']users["']\)\.where\(["']email/.test(read(file)),file);
});
test('minimal activation manager explicitly requires active status without modifying shared production helpers',()=>{
  const {build}=require('../../scripts/build-minimal-activation-rules.cjs');
  const {scope}=build();assert.ok(scope.includes('return isActiveAdmin() && isAdminManager() && get('));
  assert.ok(!scope.includes('function isMaster'));assert.ok(!scope.includes('allow read, write: if true'));
});
