# Final release gate: BLOCKED

Evidence baseline: `release-check/2026-11-14T03-52-44-934Z/MANIFEST.json` and its
actual production Rules/public-source backups. Activation 19 PASS and packaging
3 PASS retained; neither suite was repeated. No production data/configuration
changes, Git mutations, inventory, or registration-code changes were performed.

## 1. REAL_ENTERPRISE_TOKEN_AND_CLIENT_READ_NOT_VERIFIED — pending browser evidence

Cloud GET 200 confirms the expected Web App Enterprise key binding, SCORE key,
and Pages domain. Firestore App Check enforcement is UNENFORCED. This does not
prove attestation, nor does a successful Firestore read alone prove token validation
under enforcement. No enforcement change is requested as a workaround.

Minimum Owner action: open the existing Pages site in a normal browser without a
debug provider; inspect and run `enterprise-browser-readonly.js` in DevTools.
It guards the exact origin/path, project and Web App, uses official modular SDKs,
forces a real Enterprise token, and performs one SDK server GET of public
`registration_control/state`. Report only the three booleans and category printed.
No sign-up, sign-in, profile read, activation or data write is performed. The SDK
token exchange is normal App Check traffic, not a Firestore/configuration write.
This checks the intended origin/Web App; it does not prove the unpublished runtime
or a signed-in user's private-profile flow. Inspect the script before pasting.

Provider setup follows the official Firebase documentation:
https://firebase.google.com/docs/app-check/web/recaptcha-enterprise-provider

## 2. REGISTRY_READINESS_NOT_CONFIRMED — confirmed blocker, exact cause isolated

All five counter documents returned 200 and passed the existing nonnegative integer
validation. This proves structural readiness only, not a new reconciliation of NIJ
history; no such audit is repeated or claimed.

One additional authorized, field-masked GET was executed with official gcloud
authentication outside the restricted sandbox. Sanitized result:

```json
{"endpoint":"REGISTRATION_STATE","httpStatus":200,"productionMutations":0,"enabled":true,"maintenance":"MISSING_OR_WRONG_TYPE","expectedVersion":true,"ready":false}
```

Production `registrationReady()` requires enabled and version; proposal
`sparkReady()` also requires an explicit boolean maintenance=false. Therefore
deploying the proposal against this state will reject registration.

Minimum Owner action: separately approve setting ONLY the registry control field
`registration_control/state.maintenance` to boolean false at the coordinated
reopening step, preserving every other field. Keep website registration paused
during the transition. No member, NIJ, counter or reservation change is required.
This approval/write has NOT occurred. Do not remove the proposal's guard merely
to bypass missing configuration. The bounded read can be repeated, if necessary:

```powershell
node docs/activation-restoration/check-state-readonly.cjs
```

## 3. OLD_PUBLIC_READER_COMPATIBILITY_NOT_VERIFIED — confirmed incompatible Rules-only deployment

Actual production Rules use UID/document ID or verified-email ownership; proposal
ownership removes email fallback. Existing public menu (line 1859), profile and
settings query users by email. These queries cannot prove ownership under the
proposal for ordinary members. Public index rejects unverified Auth email even
for manual activation; the old administrator editor lacks the required audit.
The prepared payload contains replacement consumers/helpers, so the three runtime
files alone are insufficient and Rules-first publication would break old callers.

Additionally the full proposal is NOT an activation-only delta: production allows
public access for several unrelated collections, whereas the proposal changes
login_logs, agenda_tahunan, saran_masukan, umkm_stores, rating_toko and chats (among
others). For example the proposal restricts umkm_stores reads to owner/admin and
denies rating_toko writes. These changes cannot be certified compatible by the
19 activation tests. Do not publish this entire proposal or broaden ownership
checks to preserve email queries.

Minimum next step: prepare a narrow local Rules delta from the captured actual
production Rules, confined to registration/profile/activation/audit contracts,
retaining unrelated module policy; review and test ONLY the affected delta with
the release reader payload. Preserve all existing proposals. This is local work,
not a reason to repeat inventory or the historical audit. The current task only
examined compatibility and did not replace Rules or application code.

## Publication and rollback decision

BLOCKED. The Rules payload currently frozen in the package is not approved for
deployment. The existing exact Rules backup and rollback config are available in
`release-check/2026-11-14T03-52-44-934Z/production-backup/`.
After the narrow delta and affected checks pass, obtain explicit Owner approval
for the paired publication window and the single registry-control update. Publish
matched readers/helpers/editor with registration still paused, install reviewed
Rules in the controlled window, confirm runtime readiness, then reopen with the
reviewed maintenance override. Old cached clients must reload; do not promise
uninterrupted operation during mixed versions.

Rollback: pause registration; restore the exact captured Rules through its
`firebase.rollback.json` and the backed-up website through the approved Pages
workflow. Recheck access before reopening. No deletion of member/audit/allocation
data, counter rollback or NIJ reset is permitted. No deployment was executed and
the public site is not declared LIVE.
