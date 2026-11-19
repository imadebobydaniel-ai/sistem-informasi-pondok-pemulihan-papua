# Spark release execution inputs

This is an execution plan, not another historical audit. No production operation
below has been executed. Root firebase.json and firestore.rules remain unchanged.
The current operational procedure and compatibility gate are in
OPERATIONAL-CLOSEOUT.md. Its old-site compatibility check must precede any rollout
order below; a Rules-first deployment is NOT authorized without that evidence.

Historical baseline: registration 26 PASS; lifecycle/security 22 PASS / 1 FAIL.
Targeted UID-ownership closeout: **13 PASS / 0 FAIL**, including the original
failing test and raw SDK bypass. The 48 passing baseline tests were not rerun.
Registration remains paused in sipapua-maintenance.js until production review.

Local implementation: registration, email verification, activation, session/profile
reads, profile demographics/photo, contact reservations, and audited deletion use
the client SDK. Legacy UID-less linking and its four collections are disabled.
The existing administrator editor handles UID-bound manual activation. All other
source modules are retained; the final proposal inherits their existing 005A
policy, whose full interactive compatibility is not certified by scoped tests.

NIJ/counter/allocation/contact reservations commit atomically. Family metadata is
saved afterward in chunks of at most five children, each validated with no linked
UID/NIJ. This supports the existing thirty-child UI under the Rules expression
limit. A metadata error never reallocates NIJ or releases reservations; an
incomplete metadata save reports an error and requires retry through profile edit.
Email contact changes require the owner's refreshed Auth identity; an administrator
cannot invent a new target Auth email. Existing linked family values are retained
when unchanged; new private directory linking is paused. Auth disabled/revocation
remains subject to Firebase token validity, not an imaginary Rules Auth lookup.

## Release gate

Do not execute commit/push/deploy until the Owner authorizes the concrete manifest.
The original second-NIJ route is now denied by default. Registration requires
`uid_ownership/{uid}` whose trusted review states `clear`, with matching UID,
empty profileId, nonempty reviewId, reviewedAt and an unexpired expiresAt no more
than 24 hours after reviewedAt. No web user, master or super_admin can create,
delete or issue that record. Only separately authorized IAM-controlled operations
can attest it after reviewing actual ownership. No such production operation
has been performed or automated here.

Registration atomically consumes clear into allocated, setting profileId, NIJ
and allocatedAt while preserving review metadata. The six-document transaction
is mandatory: profile, allocation, counter, two contact reservations and ownership.
Allocated/owned/conflict/missing/expired records cannot authorize new registration.
Ownership consumption without the profile or registration without consumption
is denied. Ownership cannot be reset by the browser, including administrators.
All four legacy-linking collections remain disabled.

The index need not be assumed complete: an unknown UID is always blocked. A
reviewed UID can proceed only with a correct trusted per-UID clearance. This is
not unrestricted automatic signup. Approving all unknown UIDs, browser-written
clearances, or relying on email would invalidate the security contract.

**One minimum remaining Owner action:** under a separately approved production
scope, review the actual UID ownership inventory and attest only exhaustively
verified conflict-free UID records through the official IAM-controlled channel.
For each UID, check canonical doc.id, every legacy users/*.uid, permanent NIJ
allocations, existing ownership/link indexes and unresolved historical evidence;
Auth UID/session and organizational evidence must agree. Email is not ownership
proof. Record the review provenance, coordinate all privileged UID writers with
the same index, and do not clear a UID while a conflict remains unresolved.
This can be performed per UID, leaving the remainder blocked. Full automatic
registration still requires a complete trusted inventory/provisioning contract.

No production inventory result exists in this workspace: the previous report
explicitly recorded unknown counts. Therefore completeness/free-of-conflicts
is NOT assumed. IAM is the trust boundary: if a privileged writer deliberately
issues a false clear or writes legacy ownership without maintaining the index,
Rules cannot repair that false assertion by scanning users. Production review
is still a prerequisite, not claimed by these emulator tests.

Production readiness is also unverified. In particular, ledger completeness/counter floors and permanent legacy
reservations have not been verified from authorized production evidence; actual
Enterprise token issuance/enforcement on the Pages origin is not emulator evidence.
Neither a public site key nor enabled:true alone establishes ledger readiness.
The read-only Auth inventory 403 is not silently treated as resolved.

The safe alternative is to keep registration in maintenance until these prerequisites
are confirmed. Do not initialize/reset counters, rebuild NIJs, auto-link legacy
profiles, or switch off App Check to force a release. Registry preparation callables
are NOT part of this Spark release; if initialization/backfill is needed, it needs
a separate approved manual procedure and must not be inferred as done.

## Local commands (safe to run before authorization)

```powershell
node scripts/build-spark-release-rules.cjs
$env:SIPAPUA_TEST_RULES = 'docs/spark-release/firestore.proposed.rules'
node tests/spark-implementation/rules.cjs
Remove-Item Env:SIPAPUA_TEST_RULES
node tests/spark-release/e2e.cjs
node scripts/prepare-spark-release.cjs
```

For this closeout only, the executed command was:

```powershell
node scripts/build-spark-release-rules.cjs
node tests/spark-release/e2e.cjs --ownership-only
node scripts/prepare-spark-release.cjs
```

The original failing test was extracted unchanged into
`tests/spark-release/ownership-cases.cjs` and is called by both the full suite and
the targeted runner. It was not deleted or marked skipped. New positive test
fixtures explicitly seed synthetic IAM-reviewed eligibility; this does not
provision or migrate production data. The targeted result stores Rules/client
hashes; the manifest rejects stale closeout evidence for changed Rules/client.

## Owner-approved rollout order

1. Record the actual currently published Pages revision and export currently
   deployed Rules from the official Console to an Owner-controlled backup directory.
   Do not assume local HEAD or root firestore.rules equals production.
2. Pause registration using the existing maintenance mechanism in a separate
   reviewed publication before changing Rules. Keep existing sessions/modules
   available. Capture a genuine Enterprise attestation on the authorized origin,
   and verify Firebase Auth authorized domains, verification email/action routing,
   Firestore App Check enforcement and complete registry readiness read-only.
3. With registration paused, deploy the reviewed Rules candidate ONLY:

```powershell
firebase deploy --project boby-apps-project --config docs/spark-release/firebase.json --only firestore:rules
```

4. Check existing readers/admin access with approved accounts. If any existing
   module fails, restore the captured cloud Rules immediately while registration
   remains paused. Do not broaden privacy rules as a compatibility shortcut.
5. Publish the reviewed source set with registration still paused. Review the
   COMMIT-PATHS.txt whitelist and MANIFEST.json hashes first. Do not stage all files
   or include functions/, inventory tools, credential files, or unsafe legacy-link
   candidates. Ensure no pre-existing staged files will enter this commit:

```powershell
git diff --cached --name-only
git add --pathspec-from-file=docs/spark-release/COMMIT-PATHS.txt
git diff --cached --stat
git commit -m "Integrate Spark client registration and member lifecycle"
git push origin HEAD
```

The repository's actual approved Pages branch/workflow must be verified before
push; HEAD is not assumed to be that branch. Pause/unpause publications require
their own concrete reviewed changes and Owner authorization. This session has
not created a temporary maintenance commit, branch, worktree, or staged changes.

6. Verify script loading/cache consistency, App Check token acquisition without a
   debug token, existing module readers/writers, and no Functions request from
   new registration/login/profile/manual activation. Only after these checks
   enable registration. Synthetic production registrations/NIJ allocations require
   explicit Owner approval; emulator test users are not copied to production.

## Rollback (Owner-authorized only)

First pause registration. Restore the previously captured cloud Rules with an
Owner-only config pointing to that exact backup; do not deploy a guessed local
baseline. Restore the known-good Pages revision through the established workflow
or a reviewed revert commit in a clean release checkout:

```powershell
firebase deploy --project boby-apps-project --config <owner-backup-config.json> --only firestore:rules
git revert <spark-release-commit>
git push origin HEAD
```

Reverify existing access before reopening registration. Rollback never deletes
new Auth accounts, profiles, allocations, reservations, audit records, or decrements
counters. If the prior code cannot read newly registered profiles safely, leave
registration paused and retain the secured data for a forward fix.
