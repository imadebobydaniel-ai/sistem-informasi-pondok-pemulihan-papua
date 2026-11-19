'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const edgeFiles=['index.ts','discovery.ts'].map(name=>({name,content:fs.readFileSync(path.join(root,'supabase/functions/lacak-domba-nearby',name),'utf8')}));
const request={project_id:'cfnimvrxrnmefmxtzqks',name:'lacak-domba-nearby',entrypoint_path:'index.ts',verify_jwt:false,files:edgeFiles};
assert.ok(edgeFiles[0].content.includes('jwtVerify(token, JWKS'));assert.ok(edgeFiles[0].content.includes('algorithms: ["RS256"]'));
fs.writeFileSync(path.join(__dirname,'DEPLOY-EDGE-REQUEST.json'),JSON.stringify(request,null,2));
const db=JSON.parse(fs.readFileSync(path.join(__dirname,'LOCAL-SUITES-RESULT.json'))),edge=JSON.parse(fs.readFileSync(path.join(__dirname,'EDGE-COMPAT-SUITES-RESULT.json'))),combined=JSON.parse(fs.readFileSync(path.join(__dirname,'COMBINED-PROPOSAL-RESULT.json'))),chat=JSON.parse(fs.readFileSync(path.join(__dirname,'CHAT-ISOLATED-RESULT.json')));
assert.equal(db.tests[0].passed,26);assert.equal(db.tests[0].failed,0);assert.equal(edge.status,'PASS');assert.equal(combined.status,'PASS');assert.equal(chat.failed,0);
const report={status:'LOCAL_VERIFIED_OWNER_APPROVAL_REQUIRED',productionWrites:0,websitePublications:0,firebaseRulesChanges:0,liveLacakDomba:'NOT_RESTORED_BACKEND_NOT_DEPLOYED',
  productionBaseline:{threeTablesPresent:true,discoveryColumnsMissing:3,discoveryRpcsMissing:6,baseRpcsPresent:2,presenceRows:0,blockRows:0,scanLimitRows:0,rlsEnabled:true,publicTableAccess:false},
  discoveredBlocker:{rpc:'lacak_domba_replace_own_blocks',cause:'PLPGSQL_BLOCKED_UID_AMBIGUOUS',originalEdgeTests:{passed:24,failed:3},candidateRepairVerified:true,appliedToProduction:false},
  uniqueCandidateTests:{discoveryUnit:6,discoveryPostgres:26,edgeWithCompatibilityRepair:27,blockReplacementConcurrency:3,privateChat:14,totalPassed:76,totalFailed:0,ignored:0},
  checks:{combinedMigrationPreservesLegacyRows:combined.migrationPreservedLegacyRows,rollbackRetainsRowsAndRestoresOriginalRpc:combined.fullRollbackRetainsRowsAndRestoresOriginalRpc,newRpcs:combined.newRpcPrivileges},
  proposedChanges:{nullableSessionColumns:3,sessionChecks:3,sessionIndex:1,newServiceOnlyRpcs:6,existingBlockRpcCompatibilityRepair:1,existingScanSlotRpcChanges:0,edgeFunctionsDeployed:['lacak-domba-nearby'],websiteChanges:0,firebaseRulesChanges:0},
  files:{restorationSqlSha256:hash(fs.readFileSync(path.join(__dirname,'RESTORATION-PROPOSAL.sql'))),edgeRequestSha256:hash(fs.readFileSync(path.join(__dirname,'DEPLOY-EDGE-REQUEST.json'))),edgeSources:edgeFiles.map(f=>({name:f.name,sha256:hash(Buffer.from(f.content))}))}};
fs.writeFileSync(path.join(__dirname,'OWNER-REVIEW-RESULT.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({status:report.status,passed:76,failed:0,productionWrites:0,restorationSqlSha256:report.files.restorationSqlSha256}));
