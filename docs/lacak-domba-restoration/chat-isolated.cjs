'use strict';
// Fresh loopback Firestore emulator only. All identities/messages are synthetic.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const {initializeTestEnvironment}=require('@firebase/rules-unit-testing'),s=require('firebase/firestore');s.setLogLevel('silent');
const pause=ms=>new Promise(r=>setTimeout(r,ms)),project='demo-sipapua-lacak-chat-restore';
async function main(){
  const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'sipapua-lacak-chat-'));
  const log=fs.openSync(path.join(__dirname,'chat-emulator.log'),'a');
  const child=spawn('java',['-jar',path.join(os.homedir(),'.cache/firebase/emulators/cloud-firestore-emulator-v1.22.0.jar'),'--host','127.0.0.1','--port',String(port),'--webchannel_port','0','--websocket_port','0','--project_id',project],{cwd:temporary,windowsHide:true,stdio:['ignore',log,log]});
  let env;const result={passed:0,failed:0,productionMessages:0,productionWrites:0,cases:[]};
  async function check(name,fn){try{await fn();result.passed++;result.cases.push({name,pass:true});}catch(e){result.failed++;result.cases.push({name,pass:false,errorCode:e.code||'ASSERTION'});}}
  async function denied(fn){let rejected=false;try{await fn();}catch(e){assert.equal(e.code,'permission-denied');rejected=true;}assert.equal(rejected,true);}
  try{
    let ready=false;for(let i=0;i<100;i++){try{const r=await fetch('http://127.0.0.1:'+port+'/',{signal:AbortSignal.timeout(300)});await r.body?.cancel();if([200,404].includes(r.status)){ready=true;break;}}catch{}await pause(250);}assert.ok(ready);
    env=await initializeTestEnvironment({projectId:project,firestore:{host:'127.0.0.1',port,rules:fs.readFileSync(path.join(__dirname,'firebase.production.rules'),'utf8')}});
    const seed=(p,d)=>env.withSecurityRulesDisabled(c=>s.setDoc(s.doc(c.firestore(),p),d));
    const remove=p=>env.withSecurityRulesDisabled(c=>s.deleteDoc(s.doc(c.firestore(),p)));
    const db=(uid,verified=true)=>env.authenticatedContext(uid,{email:uid+'@example.test',email_verified:verified,firebase:{sign_in_provider:'password'}}).firestore();
    const a=db('alice'),b=db('bob'),c=db('carol');
    for(const uid of ['alice','bob','carol'])await seed('users/'+uid,{uid,status_akun:'Aktif'});
    await seed('mutual_chats/alice_bob',{members:['alice','bob'],createdAt:s.Timestamp.now(),lastMessageAt:s.Timestamp.now()});
    await seed('mutual_chats/alice_bob/messages/history',{senderUid:'alice',text:'Synthetic fixture only',createdAt:s.Timestamp.now()});
    const ref=d=>s.doc(d,'mutual_chats/alice_bob/messages/history');
    await check('non-friends cannot read private chat',()=>denied(()=>s.getDocFromServer(ref(a))));
    await seed('contacts/alice/friends/bob',{status:'accepted'});
    await check('one-sided contact cannot read private chat',()=>denied(()=>s.getDocFromServer(ref(a))));
    await seed('contacts/bob/friends/alice',{status:'accepted'});
    await seed('friend_requests/alice_bob',{fromUid:'alice',toUid:'bob',status:'pending'});
    await check('pending pair request cannot read private chat',()=>denied(()=>s.getDocFromServer(ref(a))));
    await seed('friend_requests/alice_bob',{fromUid:'alice',toUid:'bob',status:'accepted'});
    await check('mutual accepted verified active friends can read both sides',async()=>{assert.ok((await s.getDocFromServer(ref(a))).exists());assert.ok((await s.getDocFromServer(ref(b))).exists());});
    await check('synthetic existing frontend message batch uses own sender and server timestamp',async()=>{const batch=s.writeBatch(a);batch.update(s.doc(a,'mutual_chats/alice_bob'),{lastMessageAt:s.serverTimestamp()});batch.set(s.doc(a,'mutual_chats/alice_bob/messages/synthetic-new'),{senderUid:'alice',text:'Synthetic local message',createdAt:s.serverTimestamp()});await batch.commit();});
    await check('forged sender is denied',()=>denied(()=>s.setDoc(s.doc(a,'mutual_chats/alice_bob/messages/forged'),{senderUid:'bob',text:'Synthetic',createdAt:s.serverTimestamp()})));
    await check('outsider cannot read the pair',()=>denied(()=>s.getDocFromServer(ref(c))));
    await check('conversation enumeration is denied',()=>denied(()=>s.getDocs(s.collection(a,'mutual_chats'))));
    await check('unverified active account remains denied by existing chat policy',()=>denied(()=>s.getDocFromServer(ref(db('alice',false)))));
    await seed('user_blocks/bob/blocked/alice',{createdAt:s.Timestamp.now()});
    await check('reverse block immediately prevents both sides reading',async()=>{await denied(()=>s.getDocFromServer(ref(a)));await denied(()=>s.getDocFromServer(ref(b)));});
    await check('reverse block immediately prevents sending',()=>denied(()=>s.setDoc(s.doc(a,'mutual_chats/alice_bob/messages/blocked'),{senderUid:'alice',text:'Synthetic',createdAt:s.serverTimestamp()})));
    await remove('user_blocks/bob/blocked/alice');await remove('contacts/bob/friends/alice');
    await check('friend removal revokes read but preserves stored history',async()=>{await denied(()=>s.getDocFromServer(ref(a)));await env.withSecurityRulesDisabled(async ctx=>assert.ok((await s.getDoc(s.doc(ctx.firestore(),'mutual_chats/alice_bob/messages/history'))).exists()));});
    await seed('contacts/bob/friends/alice',{status:'accepted'});
    await check('message edits and deletes are denied',async()=>{await denied(()=>s.updateDoc(ref(a),{text:'changed'}));await denied(()=>s.deleteDoc(ref(a)));});
    await seed('users/alice',{uid:'alice',status_akun:'Pending'});
    await check('inactive profile loses chat access',()=>denied(()=>s.getDocFromServer(ref(a))));
  }finally{if(env)await env.cleanup();child.kill();fs.closeSync(log);fs.writeFileSync(path.join(__dirname,'CHAT-ISOLATED-RESULT.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
  if(result.failed)process.exitCode=1;
}
main().catch(()=>{console.log('ISOLATED_CHAT_CHECK_BLOCKED_NO_PRODUCTION_MESSAGES');process.exitCode=1;});
