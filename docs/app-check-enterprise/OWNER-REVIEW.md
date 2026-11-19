# App Check Enterprise patch — implemented/tested, Owner review required

## Local implementation

The Owner-approved existing public key is configured in `sipapua-app-check.js`:
`6LcepNEtAAAAAFuRFqJWbzCbkdWXzKYf_xr7kQ_i`.

The helper now requires `firebase.appCheck.ReCaptchaEnterpriseProvider`, constructs
that provider explicitly and calls `activate(provider, true)`. Token acquisition,
rejection of empty/invalid tokens, initialization idempotence, key-change rejection
and fail-closed behavior remain. There is no v3 fallback or debug token/provider.

All existing Firebase imports on the 18 approved callers use official CDN
**12.18.0 compat** modules, with one consistent version within each page. The
existing namespaced API, project `boby-apps-project`, Web App ID
`1:125984859692:web:09f75df5d2e4b6e3bcd389`, and `asia-southeast2` region remain.
Only SDK URLs changed in the HTML; normalized source hashes prove all other
markup, CSS, inline code, forms, navigation and activation UI are retained.

Implementation order: registration/login/verification/administrator activation,
then the remaining approved module callers. No Firebase configuration/provider,
production data, active Rules or backend was changed. No commit, push, merge or
deployment was performed. Original untracked files were retained.

## File manifest

- Shared implementation: `sipapua-app-check.js`.
- Registration/login/activation: `registrasi.html`, `index.html`,
  `auth-handler.html`, `verify-success.html`, `edit-jemaat-administrator.html`.
- Existing module callers: `informasi-email.html`, `menu.html`,
  `kartu-digital.html`, `baca-alkitab.html`, `games.html`, `call-center.html`,
  `halo-pope.html`, `laporan-pelayanan.html`, `profil.html`, `cetak-kartu.html`,
  `setting.html`, `database-jemaat.html`, `chat-umkm.html`.
- Updated existing affected tests: `tests/integration-003/security-assets.cjs`.
- New tests: `tests/app-check-enterprise/compat.test.cjs`, `download-sdk.cjs`,
  `browser.cjs`, `.gitignore`.
- Evidence: files in `docs/app-check-enterprise/`.

`PATCH-BASELINE.json` captures pre-patch hashes. Backend files, active Rules,
`firebase.json`, registration/lifecycle helpers outside the approved scope, and
the original two untracked files are checked against those hashes.

## Actual validation

| Check | Result |
| --- | --- |
| Enterprise compatibility tests, exact 18-page scope and preserved protected files | 6 PASS |
| Existing integration-004 frontend/session/activation/edit/delete regressions | 12 PASS |
| Existing guest-chat regressions | 11 PASS |
| Affected integration-003 App Check/registration gate tests | 4 PASS |
| Real Chrome + official compat SDK | 5 scoped checks PASS |
| Helper/new runner syntax and Git whitespace check | PASS |
| Real App Check token issuance | NOT PROVEN / BLOCKED |
| Full positive registration → verification → activation → login browser E2E | NOT RUN; cloud/attestation gates remain |

Totals are **33 distinct static/mock tests PASS, 0 remaining FAIL**, plus **5
scoped browser checks PASS**. Six compatibility tests and four helper tests were
rechecked after final adjustments; repeated runs are not added to the totals.
Unchanged backend, NIJ, Rules and geography suites were not repeated.

The official CDN bytes for App/Auth/Firestore/Functions/App Check were downloaded
only to ignored `tests/app-check-enterprise/_runtime-sdk/`, checked against the
SHA-256 values recorded during the approved SDK selection, and used by Chrome.
They were not copied into production site assets. Temporary browser profiles and
stderr logs remain under ignored `_runtime-browser-*` folders.

The browser harness serves local source and binds Firebase initialization to a
synthetic demo project only inside the test harness. It fulfills the exact official
SDK requests from checksum-verified local bytes and blocks every non-loopback
request. The actual SDK attempts `/recaptcha/enterprise.js`, not the v3 script.
The real registration and login pages initialize compat successfully. Registration
does not forward a backend request when attestation is unavailable. Observed
backend requests: **0**. Auth accounts created: **0**. NIJ allocations: **0**.

Initial harness assumptions were corrected: source comparisons normalize Windows
line endings, and a blocked reCAPTCHA script can leave the SDK token promise pending
rather than promptly rejected. The final browser assertion proves no token or
backend forwarding during that condition; mock tests separately prove explicit
token rejection. The application was not modified to fabricate a response or
bypass the pending attestation. Initial harness failures are not production bugs
and are not counted as passing executions.

## Meaning of this result and remaining blockers

The earlier local **missing key / unsupported Enterprise SDK** blockers are fixed.
The new code can initialize the real Enterprise provider; mock success confirms
the existing registration and member-session gates forward only after a token.
**This does not establish that a legitimate token was issued.** The safe local
browser test intentionally blocked external attestation and obtained no real token.

The existing key was supplied and authorized by Owner. Its binding to the exact
Firebase Web App, score-based Enterprise configuration and allowed production
hostname still require official read-only cloud evidence. No cloud account or key
registration is created by this patch. Prior Auth configuration evidence already
confirmed `imadebobydaniel-ai.github.io` is an authorized Auth domain; this is
distinct from reCAPTCHA's own domain registration.

Next verification: use authorized access to the existing Web App's App Check
Enterprise configuration and confirm the exact existing key and production domain.
Then validate real attestation on an authorized hosting origin with data/backend
operations isolated appropriately. Do not add localhost to the production Enterprise
key, disable enforcement, reuse production member data or substitute a debug token.
The current browser result cannot be described as successful production attestation.

Functions deployment/version, registry readiness including `maintenance:false`,
the private Rules release gate and other outstanding release gates remain separate.
The earlier v3-only metadata script under `tests/release-gate-005a/` is a historical
check and is not proof of Enterprise configuration. It was not modified or rerun.
Historical evidence files that record `siteKey:null` describe their original run;
this directory records the current patch.

## Reproduction

```powershell
node --test tests/app-check-enterprise/compat.test.cjs tests/integration-004/frontend.test.cjs tests/release-blocker-closeout/chat.test.cjs
node --test --test-name-pattern="App Check|registration gate" tests/integration-003/security-assets.cjs
node --check sipapua-app-check.js
node tests/app-check-enterprise/download-sdk.cjs
node tests/app-check-enterprise/browser.cjs
git diff --check
```

The downloader accesses only the official SDK CDN. The browser requires permission
for owned Chrome process control; it does not need access to production Firebase.

Official references:
[Enterprise provider and automatic refresh](https://firebase.google.com/docs/app-check/web/recaptcha-enterprise-provider),
[compat namespaced API](https://firebase.google.com/docs/web/modular-upgrade),
[SDK release notes](https://firebase.google.com/support/release-notes/js).

APP CHECK ENTERPRISE PATCH — IMPLEMENTED / TESTED / OWNER REVIEW REQUIRED
