# SIPAPUA QR-RC-03

## Decision

READY FOR STAGING OWNER DECISION. Hosted staging deployment remains gated on Owner approval, implementation and validation of the private transport, and the hosted checks below. Keep registration HOLD, QR maintenance active and QR friendship disabled.

Baseline: branch `test/sipapua-emulator-guard-20261110`, commit `76cc5f8aac48618caf7411cc966f4665bcb57a6b`. The tracked tree and index were clean. Existing untracked evidence and RC-01/02 packages were preserved. All 18 RC-02 manifest entries and all 11 RC-01 archive entries verified. Active Rules SHA-256: `7760719f940db5ba6ad07f82f871d28536aa6657888b57e77dac83958ade909a`.

## Staging configuration matrix

| Component | Proposed staging value or constraint | Owner decision |
|---|---|---|
| Firebase | Dedicated synthetic project named `sipapua-qr-stg-<suffix>`, registered web app, explicit project number and matching app ID | Approve project and provider domains |
| Browser | Fixed HTTPS staging Worker origin in the candidate adapter and distinct approved frontend origin in Worker CORS. Both remain unconfigured | Approve origins, SDK provider, CSP and test devices |
| Worker | Only `/v1/issue` and `/v1/lookup`. Template has workers.dev and preview URLs disabled. Staging Worker rejects production Firebase identifiers | Approve account, route and scoped deploy operator |
| D1 | Dedicated database using `schema.sql`, no import from production, one-minute cleanup schedule | Approve retention and capacity monitoring |
| Private verifier | `QR_AUTHORITY` exposes `authorize` and `owner` via a private service binding to a staging gateway | Approve runtime, authenticated cross-cloud transport and minimal identities |
| Firestore | `nij-owner-read.patch` applied to the exact approved staging Rules baseline | Approve hash, synthetic fixtures and Rules deploy operator |

## Private verifier and minimum access

Use the RC-02 reference authority unchanged in a Node runtime with Firebase Admin SDK, attached workload identity and application-default credentials. Restrict access to the approved gateway. The Cloudflare RPC gateway and authenticated hop to Node remain to be implemented after the transport decision. A Cloudflare service binding connects Workers, so it cannot directly bind to a Google Node service. An authenticated workload identity or equivalent keyless transport must be demonstrated before enabling the gateway. The runtime never accepts an identity or NIJ solely because the client supplied it.

Minimum permission candidates for staging are Firebase Auth account lookup (`firebaseauth.users.get`), App Check consumption (`roles/firebaseappcheck.tokenVerifier`) and Firestore point reads (`datastore.entities.get`, with only any additional permissions proven necessary by the SDK). Use an isolated staging project/database because IAM-backed Firestore reads bypass document Rules. Limit the runtime to lookup of the two known document paths in code. Scope invoke permission to the gateway identity. Keep deployment and schema-edit authority on a separate operator scoped to staging. Request Cloudflare editing rights for Workers scripts and D1 only for that operator. Route or DNS permission requires separate approval if the selected route needs it. [Firebase App Check verification](https://firebase.google.com/docs/app-check/custom-resource-backend) · [Firebase IAM roles](https://firebase.google.com/docs/projects/iam/roles-predefined-product) · [Firestore IAM](https://cloud.google.com/iam/docs/roles-permissions/firestore) · [Cloudflare RPC](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/)

The authority checks revoked sessions and disabled accounts with `verifyIdToken(token, true)`. It verifies and consumes App Check with `verifyToken(token, {consume:true})` and requires the expected app and `alreadyConsumed === false`. Lookup rechecks the current owner's account, activation and UID/NIJ binding. Missing methods, dependency errors, or mismatched authoritative responses deny the operation. Verify hosted deadlines for both RPC calls and demonstrate failure behavior before opening access. [Firebase session revocation](https://firebase.google.com/docs/auth/admin/manage-sessions)

## Worker and retention

`QR_INGRESS` is a proposed per-IP limit of 30 requests per 60 seconds per Cloudflare location; preflights count. D1 enforces a 6-per-UID and 60-global per-minute budget before verifier calls. Validate D1 write capacity and concurrency under controlled synthetic load. Use a fresh D1 database, primary-consistent mutation, and track 429/503 rates and sweep backlog without logging request headers, payloads, raw tokens or identity fields.

Cards expire after five minutes, cannot be redeemed twice and can be reissued after a 15-second cooldown. D1 stores internal UID, digest and lifecycle metadata; it omits names, NIJ and raw tokens. Budget records expire at the end of the minute. Propose deleting expired rows within ten minutes during normal staging operation via scheduled batches of up to 100 per table, alerting when backlog crosses that age. Confirm backup and recovery retention separately because deleting live rows does not erase backups. [Cloudflare rate limit](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) · [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)

## Rules reconciliation

Active Rules and the RC-01 integration snapshot have different document match trees, including different Administrator authorization and reporting code. The relevant QR behavior in the active tree is that own canonical profile reads work, `nij_allocations` has no dedicated match, and the recursive fallback denies reads and writes. RC-03 adds only one seven-line match before that fallback. It grants document `get` to a non-anonymous authenticated UID matching both the path and stored UID; list and client mutations stay denied. The Worker uses the caller's ID token for the caller's profile and allocation reads. The verifier's separate owner lookup is the IAM-gated path for another cardholder. The patch was tested on a temporary copy.

## Required Owner decisions

- Select the staging account and keyless verifier transport. Verify runtime IAM, network deadlines and privacy boundary.
- Approve the frontend/Worker origins, App Check provider and CSP, and record real limited-use token consumption and replay rejection.
- Approve D1 retention and recovery, ingress settings, and the staged Rules hash.
- Approve the synthetic browser and physical device approach and one-time redemption behavior. Authorize staging provisioning separately.

