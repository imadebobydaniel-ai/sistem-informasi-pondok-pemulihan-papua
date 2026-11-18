'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const snapshot=JSON.parse(fs.readFileSync(path.join(__dirname,'PRODUCTION-SCHEMA.json')));
const original=snapshot.base_rpc_definitions.find(x=>x.proname==='lacak_domba_replace_own_blocks').definition;
let fixed=original;
function replace(old,next){assert.ok(fixed.includes(old));fixed=fixed.split(old).join(next);}
replace('    blocked_uid TEXT;','    v_blocked_uid TEXT;');
replace('FOREACH blocked_uid IN ARRAY','FOREACH v_blocked_uid IN ARRAY');
replace('IF blocked_uid IS NULL','IF v_blocked_uid IS NULL');
replace('length(blocked_uid)','length(v_blocked_uid)');
replace('OR blocked_uid = p_blocker_uid','OR v_blocked_uid = p_blocker_uid');
replace('            blocked_uid\r\n        )\r\n        ON CONFLICT','            v_blocked_uid\r\n        )\r\n        ON CONFLICT');
replace('    DELETE FROM public.lacak_domba_blocks',"    -- Match the existing repository's per-owner atomic replacement protocol.\r\n    PERFORM pg_advisory_xact_lock(hashtextextended('lacak_domba_blocks:' || p_blocker_uid, 0));\r\n\r\n    DELETE FROM public.lacak_domba_blocks");
assert.ok(fixed.includes('ON CONFLICT (blocker_uid, blocked_uid) DO NOTHING'));
const sql=`-- REVIEW ONLY: compatibility correction to EXISTING block mirror RPC.
-- CREATE OR REPLACE changes only code, not any stored block/location row.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
do $compat_preflight$
begin
 if md5(pg_get_functiondef(to_regprocedure('public.lacak_domba_replace_own_blocks(text,text[])'))) is distinct from '5f3d414be75d04cdf44a84216f863db5' then raise exception 'STOP: existing block RPC changed since review'; end if;
 if has_function_privilege('anon','public.lacak_domba_replace_own_blocks(text,text[])','EXECUTE') or has_function_privilege('authenticated','public.lacak_domba_replace_own_blocks(text,text[])','EXECUTE') or not has_function_privilege('service_role','public.lacak_domba_replace_own_blocks(text,text[])','EXECUTE') then raise exception 'STOP: block RPC ACL differs'; end if;
end;
$compat_preflight$;
${fixed};
notify pgrst, 'reload schema';
commit;
`;
fs.writeFileSync(path.join(__dirname,'BLOCKS-COMPATIBILITY-PROPOSAL.sql'),sql);
fs.writeFileSync(path.join(__dirname,'ROLLBACK-BLOCKS-CODE-ONLY.sql'),'-- REVIEW ONLY: after disabling the new Edge; restore code/retain every row.\nbegin;\n'+original+';\nnotify pgrst, \'reload schema\';\ncommit;\n');
const discovery=fs.readFileSync(path.join(__dirname,'DISCOVERY-SESSION-PROPOSAL.sql'),'utf8');
const combined=discovery.replace(/commit;\s*$/,'')+sql.replace(/^([\s\S]*?)\nbegin;\n/,'\n-- Existing blocks RPC compatibility correction in the SAME transaction.\n');
assert.equal((combined.match(/^begin;$/gm)||[]).length,1);assert.equal((combined.match(/^commit;$/gm)||[]).length,1);
fs.writeFileSync(path.join(__dirname,'RESTORATION-PROPOSAL.sql'),combined);
const mfile=path.join(__dirname,'REVIEW-MANIFEST.json'),m=JSON.parse(fs.readFileSync(mfile));
m.blocksCompatibilityRepair={cause:'PLPGSQL_BLOCKED_UID_AMBIGUOUS',variableRenameOnlyPlusExistingPerOwnerLock:true,signatureOwnerAclUnchanged:true,productionApplied:false};
m.combinedProposalSha256=crypto.createHash('sha256').update(combined).digest('hex');fs.writeFileSync(mfile,JSON.stringify(m,null,2));
console.log(JSON.stringify({reviewOnly:true,combinedProposalSha256:m.combinedProposalSha256}));
