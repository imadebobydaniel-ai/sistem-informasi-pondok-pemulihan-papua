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
const projectId = 'demo-sipapua-guest-chat-closeout';
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
        '--webchannel_port', '0', '--websocket_port', '0', '--project_id', projectId],
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
        const proposal = fs.readFileSync(path.join(root, 'docs/release-gate-005a/firestore.final-proposed.rules'), 'utf8');
        env = await initializeTestEnvironment({projectId, firestore:{host:'127.0.0.1',port,rules:proposal}});
        const dbFor = (uid, provider='password') => env.authenticatedContext(uid,{firebase:{sign_in_provider:provider}}).firestore();
        const guest=dbFor('guest','anonymous'), seller=dbFor('seller'), stranger=dbFor('stranger');
        const message = {seller_uid:'seller',customer_id:'guest',sender:'customer',message:'<img src=x onerror=alert(1)>',
            timestamp:require('firebase/firestore').serverTimestamp(),is_read:false,deleted_by_seller:false,is_product:false};
        await env.withSecurityRulesDisabled(async ctx=>{
            await setDoc(doc(ctx.firestore(),'chats/legacy'),{seller_uid:'seller',customer_id:'legacy-local-id',sender:'customer',message:'Legacy'});
            await setDoc(doc(ctx.firestore(),'nij_counters/sentinel'),{value:41});
        });
        await check('Auth anonymous UID in isolated demo project creates message',()=>assertSucceeds(setDoc(doc(guest,'chats/new'),message)));
        await check('forged customer identity rejected',()=>assertFails(setDoc(doc(guest,'chats/forged'),{...message,customer_id:'stranger'})));
        await check('forged seller identity rejected',()=>assertFails(setDoc(doc(guest,'chats/forged-seller'),{...message,sender:'seller'})));
        await check('other participant cannot read or query conversation',async()=>{
            await assertFails(getDoc(doc(stranger,'chats/new')));
            await assertFails(getDocs(query(collection(stranger,'chats'),where('seller_uid','==','seller'))));
        });
        await check('customer and seller can query their own conversation',async()=>{
            await assertSucceeds(getDocs(query(collection(guest,'chats'),where('seller_uid','==','seller'),where('customer_id','==','guest'))));
            await assertSucceeds(getDocs(query(collection(seller,'chats'),where('seller_uid','==','seller'))));
        });
        await check('seller flags allowed; customer flags and body changes denied',async()=>{
            await assertSucceeds(updateDoc(doc(seller,'chats/new'),{is_read:true,deleted_by_seller:true}));
            await assertFails(updateDoc(doc(guest,'chats/new'),{is_read:false}));
            await assertFails(updateDoc(doc(seller,'chats/new'),{message:'changed'}));
            await assertFails(updateDoc(doc(seller,'chats/new'),{is_read:'false'}));
        });
        await check('missing or pre-set flags rejected on new writes',async()=>{
            for(const flags of [{is_read:true},{deleted_by_seller:true},{is_read:null}])
                await assertFails(setDoc(doc(guest,'chats/badflags'),{...message,...flags}));
            const missing={...message}; delete missing.is_read;
            await assertFails(setDoc(doc(guest,'chats/missing'),missing));
        });
        await check('legacy seller visibility retained without ownership migration',async()=>{
            await assertSucceeds(getDoc(doc(seller,'chats/legacy')));
            await assertFails(getDoc(doc(guest,'chats/legacy')));
            await assertSucceeds(updateDoc(doc(seller,'chats/legacy'),{deleted_by_seller:true}));
            await assertFails(updateDoc(doc(seller,'chats/legacy'),{customer_id:'guest'}));
        });
        await check('signed-out reads/writes and deletes denied',async()=>{
            const db=env.unauthenticatedContext().firestore();
            await assertFails(getDoc(doc(db,'chats/new')));await assertFails(setDoc(doc(db,'chats/anon'),message));
            await assertFails(deleteDoc(doc(seller,'chats/new')));
        });
        await check('seller reply uses same new-message flags',()=>assertSucceeds(setDoc(doc(seller,'chats/reply'),{...message,sender:'seller'})));
        await check('NIJ ledger is inaccessible to guest and unchanged',async()=>{
            await assertFails(updateDoc(doc(guest,'nij_counters/sentinel'),{value:0}));
            await env.withSecurityRulesDisabled(async ctx=>assert.equal((await getDoc(doc(ctx.firestore(),'nij_counters/sentinel'))).data().value,41));
        });
        // Same Rules on another isolated project prove anonymous production rejection.
        const otherProject='demo-sipapua-guest-production-denial';
        const otherEnv=await initializeTestEnvironment({projectId:otherProject,firestore:{host:'127.0.0.1',port,rules:proposal}});
        try {
            await check('anonymous identity outside approved demo project denied',()=>assertFails(setDoc(doc(otherEnv.authenticatedContext('guest',{firebase:{sign_in_provider:'anonymous'}}).firestore(),'chats/new'),message)));
        } finally {await otherEnv.cleanup();}
        console.log('RESULT '+passed+' PASS, 0 FAIL; proposal not adopted.');
    } finally {
        if (env) await env.cleanup();
        child.kill(); // Stop only the child created by this test; no emulator reset.
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
