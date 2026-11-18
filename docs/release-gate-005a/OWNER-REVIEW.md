# Release gate 005A — NO-GO

Implementation and local tests follow the Owner-approved 005A manifest. Stages
001–004, the existing administrator activation form and the original untracked
files are retained. No production member data or Firebase production settings
were read/modified. The App Check check inspected local authorization metadata;
it found no authorized CLI account, so no cloud metadata request was made.
No commit, push, merge, deploy, registry migration, fake site key or App Check
enforcement exception was introduced.

## Actual application file changes

| File | Scope |
| --- | --- |
| `functions/registry-preparation.js` (new) | Explicit audit/prepare/enable/abort callables, active master/super_admin authorization and fingerprint-bound transactions. |
| `functions/index.js` | Four explicit registry exports and one family search export; all prior exports retained. |
| `functions/registration-paket-a.js` | Authenticated consent/admin-scoped name lookup, minimal family DTO, legacy name aliases and rejection of own-profile alias links. Existing email mismatch rejection is unchanged in lifecycle backend. |
| `sipapua-registration-preparation.js` | Client facade only; no database transaction/batch/write path. The analysis API no longer suggests removing permanent reservations. |
| `registrasi.html` | Family search calls backend only; no whole-profile collection fallback. Existing form, free-text names, geography and verification UI retained. |
| `call-center.html`, `halo-pope.html` | Existing ticket creates now include Auth UID, required by the private Rules contract. Evidence: both write to `saran_masukan` without an ownership UID before this patch. No layout change. |

New tests and review artifacts are under `tests/release-gate-005a/` and this
directory. `firestore.rules` and `firebase.json` are intentionally unchanged.
The existing activation editor was not edited in 005A.

## Backend protections

Registry audit is read-only. Explicit preparation can create missing reservations
and monotonically advance counters, but never issue NIJ, migrate profiles, delete
allocations/reservations or lower a counter. Conflicting ownership, duplicate
permanent numbers, malformed identity/counter state and stale fingerprints fail
before any write. All reads, authorization and writes are in one transaction.
Plans over 450 writes are blocked for separate batch-workflow review; no unsafe
partial batch or recovery policy was added. An already-open registry cannot be
prepared again automatically. Audit events are server-written.

Family search requires Auth plus production App Check. Regular members search
only documents whose enabled consent grants their UID access (bounded to 50
consents and ten results). Existing active administrator roles can search the
private directory according to their existing access. Responses contain only
UID, name and NIJ. Rate limit is five lookups/minute. The old substring fallback is retained only on the server for active administrators already entitled to directory access; ordinary members never receive that query path. Before login the form still
accepts names as free text and explains why linked references require authorized
access. No account is created early to enable directory searching. Browser/login probes used only a new synthetic Auth identity in their own isolated emulator. Consent
provisioning remains a trusted workflow; client consent writes are denied.

## Tested Rules proposal — NOT adopted

`firestore.final-proposed.rules` is derived from the MAIN Rules, not copied from
the candidate. It removes unconditional public legacy collection access and tests:

- Own/admin profile and allocation reads, with all direct root-profile/identity/
  activation/counter/reservation/audit mutations denied.
- Private member records, administrative login logs, owner/admin store contacts,
  seller-owned product writes, participant-bound chats and seller read flags.
- Auth UID/email-bound ticket creation with administrative ticket access.
- Signed-in media/agenda/broadcast reads, existing role-specific management/delete
  behavior, and read receipts that can add only the current Auth email.
- Known member-readable config documents `playlist`/`running_text`; other config
  documents remain administrative.
- Existing active-role news, reports, statistics and social-presence contracts retained. Inactive master/super_admin cannot reactivate themselves, provision administrators, or read draft news; active master provisioning remains available.

The proposal is not wired into the deployment configuration because mandatory
release gates below are still blocked. The current production-target Rules file
still contains the baseline public permissions; do not deploy it as a release fix.

## Results

| Check | Result |
| --- | --- |
| Existing 004 + new 005A static/mock backend/frontend regression | **39 PASS, 0 FAIL** |
| Fresh real Firestore Rules emulator, roles/legacy modules/attacks | **31 groups PASS, 0 FAIL** |
| Fresh real Auth/Firestore/Functions HTTP E2E on main entrypoint | **13 groups PASS, 0 FAIL** |
| Actual Chrome, main pages, checksum-verified official v8 SDK | **4 scoped checks PASS** |
| Full positive browser registration/activation/login with valid App Check | **BLOCKED** |
| Existing Cloudinary widget callback with synthetic HTTPS photo (mock) | **PASS** |
| Real Cloudinary upload/cleanup | **BLOCKED; zero uploads attempted** |
| Production App Check registration/key/domain/enforcement verification | **BLOCKED** |

Browser checks cover renderer/network interception, actual national address/birth
dropdowns, Simpatisan clearing and fail-closed readiness, and a real synthetic Auth
Emulator login that does NOT establish application authorization without App Check.
The initial CDP target attachment bug was fixed by attaching directly to the page
target. No `--no-sandbox`, fake App Check token/provider, or security exception was
used. Firebase initialization is bound to demo emulators only inside the isolated
test harness, never in application files. Non-emulator Firebase requests are
blocked. The full positive flow remains blocked, not counted as a browser pass.

API E2E covers authorized registry bootstrap, registration/NIJ, genuine Auth OOB
verification, activation/login retry with one audit, unauthorized override denial,
edit/photo, private Rules, consent family search and original profile/Auth deletion
sequence while preserving permanent ledger/counter/reservations. It never accesses
the candidate's existing emulator or clears/reseeds a running emulator.

Runtime configs, browser profiles, synthetic tokens and logs remain only in
ignored `_runtime-*` test directories or system temporary directories. Publish
neither tests nor these review proposals as public application assets.

## Concrete blockers for 005B

1. **App Check:** the shared helper still has `siteKey: null`. The elevated
   read-only CLI metadata check found zero local accounts and no unexpired cached
   access token. No login/refresh or production configuration change was attempted.
   Cloud registration, domain authorization and enforcement therefore remain
   unverified. Supply a legitimate client key and read-only configuration evidence
   through normal account access, not secrets pasted into test fixtures.
2. **Positive browser E2E:** legitimate App Check configuration for the test/hosting
   domain is required. The observed fail-closed behavior cannot be called a Go Live
   success. Backend emulator success does not establish real attestation success.
3. **Cloudinary:** only the application's existing cloud/preset names are known.
   Their signing mode, safe synthetic-upload environment and disposable cleanup
   configuration have not been verified. No dedicated test cloud/preset was
   configured. The runner requires a designated test target and a preset already
   configured to return a delete token; it never changes a preset or requests an API
   secret. Callback mock and backend photo success do not prove provider upload.
4. **Legacy guest chat:** the existing customer caller uses `customerAnonymousId`
   rather than a proven Auth UID; its standalone source also lacks the bootstrap
   definitions it references. The private chat proposal correctly denies these
   unproven identities. No guessed historical-ID migration or anonymous access
   exception was added. An authenticated guest/ownership contract and regression
   of that real UI are needed before proposal adoption.
5. **Remaining legacy coverage:** current seller/admin product and store operations,
   tickets, media, broadcasts and reports pass scoped Rules tests. No verified
   client rating writer or unknown historical/private collection schema was found;
   the proposal does not invent authorization for them. Complete interactive
   regression and review of actual legacy contracts are still required. No claim
   is made that every existing module has passed a real browser test.
6. **Production registry readiness:** intentionally not inspected or initialized;
   no real member data was accessed. A separately authorized production preflight
   is needed. Oversized preparation plans and existing data conflicts remain
   explicit review stops, not automatic migrations.

Safe rejection of administrator email changes inconsistent with Firebase Auth is
preserved and regression-tested. No new archive/recovery/deletion policy was added.
These blocks remain **NO-GO**, not reasons to weaken Rules or App Check.

## Reproduction

```powershell
node --test tests/integration-004/backend.test.cjs tests/integration-004/frontend.test.cjs tests/release-gate-005a/contracts.test.cjs
node tests/release-gate-005a/rules.cjs
node tests/release-gate-005a/emulator-e2e.cjs --api-only
node tests/release-gate-005a/emulator-e2e.cjs --browser-only
node tests/release-gate-005a/app-check-readonly.cjs
node tests/release-gate-005a/cloudinary.cjs
git diff --check
```

Windows may require permission for owned emulator/browser process control and the
CLI authorization metadata file. Blocked configuration/browser-only checks return
a nonzero diagnostic exit status. Read JSON/console results; do not infer Go Live
readiness from the API-only runner exit code.

Protocol references used to verify the read-only/test tooling:
[Firebase reCAPTCHA v3 configuration GET](https://firebase.google.com/docs/reference/appcheck/rest/v1/projects.apps.recaptchaV3Config/get),
[Firebase service configuration list](https://firebase.google.com/docs/reference/appcheck/rest/v1/projects.services/list),
[Cloudinary upload parameters](https://cloudinary.com/documentation/image_upload_api_reference#unsigned_upload_parameters).
