# Local verification

**24 PASS, 0 FAIL.** The final artifacts were exercised in two runs. The Firebase emulator test file and its Rules/authority inputs were unchanged after the combined run.

| Scope | Result | Evidence |
|---|---:|---|
| Firebase Auth and Firestore | 7 PASS | One parent and six subtests on loopback, project `demo-sipapua-qr-rest`. Active Rules denied allocation. The isolated patch permitted the owner's bearer, denied cross-UID, unauthenticated and anonymous access, and denied listing and mutation. Invalid canonical bindings, disabled accounts and revoked sessions were denied. |
| Worker, D1 SQL and adapter | 14 PASS | Production identifiers and unconfigured staging rejected. Synthetic issue/lookup, claims, App Check replay/expiry mock, revocation mock, owner check, atomic concurrent redemption, cooldown, quotas, cleanup, CORS and fault paths passed. VM adapter test observed redirect rejection configuration, abort at its 10-second fetch deadline, and discarded prior-session results. |
| App Check frontend API | 3 PASS | Installed modular SDK exported `getLimitedUseToken()`. Mock acquisition verified a fresh token per call and fail-closed behavior without fallback. |

Run with Node and installed local emulator dependencies. Set `SIPAPUA_TEST_DEPS` to the workspace root, `SIPAPUA_TEST_AUTH_SERVER` to the locally installed Firebase CLI Auth emulator server module, and `SIPAPUA_FIRESTORE_JAR` if the local emulator JAR differs from the harness default.

```text
git apply --check --ignore-space-change candidates/qr-rc-03/nij-owner-read.patch
node --test candidates/qr-rc-03/test/*.test.mjs candidates/qr-rc-02/test/limited-app-check.test.mjs
```

The adapter checks session and maintenance before collecting credentials, between token calls, and after the HTTP response. Its deadline covers the HTTP fetch and response body, while SDK credential acquisition has separate timing. A browser session change suppresses stale results but cannot recall a request already sent. Hosted network, provider latency, real browser/CSP and physical scan acceptance remain pending. The reference Worker and verifier are covered locally using mocks for edge and hosted App Check plus SQLite for D1 semantics. No hosted wiring, App Check token consumption or Cloudflare capacity is certified by these tests.

RC-02 recorded 35 PASS including 13 QR/chat checks. The prior QR/chat count is not part of RC-03 totals. Registration, Rapor, Big Data and chat connected regression is reserved for the approved staging baseline. Registration HOLD and member-card maintenance were verified in active configuration.
