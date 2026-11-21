# Staging test results

| Verification | PASS | FAIL | BLOCKED |
|---|---:|---:|---:|
| RC-02 Node test runner, including two Firebase emulators | 22 | 0 | 0 |
| Existing QR and chat regression | 13 | 0 | 0 |
| Hosted acceptance gates in the Owner checklist | 0 | 0 | 5 |
| Total | 35 | 0 | 5 |

Run from the workspace root using Node with SQLite support, installed project dependencies, local Firebase CLI Auth emulator module, Java and a cached Firestore emulator JAR. Set `SIPAPUA_TEST_DEPS` to the workspace root and `SIPAPUA_TEST_AUTH_SERVER` to the installed Firebase CLI Auth server module. Set `SIPAPUA_FIRESTORE_JAR` if the emulator JAR differs from the harness default.

```text
node --test candidates/qr-rc-02/test/*.test.mjs
```

Auth and Firestore listen on 127.0.0.1 with project `demo-sipapua-qr-rest`. The Node runner counts the emulator parent test and six subtests. REST owner access uses an actual emulator bearer. An emulator account revoke and disable were rejected before the mock verifier consumed App Check. The isolated Rules proposal rejects anonymous, cross-UID, list and client writes, and the harness asserts that the root Rules file remains byte-identical.

The Worker and adapter checks use synthetic JWTs, mock verification and ingress bindings, and real SQLite for D1 SQL semantics. They exercise issue/lookup, expiry, replay, revocation, current owner checks, concurrent scans, cooldown, quotas, cleanup, outages, origin restrictions and maintenance. The SDK check imports the installed public modular API. Hosted consumption, a browser using a real App Check provider, Cloudflare quota/schedule behavior and physical QR remain blocked.

Registration maintenance is verified in configuration. Connected registration, Rapor and Big Data regressions were not rerun in RC-02. Their active files and Rules are unchanged. The staging Rules review must run those flows against the selected staging baseline.
