# Final Spark release decision — NO-GO pending Owner operations

Date: 2026-11-14. This is the single operational companion to RELEASE-STEPS.md,
COMMIT-PATHS.txt and MANIFEST.json, not a repeat of the historical audits.
The current Owner-reported production baseline and pilot decision supersede
older unknown-inventory statements below: see FINAL-PILOT-DECISION.md and
PRODUCTION-INVENTORY-BASELINE.json. Official inventory/read permissions are now
confirmed by Owner; Auth REST 403 is no longer listed as a pending blocker.

## What is ready locally

- UID ownership security closeout remains 13 PASS / 0 FAIL; Rules and registration
  client are unchanged in this operational step. That suite was not rerun.
- Owner CLI synthetic tests and real isolated Firestore REST transactions verify
  preview, atomic clear/audit creation, conflict detection and duplicate rejection.
  IAM/Owner/Auth authorization in emulator tests is synthetic; production IAM
  and Auth REST success are NOT claimed by these tests.
- Inventory uses the explicit official `X-Goog-User-Project: boby-apps-project`
  header. IAM preflight now also verifies serviceusage.services.use. This addresses
  missing/incorrect quota-project attribution without changing IAM, API enablement,
  Firebase configuration, Rules, App Check or billing plan.
- The 403 root cause is not declared proven until Owner runs the credentialed
  request. Safe Google reason categories remain enabled. No token or error body
  is printed. Unknown causes remain unknown; there is no API-key/debug fallback.
- Public registration remains maintenance:true. Legacy linking remains disabled.

Official references:
[quota project for REST](https://cloud.google.com/docs/quotas/set-quota-project),
[official interactive login](https://cloud.google.com/sdk/gcloud/reference/auth/login),
[Firestore atomic commit](https://firebase.google.com/docs/firestore/reference/rest/v1/projects.databases.documents/commit).

## Owner read-only inventory and Auth 403 procedure

Use the existing official user gcloud login. Do not copy an access token, service
account key or ADC file into the repository. If the safe reason is OAuth scope
insufficient, Owner may reauthorize the official CLI interactively with
`gcloud auth login --force`; this is not a Firebase/IAM change and must not be
performed by the agent on the Owner's behalf. If the reason remains service/
consumer/IAM/policy denied, stop and review the official Console; do not enable
APIs, upgrade billing, bypass the quota project, disable App Check or broaden IAM.

Run from the workspace in an Owner terminal without emulator variables:

```powershell
$ownerDir = Join-Path $env:LOCALAPPDATA 'SIPAPUA-Owner-Inventory'
New-Item -ItemType Directory -Path $ownerDir -Force | Out-Null
$inventory = Join-Path $ownerDir ('inventory-' + (Get-Date -Format 'yyyyMMdd-HHmmssfff') + '.json')
node scripts/legacy-uid-inventory.cjs --project boby-apps-project --owner-approved-read-only boby-apps-project --output $inventory
if ($LASTEXITCODE -ne 0) { throw 'Inventory incomplete; stop. Share only the safe error code.' }
```

Coverage includes Auth UID/disabled, users UID/doc.id, allocations, both legacy
binding indexes, and uid_ownership. The report is counts and pseudonyms only.
It is not an identity attestation or automatic index import. Missing UID fields
are not automatically cleared. Tenant coverage is default tenant only; Owner
must confirm that matches the project. Firebase reads still consume normal Spark
quota; no billing upgrade occurs.

## Operational per-person registration on Spark

This release is **Owner-reviewed onboarding**, not unattended public registration.
A person needs an actual Firebase Auth UID, confirmed through their own session
and the organization's identity procedure. Public signup may create an Auth account
but cannot allocate a NIJ while ownership is unknown. Existing retries preserve
the same account; do not create another account to bypass the waiting state.

Because maintenance is currently active, a first pilot Auth account/session must
be arranged by Owner through a separately approved onboarding action, or through
an explicitly approved guided pilot publication. This tool does not create Auth
accounts, disable maintenance, or silently bootstrap the first production user.

For each verified person, Owner copies OWNER-REVIEW-TEMPLATE.json to a protected
local directory outside Git, and fills the actual UID and opaque organization
review ID. Set organizationIdentityVerified and privilegedWritersCoordinated true
only after completing those procedures. Email alone is never proof. Never put
the filled file into docs/, assets/, public hosting or the commit list.

```powershell
$review = Join-Path $ownerDir 'review.json'
if (Test-Path -LiteralPath $review) { throw 'Use a new protected review filename; do not overwrite an existing review.' }
Copy-Item -LiteralPath docs/spark-release/OWNER-REVIEW-TEMPLATE.json -Destination $review
# Fill and review locally using the approved organization process.
node scripts/owner-uid-clear.cjs --preview $review
```

Preview checks the active CLI user's direct unconditional roles/owner binding,
read permissions, actual active Auth UID, canonical doc.id, noncanonical users.uid,
allocation IDs and UID fields, both binding indexes and existing uid_ownership.
Queries run in one Firestore snapshot. The CLI refuses impersonation and unsupported
group/inherited-only Owner verification rather than guessing authorization.
No new IAM roles or credentials are created.

Preview emits only a decision and masked references. It does not emit a UID,
email, name, NIJ, token, response body or raw account identifier.

### Separate issuance approval — NOT authorized/executed in this session

After Owner separately approves exactly that UID, set approveProductionClear=true
and approvedAt to the current UTC ISO timestamp in the protected review file.
Approval expires after 15 minutes. Then, and only then:

```powershell
node scripts/owner-uid-clear.cjs --issue-approved $review
```

The CLI repeats the authorization and ownership checks in a Firestore read-write
transaction. It can commit exactly two create-only records: uid_ownership/{uid}
state clear and a deterministic registration_audit/uid-clear_<hash>. Both use
exists:false preconditions; there is no upsert, bulk mode, automatic retry or
automatic renewal. The audit stores a hashed actor reference and review provenance.
The official request is made under the Owner IAM identity. If a network error
makes the commit outcome ambiguous, inspect the record/audit officially; do not
delete a record or retry as an update.

Eligibility lasts one hour. The person must complete registration in that window.
An expired record remains blocked and is not overwritten by the CLI; recovery
requires a separately reviewed operational action. Ownership is consumed as
allocated in the six-document client transaction. The legacy profile, NIJ,
counter and reservations are never edited by the issuer. A UID with any prior
owner/allocation/conflict is refused, even if contact information changed.

No web role can issue clear. A browser administrator does not gain IAM credentials
from this CLI. It has no listener or deployed endpoint and is not included in the
public application entrypoints. IAM itself is the trust boundary: someone already
authorized to bypass Rules could write false data outside the tool, so privileged
writers must be coordinated. All UID ownership writers must preserve the same
index; a checklist alone is not a replacement for that coordination.

## Deployment compatibility and actual Enterprise evidence

Production compatibility cannot be asserted from local source alone. Owner must
capture the actually deployed Rules and actual Pages revision before any deploy,
and verify their readers with authorized existing UID-bound accounts. The local
root firestore.rules is not assumed to equal production. Do not deploy candidate
Rules first against an untested old website: that can break its queries.

Required order after separate release approval:

1. Keep registration in maintenance and capture actual Rules/Pages rollback inputs.
2. Review old live readers versus candidate policy. Stage the client-compatible
   code and policy only in the approved order established by this comparison.
   If no compatible overlap is proved, use an Owner-approved maintenance window;
   do not advertise a zero-interruption rollout without evidence.
3. Verify Enterprise Web App/key/domain binding, Firebase Auth authorized domain
   and action link routing on imadebobydaniel-ai.github.io. In the authorized
   browser, acquiring an Enterprise token must return only a success indicator,
   never the token. No debug provider or enforcement relaxation is permitted.
4. Check actual Firestore App Check enforcement and a permitted client server
   read. CLI IAM reads bypass client Rules/App Check and do not prove attestation.
5. Confirm registry enabled/maintenance/version, safe counter floors and permanent
   legacy reservations from official evidence. Do not initialize or repair them
   through this issuer.
6. Deploy using the commands in RELEASE-STEPS.md only after authorization. Test
   existing login/profile/admin readers with approved accounts. If any fail,
   restore the exact captured Rules/code and keep registration paused.
7. Run the public asset verifier below. This verifies code publication, not
   authenticated behavior or Enterprise attestation:

```powershell
node scripts/verify-spark-public.cjs
```

Only after the above and an approved reviewed-onboarding pilot should Owner
authorize a concrete maintenance-flag change. Recompute the manifest after that
change; don't edit the flag silently or push all untracked files.

## Package and rollback

`node scripts/prepare-spark-release.cjs` prepares MANIFEST.json and COMMIT-PATHS.txt,
including hashes of all selected app, Rules, operations and test files. No Git
staging, commit, push or deployment is performed. Existing untracked material,
Functions and unsafe legacy-linking candidates remain excluded from the release
selection. Source scripts may be committed for review but are not executable by
the web application and contain no credentials.

RELEASE-STEPS.md contains the Rules-only Firebase deploy and source commit/push
commands, each still subject to Owner approval. Rollback first pauses registration,
then restores the captured Rules using an Owner backup config and reverts the
approved release commit in a clean checkout. Never decrement counters or remove
Auth accounts, profiles, allocations, reservations or consumed ownership records.

## Final decision

**NO-GO for public registration today.** The local issuance procedure exists and
is tested. Owner confirms a complete production inventory (24 Auth, 9 canonical
profiles, 1 allocation, 8 structurally unmatched, 0 duplicate UID, 0 noncanonical
UID profiles, 0 ownership records). No pilot preview/clear is evidenced yet.
The Owner must approve and operate the first per-UID review, resolve the eight
structural case findings, capture live compatibility/rollback evidence, and verify real Enterprise
attestation and registry readiness. These are actual Owner actions, not another
local audit. Unrestricted automatic signup is not provided by a manually reviewed
eligibility process and must not be described as ready.
