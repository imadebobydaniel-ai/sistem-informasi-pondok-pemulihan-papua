"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const { execFileSync } = require("node:child_process");
const { createFirebaseIdTokenVerifier } = require("./firebase-jwt-verifier.cjs");
const { createScheduleServer, createPsqlExecutor, hmac } = require("./server.cjs");

const PROJECT = "demo-sipapua-schedule";
const NOW = Math.floor(Date.now() / 1000);
const pairs = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...pairs.publicKey.export({ format: "jwk" }), kid: "local-test-key", use: "sig", alg: "RS256", key_ops: ["verify"] };
const verifyTestToken = createFirebaseIdTokenVerifier({ projectId: PROJECT, getTrustedKey: async kid => kid === "local-test-key" ? jwk : null, clock: () => NOW });
const HMAC_SECRET = process.env.SCHEDULE_TEST_HMAC || "";
const DB_PORT = Number(process.env.SCHEDULE_TEST_PG_PORT);
const PSQL = process.env.SCHEDULE_TEST_PSQL;
const ADMIN = "synthetic-active-admin";
const MASTER = "synthetic-active-master";
const INACTIVE = "synthetic-inactive-admin";
const MEMBER = "synthetic-member";
const DENIED = "synthetic-unauthorized";
const ids = {
  venue: "10000000-0000-4000-8000-000000000001",
  venue2: "10000000-0000-4000-8000-000000000002",
  venue3: "10000000-0000-4000-8000-000000000003",
  pastor1: "20000000-0000-4000-8000-000000000001",
  pastor2: "20000000-0000-4000-8000-000000000002",
  pastor3: "20000000-0000-4000-8000-000000000003",
  pastor4: "20000000-0000-4000-8000-000000000004",
  officer: "20000000-0000-4000-8000-000000000005",
  a: "30000000-0000-4000-8000-000000000001",
  b: "30000000-0000-4000-8000-000000000002",
  c: "30000000-0000-4000-8000-000000000003",
  d: "30000000-0000-4000-8000-000000000004",
  e: "30000000-0000-4000-8000-000000000005"
};

function assertLocalPreconditions() {
  assert.match(HMAC_SECRET, /^[0-9a-f]{64}$/i);
  assert.ok(Number.isInteger(DB_PORT) && DB_PORT > 1024 && DB_PORT < 65536);
  assert.ok(PSQL && PSQL.toLowerCase().endsWith("psql.exe"));
}

function token(uid, extra = {}, signingKey = pairs.privateKey) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "local-test-key" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: uid,
    iat: NOW - 20, auth_time: NOW - 40, exp: NOW + 1800, ...extra })).toString("base64url");
  const content = `${header}.${payload}`;
  return `${content}.${crypto.sign("RSA-SHA256", Buffer.from(content), signingKey).toString("base64url")}`;
}

function rawPsql(user, input) {
  return execFileSync(PSQL,["-X","-qAt","--set=ON_ERROR_STOP=1","--set=VERBOSITY=verbose","-h","127.0.0.1","-p",String(DB_PORT),"-U",user,"-d","sipapua_schedule_local"],{
    input,encoding:"utf8",timeout:6000,windowsHide:true,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,TEMP:process.env.TEMP,TMP:process.env.TMP}
  }).trim();
}

function request(origin, path, bearer, body) {
  const target = new URL(path, origin);
  assert.equal(target.hostname,"127.0.0.1"); assert.equal(target.origin,origin); assert.equal(target.protocol,"http:");
  return new Promise((resolve,reject) => {
    const req = http.request(target,{method:body === undefined ? "GET" : "POST",headers:{...(bearer ? {authorization:`Bearer ${bearer}`} : {}),...(body === undefined ? {} : {"content-type":"application/json",origin})},timeout:5000},res=>{
      const chunks=[]; res.on("data",x=>chunks.push(x)); res.on("end",()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString("utf8"))}));
    });
    req.on("error",reject); req.on("timeout",()=>req.destroy(new Error("Local API timeout"))); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function schedule(id, overrides = {}) {
  return { id, area:"ABE", category:"sunday-worship", title:"Synthetic worship", date:"2026-12-06", startTime:"09:00", endTime:"10:00",
    venueId:ids.venue, leaderId:ids.pastor1, officers:[{personId:ids.officer,role:"Musik"}], theme:"Pengharapan dalam Kristus", scripture:"John 1:1", publicNotes:"Public synthetic note", internalNotes:"internal-test-only", ...overrides };
}

function makeServer() {
  const directory = new Map([
    [ADMIN,{found:true,status:"active",role:"super_admin"}],
    [MASTER,{found:true,status:"active",role:"master"}],
    [INACTIVE,{found:true,status:"inactive",role:"master"}],
    [MEMBER,{found:true,status:"active",role:"member"}],
    [DENIED,{found:true,status:"active",role:"viewer"}]
  ]);
  return createScheduleServer({
    hmacSecret:HMAC_SECRET,
    async verifyFirebaseIdToken(raw) { return verifyTestToken(raw); },
    async readAdminRecord(uid) { return directory.get(uid) || {found:false}; },
    async readMemberAccount(uid) { return directory.get(uid) || {found:false}; },
    executeSql:createPsqlExecutor({binary:PSQL,port:DB_PORT})
  });
}

test("local PostgreSQL trusted schedule API acceptance",{timeout:45000},async t=>{
  assertLocalPreconditions();
  const server=makeServer();
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const tok={admin:token(ADMIN),master:token(MASTER),inactive:token(INACTIVE),member:token(MEMBER),denied:token(DENIED),invalid:token(ADMIN,{},crypto.generateKeyPairSync("rsa",{modulusLength:2048}).privateKey)};
  let publishedAt;

  await t.test("01 active Master and SuperAdmin allowed; inactive, member, viewer and invalid token denied",async()=>{
    assert.equal((await request(origin,"/api/admin/session",tok.admin)).body.data.role,"super_admin");
    assert.equal((await request(origin,"/api/admin/session",tok.master)).body.data.role,"master");
    assert.equal((await request(origin,"/api/admin/schedules",tok.master)).status,200);
    assert.equal((await request(origin,"/api/member/session",tok.member)).body.data.role,"member");
    assert.equal((await request(origin,"/api/admin/schedules",tok.admin)).status,200);
    assert.equal((await request(origin,"/api/admin/session",tok.inactive)).status,403);
    assert.equal((await request(origin,"/api/admin/session",tok.member)).status,403);
    assert.equal((await request(origin,"/api/admin/schedules",tok.inactive)).status,403);
    assert.equal((await request(origin,"/api/admin/schedules",tok.member)).status,403);
    assert.equal((await request(origin,"/api/admin/schedules",tok.denied)).status,403);
    assert.equal((await request(origin,"/api/admin/schedules",tok.invalid)).status,401);
    assert.equal((await request(origin,"/api/admin/schedules",null)).status,401);
  });

  await t.test("02 create and revise a draft; stale revision and client-forged actor rejected",async()=>{
    const noTheme=await request(origin,"/api/admin/drafts",tok.admin,{schedule:schedule(ids.b,{theme:"   "}),expectedRevision:0,operationId:"40000000-0000-4000-8000-000000000099"});
    assert.equal(noTheme.status,400);
    let r=await request(origin,"/api/admin/drafts",tok.admin,{schedule:schedule(ids.a),expectedRevision:0,operationId:"40000000-0000-4000-8000-000000000001"});
    assert.equal(r.status,200); assert.equal(r.body.data.revision,1); assert.equal(r.body.data.status,"draft");
    r=await request(origin,"/api/admin/drafts",tok.admin,{schedule:schedule(ids.a,{title:"Edited synthetic draft",leaderId:ids.pastor2}),expectedRevision:1,operationId:"40000000-0000-4000-8000-000000000002"});
    assert.equal(r.status,200); assert.equal(r.body.data.revision,2);
    assert.equal((await request(origin,"/api/admin/drafts",tok.admin,{schedule:schedule(ids.a),expectedRevision:1,operationId:"40000000-0000-4000-8000-000000000003"})).status,409);
    assert.equal((await request(origin,"/api/admin/drafts",tok.admin,{actorUid:ADMIN,actorRole:"master",schedule:schedule(ids.b),expectedRevision:0,operationId:"40000000-0000-4000-8000-000000000004"})).status,400);
    assert.equal((await request(origin,"/api/admin/schedules",tok.admin)).body.data.some(row=>row.id===ids.b),false);
  });

  await t.test("03 member reads no draft or internal fields",async()=>{
    const r=await request(origin,"/api/member/schedules",tok.member);
    assert.equal(r.status,200); assert.deepEqual(r.body.data,[]);
    assert.equal((await request(origin,"/api/member/schedules",tok.inactive)).status,403);
  });

  await t.test("04 authorized publish is atomic, audited and idempotent",async()=>{
    const op="50000000-0000-4000-8000-000000000001";
    const body={scheduleId:ids.a,expectedRevision:2,operationId:op};
    const first=await request(origin,"/api/admin/publish",tok.admin,body);
    assert.equal(first.status,200); assert.equal(first.body.data.status,"published"); assert.equal(first.body.data.revision,3); publishedAt=first.body.data.publishedAt;
    const replay=await request(origin,"/api/admin/publish",tok.admin,body);
    assert.equal(replay.status,200); assert.equal(replay.body.data.replayed,true);
    const list=await request(origin,"/api/admin/audit?scheduleId="+ids.a,tok.admin);
    assert.equal(list.status,200); assert.deepEqual(list.body.data.map(x=>x.action),["create_draft","edit_draft","publish"]);
    assert.equal(list.body.data.length,3);
    const revision={schedule:schedule(ids.a,{title:"Published revision",leaderId:ids.pastor2}),expectedRevision:3,operationId:"40000000-0000-4000-8000-000000000041"};
    const revised=await request(origin,"/api/admin/drafts",tok.admin,revision);
    assert.equal(revised.status,200); assert.equal(revised.body.data.status,"published"); assert.equal(revised.body.data.revision,4); assert.equal(revised.body.data.publishedAt,publishedAt);
    const revisionReplay=await request(origin,"/api/admin/drafts",tok.admin,revision);
    assert.equal(revisionReplay.status,200); assert.equal(revisionReplay.body.data.replayed,true);
    const revisedAudit=await request(origin,"/api/admin/audit?scheduleId="+ids.a,tok.admin);
    assert.deepEqual(revisedAudit.body.data.map(x=>x.action),["create_draft","edit_draft","publish","revise_published"]);
  });

  await t.test("05 member sees published projection only; area/date contract is public-safe",async()=>{
    const r=await request(origin,"/api/member/schedules?area=abepura&category=sunday-worship&from=2026-12-06&to=2026-12-06",tok.member);
    assert.equal(r.status,200); assert.equal(r.body.data.length,1);
    const row=r.body.data[0]; assert.deepEqual([row.area,row.date,row.startTime,row.status,row.leader],["abepura","2026-12-06","09:00","published","Synthetic Pastor Two"]);
    for(const key of ["internal_notes","actorUid","actorRole","audit","revision","leaderId","venueId"]) assert.equal(Object.hasOwn(row,key),false);
    assert.equal(JSON.stringify(row).includes("internal-test-only"),false);
    assert.equal((await request(origin,"/api/member/schedules?area=unknown",tok.member)).status,400);
  });

  await t.test("06 venue and pastor conflicts reject across different areas",async()=>{
    const venueSchedule=schedule(ids.b,{area:"ARS2",venueId:ids.venue,leaderId:ids.pastor3,officers:[]});
    assert.equal((await request(origin,"/api/admin/drafts",tok.admin,{schedule:venueSchedule,expectedRevision:0,operationId:"40000000-0000-4000-8000-000000000011"})).status,200);
    assert.equal((await request(origin,"/api/admin/publish",tok.admin,{scheduleId:ids.b,expectedRevision:1,operationId:"50000000-0000-4000-8000-000000000011"})).status,409);
    const pastorSchedule=schedule(ids.c,{area:"DYO",venueId:ids.venue2,leaderId:ids.pastor2,officers:[]});
    assert.equal((await request(origin,"/api/admin/drafts",tok.admin,{schedule:pastorSchedule,expectedRevision:0,operationId:"40000000-0000-4000-8000-000000000012"})).status,200);
    assert.equal((await request(origin,"/api/admin/publish",tok.admin,{scheduleId:ids.c,expectedRevision:1,operationId:"50000000-0000-4000-8000-000000000012"})).status,409);
    assert.deepEqual((await request(origin,"/api/member/schedules",tok.member)).body.data.map(x=>x.id),[ids.a]);
  });

  await t.test("07 concurrent conflicting publications admit one winner",async()=>{
    for(const [id,op] of [[ids.d,"21"],[ids.e,"22"]]) {
      assert.equal((await request(origin,"/api/admin/drafts",tok.admin,{schedule:schedule(id,{area:id===ids.d?"STN":"ARS1",venueId:ids.venue3,leaderId:id===ids.d?ids.pastor3:ids.pastor4,officers:[]}),expectedRevision:0,operationId:`40000000-0000-4000-8000-0000000000${op}`})).status,200);
    }
    const results=await Promise.all([ids.d,ids.e].map((id,i)=>request(origin,"/api/admin/publish",tok.admin,{scheduleId:id,expectedRevision:1,operationId:`50000000-0000-4000-8000-0000000000${i+21}`})));
    assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);
    assert.equal((await request(origin,"/api/member/schedules",tok.member)).body.data.filter(x=>x.venue==="Synthetic Venue Three").length,1);
  });

  await t.test("08 failed publication rolls back occurrence, projection, reservations and audit",async()=>{
    const rollbackId="30000000-0000-4000-8000-000000000006";
    assert.equal((await request(origin,"/api/admin/drafts",tok.admin,{schedule:schedule(rollbackId,{date:"2026-12-13",venueId:ids.venue2,leaderId:ids.officer,officers:[]}),expectedRevision:0,operationId:"40000000-0000-4000-8000-000000000031"})).status,200);
    const triggerSql=`CREATE FUNCTION sipapua_schedule.test_fail_audit() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN IF NEW.occurrence_id='${rollbackId}'::uuid AND NEW.action='publish' THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='injected_local_failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_fail_audit BEFORE INSERT ON sipapua_schedule.audit FOR EACH ROW EXECUTE FUNCTION sipapua_schedule.test_fail_audit();`;
    rawPsql("postgres",triggerSql);
    const failed=await request(origin,"/api/admin/publish",tok.admin,{scheduleId:rollbackId,expectedRevision:1,operationId:"50000000-0000-4000-8000-000000000031"});
    assert.equal(failed.status,503);
    const adminRows=(await request(origin,"/api/admin/schedules",tok.admin)).body.data;
    assert.equal(adminRows.find(x=>x.id===rollbackId).status,"draft");
    assert.equal(adminRows.find(x=>x.id===rollbackId).revision,1);
    assert.equal((await request(origin,"/api/member/schedules",tok.member)).body.data.some(x=>x.id===rollbackId),false);
    const counts=JSON.parse(rawPsql("postgres",`SELECT jsonb_build_object('reservations',(SELECT count(*) FROM sipapua_schedule.reservations WHERE occurrence_id='${rollbackId}'::uuid),'audit',(SELECT count(*) FROM sipapua_schedule.audit WHERE occurrence_id='${rollbackId}'::uuid),'projection',(SELECT count(*) FROM sipapua_schedule.member_projection WHERE id='${rollbackId}'::uuid))::text;`));
    assert.deepEqual(counts,{reservations:0,audit:1,projection:0});
  });

  await t.test("09 cancellation keeps first published timestamp and publishes cancellation",async()=>{
    const canceled=await request(origin,"/api/admin/cancel",tok.admin,{scheduleId:ids.a,expectedRevision:4,operationId:"60000000-0000-4000-8000-000000000001"});
    assert.equal(canceled.status,200); assert.equal(canceled.body.data.status,"cancelled"); assert.equal(canceled.body.data.publishedAt,publishedAt); assert.equal(canceled.body.data.revision,5);
    const row=(await request(origin,"/api/member/schedules",tok.member)).body.data.find(x=>x.id===ids.a);
    assert.equal(row.status,"cancelled"); assert.equal(row.publishedAt,publishedAt);
    const audit=(await request(origin,"/api/admin/audit?scheduleId="+ids.a,tok.admin)).body.data;
    assert.equal(audit.at(-1).action,"cancel"); assert.equal(audit.at(-1).revision,5);
  });

  await t.test("10 runtime has no direct table access or data-modification privilege",async()=>{
    assert.throws(()=>rawPsql("schedule_runtime","SELECT count(*) FROM sipapua_schedule.occurrences;"));
    assert.throws(()=>rawPsql("schedule_runtime",`INSERT INTO sipapua_schedule.occurrences(id,revision,status,area,category,title,service_date,start_time,end_time,venue_id,leader_id) VALUES('${ids.e}',1,'draft','ABE','sunday-worship','forged','2026-12-06','09:00','10:00','${ids.venue}','${ids.pastor1}');`));
    const forged={actorUid:ADMIN,actorRole:"super_admin",operationId:"70000000-0000-4000-8000-000000000001",actorMac:"bad",action:"publish",scheduleId:ids.a,expectedRevision:4};
    const b64=Buffer.from(JSON.stringify(forged)).toString("base64");
    assert.throws(()=>rawPsql("schedule_runtime",`\\set payload_b64 ${b64}\nSELECT sipapua_schedule.api_cancel(convert_from(decode(:'payload_b64','base64'),'UTF8')::jsonb);`));
  });

  await t.test("11 all five ministry areas map to member contract; non-Sunday category is preserved",async()=>{
    const areas=[["ABE","abepura"],["STN","sentani"],["DYO","doyo"],["ARS1","arso-1"],["ARS2","arso-2"]];
    for(let i=0;i<areas.length;i++){
      const [area,publicArea]=areas[i];
      const suffix=String(i+101).padStart(12,"0");
      const id=`30000000-0000-4000-8000-${suffix}`;
      const date=`2027-01-${String(3+i*7).padStart(2,"0")}`;
      const item=schedule(id,{area,date,category:i===4?"other-ministry":"sunday-worship",venueId:ids.venue2,leaderId:ids.pastor3,officers:[]});
      assert.equal((await request(origin,"/api/admin/drafts",tok.master,{schedule:item,expectedRevision:0,operationId:`40000000-0000-4000-8000-${suffix}`})).status,200);
      assert.equal((await request(origin,"/api/admin/publish",tok.master,{scheduleId:id,expectedRevision:1,operationId:`50000000-0000-4000-8000-${suffix}`})).status,200);
      const publicRows=(await request(origin,`/api/member/schedules?area=${publicArea}`,tok.member)).body.data;
      const row=publicRows.find(candidate=>candidate.id===id);
      assert.equal(row.area,publicArea);
      assert.equal(row.category,i===4?"other-ministry":"sunday-worship");
    }
  });
});
