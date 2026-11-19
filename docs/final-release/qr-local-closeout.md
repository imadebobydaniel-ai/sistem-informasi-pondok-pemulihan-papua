# SIPAPUA Digital Member Card QR local closeout

## Status

**Local integration complete. Production readiness: NO.** The demo emulator run verified the QR-to-contact flow against the unchanged active Firestore rules. Registration remains on hold and member-card maintenance remains enabled. No production access, deployment, or Git publishing occurred.

The workspace remains on `test/sipapua-emulator-guard-20261110` at `ed272d43621f1e211bec9898503ee2d91e362414`. The R1–R4 evidence and all pre-existing Git status entries were preserved.

## Implemented behavior

1. The existing signed-in member card issues a short-lived random card token. Newly rendered codes carry plain QR text. The scanner consumes the token through single-use tab storage and opens the result page without placing it in the page URL. The decoder also accepts the earlier short-lived custom QR payload and rejects email QR codes.
2. The result page calls `scanQrIntroduction` through the existing Firebase Auth and App Check helper. The backend reuses R1's lookup, scan cooldown and canonical member checks. It verifies the current card, recipient opt-in, blocks and prior friendship state before minting a receipt. It returns only name and verified NIJ, if available, as display fields.
3. The receipt is scanner-bound, target-bound, single use, and valid for at most 60 seconds and only while the referenced card remains valid. The browser keeps it in memory. The application's QR and receipt paths emit no token or receipt values in logs.
4. Tapping Add calls `requestQrIntroduction`. The server rechecks both accounts, the card, opt-in, blocks and duplicates before atomically consuming the receipt and creating the existing `friend_requests` pending document. QR opt-in is independent of directory discoverability.
5. The recipient's existing menu acceptance handler still updates the request and creates reciprocal contacts in one batch. Scanning creates neither a friendship nor a group membership. No messaging service or chat module was added.

## Verification

| Check | Result |
|---|---|
| Combined QR and friendship emulator suite, synthetic Auth, Firestore and Functions, using the active rules | **PASS, 7/7** |
| QR page syntax, browser helper and real Add handler in a test harness | **PASS** |
| Missing App Check on both exported HTTP endpoints | **PASS**, denied with a valid synthetic Auth session |
| Card lookup, receipt expiry, rotation, replay, cross-account redemption, duplicate attempts, opt-in, bilateral blocks, recipient acceptance and reciprocal contacts | **PASS** |
| Directory-hidden recipient with explicit QR opt-in | **PASS** through the server flow. The direct client write remained denied. |
| Existing UMKM chat regression | **PASS, 11/11** |
| Successful HTTP calls with live App Check, camera and APK behavior, and configured Node 22 runtime | **NOT TESTED**. Positive handlers used synthetic App Check context and local Node 24. |

Run the combined regression from the workspace root with the local Firebase CLI and cached emulators.

```powershell
$env:GCLOUD_PROJECT = 'demo-sipapua-member-card'
$env:METADATA_SERVER_DETECTION = 'none'
firebase.cmd emulators:exec --project demo-sipapua-member-card --only auth,firestore,functions 'node --test --test-concurrency=1 tests/member-card-emulator.cjs tests/member-card-friendship-emulator.cjs'
```

## Administrator and application audit handoff

- **Recipient opt-in.** The flow defaults to deny. It reads the protected `qr_friend_preferences/{uid}.allowQrIntroductions` flag. Only synthetic fixture provisioning was tested. A separately approved process is needed to capture, record, and revoke recipient consent. A member's directory setting does not grant QR opt-in.
- **Identity and privacy.** R1 requires a canonical active profile for QR. A noncanonical legacy member needs a trusted binding plan, and NIJ remains unavailable without a matching protected allocation. The active rules still expose full `users` documents independently of QR. R2 privacy rules would deny the current Spark direct registration and broad legacy queries. This QR friendship flow requires neither activating those rules nor modifying registration.
- **Chat.** Existing chat modules were unchanged. The active rules still deny `mutual_chats` and `sipapua_group_rooms`. That is a separate release blocker if personal or group chat is in scope. QR acceptance itself already works under the active rules.
- **Operations.** Approve expired-receipt retention and cleanup and verify the configured Functions runtime, live App Check transport, and physical QR scanning before considering activation. Keep maintenance enabled until the release gate is approved.

## Files

- `functions/index.js`
- `functions/member-card.js`
- `functions/qr-friendship.js`
- `sipapua-member-card.js`
- `bio-singkat-jemaat.html`
- `tests/member-card-friendship-emulator.cjs`
- `docs/final-release/qr-local-closeout.md`
