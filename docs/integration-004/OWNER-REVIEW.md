# Integration 004 implementation review

Local implementation follows the Owner-approved manifest. No production access,
migration, commit, push, merge, deployment, new activation page, archive, trash,
retention schedule, or recovery workflow was introduced.

## Implemented

- The main Functions entrypoint retains all 13 original exports and the six
  registration exports, adding three explicit lifecycle/profile exports. There
  remains one Admin SDK initialization.
- `functions/member-lifecycle.js` provides `getSIPAPUAOwnProfile`,
  `updateSIPAPUAProfile`, and `deleteSIPAPUAProfiles`. Authorization is re-read in
  Firestore transactions. Existing active master/super_admin/admin/viewer edit
  and deletion authority is preserved; a caller can operate on their own profile.
- NIJ, allocation, counter, activation proof and arbitrary privilege fields cannot
  be edited through lifecycle payloads. Full ordinary editor payloads and existing
  base64/HTTPS photo formats are supported. Contact reservation checks and profile
  edits are atomic. New family links require the existing consent contract.
- Deletion physically removes the requested profile, as before. It creates an
  audit event but no archive. Permanent allocations, counters, reservations and
  previous audits are retained. Administrator Database Jemaat deletion does not
  acquire a new ability to delete another user's Auth account.
- `setting.html` retains its existing self-delete ordering (profile then Auth),
  and existing email/password handling/compensation. These are separate Auth and
  Firestore operations, not an atomic cross-service transaction. No new recovery
  policy was added. Administrator email edits are rejected atomically if the
  target's Auth email does not already match; no partial ordinary fields are saved.
- `sipapua-registration.js` retains the same helper method names, now routed to
  the authorized backend. No direct client ledger/profile transactions remain.
- Login reloads Auth, refreshes the token and requires backend confirmation.
  Verified new registrations may activate only from `Menunggu Verifikasi`.
  Verified `Pending` never auto-activates. Existing verified active legacy accounts
  can log in through read-only UID/unique-email resolution, without allocating a
  NIJ, writing a profile, or migrating a document ID.
- Manual activation uses the existing `edit-jemaat-administrator.html` form with
  identity attestation, active master/super_admin and `canActivateMembers=true`.
  Explicit manual activation of Pending is audited, retry-safe and does not change
  `emailVerified`. The full editor, Cloudinary widget and existing navigation remain.
- Own-email queries in menu, profile, settings, cards, reports, games, Bible,
  call-center, Halo Pope and email information pages use an authorized own-profile
  adapter. Auth restoration is awaited. Resolved legacy IDs can be used without
  rewriting stored profiles. Profile photo updates use the resolved document ID.
- Verification handlers distinguish verified email from server-confirmed
  activation. The existing verification-success page returns to `index.html`.
- The shared App Check helper remains fail-closed with its production key unset.
  New member callables use it; no production enforcement was disabled.

## Rules gate: NOT adopted

`firestore.final-proposed.rules` is a review artifact derived from the MAIN Rules
and the stage 003 proposal. It is tested locally but is not referenced by
`firebase.json`. The active `firestore.rules` remains unchanged.

The proposal permits authorized profile/allocation reads and denies direct client
root-profile creation/edit/deletion, counter/reservation/ledger/audit manipulation
and activation writes. Existing unrelated Rules were not replaced wholesale.
The following incompatibilities still prevent calling it release-ready:

1. Pre-login family name search in registration currently queries private profiles.
   The consent-bound NIJ lookup exists, but a complete pre-login replacement cannot
   expose that private directory. The existing form was not silently removed or
   replaced with the candidate's empty-search implementation.
2. The client preparation module still writes readiness/counters/reservations.
   A trusted preparation workflow needs separate implementation/review; no such
   operation was run against production.
3. Other legacy collections still have public Rules contracts. Their schemas and
   callers have not been certified as free of private member data. No blanket deny
   was used that would break unrelated modules.
4. Legacy records without a matching Auth identity, ambiguous ownership or duplicate
   profiles require explicit review. They are not guessed, migrated or activated.
5. Legacy unverified records with a different document ID are resolved only after
   a valid administrator audit. Their own-profile adapter delivers the authorized
   backend snapshot; it does not open a direct email-based realtime subscription
   before verification/explicit UID ownership. Realtime updates for this newly
   supported override path need a reviewed contract; no polling policy was added.

## Local validation

```powershell
node --test tests/integration-004/backend.test.cjs tests/integration-004/frontend.test.cjs
node tests/integration-004/rules.cjs
node tests/integration-004/emulator-e2e.cjs
git diff --check
```

Backend/frontend static/mock regression: **28 PASS, 0 FAIL**.
Isolated real Firestore Rules emulator: **26 groups PASS, 0 FAIL**.
Final real Auth/Firestore/Functions HTTP E2E: **10 groups PASS, 0 FAIL**, including
the existing self-Auth deletion sequence after backend profile deletion.

The emulator suites create fresh demo processes on unused loopback ports, never
connect to candidate/stage4 emulator endpoints, reset an existing emulator, or use
real identities. The API E2E executes the actual MAIN Functions entrypoint with
Node 22. All requests target its loopback demo project. Email verification uses
genuine Auth Emulator OOB issuance/application, not an admin `emailVerified` update.
Normal emulator behavior is tested; this is not production App Check attestation.

Windows required permission for process control during API E2E. Earlier attempts
found a cross-drive CLI source-path issue and a discovery timeout. The test config
now uses a same-drive relative source, explicit discovery timeout and disables
cloud metadata detection for the local runner. No application security bypass was
added. Runtime configs/logs/synthetic tokens live only in ignored `_runtime-*`
test directories or the system temporary directory. They are NOT public assets.

Syntax, scoped manifest and Git whitespace checks pass. The unchanged prefix of
`functions/index.js` proves existing handler/scheduled-function source is retained.
The two pre-existing untracked files retain their recorded SHA-256 hashes.
No full real-browser E2E, Cloudinary upload, production-domain/App Check exercise,
or complete interactive regression of every existing module is claimed.

## Remaining production configuration/decisions

- Legitimate App Check site key and verified Firebase/Auth/Pages/custom domains.
- Trusted provisioning of administrator activation permission; production
  administrator documents were not changed in this task.
- Administrator email changes across Auth/Firestore need an Owner-approved
  workflow. The mismatched operation currently fails closed without partial save.
- Auth/profile self-deletion cannot be atomic across the two services. Its existing
  sequence is preserved; failure recovery/archives need a separate Owner decision.
- Resolve the Rules gates above, then browser and full module regression before
  any Rules adoption or release. Do not publish the raw repository as an artifact;
  exclude tests, runtime directories, Functions sources and review proposals.
