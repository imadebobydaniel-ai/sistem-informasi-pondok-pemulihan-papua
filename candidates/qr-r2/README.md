# SIPAPUA QR R2 local candidates

This directory is for isolated emulator review. The root Firebase configuration still selects the active rules. The receipt module is imported only by the candidate test and has no application or Functions entry point.

## Identity compatibility

Firebase Auth supplies the caller UID. The server registration path creates `users/{uid}` and `nij_allocations/{uid}` in a transaction. The allocation is the permanent NIJ source for that path, and registration proof also checks the profile and reservation records. The registry preparation module audits users, allocations, counters, and unique claims. Its presence establishes neither historical coverage nor successful migration.

| Synthetic case | Candidate behavior |
|---|---|
| Active canonical profile with a matching protected allocation | Own profile read and QR with verified NIJ |
| Active canonical profile without a matching allocation | Own profile read and QR with `nij: null` |
| Noncanonical profile with an administrator-verified, server-written `member_identity/{uid}` binding | Direct read at the bound profile ID. QR R1 still requires a canonical profile. |
| Noncanonical profile found only through email or its editable UID | Full profile discovery denied. An approved ownership proof and a direct-read path are needed. |

Only trust a legacy binding after its provenance has been audited. The candidate denies all client writes to the binding collection. Synthetic allocations use fabricated identifiers and exist only in the emulator.

## Rules scope and known compatibility gaps

- The candidate starts from the active rules and changes full-profile authorization and the two chat namespaces. Administrator profile access retains the active role policy.
- Own-profile direct gets and pending canonical profile creation remain possible. Client registration may attach an NIJ only if a protected allocation already matches it. The Spark client transaction needs direct access to registration control, counters, allocations, and claims. Those paths remain closed here. Browser email or UID collection queries for legacy login also require a verified direct-read resolver or a narrow server endpoint. Registration and login code are outside this candidate.
- Personal chat derives participants from the accepted request and checks both reciprocal contacts. Existing thread membership must match those participants. The current pair ID remains a routing key. Historical UIDs containing underscores can still produce a pair ID collision, which can block another pair from creating a request. The candidate does not grant access on the basis of that key alone.
- Group chat retains the verified-email, active-member policy for the single official room. Active master and super admin users can moderate. The candidate preserves the rolling limits and requires an atomic, matching moderation log entry.

## QR introduction model

An authorized scan can mint a receipt only while the target has opted into QR introductions. The protected preference is independent of directory discoverability and defaults to deny. Only the digest is stored. Redemption rechecks card validity, the scanner and target, opt-in, account status, blocks, and existing friendship state. It consumes the receipt and creates the existing pending request atomically. Contact creation still requires recipient acceptance. The proposal needs an approved way for the recipient to manage the preference, plus issuance throttling and expired-receipt cleanup before an application integration.

## Isolated verification

Run from the workspace root with the locally installed Firebase CLI, Java, and cached Firestore Emulator. Use the demo project and the candidate configuration together.

```powershell
$env:GCLOUD_PROJECT = 'demo-sipapua-qr-r2'
$env:METADATA_SERVER_DETECTION = 'none'
firebase.cmd emulators:exec --config candidates/qr-r2/firebase.candidate.json --project demo-sipapua-qr-r2 --only auth,firestore 'node --test candidates/qr-r2/compatibility.test.cjs'
```

The test checks the demo project and loopback emulator endpoints before creating synthetic users or fixtures. Receipt and QR handlers receive synthetic App Check context. Live attestation and browser integration are outside this test.
