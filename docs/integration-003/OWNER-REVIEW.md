# Integration 003: Owner review

Local preparation only. No commit, push, merge, deployment, production Firebase
access, Auth account creation, registration callable execution, counter migration,
or reset of an existing emulator was performed.

## Security decision: production remains blocked

`firestore.rules` is intentionally unchanged. Applying a registration-only lock
would break existing client lifecycle operations. The proposed file
`firestore.registration-proposed.rules` was derived from the MAIN Rules, replacing
only the users/subcollections block and adding explicit registration collections.
It is NOT referenced by `firebase.json` and must NOT be deployed as a release file.

The proposal denies client profile creation/deletion, changes to NIJ, identity,
activation status/proof, and writes to counters, reservations, allocations, audit,
readiness, consent, and lookup quota. Owners can read their own profile/allocation;
active existing administrator roles can read/list profiles/allocations. Nonidentity
editor saves remain available, including a payload containing unchanged identity
fields. Existing unrelated Rules are preserved, not copied from the candidate.

Confirmed blockers:

- MAIN Rules allow anonymous profile/nested-profile reads. Own allocation reads
  are denied by the default rule, so frontend confirmation is blocked.
- The proposal blocks Database Jemaat single/bulk deletion and settings account
  deletion because the current helpers also remove identity reservations.
- Email/WhatsApp/location/NIJ edits and direct administrator status changes need
  separately reviewed trusted services. Do not relax immutable fields to restore
  these paths. Activation belongs in the audited callable and existing Owner form.
- The existing client preparation module writes readiness/counters/reservations.
  The proposal denies those writes too; approved preparation must move to a
  separately reviewed trusted administrative workflow, not a Rules exception.
- Email-only user queries in menu/cards/reports and family search are incompatible
  with owner-private Rules. Use authenticated UID-scoped access or a consent-bound
  minimal lookup contract; do not restore public profile access.
- Other MAIN Rules still contain public legacy contracts (`jemaat`, `login_logs`,
  `chats`, etc.). Their actual schemas/callers need review before claiming private
  data is protected across the application. Unrelated modules were not blocked
  wholesale. Unknown nested write contracts and administrator permission
  provisioning also remain to be reviewed.
- Existing viewer profile edit capability is preserved in the proposal to avoid
  silently changing current roles; the Owner must explicitly approve any role-policy
  change. This is not certification of the legacy permission design.

## App Check

`sipapua-app-check.js` uses the already loaded Firebase v8 App Check SDK,
reCAPTCHA v3 `activate(siteKey, true)`, and token acquisition before callables.
Repeated initialization with the same configuration is idempotent; changing a key
in the same instance is rejected. No debug token, emulator exception, guessed key,
or backend enforcement change was added.

The default site key is **null**. Supply the legitimate registered production site
key in that helper only after verifying the Firebase app identity, reCAPTCHA
registration, GitHub Pages/custom domains, and Auth authorized domains. Missing
configuration/SDK/token/network causes registration to stop before Auth creation.
Production App Check behavior is NOT verified by the local mocks.

## National geography assets

Public payload: `assets/wilayah/v2/` only. There are 7,838 endpoint JSON files plus
a provenance/checksum manifest. Each endpoint publishes only `{data:[{id,name}]}`;
no member data, emulator artifacts, caches, logs, fixtures, or raw source directory
was copied. Source data is the candidate's complete national snapshot, not a
download performed during this task.

Counts: 38 provinces, 514 regencies, 7,285 districts, 83,762 villages. Every source
file's byte count/SHA-256 and every parent/child edge was checked before writing.
The projected byte counts/checksums and source checksums are recorded per endpoint.
Source manifest SHA-256:
`aa26a8dd2bef439aeee56b6800d1b32b3e0f3f650a9a8743de84fbda2af5353d`.

The loader uses `./assets/wilayah/v2`, so it resolves below the repository path,
supports address/birthplace, rejects malformed data, retries failed requests, and
ignores stale responses after parent changes. Old draft geography codes from the
v1 provider may need reselection; no guessed translation or member-data rewrite
was added. The form field structure and verification/resend flow are preserved.

## Reproducible local checks

```powershell
node --test tests/integration-003/security-assets.cjs
node tests/integration-003/rules.cjs
node --check sipapua-app-check.js
git diff --check
```

The Rules runner requires Java and a local Firestore emulator JAR. It creates its
own Firestore-only process on an unused loopback port and uses only
`demo-sipapua-security003`. SDK mock authenticated contexts do not create Auth
accounts. Rules-only synthetic fixture documents issue no NIJ and call no
registration function. Test logs remain in the system temporary directory. The
runner never clears a database and stops only the process it created. It compares
baseline and proposal, so baseline exposure and known lifecycle incompatibility
are expected observations, not security or production-readiness passes.

Final local results: **11 asset/App Check/static/HTTP groups PASS**, **26 real
Firestore Rules emulator groups PASS**, no failed/skipped cases in the final
runs. JavaScript syntax and tracked Git whitespace checks pass. Both Stage 001
backend files and the two pre-existing untracked files retain their recorded
SHA-256 hashes. The active Rules and existing Owner form remain unchanged.
Full browser E2E and full application module regression are NOT claimed.

Offline asset rebuild, after review, requires an explicit snapshot directory:

```powershell
node scripts/build-wilayah-national.cjs '<candidate>/.region-v2-national'
```

Tests, scripts, Functions sources, this Rules proposal/review, and any evidence
must be excluded from the public release artifact. Only allowlisted application
files and the projected public assets should be published. No Pages artifact was
built/published and no hosting workflow was changed in this stage.

Next: resolve lifecycle and UID-query contracts, adopt a reviewed Rules patch,
provide legitimate App Check configuration, then run full browser/module
regression before a separately authorized release.
