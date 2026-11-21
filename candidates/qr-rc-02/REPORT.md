# SIPAPUA QR-RC-02

Workspace baseline: `test/sipapua-emulator-guard-20261110` at `76cc5f8aac48618caf7411cc966f4665bcb57a6b`. The active checkout retains registration HOLD and member-card maintenance. QR friendship remains disabled.

RC-01 was preserved under `candidates/qr-rc-01-preserved/`. All 11 entries in its original manifest and the manifest itself were copied byte-for-byte. The integration Rules snapshot in that archive is the baseline for the RC-02 patch. The active checkout uses different Rules. Reconciliation with the Rules selected for hosted staging is a release gate.

RC-02 adds a candidate adapter and modular App Check bootstrap that request a fresh limited-use token for each QR operation. The fixed Worker origin is unset. The Worker, private authority reference, schema and owner-only Rules patch retain their RC-01 bytes. The local harness adds SDK API, expiry, dependency failure and integrated candidate adapter coverage. See the test record and acceptance checklist for environment boundaries and results.

Recommendation: GO for Owner review of the local release package. NO-GO for hosted staging deployment or production until the applicable acceptance gates pass.
