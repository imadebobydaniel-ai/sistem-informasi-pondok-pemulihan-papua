# Minimal release candidate — local PASS, publication BLOCKED

Latest handoff: [FINAL-OWNER-HANDOFF.md](FINAL-OWNER-HANDOFF.md). Active Pages
SHA and a full source rollback archive are now confirmed. A fresh public read
shows registration:false, so the approved release must establish the pause first;
the earlier instructions below must not be read as proof that production is paused.

Release artifact: `release-check/2026-11-14T04-09-56-748Z/`.
`FILES.txt` is the complete allowlist; `MANIFEST.json` contains source/payload
hashes. Existing source and prior artifacts are preserved. No production reads
or writes of member data, deployment, commit, push or merge occurred in this fix.

## Changes and evidence

- New `firestore.minimal.rules` is generated from the actual captured production
  Rules by `scripts/build-minimal-activation-rules.cjs`. Only the ownership,
  registration/profile lifecycle and activation/audit section is replaced with
  the reviewed Firestore-only contracts. Production prefix and suffix are
  byte-identical, including shared admin policy and every unrelated module match.
  Registration identity immutability and contact/family/profile contracts remain
  as in the 19-PASS restoration; no new registration implementation was created.
- Activation requires an ACTIVE master/super_admin with canActivateMembers;
  explicit active checks are local to this contract because the production shared
  role helper is not sufficient. An immutable, atomic audit and identity attestation
  are required. Manual activation does not change Firebase Auth emailVerified.
- Existing menu/profile/settings readers in the release already use the shared
  UID resolver. Email-shaped facade calls only check session consistency and do
  NOT query Firestore by email or grant ownership. Tested both get and listener.
  The existing editor dropdown and its audited activation workflow are preserved.
- Added the missing Firestore compat SDK to auth-handler.html and
  verify-success.html, and the correct Web App ID to verify-success.html. All
  packaged helper consumer pages load App/Auth/Firestore/App Check compat 12.18.0
  before helper use. Enterprise provider/key binding matches the cloud evidence.
  Read-only official CDN GETs returned HTTP 200 for all four 12.18.0 compat SDKs
  (App, Auth, Firestore, App Check). This is availability evidence, not attestation.
  Card maintenance remains unchanged; no card feature was added or unpaused.
- New emulator tests: **11 PASS / 0 FAIL**, real Firebase client SDK on newly
  started loopback-only Auth/Firestore emulators. Covers the changed Rules contract,
  immutable NIJ/role/status, private profile/subcollection denial, inactive and
  unpermitted admin denial, manual audit/login while Auth remains unverified,
  automatic verified activation, UID reader/listener and Database Jemaat,
  unchanged UMKM/rating/agenda/telemetry access, registry fail-closed behavior.
- Package tests: **7 PASS / 0 FAIL** (4 new compatibility checks and 3 affected
  packaging checks). Original restoration 19-PASS suite was NOT repeated.
- Untouched module policies are deliberately preserved, including any existing
  broad access in production. This is not certification of those unrelated
  policies or justification to expand access in registration/profile Rules.

## Remaining publication gates

1. Owner runs `enterprise-browser-readonly.js` on the exact Pages origin/Web App
   and supplies boolean-only token/server-read result. No debug token. Current
   Firestore enforcement is UNENFORCED; a read alone does not prove attestation.
2. Separately approve the single registry maintenance boolean update below at
   reopening. Existing enabled/version/counters remain unchanged. The confirmed
   missing/nonboolean value fails closed in both client and candidate Rules.
3. Approve the paired code/Rules publication window. Existing public code is
   incompatible with a blind Rules-first rollout. Capture the current successful
   Pages deployment revision/artifact before publishing. No local .github workflow
   exists, so do not invent a branch/workflow deployment command or rollback SHA.
   The original nine public entrypoints are backed up; this is NOT a full backup
   of every website asset in the larger matched-reader package.

The manifest's old-public compatibility gate records production/runtime evidence,
not the local reader tests. It stays unresolved until the matched website is
actually published and checked. No LIVE claim is made.

## Exact Rules commands — only after separate Owner deployment approval

```powershell
Set-Location -LiteralPath 'D:\MASTER PROJECT\SIPAPUA\APLIKASI SIPAPUA'
$release = Join-Path $PWD 'docs\activation-restoration\release-check\2026-11-14T04-09-56-748Z'
firebase deploy --project boby-apps-project --config (Join-Path $release 'firebase.release.json') --only firestore:rules
```

Use ONLY this frozen package configuration; the previous restoration firebase.json
and broad proposal are not the minimal candidate. The package includes all current
matched readers/helpers/editor, not only the original three runtime files. Copy
FILES.txt inputs from payload into a clean, separately approved release checkout;
never overwrite/reset/clean this shared working tree or stage all untracked files.

## Registry action — separate approval required, NOT executed

At the controlled reopening step, Owner can set the single Firestore Console field
registration_control/state.maintenance to boolean false, or review this equivalent
official IAM request. The update mask preserves all other fields and the existence
precondition prevents accidentally creating a missing state document.

```powershell
$registryPatch = Get-Content docs/activation-restoration/registry-maintenance.patch.json -Raw
$registryToken = gcloud auth print-access-token
try {
  Invoke-RestMethod -Method Patch -Uri 'https://firestore.googleapis.com/v1/projects/boby-apps-project/databases/(default)/documents/registration_control/state?updateMask.fieldPaths=maintenance&currentDocument.exists=true&mask.fieldPaths=maintenance' -Headers @{ Authorization = "Bearer $registryToken"; 'X-Goog-User-Project' = 'boby-apps-project' } -ContentType 'application/json' -Body $registryPatch | Out-Null
} finally { Remove-Variable registryToken -ErrorAction SilentlyContinue }
```

## Coordinated deployment and rollback

1. Record the current successful Pages revision/artifact and confirm exact Rules
   backup in production-backup/firestore.pre-release.rules. Review final payload
   hashes and cloud drift before the authorized window; do not silently deploy
   against a subsequently changed production Rules version.
2. Keep registration paused during the controlled window. Publish matched pages,
   helpers and existing editor, then minimal Rules. Mixed versions may fail closed;
   old browser tabs must reload. Do not claim uninterrupted service in this window.
3. Perform the separately approved registry action. Only then publish the reviewed
   payload's registration:false maintenance override. Root source stays paused.
4. Check public asset hashes/HTTP availability, actual Enterprise token, login,
   own-profile, Database Jemaat, and administrator form access. Registration and
   activation smoke tests mutate data and require separately authorized accounts
   and actions. Confirm server audit and unchanged NIJ; never fake Auth verification.

If any gate fails, pause registration, restore the exact Rules backup:

```powershell
firebase deploy --project boby-apps-project --config (Join-Path $release 'production-backup\firebase.rollback.json') --only firestore:rules
```

Restore the recorded successful Pages deployment through the actual existing Pages
publication mechanism. Do not guess a git reset/force push or branch. Recheck old
access while registration remains paused. Do not delete profiles/audits/allocations,
reset counters, or change NIJ during rollback. No deployment command above was run.
