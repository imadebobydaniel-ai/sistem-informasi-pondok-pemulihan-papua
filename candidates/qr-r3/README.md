# R3 registration compatibility gate

Local evidence only. The R3 config starts with deny-all rules and the test explicitly loads the unchanged R2 rules into its demo Firestore project. Registration, active Rules, R2, and application entry points are outside this candidate.

## Existing workflow

| Step | Existing client and Firestore operations | Server path available for future review |
|---|---|---|
| Firebase Auth account | The form runs preflight before account creation. It calls Auth signup, reuses the same signed-in email, or attempts password sign-in after an existing-email error. Auth alone writes no Firestore profile or allocation. | Keep Auth signup and credential recovery separate from the profile transaction. |
| Readiness | The Spark client reads `registration_control/state` and requires the expected enabled, maintenance, and version values. | `registrationReadiness` reads that document and `nij_counters/{region}` and returns readiness. |
| Profile creation | The Spark transaction reads `users/{uid}`, requires absence, and creates it with `Menunggu Verifikasi`. It later writes child metadata in batches and re-reads the own profile and allocation from the server. | `registerSIPAPUAProfile` binds the payload to the Firebase UID and Auth email, validates input, and writes the profile with the allocation, counter, and claims in one transaction. It validates linked family refs against private consent and profile documents. |
| Permanent NIJ | The client transaction reads and advances `nij_counters/{region}` by one, and creates `nij_allocations/{uid}` with region, sequence, Jayapura-year NIJ, and timestamp. It copies the NIJ and sequence into the profile. | The existing Paket A callable does the same core allocation using the Admin SDK. The protected allocation is authoritative for the canonical path. |
| Unique email and WhatsApp | The same transaction reads and creates `registration_unique/email_{escaped-normalized-email}` and `registration_unique/phone_{normalized-digits}`, both bound to the UID. | The callable checks and writes both protected reservations in the same transaction. Auth verifies the email identity. Registry uniqueness does not verify ownership of a WhatsApp number. |
| Pending and activation | The form sends Auth verification mail after profile confirmation. Spark member status can attempt a direct profile update and a `registration_audit/{id}` write for a verified user. It re-reads status and may directly read an override audit. | `activateVerifiedSIPAPUAProfile` checks Auth verification, canonical profile, NIJ allocation, and both claims before updating status and writing an audit. The existing separate admin activation callable has role, permission, and audit checks. |
| Retry | The client may retry after a denied write only when a server read proves the regional counter advanced, with up to two retries. After a failed or uncertain profile write, the form uses own profile/allocation confirmation and credential recovery. The post-commit family writes can fail separately. | The existing registration callable returns `already-exists` on a committed replay. It does not allocate again. A future adapter needs a safe confirmation response for the same UID. Verified activation retries create no second audit for an already-active account. |

The registry preparation paths audit collection scans across `users`, allocations, counters and claims, compare a fingerprint, and can stage reservations and counters under a controlled gate. They cannot establish historic ownership from a mutable profile field. R3 performs no registry preparation or linking writes outside the synthetic emulator.

## Existing login and member-session access

- The current member-session facade accepts an email-shaped query only when it equals the current Auth email. It resolves a canonical document first through Spark member code. With no canonical document, Spark queries `users.uid == auth.uid` and depends on one result. This UID query is denied by R2. The facade's email-shaped argument is distinct from a raw Firestore email query.
- Existing server lifecycle logic can fall back to UID and email searches, with verification or activation-audit conditions for some legacy paths. The presence of these fallbacks does not establish that the matching profile UID is immutable under the active rules. R3 does not use discovery by email or UID fields.
- Spark member status reads the profile again after activation and can read `registration_audit` for administrative override evidence. R2 blocks direct audit reads and protected status writes. Active admins retain profile get and list access; this does not grant ordinary users a way to discover another member's document.
- The R3 resolver returns only the caller's allowed profile document ID and login status. A canonical document comes from the Auth UID. A noncanonical profile requires a server-written, audited-provenance `member_identity/{uid}` binding. The test models a binding with fixtures. The resolver checks Auth verification and account status and performs no activation. Audited overrides without verified email need a separately reviewed integration.

## Alternatives

| Option | Privacy and identity | Transactions and compatibility | Scope and risk |
|---|---|---|---|
| A. Narrow Rules exceptions | A canonical own-document get is safe and already in R2. Direct reads of arbitrary claim IDs or broad profile queries expose registry or private profile data. | Restoring Spark would require tightly coupled rules for reads, the allocation batch, status and audit writes, and retries. A weak exception risks NIJ or reservation integrity. | More rules surface and workflow retesting. Keep the canonical own-document get. |
| B. Authenticated server resolver | An Auth- and App Check-bound self resolver can return only a document ID and status. Historical users still need trusted binding evidence. | No allocation writes. Provides a safe route to R2's direct profile read. | Small isolated adapter. A future client entry point is required. |
| C. Canonical lookup with verified legacy mapping | Uses Auth UID and explicit verified ownership. Unbound, conflicting, and unknown profiles fail closed. | Makes no NIJ assignment or profile migration. Supports already-bound historical profiles by direct get. | Requires approval for binding provenance, inventory, and compatibility with existing overrides. |
| D. Reuse existing server registration and reviewed linking | Keeps reservation, allocation, and activation proof behind trusted server code. Reuse verified linking evidence after audit. | Reuses Paket A's atomic write and activation. Before wiring it in, verify historical claim coverage and guard existing legacy bindings in the registration transaction so a bound member cannot receive a second NIJ when historical claims are missing. | Preferred with B and C. Adapting the current Spark entry points, recovery proof, and override handling requires separate approval. |

## Isolated test

```powershell
$env:GCLOUD_PROJECT = 'demo-sipapua-qr-r3'
$env:METADATA_SERVER_DETECTION = 'none'
firebase.cmd emulators:exec --config candidates/qr-r3/firebase.candidate.json --project demo-sipapua-qr-r3 --only auth,firestore 'node --test candidates/qr-r3/compatibility.test.cjs'
```

The test guards the demo project and loopback endpoints before creating synthetic users. Existing Paket A code and the candidate resolver run in-process with synthetic App Check context. The test sets verification on a synthetic Auth record and does not test email delivery, live attestation, or the browser integration.
