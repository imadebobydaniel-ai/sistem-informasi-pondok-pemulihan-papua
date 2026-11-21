# SIPAPUA QR-RC-01

**READY FOR OWNER REVIEW. NO-GO for deployment or unpausing QR.**

Baseline `integration/sipapua-a335b039` at `a335b039d2809af45974e750698a714af4029406`. RC changes are isolated to this directory. Existing worktree modifications, earlier candidates and temporary evidence were left in place. The installed adapter still has no Worker origin. Both maintenance flags remain enabled. Friendship remains disabled.

## Evidence

| Gate | Result |
|---|---|
| Candidate Worker, SQL and installed adapter contract | PASS, 10 checks. Includes signed synthetic JWTs, mocked App Check consumption, HTTPS origin and route selection, CORS, ingress denial, per-UID and global admission, cooldown, expiry, self-scan, replay, rotation race and bounded cleanup. |
| Auth and Firestore Emulator | PASS, 7 reported checks including parent. Real Auth Emulator revoked and disabled accounts were denied before the synthetic App Check consumer was invoked. The owner-only candidate permits an owner get and denies list, write, other UID, anonymous and unrelated reads. |
| Existing QR and chat regressions | PASS, 13 checks, freshly run. |
| Registration, Rapor and Big Data | PASS, inherited installed runtime evidence from the preceding 66-pass baseline. These paths and active Rules were untouched in this turn, and their browser suite was not repeated. |
| Live App Check consumption, Cloudflare bindings and quotas, physical QR | BLOCKED pending approved infrastructure, configuration and acceptance. |
| Failed intermediate check | The first local purge run exposed a missing clock default. Corrected and rerun successfully. |

The Worker validates both signed token envelopes, then delegates revocation and one-time App Check consumption to a required private authority. The reference authority calls Firebase Admin `verifyIdToken(token,true)` and checks exact UID, auth time, and app ID. On lookup it verifies the owner's current enabled Auth record, revocation cutoff, canonical active membership and NIJ binding. Client-profile GETs still use the caller bearer token under Firestore Rules. The reference owner's reads require a separately approved narrowly scoped private service identity. The owner-only allocation patch does not grant this service or scanner access to other members.

QR cards are one successful scan per issuance. An atomic conditional update blocks concurrent replay, expiration and rotation after the initial read. The card table stores UID, token hash, timing and consumption state. It stores no name, NIJ, Komsel or raw token. Ingress admission is required before JWT work. The candidate uses fixed-minute D1 admission with 60 global and six per hashed UID, plus issuer cooldown. Limits are local policy defaults. Cloudflare platform limits and distributed ingress behavior require measurement and approval. Revocation and the final SQL write occur across different services. No cross-service atomicity is assumed.

Before any rollout the browser must acquire a fresh supported limited-use App Check token per QR request. The installed compat adapter uses the standard acquisition path today. The local adapter contract uses explicitly synthetic fresh attestations. Live provider replay consumption, a supported limited-use client integration and the approved private authority binding remain release gates.

## Owner acceptance and staged deployment plan

1. Approve the one-successful-scan rule, owner allocation document fields, private authority permissions, telemetry redaction, rate limits, retention period and accepted load. Accept that one consumed card requires reopening or refreshing before another scan.
2. Approve a supported limited-use App Check client integration. Verify origin, Firebase project/App ID and the private authority. Bind the ingress limiter to the trusted edge path. Keep the public Worker origin unset until review completes.
3. Approve an isolated staging project and a fresh D1 schema. The earlier card schema is incompatible. Configure and measure scheduled cleanup capacity under peak load. Use synthetic identities, and validate App Check consumption, real ingress policy, denied/accepted roles, Auth revocation, expiry, concurrent replay, and quota failure. Inspect logs for absence of credentials or raw QR tokens.
4. Require Rules review and a staging Firestore smoke test with the proposed patch. Validate complete documents returned to owners and App Check enforcement on the Firestore REST reads. Confirm current owner reads remain private.
5. Perform physical Android/iOS browser and camera acceptance, accessibility checks, and Owner review of the production change window. Maintain QR and registration holds pending separate approval. Keep friendship disabled.

## Rollback plan

1. Keep or restore the member-card maintenance gate, remove the configured frontend Worker origin, and stop new traffic to the candidate Worker. Registration remains on HOLD.
2. Revert only the separately approved QR frontend, Worker bindings and owner-read Rules change to their reviewed previous versions. Verify the previous build and Rules before any traffic is restored.
3. Revoke or detach the private authority and ingress bindings as approved. Keep D1 inaccessible to the frontend, preserve approved evidence, and follow the approved expiry/purge policy. Do not migrate or restore card rows into an older schema.
4. Verify issuance fails closed, member access rules return to the previous contract, both maintenance flags remain enabled, and registration/reporting are unaffected.

No deployment, commit, push, merge, production access, IAM, billing, DNS or Cloudflare changes were performed.
