# Final release check — BLOCKED

Update: this earlier report is superseded by [FINAL-BLOCKER-CLOSEOUT.md](FINAL-BLOCKER-CLOSEOUT.md).
The newer Owner cloud read captured actual production Rules and configuration;
a subsequent bounded GET isolated the registry maintenance-field mismatch.
Statements below about unavailable cloud evidence describe the earlier run only.

Scope: original registration + administrator activation. Baseline 19 PASS retained;
no registration rebuild, UID inventory, new eligibility mechanism or historical
audit was run. Only release packaging/configuration/public source was checked.

## Evidence actually obtained

- Public GETs succeeded outside the network sandbox. Existing index.html still
  explicitly blocks !user.emailVerified. Publishing only the three runtime fixes
  cannot enable audited manual login while leaving that old page in place.
- Five required helpers are HTTP 404 on the current website:
  sipapua-spark-member.js, sipapua-spark-registration.js,
  sipapua-member-session.js, sipapua-login.js, sipapua-app-check.js.
  They are included in the prepared payload, along with login/verification,
  administrator, menu and existing shared-reader consumer pages.
- Live profil.html and setting.html contain direct email profile queries, and the
  live editor lacks the new audit activation workflow. The new private Rules
  must not be installed in isolation while leaving those old callers unreviewed.
  A matched code/Rules publication or an approved maintenance window is needed.
- Source backup of successful public GETs is captured in public-backup/ under
  release-check/. HTTP 404 is recorded for helpers absent before release; these
  are not fabricated as rollback files. A public hash snapshot does not prove
  the Git commit currently served by Pages.
- The current environment has no usable official gcloud executable/authentication.
  An elevated read-only retry restored public HTTP access, but not official cloud
  authentication. No deployed Rules, binding/enforcement configuration or registry
  state was read from production. A real production Rules backup is NOT claimed.
- The local root maintenance flag is still true. Payload-only transformation sets
  registration:false and leaves memberCard:true. The working tree is not silently
  unpaused. This exact release-only change is included in the manifest for review.

Three packaging tests PASS: complete required dependency coverage, release-only
maintenance override/source preservation, and GET-only Rules backup behavior.
The backup test is synthetic and does not constitute a production backup.

## Release package

LATEST-RELEASE-CHECK.txt points to the generated release-check directory:

- payload/: explicit HTML/JS dependencies and existing geography JSON assets.
- FILES.txt and MANIFEST.json: selected files, source/payload hashes, differences,
  live read evidence and unresolved gates.
- public-backup/: previously published sources actually retrieved by GET.
- production-backup/: created ONLY if the official Rules API read succeeds.
- firebase.release.json: references the restoration proposal, never the root
  firestore.rules or an old ownership-clear candidate. Its matching Rules file
  is frozen inside rules/ so the directory is self-contained for Rules deployment.

The payload includes working-tree versions of existing shared-helper consumers;
review their current-versus-public diffs as part of this specific publication.
Do not stage arbitrary untracked files, Functions, snapshots, private backups,
Owner review files, old UID linking/clear tools or unrelated review directories.

Use a clean, separately approved release checkout to apply FILES.txt from payload/.
Do not copy it over the shared working tree or run git reset/clean. In particular,
committing the root maintenance file unchanged would publish registration:true;
the release artifact's maintenance file is the reviewed publication input.

## Exact remaining Owner actions

1. In the Owner PowerShell session where official gcloud authentication already
   works, run the same read-only command:

```powershell
Set-Location -LiteralPath 'D:\MASTER PROJECT\SIPAPUA\APLIKASI SIPAPUA'
node scripts/check-activation-release.cjs --cloud-read-only --public-read-only
```

   No login/token copying, Firebase writes, rule deployment or Git writes occur.
   The script captures actual deployed Rules using the official Rules API, writes
   an exact local rollback config, checks Enterprise key/domain/enforcement metadata
   and reads only bounded registration state/counter metadata, never member profiles.
   Require rulesBackupCaptured=true. Compare that source with the restoration
   proposal before authorizing publication; equality is not assumed.

2. On the approved Pages origin with an authorized browser, obtain a genuine
   Enterprise token and a permitted server read. Report only success/failure,
   never a token. If the old page lacks the App Check SDK, use an Owner-approved
   staged validation on the intended origin before the release window. No debug
   provider, App Check disablement or broad Rules is an acceptable workaround.
   Configuration reads alone and emulator stubs cannot establish attestation.
   Check the existing active master/super_admin canActivateMembers permission
   through official configuration; this task does not grant it automatically.

3. Authorize the paired code/Rules deployment window after the above. The old
   public pages are not a safe basis for a blind Rules-first deployment. Keep
   registration paused while components are being switched, then install the
   reviewed release-only maintenance override only when the pair is ready.
   This task does not authorize that publication or the maintenance transition.

## Prepared deployment, verification and rollback — NOT executed

Rules command after explicit Owner authorization:

```powershell
firebase deploy --project boby-apps-project --config docs/activation-restoration/firebase.json --only firestore:rules
```

For the frozen release artifact instead of the working source configuration:

```powershell
$release = Join-Path $PWD ((Get-Content docs/activation-restoration/LATEST-RELEASE-CHECK.txt -Raw).Trim())
firebase deploy --project boby-apps-project --config (Join-Path $release 'firebase.release.json') --only firestore:rules
```

Publish only the approved payload into the actual Pages branch/workflow; verify
the branch/revision before commit/push. The source-only three-file delta is not
the complete deployment set. No commit or push has been made by this check.

After publication compare each released public asset to payload (normalize CRLF
only), confirm no required helper is 404, and check registration is not showing
maintenance. Verify existing member login, profile, Database Jemaat/admin access
and activation audit using specifically authorized accounts. A production
registration or activation modifies data and needs separate explicit permission;
this check did not create test members or alter any account status/NIJ.
Do not declare LIVE solely from HTTP 200 or the 19 emulator tests.

Rollback: pause registration, restore the actual production-backup Rules using
production-backup/firebase.rollback.json, and restore the captured known-good code
through the approved Pages workflow in a clean checkout. Files absent before
release are explicitly marked in the public snapshot; don't invent their previous
contents. Recheck existing access before reopening registration. Never delete
accounts/profiles/audits/allocations/reservations or decrement counters as rollback.

**Decision: BLOCKED**, specifically by missing authenticated production Rules
backup/comparison, real Enterprise/client-read evidence and approval of the matched
publication window. Dependency and maintenance fixes are prepared locally; they
are not a claim that the public website is already restored or LIVE.
