# R4 QR friendship integration

This is an isolated candidate. There is no import from the active Functions entry point or application pages. Registration remains on hold and member-card maintenance stays enabled.

## Flow

1. The existing scanner hands off a token through tab session storage. The adapter consumes that token with the existing member-card helper, which restores Auth and acquires App Check before the call.
2. `scanQrIntroduction` composes the R3 canonical profile resolver, R1 card lookup and scan cooldown, and R2 receipt minting. Legacy profile access alone does not qualify an account for QR. R1/R2 keep their existing active-account policy.
3. The adapter returns only the member display fields and keeps the receipt in memory until the scanner explicitly requests friendship. The receipt expires within 60 seconds and can expire sooner if the card does.
4. `requestQrIntroduction` is the R2 redemption handler. It rechecks current card status, both accounts, recipient QR opt-in, both block directions, and prior requests and contacts. In one transaction it creates the existing `friend_requests` pending document and removes the receipt. The user never supplies a target UID.
5. The existing recipient acceptance handler writes the accepted request and both contacts in one Firestore batch. There is no group or chat membership write.

## Isolated test

Run from the workspace root. The R3 emulator config supplies the deny-all bootstrap and loopback endpoints. The test loads the unchanged R2 candidate Rules into the separate R4 demo project.

```powershell
$env:GCLOUD_PROJECT = 'demo-sipapua-qr-r4'
$env:METADATA_SERVER_DETECTION = 'none'
firebase.cmd emulators:exec --config candidates/qr-r3/firebase.candidate.json --project demo-sipapua-qr-r4 --only auth,firestore 'node --test candidates/qr-r4/integration.test.cjs'
```

The test validates emulator endpoints before creating synthetic accounts. It executes the existing browser helper and the unmodified acceptance handler from `menu.html` in a VM. App Check is simulated and callables run in-process. The test does not open a camera, render the pages, or use a live App Check provider.

## Integration decisions before activation

The candidate needs an approved preference management path for recipient opt-in, an expired-receipt cleanup policy, and live browser and callable transport verification. End users still use the current QR and friendship screens. Any application wiring, shared Rules activation, and deployment require separate authorization.
