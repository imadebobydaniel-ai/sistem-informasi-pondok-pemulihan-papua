# SIPAPUA QR-RC-04 — Zero-cost architecture gate

**Decision: BLOCKED for hosted staging and release at an absolute Rp0.** Continue synthetic local verification as needed. Preserve registration HOLD, member-card maintenance ACTIVE, and QR friendship DISABLED.

## Verified inputs

The development branch `test/sipapua-emulator-guard-20261110` is at `76cc5f8aac48618caf7411cc966f4665bcb57a6b`. RC-03 manifest SHA-256 is `5ed90d904d4d228bc763faed3d82a3d6aceb36b4d699af2ef6bd58fb4f7fc9ea`. Verified all 12 RC-03, 18 RC-02, and 11 archived RC-01 entries. The intended staging feature needs Firebase Auth, Firestore, limited-use App Check, a privileged verifier, Worker, D1, and an approved HTTPS origin. The Worker origin is unset and the RPC gateway is still a design.

## Component decision

| Component | Billing-free feasibility | Constraint |
|---|---|---|
| Firebase Auth | Available on Spark for the email/password flow | Phone/SMS is outside the design. User credentials and public Firebase config cannot perform privileged lookup by another UID. |
| Firestore Standard | Available on Spark | One free database per project. 50,000 reads, 20,000 writes and 20,000 deletes/day, 1 GiB storage and 10 GiB outbound/month. Use synthetic data and keep owner-only Rules for user-bearer reads. Privileged current-owner checks need scoped server authorization. |
| Firebase App Check and web attestation | Free within applicable quotas | App Check is no-cost, but attestation quotas are separate. Google documents 10,000 reCAPTCHA assessments/month without active billing across the organization. Verify shared usage, provider and quota behavior on the approved project. The client must keep obtaining a fresh limited-use token per operation. |
| App Check token consumption | API contract verified. Billing-free service identity path unverified | Requires OAuth and `firebaseappcheck.appCheckTokens.verify`. The managed Node SDK with `consume:true` or the official privileged REST method preserves provider-side replay protection. |
| Cloudflare Workers Free | Available within hard quotas | 100,000 requests/day per account, resets 00:00 UTC. Excess yields Cloudflare 1027. HTTP CPU 10 ms, 50 subrequests per invocation, 5 cron triggers per account. Verify live service-binding CPU/subrequest use and include preflights and other account workloads. |
| D1 Free | Available within hard quotas | 5 million rows read/day, 100,000 rows written/day and 5 GB total. Up to 10 databases and 500 MB each. Queries fail after daily limits until 00:00 UTC. Time Travel keeps 7 days of history, including data deleted from live tables. |
| Firebase Functions / Cloud Run verifier | **Blocked under no billing** | Functions deployment requires Blaze. Cloud Run requires a linked Cloud Billing account, including Free Tier. A projected bill of zero does not satisfy the billing restriction. |

Sources: [Firebase plans](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans), [Firebase pricing](https://firebase.google.com/pricing), [Firestore free quota](https://firebase.google.com/docs/firestore/quotas), [App Check overview](https://firebase.google.com/docs/app-check), [reCAPTCHA quotas](https://docs.cloud.google.com/recaptcha/quotas), [App Check consume API](https://firebase.google.com/docs/reference/appcheck/rest/v1beta/projects/verifyAppCheckToken), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/), [Cloud Billing](https://docs.cloud.google.com/docs/get-started/learn-about-billing).

## Verifier architecture alternatives

| Design | Security and cost evaluation | Decision |
|---|---|---|
| RC-03 Worker + private Node on Cloud Run or Functions | Attached workload identity can support Auth revocation, disabled-user and owner checks, and verified App Check consumption without key files. The hosting plan requires billing. | **BLOCKED** under Rp0/no billing. |
| Worker + private RPC Worker using REST and federated short-lived OAuth | Removes Node hosting while keeping privileged Auth account lookup, Firestore point reads and App Check consumption. Needs a trusted runtime-issued workload identity, tightly scoped federation, short-lived credentials, and verified API availability on an unbilled project. Cloudflare RPC provides an internal invocation path. It does not issue a Google identity. | **Candidate for Owner review.** No issuer or unbilled end-to-end authorization has been established. |
| Existing Owner-operated Node host + workload identity federation | Reference Node verifier can remain behind an approved private transport. Requires an already-funded, managed always-on host and trusted workload issuer, proof of no incremental cost, patching and monitoring ownership, and proof that the required APIs work on an unbilled project. A free-beta network service is not a durable cost guarantee. | **Conditional only.** No qualifying host or transport was established. |
| Emulator-only | Covers synthetic Auth/Rules, mocked verifier and SQL failure semantics without hosted services. | **GO for local work.** Hosted App Check consumption, cloud quota enforcement and app/device attestation are outside its evidence. |

A qualifying verifier must validate Firebase ID token signature and claims, check revocation and disabled accounts on every QR operation, check the current owner and canonical binding at scan time, and validate the App Check app and consume the limited-use token. The REST alternative needs Auth lookup with `firebaseauth.users.get`, scoped Firestore point reads and the App Check Token Verifier permission. Match the provider's response contract: the REST success response omits `alreadyConsumed` on first consumption, whereas the current reference expects the Admin SDK to return explicit `false`. Test that mapping before acceptance. Fail closed on unavailable services, malformed responses and unknown account state. Store neither a service-account key nor a personal refresh token in a Worker. Public JWKS checks, CORS, a caller's own bearer and local replay storage do not establish the authoritative checks for the scanned owner or provider-side token consumption.

Google describes federation without service-account keys and the IAM API as free. Those facts alone do not establish unbilled eligibility for a particular issuer, STS and credential path, or the target Firebase APIs. Preserve the restriction until the combined path is verified. [Workload Identity Federation](https://docs.cloud.google.com/iam/docs/workload-identity-federation) · [IAM pricing](https://cloud.google.com/iam/pricing) · [Auth account lookup](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v1/accounts/lookup) · [App Check backend verification](https://firebase.google.com/docs/app-check/custom-resource-backend) · [Cloudflare RPC](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/)

## Capacity and failure behavior

RC-03 permits 60 globally admitted operations/minute. At saturation that is 86,400/day. Each fully admitted request writes both global and per-UID budget counters, so those two writes alone can reach **172,800 base row mutations/day**, before card issue/redemption, indexes, and cleanup. Global counter writes can still occur for requests later denied at the per-UID gate. A minute-level guard therefore cannot reserve enough Free capacity for cleanup or guarantee daily availability. Measured D1 rows written per path, including index costs, must inform a staging daily admission target and an explicit cleanup reserve. Include invalid requests and preflights in Workers planning, and reserve reCAPTCHA assessments for other apps sharing the quota.

When D1 throws on quota, the current request path fails closed with 503. Consumed or expired QR tokens remain unusable by SQL conditions. Cleanup can fail while quota is exhausted, so the proposed ten-minute live cleanup objective can be missed. Retain the seven-day recovery window in privacy acceptance and test that restoring old state cannot reopen redemption before enabling traffic after a restore. Plan for ongoing outage under sustained load and recover after quota reset. Keep the Free plan, preserve maintenance, and avoid automatic failover to a path that omits verifier or replay checks. [D1 quota and billing metrics](https://developers.cloudflare.com/d1/platform/pricing/) · [D1 daily enforcement](https://developers.cloudflare.com/d1/platform/release-notes/)

## Owner decision and acceptance

1. Keep the hosted feature on hold under the current budget. If an existing approved workload issuer or host is available at Rp0 incremental cost, review the corresponding design first.
2. Before authorizing any resources, require a written no-billing inventory of Firebase, the identity issuer, credential issuance, private transport, Worker, D1, and the approved HTTPS origin. A Free Tier allowance, trial credit or spend alert is insufficient to prove this gate.
3. Before staging acceptance, prove the private OAuth path against the isolated Firebase project and test revoked and disabled accounts, current owner checks, real limited-use consumption and replay, quota exhaustion, and cleanup. Use synthetic accounts and keep the actual application in maintenance.
4. Review retention, capacity, outages, real browser and physical scans, then decide separately whether rollout is allowed. Owner review of this package does not approve deployment.

## Evidence boundary

RC-03 recorded **24 PASS, 0 FAIL**, including Firebase Auth and Firestore loopback emulators. RC-04 modifies documentation only and introduces no new local integration path. Passing emulator tests were reused, not rerun. Hosted billing eligibility, app attestation, identity issuance and quota limits are documentation or pending hosted evidence as indicated above. No resources, credentials, billing plans, routes, deployments or application code were changed.

