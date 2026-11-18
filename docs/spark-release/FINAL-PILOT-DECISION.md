# Final pilot and go-live decision

Baseline: Owner's official inventory, recorded 2026-11-14, project
boby-apps-project. 24 Auth accounts, 9 canonical profiles, 1 NIJ allocation,
0 duplicate UIDs, 0 noncanonical profiles with uid, 8 structurally unmatched
profiles, 0 uid_ownership. Inventory complete and read permissions verified.
Auth REST 403 is no longer treated as an outstanding inventory blocker: the
Owner reports a successful official inventory. These totals are structural
evidence, not human identity attestation or a per-person eligibility decision.

No production access, issuance, data reconciliation, deployment or test rerun
was performed to prepare this decision. The security baseline stays 13 PASS.

## Bounded reconciliation of the eight existing profiles

Use only the eight masked references already in the Owner's protected inventory.
Assign local review labels R01-R08 there; these labels are workflow slots, not
invented production references. Do not export UID/contact/NIJ values into Git.
For each slot, record read-only findings in the protected case file:

| Check | Decision |
| --- | --- |
| Canonical doc.id, stored uid and actual Auth UID agree | Missing/contradictory uid is a separate case; don't change it automatically. |
| Existing NIJ and optional numeric/region fields agree | Preserve the existing NIJ; never allocate a replacement to resolve a mismatch. |
| Allocation exists and agrees with that profile | Missing allocation is not evidence the person is new. Do not create/backfill one in this scope. |
| Auth account is active and session ownership is established | Organizational identity verification remains required; email alone is insufficient. |
| Current profile status and the existing login/editor path | Identify whether the current candidate can read and retain that behavior without writes. |
| Review outcome | structurally explained / needs correction approval / unresolved; all three remain ineligible for a new NIJ because a profile already exists. |

Do not infer that all eight mismatches are missing allocations just because
9 profiles and 1 allocation were counted. The reasons per record were not
provided. Any required profile/ledger correction needs its own later approval;
this decision does not authorize it.

The eight cases do not automatically prevent previewing an unrelated new UID.
They DO prevent claiming existing-service compatibility until their reader/
activation cases are understood. No existing UID with a profile may receive
clear, even if its allocation is missing.

## Shortest individual pilot

1. Owner nominates one actual test Auth UID with consent, proof of control from
   that account's own session, an organizational identity review and an opaque
   review reference. The 24-minus-9 difference is NOT an eligible-account list.
   If a new Auth account must be created, that is a separate approved pilot
   operation; neither this plan nor the issuer creates one silently.
2. Fill a protected copy of OWNER-REVIEW-TEMPLATE.json outside the repository.
   Set identity/writer-coordination assertions only after verification. Leave
   approveProductionClear=false during preview. Run from the workspace:

```powershell
$review = Join-Path $env:LOCALAPPDATA 'SIPAPUA-Owner-Inventory\pilot-review.json'
node scripts/owner-uid-clear.cjs --preview $review
```

   Expected decision: ELIGIBLE_PREVIEW_ONLY, writes:0. The tool rechecks the
   actual active Auth UID and all relevant UID ownership paths in a Firestore
   snapshot; it does not issue clear from aggregate counts or an old report.
   Any existing profile/allocation/index record refuses eligibility. Any
   unresolved human identity evidence also refuses approval, even with an empty
   query result. Preview is a transaction-backed read, not data issuance.
3. Owner separately authorizes exactly this UID's two-record issuance. Refresh
   approvedAt and approveProductionClear in the protected file only after that
   authorization. This command is prepared, NOT executed or authorized here:

```powershell
node scripts/owner-uid-clear.cjs --issue-approved $review
```

   Both clear and the deterministic audit are create-only and atomic; duplicate
   issuance fails. Clear lasts one hour. No profile, NIJ, counter or reservation
   is modified by issuance. No expired record is silently renewed.
4. Actual pilot registration is a different authorized operation: it creates a
   profile, allocation and reservations and increments a counter. It is NOT
   covered by approval merely to issue clear. Schedule issuance immediately
   before the approved registration window so the one-hour proof does not
   expire during deployment. Do not unpause public registration to stage the
   proof; use a separately reviewed controlled pilot/release window.
5. Verify one NIJ, consumed ownership, verified-email activation, login and own
   profile plus rejection of a second registration. No cleanup may recycle NIJ
   or decrement the counter. Preserve the audit and consumed ownership.

## Deployment and rollback sequence

No deployment in the present scope. Before requesting its authorization:

- Capture actual live Rules and actual published Pages revision as rollback
  inputs. Local HEAD and root firestore.rules are not assumed to be production.
- Classify the eight existing reader/activation cases above against the candidate.
  Compare the old site's actual query paths with candidate Rules. Do not assume
  a Rules-first rollout is compatible. If no overlap is proven, use an explicitly
  approved maintenance window instead of broadening Rules or promising no outage.
- Obtain actual Enterprise attestation on the Pages origin, confirm Web App/key/
  domain binding, Firestore enforcement and Auth verification/action domains.
  The successful IAM inventory does not test client Rules or App Check. Keep
  Enterprise enabled; never use a debug provider as production evidence.
- Confirm registration_control/state plus all regional counter floors and
  permanent legacy contact reservations. The count of 1 allocation does not
  certify counter floors or reservation completeness. No reset/backfill here.

After those gates and separate deployment approval: keep registration paused;
deploy the reviewed code/Rules pair in the compatibility-tested order (or within
the approved maintenance window); verify existing account reads/admin access;
run `node scripts/verify-spark-public.cjs`; then perform only the approved
single-UID pilot. Broader opening requires another explicit maintenance-flag
decision and a working per-UID Owner review process. This remains reviewed
onboarding, not unrestricted automatic public registration.

Rules-only command, for the separately approved execution window:

```powershell
firebase deploy --project boby-apps-project --config docs/spark-release/firebase.json --only firestore:rules
```

Rollback: pause registration first; restore the exact captured cloud Rules and
known-good published code as a coordinated pair; verify existing access. Use
the backup-config/revert commands in RELEASE-STEPS.md only with Owner approval.
Never remove pilot data/ownership/audit, release reservations or decrement a
counter. If the old site cannot safely handle a pilot account, keep the affected
flow paused and apply a reviewed forward fix rather than weakening policy.

## Decision

GO to prepare the protected individual review and request a read-only preview.
NO-GO to issue clear, run production registration, deploy or open public signup
under this scope. The remaining Owner inputs are the eight mismatch findings,
one verified pilot identity, actual live compatibility/rollback evidence,
Enterprise attestation and registry readiness, followed by separate approvals.
