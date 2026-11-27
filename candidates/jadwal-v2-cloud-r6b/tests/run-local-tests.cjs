"use strict";

// Local-only PostgreSQL 19 harness. Uses existing binaries and Node built-ins.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const pgBin = "C:\\Program Files\\PostgreSQL\\19\\bin";
const initdb = path.join(pgBin,"initdb.exe");
const pgCtl = path.join(pgBin,"pg_ctl.exe");
const psqlBin = path.join(pgBin,"psql.exe");
const root = path.resolve(__dirname,"..");
const schema = path.join(root,"schema.sql");
const tests = path.join(__dirname,"..","server.test.cjs");
const authTests = path.join(__dirname,"..","auth-adapters.test.cjs");
const tempRoot = path.resolve(os.tmpdir());
const sessionRoot = path.join(tempRoot,"sipapua-jadwal-sprint-"+crypto.randomUUID());
const dataDir = path.join(sessionRoot,"pgdata");
const logFile = path.join(sessionRoot,"postgres.log");
let port;
let started = false;

function minimalEnv(extra = {}) {
  const env = {};
  for (const key of ["PATH","SystemRoot","WINDIR","TEMP","TMP"]) if (process.env[key]) env[key]=process.env[key];
  return {...env,...extra};
}

function run(file,args,{input,env=minimalEnv(),timeout=30000,stdio="pipe"}={}) {
  const result=spawnSync(file,args,{input,encoding:"utf8",windowsHide:true,timeout,env,maxBuffer:4*1024*1024,stdio});
  if(result.error) throw result.error;
  if(result.stdout) process.stdout.write(result.stdout);
  if(result.stderr) process.stderr.write(result.stderr);
  if(result.status!==0) throw new Error(`${path.basename(file)} failed with exit ${result.status}.`);
  return result.stdout||"";
}

async function freeLoopbackPort() {
  const server=net.createServer();
  await new Promise((resolve,reject)=>server.once("error",reject).listen(0,"127.0.0.1",resolve));
  const selected=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  const check=net.createServer();
  await new Promise((resolve,reject)=>check.once("error",reject).listen(selected,"127.0.0.1",resolve));
  await new Promise(resolve=>check.close(resolve));
  return selected;
}

function runPsql(database,sql,extra={}) {
  const commandArgs=extra.args || (sql ? ["-c",sql] : []);
  return run(psqlBin,["-X","-v","ON_ERROR_STOP=1","-h","127.0.0.1","-p",String(port),"-U","postgres","-d",database,...commandArgs],{input:extra.input,timeout:30000});
}

async function assertPortReleased() {
  const check=net.createServer();
  await new Promise((resolve,reject)=>check.once("error",reject).listen(port,"127.0.0.1",resolve));
  await new Promise(resolve=>check.close(resolve));
}

async function main() {
  for(const file of [initdb,pgCtl,psqlBin,process.execPath,schema,tests,authTests]) if(!fs.existsSync(file)) throw new Error(`Missing preinstalled local file: ${file}`);
  if(fs.existsSync(sessionRoot)) throw new Error("Unique temporary path already exists.");
  port=await freeLoopbackPort();
  fs.mkdirSync(sessionRoot);
  let primaryError;
  try {
    run(initdb,["-D",dataDir,"-U","postgres","--auth-local=trust","--auth-host=trust","--no-instructions"]);
    started=true; // cleanup attempts are now scoped to this exact new data directory
    process.stdout.write("STARTUP: creating loopback-only PostgreSQL cluster\n");
    run(pgCtl,["-D",dataDir,"-l",logFile,"-o",`-h 127.0.0.1 -p ${port} -c listen_addresses=127.0.0.1`,"-w","-t","20","start"],{stdio:"ignore",timeout:25000});
    process.stdout.write("BOOTSTRAP: creating local schema and synthetic fixtures\n");
    runPsql("postgres","CREATE DATABASE sipapua_schedule_local;");
    runPsql("sipapua_schedule_local","",{args:["-f",schema]});
    const secret=crypto.randomBytes(32).toString("hex");
    runPsql("sipapua_schedule_local",`INSERT INTO sipapua_private.writer_secret(singleton,secret) VALUES(true,decode('${secret}','hex'));`);
    runPsql("sipapua_schedule_local",`INSERT INTO sipapua_schedule.resources(id,kind,display_name) VALUES
      ('10000000-0000-4000-8000-000000000001','venue','Synthetic Venue One'),
      ('10000000-0000-4000-8000-000000000002','venue','Synthetic Venue Two'),
      ('10000000-0000-4000-8000-000000000003','venue','Synthetic Venue Three'),
      ('20000000-0000-4000-8000-000000000001','person','Synthetic Pastor One'),
      ('20000000-0000-4000-8000-000000000002','person','Synthetic Pastor Two'),
      ('20000000-0000-4000-8000-000000000003','person','Synthetic Pastor Three'),
      ('20000000-0000-4000-8000-000000000004','person','Synthetic Pastor Four'),
      ('20000000-0000-4000-8000-000000000005','person','Synthetic Officer One');`);
    const testEnv=minimalEnv({SCHEDULE_TEST_PG_PORT:String(port),SCHEDULE_TEST_PSQL:psqlBin,SCHEDULE_TEST_HMAC:secret});
    run(process.execPath,["--test",authTests,tests],{env:testEnv,timeout:60000});
  } catch (error) {
    primaryError=error;
  } finally {
    if(started) {
      try {
        run(pgCtl,["-D",dataDir,"-m","fast","-w","-t","20","stop"],{timeout:25000});
        started=false;
        await assertPortReleased();
      } catch(error) {
        process.stderr.write(`ISOLATED CLUSTER CLEANUP FAILED: ${error.message}\n`);
        if(!primaryError) primaryError=error;
      }
    }
    // Retain the stopped synthetic cluster and log under the unique temp path
    // so a failure is diagnosable; no live service or credentials remain.
    process.stdout.write(`ISOLATED_TEST_DATA: ${sessionRoot}\n`);
  }
  if(primaryError) throw primaryError;
}

main().catch(error=>{process.stderr.write(`LOCAL TEST RUN FAILED: ${error.message}\n`);process.exitCode=1;});
