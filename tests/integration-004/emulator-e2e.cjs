'use strict';
// New Auth/Firestore/Functions processes only; never candidate/existing endpoints.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn,execFileSync}=require('node:child_process'),{createRequire}=require('node:module');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),project='demo-sipapua-integration004';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let passed=0;
async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
async function run(){
    const cli=process.env.SIPAPUA_FIREBASE_CLI||path.join(os.homedir(),'AppData/Roaming/npm/node_modules/firebase-tools/lib/bin/firebase.js');
    const node=process.env.SIPAPUA_NODE22||path.resolve(root,'../SIPAPUA-REG-INTEGRATION-CANDIDATE/.manual-assets/node22/node-v22.23.3-win-x64/node.exe');
    assert.ok(fs.existsSync(cli)&&fs.existsSync(node),'Local CLI and Node 22 required; no installation/download fallback');
    assert.match(execFileSync(node,['--version'],{encoding:'utf8'}),/^v22\./);
    // Keep config on the source drive: Firebase CLI joins source paths instead
    // of accepting a Windows absolute path on a different drive.
    const temporary=fs.mkdtempSync(path.join(__dirname,'_runtime-'));
    const ports={},reservations=[];
    for(const name of ['auth','firestore','functions','hub','logging','eventarc','tasks','websocket']){
        const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});ports[name]=server.address().port;reservations.push(server);
    }
    const config={functions:{source:path.relative(temporary,path.join(root,'functions')).replace(/\\/g,'/'),runtime:'nodejs22'},firestore:{rules:path.join(root,'docs/integration-004/firestore.final-proposed.rules')},emulators:{ui:{enabled:false},singleProjectMode:true}};
    for(const [name,port]of Object.entries(ports))if(name!=='websocket')config.emulators[name]={host:'127.0.0.1',port};
    config.emulators.firestore.websocketPort=ports.websocket;
    fs.writeFileSync(path.join(temporary,'firebase.json'),JSON.stringify(config));
    const environment={};
    for(const key of ['SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','JAVA_HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP'])if(process.env[key])environment[key]=process.env[key];
    environment.PATH=path.dirname(node)+path.delimiter+process.env.PATH;
    Object.assign(environment,{CI:'true',FIREBASE_CLI_DISABLE_UPDATE_CHECK:'true',XDG_CONFIG_HOME:path.join(temporary,'config'),GCLOUD_PROJECT:project,GOOGLE_CLOUD_PROJECT:project,METADATA_SERVER_DETECTION:'none',FUNCTIONS_DISCOVERY_TIMEOUT:'60'});
    for(const server of reservations)await new Promise(resolve=>server.close(resolve));
    const child=spawn(node,[cli,'emulators:start','--project',project,'--config',path.join(temporary,'firebase.json'),'--only','auth,firestore,functions','--non-interactive'],{cwd:temporary,env:environment,windowsHide:true,stdio:['ignore','pipe','pipe']});
    fs.writeFileSync(path.join(temporary,'owned-process.json'),JSON.stringify({runnerPid:process.pid,cliPid:child.pid,ports,project}));
    let log='',startupError;child.on('error',e=>{startupError=e;});
    for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{log=(log+bytes).slice(-40000);});
    let db,app,deleteApp;
    try{
        let ready=false;
        for(let i=0;i<240;i++){
            if(startupError)throw startupError;
            if(child.exitCode!==null)throw Error('Isolated emulator startup failed: '+log);
            if(log.includes('Failed to load function definition'))throw Error('Functions definition failed: '+log);
            if(log.includes('All emulators ready')&&log.includes('registrationReadiness')){ready=true;break;}
            await wait(500);
        }
        assert.ok(ready,'Emulator startup timed out: '+log);
        const local=createRequire(path.join(root,'functions/package.json'));
        process.env.GCLOUD_PROJECT=project;process.env.GOOGLE_CLOUD_PROJECT=project;process.env.METADATA_SERVER_DETECTION='none';
        process.env.FIRESTORE_EMULATOR_HOST='127.0.0.1:'+ports.firestore;
        process.env.FIREBASE_AUTH_EMULATOR_HOST='127.0.0.1:'+ports.auth;
        const sdk=local('firebase-admin/app');deleteApp=sdk.deleteApp;app=sdk.initializeApp({projectId:project},'integration004-e2e');
        db=local('firebase-admin/firestore').getFirestore(app);db.settings({host:'127.0.0.1:'+ports.firestore,ssl:false});
        const origins=new Set(Object.values(ports).map(port=>'http://127.0.0.1:'+port));
        async function json(url,data,token,method='POST'){
            const u=new URL(url);assert.ok(origins.has(u.origin));assert.equal(u.hostname,'127.0.0.1');
            const response=await fetch(url,{method,redirect:'error',headers:{'content-type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(data===undefined?{}:{body:JSON.stringify(data)}),signal:AbortSignal.timeout(30000)});
            const body=await response.text();
            try{return {status:response.status,data:JSON.parse(body)};}catch(_){throw Error('Non-JSON emulator response '+response.status+': '+body.slice(0,300));}
        }
        const auth=(action,data)=>json('http://127.0.0.1:'+ports.auth+'/identitytoolkit.googleapis.com/v1/accounts:'+action+'?key=demo-key',data);
        const call=(name,data,token)=>json('http://127.0.0.1:'+ports.functions+'/'+project+'/asia-southeast2/'+name,{data},token);
        const password='SyntheticOnly-42!',email='integration004-member@example.test';
        const created=await auth('signUp',{email,password,returnSecureToken:true});assert.equal(created.status,200);
        const uid=created.data.localId;let token=created.data.idToken;
        const input={uid,nama:'Synthetic Integration 004',email,email_normalized:email,whatsapp:'081234567890',whatsapp_normalized:'6281234567890',wilayah:'Abepura',status_akun:'Menunggu Verifikasi',provinsi:'Synthetic',kabupaten_kota:'Synthetic',kecamatan:'Synthetic',desa_kelurahan:'Synthetic',alamat_detail:'Synthetic',provinsi_lahir:'Synthetic',kota_lahir:'Synthetic',kecamatan_lahir:'Synthetic',desa_lahir:'Synthetic',tgl_lahir:'2000-01-01',jenis_kelamin:'Perempuan',status_pernikahan:'Single',pekerjaan:'Synthetic',komsel:'Synthetic',jabatan:'Anggota Jemaat',sub_jabatan:'Jemaat Simpatisan',pelayanan:'',detail_pelayanan:'',jumlah_anak:0,anak:[]};
        await db.doc('registration_control/state').set({enabled:true,maintenance:false,version:'original-spark-v1'});
        await db.doc('nij_counters/Abepura').set({last:0});
        const denied=(r,status)=>assert.equal(r.data.error?.status,status,JSON.stringify(r.data));
        let nij;
        await test('real readiness and anonymous registration rejection',async()=>{assert.equal((await call('registrationReadiness',{code:'ABE'})).data.result.ready,true);denied(await call('registerSIPAPUAProfile',{code:'ABE',input}),'UNAUTHENTICATED');});
        await test('main backend registers one NIJ atomically',async()=>{const r=await call('registerSIPAPUAProfile',{code:'ABE',input},token);assert.equal(r.status,200,JSON.stringify(r.data));nij=r.data.result.nij;assert.equal((await db.doc('nij_counters/Abepura').get()).data().last,1);assert.equal((await db.doc('nij_allocations/'+uid).get()).data().nij,nij);});
        await test('unverified activation denied; inactive login confirmed',async()=>{denied(await call('activateVerifiedSIPAPUAProfile',{},token),'FAILED_PRECONDITION');assert.equal((await call('memberLoginStatus',{},token)).data.result.active,false);});
        await test('genuine Auth emulator email action verifies email',async()=>{assert.equal((await auth('sendOobCode',{requestType:'VERIFY_EMAIL',idToken:token})).status,200);const list=await json('http://127.0.0.1:'+ports.auth+'/emulator/v1/projects/'+project+'/oobCodes',undefined,null,'GET');const code=list.data.oobCodes.find(c=>c.email===email);assert.ok(code);assert.equal((await auth('update',{oobCode:code.oobCode})).status,200);token=(await auth('signInWithPassword',{email,password,returnSecureToken:true})).data.idToken;});
        await test('verified login activates once and retries keep NIJ/audit',async()=>{for(const name of ['memberLoginStatus','activateVerifiedSIPAPUAProfile','memberLoginStatus'])assert.equal((await call(name,{},token)).data.result.active,true);const audits=await db.collection('registration_audit').where('targetUid','==',uid).get();assert.equal(audits.size,1);denied(await call('registerSIPAPUAProfile',{code:'ABE',input},token),'ALREADY_EXISTS');});
        await test('authorized edit/photo works; NIJ/status injection rejected',async()=>{const r=await call('updateSIPAPUAProfile',{docId:uid,changes:{nama:'Synthetic Edited',foto_profil:'data:image/jpeg;base64,AAAA'}},token);assert.equal(r.data.result.updated,true,JSON.stringify(r.data));denied(await call('updateSIPAPUAProfile',{docId:uid,changes:{nij:'forged'}},token),'INVALID_ARGUMENT');denied(await call('updateSIPAPUAProfile',{docId:uid,changes:{status_akun:'Pending'}},token),'FAILED_PRECONDITION');});
        await test('Rules deny anonymous profile and direct client counter/NIJ/status writes',async()=>{const url='http://127.0.0.1:'+ports.firestore+'/v1/projects/'+project+'/databases/(default)/documents/';assert.equal((await json(url+'users/'+uid,undefined,null,'GET')).status,403);const update={fields:{status_akun:{stringValue:'Pending'}}};assert.equal((await json(url+'users/'+uid+'?updateMask.fieldPaths=status_akun',update,token,'PATCH')).status,403);assert.equal((await json(url+'nij_counters/Abepura',{fields:{last:{integerValue:'0'}}},token,'PATCH')).status,403);});
        const legacyAuth=await auth('signUp',{email:'integration004-legacy@example.test',password,returnSecureToken:true});assert.equal(legacyAuth.status,200);
        const legacyUid=legacyAuth.data.localId,legacyToken=legacyAuth.data.idToken;
        await db.doc('users/'+legacyUid).set({uid:legacyUid,email:'integration004-legacy@example.test',status_akun:'Pending'});
        await test('manual override denied without permission; existing admin form contract works with audit',async()=>{denied(await call('adminActivateSIPAPUAProfile',{targetUid:legacyUid,identityVerified:true},token),'PERMISSION_DENIED');await db.doc('admin_users/'+uid).set({role:'master',status:'active',permissions:{canActivateMembers:true}});assert.equal((await call('adminActivateSIPAPUAProfile',{targetUid:legacyUid,identityVerified:true},token)).data.result.active,true);assert.equal((await call('memberLoginStatus',{},legacyToken)).data.result.active,true);const lookup=await auth('lookup',{idToken:legacyToken});assert.equal(lookup.data.users[0].emailVerified,false);assert.equal((await db.doc('nij_allocations/'+legacyUid).get()).exists,false);});
        await test('hard-delete backend preserves permanent ledger and counter',async()=>{assert.equal((await call('deleteSIPAPUAProfiles',{docIds:[uid]},token)).data.result.deleted,true);assert.equal((await db.doc('users/'+uid).get()).exists,false);assert.equal((await db.doc('nij_allocations/'+uid).get()).data().nij,nij);assert.equal((await db.doc('nij_counters/Abepura').get()).data().last,1);assert.equal((await db.doc('registration_unique/email_'+email).get()).exists,true);});
        await test('existing self-account deletion sequence removes Auth after profile, keeps ledger',async()=>{assert.equal((await auth('delete',{idToken:token})).status,200);assert.equal((await db.doc('nij_allocations/'+uid).get()).data().nij,nij);assert.equal((await db.doc('nij_counters/Abepura').get()).data().last,1);});
        console.log('RESULT '+passed+' real API emulator groups PASS. Own new demo processes only; no browser/production App Check pass claimed.');
    }finally{
        if(db)await db.terminate();if(app)await deleteApp(app);
        if(child.exitCode===null){if(process.platform==='win32')try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch(_){}else child.kill('SIGINT');}
    }
}
if(process.argv.includes('--cleanup-owned')){
    // Windows sandbox may deny taskkill in a failed earlier test run. Match only
    // this stage's temporary CLI configs, never candidate/stage4 emulators.
    const command="$owned = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*emulators:start*' -and $_.CommandLine -like '*integration-004\\_runtime-*' }; foreach ($item in $owned) { taskkill /PID $item.ProcessId /T /F }";
    execFileSync('powershell',['-NoProfile','-Command',command],{windowsHide:true,stdio:'inherit'});
}else run().then(()=>process.exit(0),e=>{console.error(e);process.exit(1);});
