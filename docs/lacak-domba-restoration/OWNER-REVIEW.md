# Lacak Domba restoration — locally verified, Owner approval required

Target Supabase cfnimvrxrnmefmxtzqks; Firebase boby-apps-project. No production
migration, function deployment, data write, message send, account change, Git
commit/push or website publication was performed during this task. Registration,
administrator permissions, permanent NIJ and active Firebase Rules were not changed.

## Current production and original sources

Read-only catalog inspection confirms three existing tables with RLS enabled,
no public/anon/authenticated table SELECT access, and two existing service-only
RPCs. All three table row counts were 0 at inspection. The project migration
history is empty and lacak-domba-nearby is absent from the deployed function list.
The three unrelated existing Edge Functions were not changed.

Both original migration files and both Edge code modules match their Git blob
objects in the existing published source commit 45b18b0. They are preserved.
The comparison and code snapshot are in PRODUCTION-SCHEMA.json and
REVIEW-MANIFEST.json; no production location/profile/message rows were exported.

| Contract | Production | Original migration | Minimum plan |
|---|---|---|---|
| Three base tables | Present | Base creates if absent | Do not recreate/reapply base |
| latitude/longitude/location_updated_at | Nullable legacy schema | Fresh base declares NOT NULL | Preserve legacy nullability |
| Presence constraints/indexes | Legacy coordinate CHECK and search index | Fresh base differs | Preserve; add session checks/index only |
| discoverable_until/discovery_session_id/session_started_at | Missing | Discovery adds nullable columns | Add these three columns |
| Six discovery/scan/purge RPCs | Missing | Discovery defines them | Add exactly those six |
| take_scan_slot | Present, service-only | Base fallback implementation | Preserve actual production definition/ACL |
| replace_own_blocks | Present, service-only | Base fallback implementation differs | Compatibility correction required below |

The old RELEASE-PLAN/preflight expectations are not blindly applied: making the
legacy coordinate columns NOT NULL or rerunning the base migration is unnecessary
and would expand this restoration. Existing rows with no session remain unchanged
and are not discoverable until their owner explicitly starts a session.

The security advisor's three RLS-without-policy INFO findings are intentional
for these server-only tables; they are not fixed by granting public access.
Reference: https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy

## Concrete additional compatibility defect found

The EXACT production definition of lacak_domba_replace_own_blocks declares a
PL/pgSQL variable named blocked_uid. Its INSERT also uses blocked_uid as a target
column and in ON CONFLICT. On the production-schema clone, nonempty block lists
raise PostgreSQL error 42702: column reference blocked_uid is ambiguous. This
caused three existing Edge suite failures (24 PASS / 3 FAIL) and is not repaired
by installing the six discovery RPCs alone.

BLOCKS-COMPATIBILITY-PROPOSAL.sql renames only the loop variable/references to
v_blocked_uid and adds the repository's per-owner transaction advisory lock before
replacement. Column names, function arguments/result, attempted-insert count
semantics, validation limits, owner, SECURITY DEFINER, search_path and ACL remain
unchanged. The lock prevents concurrent replacements from merging block lists.
CREATE OR REPLACE updates code only; it does not execute the function or change
any existing block/location row. This correction is INCLUDED for explicit Owner
approval, not silently applied to production.

## Verified deployment artifacts — proposals only

- RESTORATION-PROPOSAL.sql: one explicit transaction; bounded lock/statement timeouts;
  production-definition drift guards; three nullable columns, three session CHECKs,
  one index, six new RPCs and the reviewed existing block-RPC compatibility repair.
  No DROP, TRUNCATE, backfill, table-grant expansion or top-level data DML.
- DISCOVERY-SESSION-PROPOSAL.sql: discovery-only component, preserving both old RPCs.
- DEPLOY-EDGE-REQUEST.json: exact MCP deploy request for ONLY lacak-domba-nearby,
  index.ts + discovery.ts, entrypoint index.ts, verify_jwt=false. It contains code
  only, no service keys, env file, test fixtures, snapshots or unrelated functions.
- postcheck-readonly.sql: catalog/privilege/column checks only. Do not invoke a
  lifecycle/purge/scan RPC as a supposedly read-only postcheck.
- OWNER-REVIEW-RESULT.json and REVIEW-MANIFEST.json: file hashes and test evidence.

Combined SQL SHA256:
4f2ab7cd6876457a2bac61d90dba69bc4b5917fd4a161383c76e774cdf22233f

All six new RPCs are SECURITY DEFINER with pinned pg_catalog,public search_path;
PUBLIC/anon/authenticated EXECUTE is revoked, service_role EXECUTE is granted.
Confirmed in the real local catalog and through real PostgREST requests:

1. lacak_domba_discovery_start(text,jsonb)
2. lacak_domba_discovery_extend(text,uuid,jsonb)
3. lacak_domba_discovery_refresh(text,jsonb,timestamptz)
4. lacak_domba_discovery_end(text,text,uuid)
5. lacak_domba_scan_candidates(text,double precision,double precision,integer,integer,integer)
6. lacak_domba_purge_stale(integer)

The public schema does not make these public APIs: effective execute grants are
restricted. Their privileged use is confined to the server after verifying the
Firebase caller. Do not expose a service-role/secret key in the frontend.

## Edge authentication and frontend contract

The existing handler verifies the Firebase Bearer token with Google's JWKS,
RS256, issuer https://securetoken.google.com/boby-apps-project, matching audience,
expiry and bounded subject. It then reads the caller's canonical active profile,
own presence/private location and own blocks with that caller's Firebase token.
Request-body UIDs/coordinates are not trusted as another person's identity.
Supabase service access stays server-side. Clear only hides the verified caller.

verify_jwt=false is necessary for this original external-Firebase-token design;
it disables the Supabase-token gateway check ONLY for this function, while the
handler's Firebase verification remains mandatory. No emulator/debug switch is
added to production code. Package imports remain jose@5.9.6 and
@supabase/supabase-js@2.116.0. Deno type checking passes.

The handler uses platform-provided SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY;
values were not fetched/copied. Default-secret documentation:
https://supabase.com/docs/guides/functions/secrets
External/custom authentication boundary:
https://supabase.com/docs/guides/functions/auth

Fresh public source GETs confirm that lacak-domba.html already calls this exact
Supabase function, not findNearbyMembers, and matches local source. chat.html and
kontak.html also match. No website deployment is needed for this candidate.
The backend/frontend four-field discovery response, HTTP errors, TTL/extend,
rate limit and coarse distance ranges are covered by existing Edge tests.

## Isolated verification — 76 unique PASS / 0 current FAIL

No registration/admin suite was rerun. All test identities and locations were
synthetic, on new local processes with no production credentials inherited.

| Suite | Result |
|---|---|
| Existing discovery state unit tests | 6 PASS |
| Existing real-PostgreSQL discovery/concurrency tests | 26 PASS |
| Existing Edge + real local PostgREST, after the compatibility repair | 27 PASS |
| Additional block-RPC identifier/count/concurrency checks | 3 PASS |
| Private chat using actual production Rules on a NEW Firebase emulator | 14 PASS |

Local PostgreSQL is portable 17.12; production is 17.6. Only core PostgreSQL
features are used. The local baseline recreates the captured production schema
and exact two RPC definitions/ACL, including nullable columns; production row
contents were never copied. PostgREST 16.5 uses fixture-only local service/anon
JWTs. Firebase/Google reads in the Edge suite are in-process synthetic fakes;
the suite verifies no request escaped except to local PostgREST. This is not a
claim of a successful authenticated production scan before deployment.

The combined exact SQL was applied locally with a synthetic legacy row present:
row fingerprints were unchanged. It refuses unexpected reapplication without
partial changes. Rollback retained every row, column and new function while
restoring the original block-RPC definition/ACL. All test servers were stopped.
Logs retain the original three failures and the corrected verification evidence;
the original failing condition was not removed from the suite or marked skipped.

## Chat status and limits

Public chat uses mutual_chats, not the UMKM chats collection. Current deployed
Rules (SHA256 e75a7ca...) are unchanged. Both accepted contact entries AND an
accepted pair friend_request are required, plus no block in either direction.
The account must be active, non-anonymous and email-verified. A manually active
account with unverified email is still denied by this EXISTING chat policy;
this restoration does not change it.

The exact frontend root/message batch succeeds in the emulator. Outsiders,
one-sided/pending contacts, blocks, inactive/unverified accounts, forged senders,
history edits/deletes and enumeration are denied. Removing friendship revokes
access but retains stored history. No production message or relationship row was
read/exported/changed, and no production message was sent. Readiness is based on
source/Rules and isolated contract tests, not an invented production conversation.

## Minimum production actions after explicit Owner approval

1. Recheck only drift against the saved schema/functions/grants; retain schema/code
   backups and verify the named project. Do NOT run generic db push or replay the
   base migration against the empty migration-history ledger.
2. Apply RESTORATION-PROPOSAL.sql as the single reviewed atomic transaction using
   the explicitly selected project. Record only this reviewed migration according
   to the approved history process; do not claim the reconstructed fresh-install
   base migration exactly equals the legacy database.
3. Run metadata-only postcheck; require all six signatures and service-only EXECUTE,
   unchanged table access and take_scan_slot, and the expected block compatibility
   code. No account/profile/NIJ/Firebase Rule changes.
4. Deploy ONLY the prepared lacak-domba-nearby request. Do not deploy all functions,
   push global configuration or change other administrators' Edge Functions.
5. Read back deployment metadata; OPTIONS can verify CORS and an unauthenticated
   POST must return handler missing_token/401 before any database operation.
   A genuine authenticated scan/sync/start is NOT read-only: it updates the cache,
   block mirror or rate limit and may purge stale cache rows. Run such a smoke only
   with separately authorized user consent/location activity, never covertly.

At inspection all three Supabase tables were empty. If a subsequent preflight
finds existing presence/location rows, STOP before enabling the Edge and review
the retention condition: the ORIGINAL runtime purges expired/sessionless cache
rows and clear/stop removes the caller's cached presence. The migration itself
does not delete them; no cleanup/backfill/RPC is run during deployment checks.
Do not reinterpret the Owner's no-location-deletion boundary as permission for
an automatic legacy cleanup. Firestore private-location documents are not deleted
by the migration or Edge code.

Original semantics retained: discoverability lasts up to 15 minutes on database
time; heartbeat does not extend it, explicit extend does. Offline/crashed clients
can remain visible for up to the 3-minute presence freshness interval; mirrored
block changes have the existing sync/freshness bound. No new immediate-global
presence guarantee is claimed and no architecture change was introduced.

## Data-preserving rollback (prepared and locally tested)

Disable/remove ONLY the newly deployed Edge endpoint (there was no earlier deployed
version), then apply ROLLBACK-DISABLE-PROPOSAL.sql to revoke service_role execution
of the six new RPCs. Restore the exact old blocks implementation with
ROLLBACK-BLOCKS-CODE-ONLY.sql only as part of the approved rollback. Leave all
tables, rows, coordinates, columns, CHECKs and indexes in place. Do not undo normal
user-created cache data or restore an old data dump over new activity. Existing
unrelated Edge Functions, Firebase Rules, accounts and friendship/message history
remain untouched. Roll forward by reviewed regrant/code deployment when ready.

**Decision: READY FOR SPECIFIC OWNER APPROVAL, NOT DEPLOYED.** Approval must cover
the discovery schema/RPC additions, the identified existing block-RPC code repair,
and the single Edge deployment. No production action is inferred from this plan.
