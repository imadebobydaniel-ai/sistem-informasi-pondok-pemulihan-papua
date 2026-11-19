const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const root=require('node:path').resolve(__dirname,'../..');
const read=f=>fs.readFileSync(root+'/'+f,'utf8');
const inline=f=>[...read(f).matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).filter(s=>s.trim());
function node(){return {children:[],style:{},value:'',disabled:false,textContent:'',appendChild(n){this.children.push(n)},replaceChildren(){this.children=[]},classList:{toggle(){}}};}
function harness({user={uid:'auth-guest',isAnonymous:false},config,hostname='127.0.0.1',gate=true}={}){
 const elements={},writes=[],queries=[];let anon=0,initialized=0;
 const auth={currentUser:user,useEmulator(){},onAuthStateChanged(fn){queueMicrotask(()=>fn(auth.currentUser));return ()=>{}},async signInAnonymously(){anon++;auth.currentUser={uid:'emulator-guest',isAnonymous:true}}};
 const query={where(...args){queries.push(args);return this},orderBy(){return this},onSnapshot(fn){fn({forEach(cb){cb({data:()=>({sender:'customer',message:'<img onerror=evil()>'})})}});return ()=>{}},async add(data){writes.push(data)}};
 const db={collection(){return query},useEmulator(){}};
 const firebase={apps:[],initializeApp(c){initialized++;firebase.apps.push({options:c})},app(){return firebase.apps[0]},auth:()=>auth,firestore:()=>db};firebase.firestore.FieldValue={serverTimestamp:()=>123};
 const context={window:null,location:{hostname,search:'?seller_uid=seller&customer_id=legacy-local-id'},URL,URLSearchParams,console,Promise,
 document:{getElementById(id){return elements[id]??=node()},createElement:node},firebase,
 SIPAPUA_APP_CHECK:{prepare(){if(!gate)throw Error('App Check belum dikonfigurasi.');return async()=>{}}},SIPAPUA_GUEST_CHAT_TEST:config};context.window=context;
 vm.createContext(context);const run=()=>vm.runInContext(inline('chat-umkm.html')[0],context);
 return {context,elements,writes,queries,auth,run,get anonymousCalls(){return anon},get initialized(){return initialized}};
}
const settle=()=>new Promise(r=>setImmediate(r));
test('all changed page inline scripts parse',()=>{for(const f of ['chat-umkm.html','chat-dashboard-umkm.html','dashboard-umkm.html'])for(const s of inline(f))new vm.Script(s,{filename:f})});
test('customer writes Auth UID, flags, actual input and safe nodes',async()=>{
 const h=harness();h.run();await settle();h.elements['msg-input'].value='Hello';await h.context.kirimPesan();
 assert.equal(h.writes[0].customer_id,'auth-guest');assert.equal(h.writes[0].is_read,false);assert.equal(h.writes[0].deleted_by_seller,false);
 assert.equal(h.elements['chat-box'].children[0].children[0].textContent,'<img onerror=evil()>');
 assert.ok(h.queries.some(q=>q[0]==='customer_id'&&q[2]==='auth-guest'));assert.ok(!h.queries.some(q=>q.includes('legacy-local-id')));
});
test('signed-out production path never signs in anonymously',async()=>{const h=harness({user:null,hostname:'example.github.io'});h.run();await settle();assert.equal(h.anonymousCalls,0);assert.equal(h.elements['msg-input'].disabled,true)});
test('valid explicit localhost demo configuration permits anonymous test support',async()=>{const h=harness({user:null,config:{projectId:'demo-sipapua-guest-chat-closeout',allowAnonymous:true,authPort:19099,firestorePort:18080}});h.run();await settle();assert.equal(h.anonymousCalls,1)});
test('invalid test config fails before Firebase initialization',()=>{for(const cfg of [{projectId:'production',allowAnonymous:true,authPort:9099,firestorePort:8080},{projectId:'demo-sipapua-guest-chat-closeout',allowAnonymous:true,authPort:0,firestorePort:8080}]){const h=harness({config:cfg});assert.throws(h.run);assert.equal(h.initialized,0)}});
test('test configuration rejected on hosting domain',()=>{const h=harness({hostname:'example.github.io',config:{projectId:'demo-sipapua-guest-chat-closeout',allowAnonymous:true,authPort:9099,firestorePort:8080}});assert.throws(h.run);assert.equal(h.initialized,0)});
test('App Check failure leaves input disabled, no writes or anonymous sign in',async()=>{const h=harness({user:null,gate:false,config:{projectId:'demo-sipapua-guest-chat-closeout',allowAnonymous:true,authPort:9099,firestorePort:8080}});h.run();await settle();assert.equal(h.anonymousCalls,0);assert.equal(h.writes.length,0);assert.equal(h.elements['msg-input'].disabled,true)});
test('signed-out or changed identity cannot send',async()=>{const h=harness();h.run();await settle();h.elements['msg-input'].value='Hello';h.auth.currentUser=null;await h.context.kirimPesan();assert.equal(h.writes.length,0)});
test('seller renderers use safe text and retain seller authorization filters',()=>{const s=inline('chat-dashboard-umkm.html')[0];assert.ok(!s.includes('innerHTML'));assert.match(s,/name.textContent/);assert.match(s,/bubble.textContent/);assert.match(s,/where\("seller_uid", "==", myId\)/);assert.ok(!s.includes('.where("deleted_by_seller", "==", false)'));assert.match(s,/data.deleted_by_seller === true/);assert.match(s,/is_read: false,/);assert.match(read('dashboard-umkm.html'),/data.customer_id && data.deleted_by_seller !== true/)});
test('no legacy-ID claim, local storage or client ledger write',()=>{const s=inline('chat-umkm.html')[0];assert.ok(!/localStorage|nij_|customer_id.*params.get|update\(|\.set\(/.test(s));assert.match(s,/customer_id: user.uid/)});

test('seller DOM renderer keeps legacy text inert and checkbox identity literal',()=>{
 const elements={},callbacks=[];
 const auth={currentUser:{uid:'seller'},onAuthStateChanged(fn){callbacks.push(fn)}};
 const firebase={apps:[{}],auth:()=>auth,firestore:()=>({})};
 const context={firebase,document:{getElementById(id){return elements[id]??=node()},createElement:node},console,setTimeout,window:{location:{}},confirm:()=>false};
 vm.createContext(context);vm.runInContext(inline('chat-dashboard-umkm.html')[0],context);
 const hostile="<img src=x onerror=alert(1)>";
 context.renderUserItem({customer_id:"legacy' onclick='evil()",customer_name:hostile,message:hostile});
 const item=elements['list-container'].children[0];
 assert.equal(item.children[0].value,"legacy' onclick='evil()");
 const info=item.children[1].children[1];assert.equal(info.children[0].textContent,hostile);assert.equal(info.children[1].textContent,hostile);
 assert.equal(typeof item.children[1].onclick,'function');
});
