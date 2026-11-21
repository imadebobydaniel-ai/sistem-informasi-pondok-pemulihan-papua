import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { internal } from '../src/worker.mjs';
import { createQrAuthority } from '../src/authority.mjs';

const projectId = 'demo-sipapua-qr-rest';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'sipapua-qr-rules-'));
const baseRules = readFileSync(join(root, 'firestore.rules'), 'utf8');
writeFileSync(join(scratch, 'firestore.rules'), baseRules);
execFileSync('git', ['apply', '--ignore-space-change', join(root, 'candidates/qr-rc-01/nij-owner-read.patch')], { cwd: scratch });
const proposedRules = readFileSync(join(scratch, 'firestore.rules'), 'utf8');

test('Auth and Firestore emulator owner-only allocation REST contract', async t => {
  const deps = process.env.SIPAPUA_TEST_DEPS;
  const authModule = process.env.SIPAPUA_TEST_AUTH_SERVER;
  assert.ok(deps && authModule, 'Set SIPAPUA_TEST_DEPS and SIPAPUA_TEST_AUTH_SERVER to installed local tooling');
  process.env.XDG_CONFIG_HOME = join(scratch, 'firebase-config');
  process.env.CI = 'true';
  const use = createRequire(resolve(deps,'package.json'));
  const { initializeTestEnvironment } = use('@firebase/rules-unit-testing');
  const firestore = use('firebase/firestore');
  const appSdk = use('firebase/app');
  const authSdk = use('firebase/auth');
  const host = '127.0.0.1';
  const port = await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error',reject);
    server.listen(0,host,() => {
      const selected = server.address().port;
      server.close(() => resolve(selected));
    });
  });
  const jar = process.env.SIPAPUA_FIRESTORE_JAR || join(homedir(),'.cache/firebase/emulators/cloud-firestore-emulator-v1.22.0.jar');
  assert.ok(existsSync(jar), 'Local Firestore emulator JAR required');
  const child = spawn('java',['-jar',jar,'--host',host,'--port',String(port),'--websocket_port','0','--project_id',projectId],
    { cwd: scratch, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  let startupError, logs = '', env;
  child.on('error',error => { startupError = error; });
  for (const stream of [child.stdout,child.stderr]) stream.on('data',bytes => { logs = (logs + bytes).slice(-12000); });
  t.after(async () => {
    try { if (env) await env.cleanup(); }
    finally {
      if (child.exitCode === null && child.signalCode === null && !startupError) {
        const closed = new Promise(resolve => child.once('close',resolve));
        child.kill();
        await closed;
      }
    }
  });
  const firestoreOrigin = 'http://' + host + ':' + port;
  let ready = false;
  for (let i=0;i<100 && !ready;i++) {
    if (startupError || child.exitCode !== null) throw startupError || Error(logs);
    try {
      const res = await fetch(firestoreOrigin,{redirect:'error',signal:AbortSignal.timeout(300)});
      ready = [200,404].includes(res.status);
      await res.body?.cancel();
    } catch {}
    if (!ready) await new Promise(resolve => setTimeout(resolve,200));
  }
  assert.ok(ready,logs);
  const {createApp} = use(authModule);
  const authApp = await createApp(projectId,2);
  const authServer = await new Promise((resolve,reject) => {
    const server = authApp.listen(0,host,() => resolve(server));
    server.once('error',reject);
  });
  t.after(() => new Promise(resolve => authServer.close(resolve)));
  const authOrigin = 'http://' + host + ':' + authServer.address().port;
  async function identity(name) {
    const app = appSdk.initializeApp({projectId,apiKey:'demo-key'},name);
    t.after(() => appSdk.deleteApp(app));
    const auth = authSdk.getAuth(app);
    authSdk.connectAuthEmulator(auth,authOrigin,{disableWarnings:true});
    const {user} = await authSdk.createUserWithEmailAndPassword(auth,name+'@example.test','Synthetic-only-42!');
    return {uid:user.uid,idToken:await user.getIdToken()};
  }
  const owner = await identity('allocation-owner');
  const other = await identity('allocation-other');
  const inactive = await identity('allocation-inactive');
  const missing = await identity('allocation-missing');
  const inconsistent = await identity('allocation-inconsistent');
  const misplaced = await identity('allocation-misplaced');
  const nij = 'NIJ-PPP-ABE-001-2026';
  const otherNij = 'NIJ-PPP-ABE-002-2026';
  const userPath = who => 'users/' + who.uid;
  const allocPath = who => 'nij_allocations/' + who.uid;
  const paths = {
    [userPath(owner)]: {uid:owner.uid,nij,nama:'Synthetic owner',status_akun:'Aktif',komsel:'JC Synthetic'},
    [allocPath(owner)]: {uid:owner.uid,nij},
    [userPath(other)]: {uid:other.uid,nij:otherNij,status_akun:'Aktif'},
    [allocPath(other)]: {uid:other.uid,nij:otherNij},
    [userPath(inactive)]: {uid:inactive.uid,nij,status_akun:'Pending'},
    [allocPath(inactive)]: {uid:inactive.uid,nij},
    [userPath(missing)]: {uid:missing.uid,nij,status_akun:'Aktif'},
    [userPath(inconsistent)]: {uid:inconsistent.uid,nij,status_akun:'Aktif'},
    [allocPath(inconsistent)]: {uid:inconsistent.uid,nij:otherNij},
    [userPath(misplaced)]: {uid:misplaced.uid,nij,status_akun:'Aktif'},
    [allocPath(misplaced)]: {uid:other.uid,nij},
    'registration_unique/synthetic-private': {uid:owner.uid}
  };
  const settings = rules => ({projectId,firestore:{host,port,rules}});
  env = await initializeTestEnvironment(settings(baseRules));
  await env.withSecurityRulesDisabled(async context => {
    const client = context.firestore();
    for (const [path,data] of Object.entries(paths)) await firestore.setDoc(firestore.doc(client,path),data);
  });
  const restRoot = firestoreOrigin + '/v1/projects/' + projectId + '/databases/(default)/documents/';
  async function status(path,idToken,expected,method='GET',body) {
    const response=await fetch(restRoot+path,{method,redirect:'error',headers:{
      ...(idToken ? {Authorization:'Bearer '+idToken} : {}),'Content-Type':'application/json'
    },...(body ? {body:JSON.stringify(body)} : {})});
    await response.body?.cancel();
    assert.equal(response.status,expected);
  }
  const allocationPath = allocPath(owner);
  const probe = { FIREBASE_PROJECT_ID: projectId };
  const wire = [];
  function mapWorkerRead(idToken) {
    return async (url, options) => {
      const u = new URL(url);
      assert.equal(u.origin, 'https://firestore.googleapis.com');
      assert.ok(u.pathname.startsWith('/v1/projects/'+projectId+'/databases/(default)/documents/'));
      assert.deepEqual(Object.keys(options.headers),['Authorization']);
      assert.ok(options.headers.Authorization === 'Bearer '+idToken);
      const path = u.pathname.split('/documents/')[1];
      wire.push(path);
      // Redirect only inside the test transport. Preserve the Firebase user bearer header.
      return fetch(restRoot+path,{...options,redirect:'error'});
    };
  }
  const profile = (identity,uid=identity.uid) => internal.memberProfile(probe,identity.idToken,uid,mapWorkerRead(identity.idToken));

  await t.test('active Rules allow own canonical profile and deny its allocation at the fallback match', async () => {
    await status(userPath(owner),owner.idToken,200);
    await status(allocationPath,owner.idToken,403);
    await assert.rejects(profile(owner),/firestore-access-denied/);
  });
  await env.cleanup();
  env = await initializeTestEnvironment(settings(proposedRules));
  await t.test('isolated rule permits owner get with the actual Firebase Auth emulator bearer token', async () => {
    wire.length=0;
    assert.deepEqual(await profile(owner),{nij,nama:'Synthetic owner',komsel:'JC Synthetic'});
    assert.deepEqual(wire,[userPath(owner),allocationPath]);
    await status(allocationPath,owner.idToken,200);
  });
  await t.test('cross-member, unauthenticated, anonymous, misbound and unrelated reads remain denied', async () => {
    await status(allocationPath,other.idToken,403);
    await status(allocationPath,null,403);
    await status(allocPath(misplaced),misplaced.idToken,403);
    await status('registration_unique/synthetic-private',owner.idToken,403);
    const anon = env.authenticatedContext(owner.uid,{firebase:{sign_in_provider:'anonymous'}}).firestore();
    await assert.rejects(firestore.getDoc(firestore.doc(anon,allocationPath)),{code:'permission-denied'});
  });
  await t.test('owner cannot list, create, update or delete allocation documents', async () => {
    const data = who => ({fields:{uid:{stringValue:who.uid},nij:{stringValue:otherNij}}});
    await status('nij_allocations',owner.idToken,403);
    await status(allocPath(missing),missing.idToken,403,'PATCH',data(missing));
    await status(allocationPath,owner.idToken,403,'PATCH',data(owner));
    await status(allocationPath,owner.idToken,403,'DELETE');
  });
  await t.test('Worker membership read fails for forged UID, inactive profile, missing or inconsistent allocation', async () => {
    await assert.rejects(profile(owner,other.uid),/firestore-access-denied/);
    await assert.rejects(profile(inactive),/identity-not-verified/);
    await assert.rejects(profile(missing),/firestore-access-denied/);
    await assert.rejects(profile(inconsistent),/identity-not-verified/);
    await assert.rejects(profile(misplaced),/firestore-access-denied/);
  });
  await t.test('authority rejects real Auth emulator revoked and disabled sessions before consuming App Check', async () => {
    const adminUse=createRequire(resolve(deps,'functions/package.json'));
    const {initializeApp,deleteApp}=adminUse('firebase-admin/app');
    const {getAuth}=adminUse('firebase-admin/auth');
    process.env.FIREBASE_AUTH_EMULATOR_HOST=authOrigin.slice('http://'.length);
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const app=initializeApp({projectId},projectId);
    try {
      const auth=getAuth(app);
      let consumed=0;
      const appId='synthetic-app';
      const authority=createQrAuthority({auth,expectedAppId:appId,
        appCheck:{async verifyToken(_token,options) {
          assert.deepEqual(options,{consume:true});
          consumed++;
          return {appId,alreadyConsumed:false};
        }}});
      async function requestFor(identity) {
        const decoded=await auth.verifyIdToken(identity.idToken,true);
        return {idToken:identity.idToken,appToken:'synthetic-app-check',uid:identity.uid,authTime:decoded.auth_time,appId};
      }
      const first=await requestFor(owner);
      const second=await requestFor(other);
      assert.equal((await authority.authorize(first)).allowed,true);
      await new Promise(resolve=>setTimeout(resolve,1100));
      await auth.revokeRefreshTokens(owner.uid);
      await auth.updateUser(other.uid,{disabled:true});
      assert.equal((await authority.authorize(first)).allowed,false);
      assert.equal((await authority.authorize(second)).allowed,false);
      assert.equal(consumed,1);
    } finally { await deleteApp(app); }
  });
  assert.equal(readFileSync(join(root,'firestore.rules'),'utf8'),baseRules);
});
