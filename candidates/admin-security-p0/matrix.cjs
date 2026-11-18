
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');

const os = require('node:os');
const sourcePath = path.join(__dirname, 'source-path.txt');
const root = path.resolve(process.env.SIPAPUA_WORKSPACE ||
  (fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, 'utf8').trim() : path.join(__dirname, '../..')));
const repo = createRequire(path.join(root, 'package.json'));
const { initializeTestEnvironment, assertFails, assertSucceeds } = repo('@firebase/rules-unit-testing');
const firestore = repo('firebase/firestore');
const { doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, query, where } = firestore;
firestore.setLogLevel('silent');

async function main() {
  const projectId = 'demo-sipapua-admin-p0';
  const jar = process.env.SIPAPUA_FIRESTORE_JAR ||
    path.join(os.homedir(), '.cache', 'firebase', 'emulators', 'cloud-firestore-emulator-v1.22.0.jar');
  assert.ok(fs.existsSync(jar), 'Local emulator JAR required');
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  const child = spawn('java', ['-jar', jar, '--host', '127.0.0.1', '--port', String(port),
    '--websocket_port', '0', '--webchannel_port', '0', '--project_id', projectId],
    { cwd: __dirname, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let startupError, logs = '', env;
  child.on('error', error => { startupError = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs += data; });
  try {
    let ready = false;
    for (let count = 0; count < 80 && !ready; count++) {
      if (startupError) throw startupError;
      if (child.exitCode !== null) throw Error(logs);
      try {
        const response = await fetch('http://127.0.0.1:' + port, { signal: AbortSignal.timeout(400), redirect: 'error' });
        await response.body?.cancel();
        ready = [200, 404].includes(response.status);
      } catch {}
      if (!ready) await new Promise(resolve => setTimeout(resolve, 300));
    }
    assert.ok(ready, logs);
    env = await initializeTestEnvironment({ projectId, firestore: { host: '127.0.0.1', port,
      rules: fs.readFileSync(path.join(__dirname, 'firestore.p0.candidate.rules'), 'utf8') } });
    const fixture = {
      'users/member': { uid: 'member', nij: 'SYN-1', nij_number: 1, status_akun: 'Pending', nama: 'Synthetic' },
      'users/other': { uid: 'other', status_akun: 'Aktif' },
      'users/old-record': { uid: 'legacy', nij: 'SYN-2' },
      'users/member/private/preference': { synthetic: true },
      'jemaat/family': { synthetic: true },
      'config/playlist': { mode: 'looping' },
      'config/running_text': { pesan: 'Synthetic', internal: true },
      'config/private': { synthetic: true },
      'login_logs/event': { synthetic: true },
      'kehadiran/event': { synthetic: true },
      'saran_masukan/event': { synthetic: true },
      'chats/message': { synthetic: true },
      'laporan_doa/report': { uid: 'member' },
      'registration_audit/event': { targetUid: 'member' },
      'nij_allocations/member': { uid: 'member', nij: 'SYN-1' },
    };
    for (const role of ['master', 'super_admin', 'admin', 'viewer']) {
      fixture['admin_users/' + role] = { role, status: 'active', protected: role === 'master' };
    }
    fixture['admin_users/inactive'] = { role: 'super_admin', status: 'inactive', protected: false };
    await env.withSecurityRulesDisabled(async context => {
      const database = context.firestore();
      await Promise.all(Object.entries(fixture).map(([key, value]) => setDoc(doc(database, key), value)));
    });
    const auth = uid => env.authenticatedContext(uid).firestore();
    const anon = env.unauthenticatedContext().firestore();
    const read = (db, key) => getDoc(doc(db, key));
    const update = (db, key, change) => updateDoc(doc(db, key), change);
    let pass = 0, fail = 0;
    const check = async (name, test) => {
      try { await test(); pass++; console.log('PASS ' + name); }
      catch (error) { fail++; console.error('FAIL ' + name + ' | ' + error.message); }
    };
    const member = auth('member'), viewer = auth('viewer'), admin = auth('admin');
    const master = auth('master'), superAdmin = auth('super_admin'), inactive = auth('inactive');
    await check('anonymous private read and write denial', async () => {
      for (const key of ['users/member', 'users/member/private/preference', 'jemaat/family', 'config/private', 'login_logs/event', 'kehadiran/event', 'saran_masukan/event', 'chats/message']) {
        await assertFails(read(anon, key));
        await assertFails(update(anon, key, { synthetic: false }));
      }
    });
    await check('public config allows only explicit document shapes and only get', async () => {
      await assertSucceeds(read(anon, 'config/playlist'));
      await assertFails(read(anon, 'config/running_text'));
      await assertFails(getDocs(collection(anon, 'config')));
      await assertFails(update(anon, 'config/playlist', { mode: 'single' }));
    });
    await check('owner canonical profile and subcollection read and unrelated denial', async () => {
      await assertSucceeds(read(member, 'users/member'));
      await assertSucceeds(read(member, 'users/member/private/preference'));
      await assertFails(read(member, 'users/other'));
      await assertFails(update(member, 'users/other', { nama: 'Synthetic' }));
      await assertFails(getDocs(collection(member, 'users')));
      await assertSucceeds(update(member, 'users/member', { nama: 'Edited' }));
    });
    await check('viewer and admin member listing, family and report reads', async () => {
      for (const db of [viewer, admin]) {
        await assertSucceeds(getDocs(collection(db, 'users')));
        await assertSucceeds(read(db, 'jemaat/family'));
        await assertSucceeds(read(db, 'laporan_doa/report'));
      }
    });
    await check('viewer and admin privileged member writes denied', async () => {
      for (const db of [viewer, admin]) {
        await assertFails(update(db, 'users/member', { nama: 'Denied' }));
        await assertFails(deleteDoc(doc(db, 'users/member')));
        await assertFails(update(db, 'jemaat/family', { synthetic: false }));
        await assertFails(update(db, 'laporan_doa/report', { synthetic: false }));
      }
    });
    await check('master and super admin can update ordinary member and report data', async () => {
      for (const db of [master, superAdmin]) {
        await assertSucceeds(update(db, 'users/member', { nama: 'Manager edit' }));
        await assertSucceeds(update(db, 'jemaat/family', { synthetic: false }));
        await assertSucceeds(update(db, 'laporan_doa/report', { synthetic: false }));
        await assertSucceeds(read(db, 'login_logs/event'));
      }
    });
    await check('super admin manages lower roles and master remains protected', async () => {
      await assertSucceeds(update(superAdmin, 'admin_users/viewer', { displayName: 'Synthetic' }));
      await assertFails(update(superAdmin, 'admin_users/master', { status: 'inactive' }));
      await assertFails(update(master, 'admin_users/master', { status: 'inactive' }));
      await assertSucceeds(update(master, 'admin_users/super_admin', { displayName: 'Synthetic' }));
    });
    await check('inactive administrator and member escalation denied', async () => {
      await assertFails(getDocs(collection(inactive, 'admin_users')));
      await assertFails(update(inactive, 'admin_users/admin', { status: 'inactive' }));
      await assertFails(update(inactive, 'users/member', { nama: 'Denied' }));
      await assertFails(setDoc(doc(member, 'admin_users/member'), { role: 'master', status: 'active' }));
    });
    for (const [name, change] of Object.entries({ UID: { uid: 'other' }, NIJ: { nij: 'SYN-9' },
      nij_number: { nij_number: 9 }, status: { status_akun: 'Aktif' },
      'activation metadata': { activation: { method: 'admin-override' } } })) {
      await check(name + ' client update denied', async () => {
        for (const db of [member, viewer, admin, superAdmin, master]) await assertFails(update(db, 'users/member', change));
      });
    }
    await check('activation audit target can read and all clients denied audit writes', async () => {
      await assertSucceeds(read(member, 'registration_audit/event'));
      await assertFails(read(auth('other'), 'registration_audit/event'));
      await assertFails(update(master, 'registration_audit/event', { targetUid: 'other' }));
    });
    await check('legacy UID query and cross-owner denial', async () => {
      const legacy = auth('legacy');
      await assertSucceeds(read(legacy, 'users/legacy'));
      const result = await assertSucceeds(getDocs(query(collection(legacy, 'users'), where('uid', '==', 'legacy'))));
      assert.equal(result.docs[0].id, 'old-record');
      await assertFails(update(legacy, 'users/old-record', { nij: 'SYN-9' }));
    });
    await check('client creation and permanent allocation changes denied', async () => {
      await assertFails(setDoc(doc(auth('new'), 'users/new'), { uid: 'new', status_akun: 'Menunggu Verifikasi' }));
      await assertFails(update(master, 'nij_allocations/member', { nij: 'SYN-9' }));
    });
    console.log('RESULT ' + pass + ' PASS, ' + fail + ' FAIL');
    if (fail) process.exitCode = 1;
  } finally {
    if (env) await env.cleanup();
    child.kill();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
