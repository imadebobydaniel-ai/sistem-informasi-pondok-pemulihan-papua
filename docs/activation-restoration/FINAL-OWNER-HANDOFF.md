# Final Owner deployment handoff

Decision: release package and rollback READY; App Check real-browser check now
PASS via isolated local Chrome debugging, without Console copy/paste. Evidence:
APP-CHECK-LOCAL-BROWSER-RESULT.json, checked 2026-11-14T05:44:19.121Z.
No registration/activation suites were repeated. Production mutations, Git
commits/pushes/merges and deployments: 0. Deployment still requires separate approval.

## Previous Console procedure — superseded; no Owner browser action needed

The check has already completed automatically using
`scripts/check-appcheck-local-browser.cjs`. Do not repeat the older Console
procedure below. The isolated Chrome profile was removed and only sanitized
booleans/categories were exported. See APP-CHECK-NO-CONSOLE.md for this method.

Open https://imadebobydaniel-ai.github.io/sistem-informasi-pondok-pemulihan-papua/index.html
in a normal browser without a debug provider. In F12 > Console, paste and execute
the ENTIRE contents of `enterprise-browser-readonly.js` once. No login, signup,
activation, or Console configuration change is needed. Report ONLY the final JSON:

```json
{"enterpriseToken":true,"clientServerRead":true,"productionDataWrites":0,"category":"PASS"}
```

Do not send tokens, Network entries or a full Console export. If the category is
not PASS, send that JSON only; do not disable protections or enable debug mode.
The script verifies the exact origin/path/project/Web App, loads official SDKs,
uses a separate temporary named CLIENT app with the real Enterprise provider,
forces a token exchange, and performs one permitted server GET of the public
registration_control/state document. It does not reuse/sign in an Auth account,
write documents, modify Rules/App Check configuration, or activate enforcement.
It logs booleans/categories only and cleans up its own client instance. Normal
attestation/token-exchange traffic and local SDK cache activity occur; "read-only"
here means no production data/configuration mutations, not HTTP GET-only traffic.

Four new synthetic browser-safety tests PASS: valid read-only path, wrong
origin/app guard, token failure without subsequent read, and sanitized read denial.
No token/exception body is printed in those cases. These are code-safety checks,
not a replacement for Owner attestation. Firestore enforcement remains UNENFORCED;
therefore successful Firestore reading alone is not evidence of attestation.

## Active website and rollback — READY

- Confirmed active source commit: **8fdc6cc65ab2ff112501b0f047ceaf509ea6f76a**.
  Tree: `639ca43ba5b5dcdc94b17268e6ca5221d163b79e`.
- Actual successful GitHub Pages deployment: **7480533321**, ref **main**;
  workflow run **41360619187**, deploy job **125010116806**. Success environment
  URL is the exact public site above. The latest sampled Pages deployment and
  latest workflow run agree. This is NOT inferred from local HEAD ed272d4.
- Current GETs of index.html, registrasi.html, edit-jemaat-administrator.html,
  and sipapua-maintenance.js match that commit's raw files after CRLF normalization.
  Evidence: `PAGES-HANDOFF-EVIDENCE.json`. Public unauthenticated /pages and
  /pages/builds/latest returned 404; no source-folder setting is claimed from them.
- Source ZIP: `handoff/pages-source-8fdc6cc65ab2ff112501b0f047ceaf509ea6f76a.zip`.
  SHA256: `2bea19873f606f58a2b196162e677a68209da53e5d6fe7e2fa83a13280d4ace7`.
  This is the complete Git source tree at the confirmed remote commit, not an
  archived built Pages artifact. The old Actions artifact list is empty. Rebuild
  through the existing Pages Jekyll pipeline; do not claim byte-identical generated
  build output merely from this source ZIP or rerun an old job blindly.
- Rollback method after separate authorization: use a CLEAN separate checkout
  of current remote main, undo ONLY the approved release commits in a rollback
  branch/PR, verify original website sources against the above immutable source
  (retain the pause overlay during recovery), and publish through the same main
  Pages pipeline. Do not force main back to the old SHA, overwrite this workspace,
  revert unrelated later work, or restore/delete Firebase data. Record the actual
  approved release commit IDs during publication so rollback can target them.
  Verify successful Pages deployment and public hashes after rollback.
- Exact production Rules backup is included in the release artifact's
  production-backup/firestore.pre-release.rules, with firebase.rollback.json.
  Its SHA256 is `ffd1e91aa3c15657715e5695a0cc9687634cbb6639222c992c1af141ff404e17`.

GitHub evidence:
https://github.com/imadebobydaniel-ai/sistem-informasi-pondok-pemulihan-papua/actions/runs/41360619187

## Package integrity — READY

Frozen release: `release-check/2026-11-14T04-09-56-748Z/`.
All **7,876** allowlisted payload SHA256 values match; current source SHA values
also match the manifest. FILES.txt exactly covers the dependency resolver's output.
The frozen Rules match firestore.minimal.rules, NOT the older broad proposal.
Manifest SHA256: `32893ad4faf9d90673735a57e46b98f039b34a70d3cec37d037cb6be1ba3beea`.
Rules SHA256: `f1aa558b3c62b8e7cc6ed6ea45164ce4aa44e4863982a8a861ea15f8f75a0200`.
Full local check results: `FINAL-HANDOFF-CHECKS.json`.

Registration, auth-handler, verify-success, login/index, Database Jemaat and the
existing administrator editor are included. The Status Akun save hook and identity
checkbox are present. Matching UID readers/helpers and SDK dependencies are included.
Baselines 19 + 11 + 7 PASS retained. No runtime file changed during this handoff.

## Publication order and the real maintenance condition

IMPORTANT: the CURRENT PUBLIC flag is **registration:false**, confirmed by a fresh
GET. It is not correct to claim production registration is already in maintenance.
No flag was changed in this task. A separately authorized opening deployment step
must FIRST publish the prepared pause overlay before switching components.

1. After browser PASS, request one explicit approval covering the paired code/Rules
   window, initial website pause, registry boolean update and final reopening.
   Check for intervening deployment/Rules changes at execution time; do not use
   stale backups if production changed after this handoff.
2. First publish `handoff/sipapua-maintenance.paused.js` AS sipapua-maintenance.js
   through the existing main Pages process, and confirm public registration:true.
   It is byte-identical to the preserved local maintenance source; memberCard:true
   remains unchanged. Pause SHA256:
   `004db84ae4974fe370320fb0b953e7f44c8b9e0ea82667e69f6264b4095c83fa`.
3. Publish all matched website payload files with that pause overlay retained.
   Wait for successful Pages build and verify served dependencies. Then deploy
   the frozen MINIMAL Rules, never the old broad proposal. Unrelated module Rules
   remain byte-identical to production; the candidate's targeted tests passed.
4. With matching code and Rules available, separately set ONLY
   **registration_control/state.maintenance = boolean false**. Preserve enabled,
   version and all other fields. `registry-maintenance.patch.json` and the masked
   IAM PATCH command are already prepared in MINIMAL-RELEASE.md; NOT executed.
5. Publish ONLY the release payload's sipapua-maintenance.js (registration:false)
   to reopen. Perform authorized post-publication checks. Do not declare LIVE
   from HTTP 200 alone. Production signup/activation smoke tests require explicitly
   approved accounts/actions because they write data.

New UID readers work under both old and new Rules; old cached email-query pages
cannot be guaranteed to work after the Rules switch. Require reload and an approved
controlled transition for registration/activation. There is NO claim of zero
interruption for old cached clients, and no broad Rules exception is introduced.

Commands AFTER explicit deployment approval, from the main workspace (no commands
were executed here):

```powershell
$release = Join-Path $PWD 'docs\activation-restoration\release-check\2026-11-14T04-09-56-748Z'
firebase deploy --project boby-apps-project --config (Join-Path $release 'firebase.release.json') --only firestore:rules
```

On failure: pause registration, restore the exact Rules backup, restore website
sources by the rollback PR above with pause retained, wait for successful Pages
deployment and verify old access. Reopening remains a separate decision.

```powershell
firebase deploy --project boby-apps-project --config (Join-Path $release 'production-backup\firebase.rollback.json') --only firestore:rules
```

Owner action remaining: explicit release authorization for the controlled sequence
above. The real-browser result is already PASS. No new inventory, architecture,
ownership-clear index or unaffected suite is required.
