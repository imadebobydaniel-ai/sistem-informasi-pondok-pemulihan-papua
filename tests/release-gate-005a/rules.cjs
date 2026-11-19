'use strict';
// Starts a NEW Firestore-only emulator on an unused loopback port. No Auth,
// Functions, registration call, reset, import/export, or existing emulator access.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const projectId = 'demo-sipapua-release005a-rules';
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
    const jar = process.env.SIPAPUA_FIRESTORE_EMULATOR_JAR ||
        path.join(os.homedir(), '.cache/firebase/emulators/cloud-firestore-emulator-v1.22.0.jar');
    assert.ok(fs.existsSync(jar), 'Local emulator JAR required; no automatic download');
    const reservation = net.createServer();
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sipapua-security003-'));
    const child = spawn('java', ['-jar', jar, '--host', '127.0.0.1', '--port', String(port),
        '--webchannel_port', '0', '--websocket_port', '0', '--project_id', projectId, '--single_project_mode', '--single_project_mode_error'],
    { cwd: temporary, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '', startupError;
    child.on('error', error => { startupError = error; });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log = (log + bytes).slice(-16000); });
    let env;
    try {
        let ready = false;
        for (let i = 0; i < 60; i++) {
            if (startupError) throw startupError;
            if (child.exitCode !== null) throw Error('New emulator failed to start: ' + log);
            try {
                const response = await fetch('http://127.0.0.1:' + port + '/', { redirect: 'error', signal: AbortSignal.timeout(500) });
                await response.body?.cancel(); if (response.status === 200 || response.status === 404) { ready = true; break; }
            } catch (_) { /* Only this new loopback process is probed. */ }
            await pause(500);
        }
        assert.ok(ready, 'New isolated emulator unavailable: ' + log);
        const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
        const { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, query, where, writeBatch, setLogLevel } = require('firebase/firestore');
        setLogLevel('silent'); // Expected permission denials are asserted below.
        const baseline = fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8').replace(/\r\n/g, '\n');
        const proposal = fs.readFileSync(path.join(root, 'docs/release-gate-005a/firestore.final-proposed.rules'), 'utf8').replace(/\r\n/g, '\n');
        const initialize = rules => initializeTestEnvironment({ projectId, firestore: { host: '127.0.0.1', port, rules } });
        env = await initialize(baseline);
        const fixture = { uid: 'member', nama: 'Rules-only fixture', email: 'fixture@example.test',
            email_normalized: 'fixture@example.test', whatsapp: '081234567890', whatsapp_normalized: '6281234567890',
            nij: 'RULES-FIXTURE-NOT-AN-ALLOCATION', nij_number: 41, wilayah: 'Fixture', status_akun: 'Pending', alamat_detail: 'Fixture' };
        const roles = { master: { role: 'master', status: 'active' }, super: { role: 'super_admin', status: 'active' },
            editor: { role: 'admin', status: 'active' }, viewer: { role: 'viewer', status: 'active' },
            inactive: { role: 'admin', status: 'inactive' }, inactiveMaster:{role:'master',status:'inactive'}, inactiveSuper:{role:'super_admin',status:'inactive'} };
        // Only synthetic Firestore rule fixtures, not Firebase Auth accounts or registrations.
        await env.withSecurityRulesDisabled(async context => {
            const db = context.firestore();
            await setDoc(doc(db, 'users/member'), fixture);
            await setDoc(doc(db, 'users/other'), { ...fixture, uid: 'other' });
            await setDoc(doc(db, 'nij_allocations/member'), { uid: 'member', nij: fixture.nij });
            await setDoc(doc(db, 'registration_audit/fixture'), { targetUid: 'member', action: 'fixture-only' });
            for (const [uid, data] of Object.entries(roles)) await setDoc(doc(db, 'admin_users/' + uid), { ...data, protected: uid === 'master' });
            await setDoc(doc(db, 'sipapua_news/public'), { status: 'published' });
            await setDoc(doc(db, 'sipapua_news/draft'), { status: 'draft' });
            await setDoc(doc(db, 'laporan_doa/fixture'), { uid: 'member' });
            await setDoc(doc(db, 'umkm_stores/seller'), {status:'active',email:'private@example.test',nama_toko:'Synthetic Store'});
            await setDoc(doc(db, 'umkm_products/fixture'), {seller_uid:'seller',nama:'Synthetic Product'});
            await setDoc(doc(db, 'chats/fixture'), {seller_uid:'seller',customer_id:'customer',sender:'customer',message:'Synthetic'});
            await setDoc(doc(db, 'pengumuman_komsel/fixture'), {target_jc:'Semua JC',readBy:[],isi:'Synthetic'});
            await setDoc(doc(db, 'portal_media/fixture'), {judul:'Synthetic'});
            await setDoc(doc(db, 'agenda_tahunan/fixture'), {nama:'Synthetic'});
            await setDoc(doc(db, 'login_logs/fixture'), {userName:'Synthetic'});
            await setDoc(doc(db, 'config/playlist'), {mode:'auto'});
            await setDoc(doc(db, 'config/private-fixture'), {synthetic:'not public'});
            await setDoc(doc(db, 'statistik_jemaat_pusat/fixture'), { uid: 'member' });
        });
        await check('baseline exposes anonymous private profile (confirmed blocker)', () => assertSucceeds(getDoc(doc(env.unauthenticatedContext().firestore(), 'users/member'))));
        await check('baseline denies owner allocation confirmation (confirmed blocker)', () => assertFails(getDoc(doc(env.authenticatedContext('member').firestore(), 'nij_allocations/member'))));
        await env.cleanup(); env = await initialize(proposal); // No clear/reset or reseeding.
        const dbFor = uid => uid ? env.authenticatedContext(uid).firestore() : env.unauthenticatedContext().firestore();
        const owner = dbFor('member'), other = dbFor('other'), anonymous = dbFor();
        await check('proposal denies anonymous profile and nested private reads', async () => {
            await assertFails(getDoc(doc(anonymous, 'users/member')));
            await assertFails(getDoc(doc(anonymous, 'users/member/private/fixture')));
        });
        await check('proposal allows owner profile/allocation, denies unrelated member and allocation list', async () => {
            await assertSucceeds(getDoc(doc(owner, 'users/member')));
            await assertSucceeds(getDoc(doc(owner, 'nij_allocations/member')));
            await assertFails(getDoc(doc(other, 'users/member')));
            await assertFails(getDoc(doc(other, 'nij_allocations/member')));
            await assertFails(getDocs(collection(owner, 'nij_allocations')));
        });
        for (const uid of ['master', 'super', 'editor', 'viewer']) {
            await check(uid + ': Database Jemaat profile/allocation list preserved; direct client edit denied', async () => {
                const db = dbFor(uid);
                await assertSucceeds(getDocs(collection(db, 'users')));
                await assertSucceeds(getDocs(collection(db, 'nij_allocations')));
                await assertFails(updateDoc(doc(db, 'users/member'), { ...fixture, alamat_detail: 'Updated fixture ' + uid }));
            });
        }
        await check('inactive administrator cannot read other profiles/allocations', async () => {
            const db = dbFor('inactive'); await assertFails(getDoc(doc(db, 'users/member'))); await assertFails(getDoc(doc(db, 'nij_allocations/member')));
        });
        for (const uid of ['member', 'other', 'master', 'super', 'editor', 'viewer', 'inactive']) {
            await check(uid + ': protected identity/status/audit fields cannot change', async () => {
                const db = dbFor(uid);
                for (const changes of [{ nij: 'forged' }, { nij_number: 42 }, { wilayah: 'forged' }, { uid: 'forged' },
                    { email: 'forged@example.test' }, { whatsapp_normalized: '62800000000' }, { status_akun: 'Aktif' },
                    { activation: { method: 'admin-override' } }, { initial_verification_status: 'forged' }]) {
                    await assertFails(updateDoc(doc(db, 'users/member'), changes));
                }
            });
        }
        for (const uid of [null, 'member', 'master', 'editor']) {
            await check((uid || 'anonymous') + ': all ledger/counter/reservation/control/audit/consent writes denied', async () => {
                const db = dbFor(uid);
                for (const p of ['nij_allocations/member', 'nij_counters/Fixture', 'registration_unique/fixture',
                    'registration_control/state', 'registration_audit/fixture', 'family_link_consents/member', 'family_lookup_limits/member']) {
                    await assertFails(setDoc(doc(db, p), { forged: true })); await assertFails(deleteDoc(doc(db, p)));
                }
            });
        }
        await check('private ledgers/audit: owner cannot enumerate reservations; audit requires active admin', async () => {
            await assertFails(getDocs(collection(owner, 'registration_unique')));
            await assertFails(getDoc(doc(owner, 'registration_audit/fixture')));
            await assertSucceeds(getDoc(doc(dbFor('master'), 'registration_audit/fixture')));
        });
        await check('profile creation/deletion blocked: existing lifecycle requires trusted replacement', async () => {
            for (const db of [owner, dbFor('master')]) {
                await assertFails(setDoc(doc(db, 'users/new-fixture'), fixture));
                await assertFails(deleteDoc(doc(db, 'users/member')));
                const batch = writeBatch(db); batch.delete(doc(db, 'users/member')); batch.delete(doc(db, 'registration_unique/fixture'));
                await assertFails(batch.commit());
            }
        });
        await check('own UID-filtered queries work; broad email fallback conflicts with private rules', async () => {
            await assertSucceeds(getDocs(query(collection(owner, 'users'), where('uid', '==', 'member'))));
            await assertFails(getDocs(query(collection(owner, 'users'), where('email', '==', fixture.email))));
        });
        await check('existing news public/draft role behavior preserved', async () => {
            await assertSucceeds(getDoc(doc(anonymous, 'sipapua_news/public')));
            await assertFails(getDoc(doc(anonymous, 'sipapua_news/draft')));
            for (const uid of ['master', 'super', 'editor', 'viewer']) await assertSucceeds(getDoc(doc(dbFor(uid), 'sipapua_news/draft')));
        });
        await check('existing private report/statistics roles preserved', async () => {
            await assertSucceeds(getDoc(doc(owner, 'laporan_doa/fixture')));
            await assertFails(getDoc(doc(other, 'laporan_doa/fixture')));
            await assertFails(getDoc(doc(anonymous, 'laporan_doa/fixture')));
            for (const uid of ['master', 'super', 'editor', 'viewer']) {
                await assertSucceeds(getDoc(doc(dbFor(uid), 'laporan_doa/fixture')));
                await assertSucceeds(getDoc(doc(dbFor(uid), 'statistik_jemaat_pusat/fixture')));
            }
        });
        await check('store/product ownership preserved without exposing private store contacts publicly',async()=>{
            await assertFails(getDoc(doc(anonymous,'umkm_stores/seller')));
            await assertFails(getDoc(doc(owner,'umkm_stores/seller')));
            await assertSucceeds(getDoc(doc(dbFor('seller'),'umkm_stores/seller')));
            await assertSucceeds(getDoc(doc(dbFor('master'),'umkm_stores/seller')));
            await assertSucceeds(updateDoc(doc(dbFor('seller'),'umkm_stores/seller'),{nama_toko:'Synthetic Edited'}));
            await assertFails(updateDoc(doc(dbFor('seller'),'umkm_stores/seller'),{status:'inactive'}));
            await assertSucceeds(getDoc(doc(owner,'umkm_products/fixture')));
            await assertFails(updateDoc(doc(owner,'umkm_products/fixture'),{nama:'forged'}));
            await assertSucceeds(updateDoc(doc(dbFor('seller'),'umkm_products/fixture'),{nama:'Synthetic Edited'}));
        });
        await check('chat participants and seller read flags; no anonymous or unrelated message access',async()=>{
            await assertFails(getDoc(doc(anonymous,'chats/fixture')));await assertFails(getDoc(doc(owner,'chats/fixture')));
            await assertSucceeds(getDoc(doc(dbFor('customer'),'chats/fixture')));await assertSucceeds(getDoc(doc(dbFor('seller'),'chats/fixture')));
            await assertSucceeds(updateDoc(doc(dbFor('seller'),'chats/fixture'),{is_read:true,deleted_by_seller:true}));
            await assertFails(updateDoc(doc(dbFor('customer'),'chats/fixture'),{is_read:false}));
            await assertFails(updateDoc(doc(dbFor('seller'),'chats/fixture'),{customer_id:'other'}));
        });
        await check('ticket creates are bound to real Auth UID/email; administrative reads preserved',async()=>{
            const db=env.authenticatedContext('customer',{email:'customer@example.test',email_verified:true}).firestore();
            const {serverTimestamp}=require('firebase/firestore');
            const ticket={uid:'customer',email:'customer@example.test',status:'proses',timestamp:serverTimestamp(),isi_saran:'Synthetic'};
            await assertSucceeds(setDoc(doc(db,'saran_masukan/fixture'),ticket));
            await assertFails(setDoc(doc(db,'saran_masukan/forged'),{...ticket,uid:'other'}));
            await assertFails(getDoc(doc(owner,'saran_masukan/fixture')));
            await assertSucceeds(getDoc(doc(dbFor('viewer'),'saran_masukan/fixture')));
        });
        await check('media, agenda, broadcasts and login logs keep role-specific access',async()=>{
            await assertSucceeds(getDoc(doc(owner,'config/playlist')));await assertFails(getDoc(doc(owner,'config/private-fixture')));await assertSucceeds(getDoc(doc(dbFor('master'),'config/private-fixture')));
            await assertFails(getDoc(doc(anonymous,'portal_media/fixture')));await assertSucceeds(getDoc(doc(owner,'portal_media/fixture')));
            await assertSucceeds(updateDoc(doc(dbFor('viewer'),'portal_media/fixture'),{judul:'Synthetic Edited'}));
            await assertFails(deleteDoc(doc(dbFor('viewer'),'portal_media/fixture')));
            await assertFails(deleteDoc(doc(dbFor('editor'),'agenda_tahunan/fixture')));
            await assertSucceeds(getDoc(doc(owner,'pengumuman_komsel/fixture')));
            await assertFails(getDoc(doc(owner,'login_logs/fixture')));await assertSucceeds(getDoc(doc(dbFor('viewer'),'login_logs/fixture')));
            const db=env.authenticatedContext('customer',{email:'customer@example.test'}).firestore();
            await assertSucceeds(updateDoc(doc(db,'pengumuman_komsel/fixture'),{readBy:['customer@example.test']}));
            await assertFails(updateDoc(doc(db,'pengumuman_komsel/fixture'),{readBy:['customer@example.test','other@example.test']}));
        });
        await check('inactive master/super cannot reactivate self, manage admins, or read drafts',async()=>{
            for(const uid of ['inactiveMaster','inactiveSuper']){
                const db=dbFor(uid);
                await assertFails(updateDoc(doc(db,'admin_users/'+uid),{status:'active',role:uid==='inactiveMaster'?'master':'super_admin',protected:uid==='inactiveMaster'}));
                await assertFails(setDoc(doc(db,'admin_users/forged-admin'),{role:'admin',status:'active',protected:false}));
                await assertFails(getDoc(doc(db,'sipapua_news/draft')));
            }
            await assertSucceeds(setDoc(doc(dbFor('master'),'admin_users/approved-admin'),{role:'admin',status:'active',protected:false}));
        });
        await check('no unconditional public legacy collection access; social presence contracts retained',()=>{
            assert.ok(!proposal.includes('allow read, write: if true;'));
            const chunk=x=>x.slice(x.indexOf('    match /presence/{uid}'),x.indexOf('    match /pengumuman_komsel/'));
            assert.equal(chunk(proposal),chunk(baseline));
        });
        console.log('RESULT ' + passed + ' PASS, 0 FAIL. Rules proposal is NOT adopted; lifecycle/privacy blockers remain.');
    } finally {
        if (env) await env.cleanup();
        child.kill(); // Stop only the child created by this test; no emulator reset.
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
