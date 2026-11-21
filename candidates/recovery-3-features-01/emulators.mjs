import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';

const projectId = 'demo-sipapua-recovery';
const root = fileURLToPath(new URL('../../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'sipapua-recovery-'));
const baseRules = readFileSync(join(root, 'firestore.rules'), 'utf8');
const activeRules = readFileSync(join(root, 'firestore.rules'));
writeFileSync(join(scratch, 'firestore.rules'), baseRules);
execFileSync('git', ['apply', '--ignore-space-change', '--include=firestore.rules', join(root, 'candidates/recovery-3-features-01/member-delete.patch')], { cwd: scratch });
const proposedRules = readFileSync(join(scratch, 'firestore.rules'), 'utf8');

export async function withRecoveryEmulators(t) {
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
    const db=firestore.getFirestore(app);
    firestore.connectFirestoreEmulator(db,host,port);
    return {uid:user.uid,auth,db,email:user.email};
  }
  const init=async rules=>{
    if(env) await env.cleanup();
    env=await initializeTestEnvironment({projectId,firestore:{host,port,rules}});
    return env;
  };
  return {root,scratch,projectId,port,authOrigin,identity,firestore,init,baseRules,proposedRules,activeRules};
}
