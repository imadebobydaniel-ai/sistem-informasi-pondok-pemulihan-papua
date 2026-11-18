# SIPAPUA final implementation and development checkpoint

**Administrator Rapor implemented. Ready for Owner review. Production readiness NO.**

## Baseline and checkpoint

The writable repository root was `.`. The branch remained `test/sipapua-emulator-guard-20261110` at `36a402024f5c040d4cc07caa5416922c4d55ec45`. Git reported zero tracked modifications. The 69,704 original untracked entries were retained and six checkpoint files were added. The entries already present include release payload copies, geographic assets, test caches, prior candidates, and inspection evidence.

All six P0 hashes matched the original manifest. All five Phase 4 and six Phase 5 hashes matched their values at entry. The active `firestore.rules`, `firebase.json`, `functions/member-lifecycle.js`, and maintenance script match HEAD. Registration HOLD and member-card maintenance remain enabled. No production Firebase access, staging, commit, push, merge, or deployment occurred.

## Administrator Rapor

Big Data has one NIJ field and a **Buka Rapor** button. It opens the existing `rapor.html` in Administrator mode. The same renderer, scoring functions, period selectors and weights serve the member and Administrator views. The Administrator view loads a read snapshot. Opening it again fetches a fresh snapshot.

`getSIPAPUAAdministratorRapor` authorizes the signed-in request against the current Auth user and active `admin_users/{uid}` record inside the read transaction. Master, Super Admin, Admin and Viewer have the candidate's existing read authority. The operation accepts only an NIJ. It requires one NIJ match and one explicit UID match. A permanent allocation must agree on canonical document, UID, NIJ and NIJ number. Without an allocation, an explicit unique historical UID must also match a verified Auth email. Missing, ambiguous and unbound identities fail closed.

The response contains the Rapor header fields and the report fields used by the existing calculations. It omits contact details, profile addresses, free-text reading notes and unrelated member records. The Admin SDK reads are scoped by the resolved UID in `laporan_bacaan`, `kehadiran_jemaat`, `laporan_komsel_umum`, and `laporan_doa`. No Rules changes were needed. The callable rejects oversized histories explicitly at 10,000 report rows or an 8 MiB response. It does not truncate records and produce partial scores.

## Local tests and report consistency

- **PASS** Final connected loopback Chrome and emulator suite, **33 passed, 0 failed**.
- **PASS** Final emulator and callable suite without Chrome, **23 passed, 0 failed**.
- **PASS** An active Viewer submitted the NIJ from Big Data and saw the correct member. The Administrator Rapor matched the member Rapor in weekly, monthly and yearly views. An unrelated member and an inactive Administrator were denied in the browser.

| Workflow | Observable evidence |
|---|---|
| Menu Laporan and Pelayanan | Member login and cache-free restoration lead to the form. One authorized submission saves one UID-owned `laporan_pelayanan` record and awards 10 points. Retry adds neither a row nor points. An inactive member profile triggers the error UI. The Viewer sees the result in Big Data. |
| Pembacaan Alkitab | The browser creates one UID-owned `laporan_bacaan` row and the member Rapor consumes it. The callable rejects out-of-range input and the WIT boundary test checks 00:00:59, 00:01:00 and 22:00:00. The Viewer sees the saved record in the Bacaan tab. |
| Laporan Latihan | The browser selects Latihan PW and submits using synthetic coordinates. The saved `kehadiran_jemaat` row has a matching `statistik_jemaat_pusat` record. Denial shows an error and leaves the row count unchanged. The Viewer sees both expected training rows and the chart count of two. |
| Rapor Jemaat | Existing scoring code matches baseline. For the same member and period, the browser compared period keys, all six indicator counts, percentages, points, and the rendered points table. The separate backend calculator retained its original observed-opportunity formula. |
| Administrator Big Data | The Viewer opens Pelayanan, Bacaan, Latihan, KD and Peringkat JC. KD includes current and legacy sources. The browser downloads the selected training PDF and verifies its signature and title. Export source assembly verifies the expected KD and ranking row IDs. Full multi-tab and Rapor PDF export are NOT TESTED. |

### Security regression

The combined synthetic suite covers denied anonymous and cross-member access, report and identity write restrictions for active read-only roles, inactive Administrator denial, authorized Master and Super Admin operations, audited activation, and ambiguous historical identity rejection. It also verifies active-role KD and ranking reads plus participant-only UMKM chat. Separate existing frontend checks cover 11 chat cases and two QR script and token-handoff cases. Registration readiness still rejects the disabled control state.

## Files and checkpoint allowlist

All changes are under `candidates/final-release-checkpoint/`.

| File | Purpose |
|---|---|
| `administrator-rapor.patch` | Applies after Phase 4 and Phase 5. Adds NIJ navigation in `admin-bigdata.html`, Administrator mode in `rapor.html`, the session callable allowlist entry, and the Functions export. |
| `administrator-rapor.js` | New backend callable source, staged as `functions/administrator-rapor.js`. |
| `rapor-checks.cjs` | Focused emulator tests for roles, trusted identity, minimal data and denial. |
| `verify.cjs` | Extends the preserved Phase 5 suite in TEMP and adds browser Rapor parity and denial checks. |
| `ALLOWLIST.txt` | Exact 22-file candidate-only allowlist for later Owner-reviewed staging. |
| `REPORT.md` | This implementation and release gate report. |

The allowlist excludes production inspection evidence, real PII, credentials, keys, tokens, raw logs, dependencies, caches, browser profiles and unrelated assets. The preserved P0 console transcript remains on disk outside the allowlist. No Git staging was performed.

## Release gate

| Gate | Status |
|---|---|
| Local emulator and browser acceptance | See the results above. The connected browser uses synthetic accounts and local Auth and Firestore. |
| Security Rules compatibility | PASS locally with the unchanged Phase 5 candidate Rules. |
| Backend callable authorization | PASS with the loopback callable SDK wrapper and emulator Auth token verification. |
| Deployment-equivalent Firebase Functions and App Check | NOT TESTED. The browser harness uses a local App Check substitution and the test callable HTTP server. Validate with the Firebase CLI Functions emulator and an approved App Check test provider. |
| Legacy account compatibility | PASS for the synthetic verified linked legacy account and fail-closed cases. Owner-approved representative legacy fixtures remain an acceptance gate for release. |
| Data migration | This implementation performs none. Ambiguous or unbound records remain unavailable for Administrator Rapor and require a separate Owner decision if access is needed. |
| Administrator report compatibility | PASS for matching weekly, monthly and yearly views in the browser. Additional historical period formats and full exports remain release acceptance cases. |
| Physical QR | NOT TESTED. Maintenance remains enabled. |
| Backup and rollback readiness | NOT TESTED. Confirm the approved backup, restore rehearsal and rollback procedure before any production change. The development checkpoint itself is an unapplied overlay. |
| Owner approval | PENDING. Review the candidate-only allowlist and mandatory release checks before any staging or release decision. |

To reproduce, run from the repository root. Positive browser reports use the live Asia/Jayapura reporting window. The WIT boundary test uses a fixed clock. The browser reads the preserved Phase 5 chart/PDF libraries from TEMP and uses a fresh local profile.

```powershell
node candidates/final-release-checkpoint/verify.cjs
# Set SIPAPUA_PHASE5_BROWSER to the path of an installed Chrome executable.
$env:SIPAPUA_PHASE5_BROWSER_LIBS = Join-Path $env:TEMP 'sipapua-phase5-browser-libs'
node candidates/final-release-checkpoint/verify.cjs
node --test tests/release-blocker-closeout/chat.test.cjs
node --test --test-name-pattern 'card page scripts parse|browser handoff' tests/member-card-emulator.cjs
```
