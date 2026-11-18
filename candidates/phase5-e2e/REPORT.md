# SIPAPUA Phase 5 local integrated verification

## Baseline

| Check | Evidence |
|---|---|
| Workspace | Writable repository root `.` |
| Branch and HEAD | `test/sipapua-emulator-guard-20261110` at `36a402024f5c040d4cc07caa5416922c4d55ec45` |
| Git status | Zero tracked modifications. 69,698 untracked entries at entry and 69,704 after the six Phase 5 files. |
| Preserved references | Six P0 SHA-256 values match their manifest. The five Phase 4 artifacts match their entry hashes. |
| Active release files | `firestore.rules`, `firebase.json`, `functions/member-lifecycle.js`, and `sipapua-maintenance.js` match HEAD. Registration HOLD and member-card maintenance are enabled. |
| Existing artifacts | The 69,698 entry baseline includes 62,712 geographic asset paths inside copied release payloads, plus cached tooling, prior candidates and retained evidence. No artifacts were staged, overwritten or removed. |

## Files changed

| Phase 5 file | Purpose |
|---|---|
| `firestore.phase5.rules` | P0/Phase 4-based isolated Rules. Adds read-only `kehadiran_kd` and `peringkat_jc` access for active Administrator roles, plus participant-only `chats` compatibility. |
| `big-data.patch` | Overlay for Phase 4's `admin-bigdata.html`. The KD table and export combine legacy KD with `kehadiran_jemaat` records whose activity is `Absen KD`. Peringkat JC supports the existing `periode` field as a date fallback, including `YYYY-MM`. |
| `verify.cjs` | Stages the Phase 4 application overlay and Phase 5 Big Data patch into TEMP. Starts local demo Auth and Firestore, seeds synthetic fixtures, and tests authorization, writes, queries, scoring parity, and the export data path. |
| `transport.cjs` | Uses Firebase Functions SDK callable wrappers and an ephemeral loopback HTTP server. Auth tokens are verified against local Auth. Handlers use the real Firestore emulator. |
| `browser.cjs` | Headless Chrome harness. Serves the actual staged HTML and tracked scripts over loopback, uses a fresh Chrome profile, and exercises form controls and report rendering. |
| `REPORT.md` | This report and the Owner acceptance matrix. |

The Phase 5 runner uses `demo-sipapua-phase5` plus ephemeral loopback ports. The browser serves Firebase SDK libraries locally and rewrites initialization to the demo emulators. Browser CSP and Chrome networking restrict requests to loopback. App Check is substituted in the harness. Production App Check and the Firebase CLI Functions process are outside the test. The HTTP assertions exercise the callable SDK protocol, verified Auth context, and candidate handler code.

## Security regression

| Scenario | Status | Evidence |
|---|---|---|
| Anonymous access; private and cross-member reads | PASS | Signed-out callable returns `functions/unauthenticated`. Rules deny another member's Reading record, unauthenticated and inactive reads of KD/JC, and the private `statistik_jemaat_pusat` mirror. |
| Viewer and Admin restrictions | PASS | Both active roles read the authorized dashboard sources, but cannot write KD/JC, change reports, activate an account, or bulk-delete profiles. |
| Master and Super Admin | PASS | Authorized profile management, read visibility and ordinary report edits verified. UID and NIJ reassignment remain denied. Synthetic bulk delete stops when the role is revoked and retains the unprocessed document. |
| Audited activation and legacy identity | PASS | Verified registration creates one activation audit and retains its allocation. An authorized Super Admin override creates an audit and Auth remains email-unverified. Ambiguous legacy identity and mismatched allocation targets are denied. |
| Registration and QR | PASS | Disabled registration readiness rejects; NIJ allocation writes remain denied. The registration and QR maintenance flags stay on. Two existing QR script/token-handoff tests passed. Physical QR scan is NOT TESTED. |
| Shared UMKM chat | PASS | Synthetic customer create and thread query, seller scoped list, read flag, soft removal, and reply succeed. Unrelated Viewer and anonymous reads are denied. Customer cannot set seller flags, and seller cannot change identities. Existing 11 frontend regression tests pass separately. The browser UMKM journey is NOT TESTED. |

## Connected module evidence

The matrix below distinguishes browser interactions from callable and Rules observations. Rapor and Big Data are read-only outputs, so a database-write status there refers to their upstream fixtures.

| Module | UI OPEN | INPUT VALIDATION | BACKEND AUTHORIZATION | DATABASE WRITE | DATABASE READ | ADMINISTRATOR DISPLAY | BIG DATA AGGREGATION | REPORT / RAPOR OUTPUT |
|---|---|---|---|---|---|---|---|---|
| Menu Laporan and Pelayanan | PASS browser login, restored session and report navigation | PASS service form rejection and duplicate response | PASS callable requires the signed-in active profile | PASS one browser submission and 10 points | PASS stored UID, points and retry count checked | PASS Viewer Pelayanan table | PASS selected source and period filter | PASS browser save confirmation. Service-specific PDF NOT TESTED. |
| Pembacaan Alkitab | PASS browser form | PASS invalid chapters and WIT boundary checks | PASS authenticated callable and cross-member write denial | PASS browser submission into `laporan_bacaan` | PASS saved UID and own Rapor read | PASS Viewer Bacaan table | PASS matched period and reading source | PASS own Rapor display. Reading-specific PDF NOT TESTED. |
| Laporan Latihan | PASS browser activity selection | PASS invalid coordinates rejected and rejected write surfaces an error | PASS signed-in member request; signed-out and inactive profile requests denied | PASS browser submission and matching private raw mirror | PASS saved activity, member and timestamp | PASS Viewer Latihan table | PASS training rows and chart counts | PASS browser training PDF generated. |
| Rapor Jemaat | PASS browser self-view | PASS synthetic scoring fixtures and period selection logic | PASS owned profile callable and UID-scoped report reads | PASS upstream browser Reading fixture | PASS member display and stored Reading input | BLOCKED for a separate Administrator per-member view | PASS scoring parity. Big Data uses the reporting records separately. | PASS member table and monthly/yearly fixed-target checks. Member PDF NOT TESTED. |
| Big Data Administrator | PASS browser active Viewer dashboard | PASS activity, period and source filters | PASS active roles read; inactive, member and anonymous roles denied private data | PASS read-only restrictions and upstream member writes | PASS core sources, KD legacy/current sources and ranking | PASS Viewer tables for member inputs, KD and JC | PASS training count and selected-source export model | PASS training PDF with the selected output. Full multi-tab export NOT TESTED. |

The browser submits through the staged pages, observes their state changes and confirms stored records with the emulator. The Viewer journey opens the actual report tabs. The PDF test downloads a file, checks the PDF header and confirms the training title. The KD and JC model test separately compares selected source row IDs under the Viewer Rules.

| Test run | Observed result |
|---|---|
| Phase 5 connected headless Chrome run | **28 PASS, 0 FAIL**, including service and training failure handling, own Rapor output, active Viewer display, and the training chart and PDF. |
| Phase 5 callable, Rules and fixture run without Chrome | **21 PASS, 0 FAIL**. |
| Preserved P0 matrix with Phase 5 Rules | **16 PASS, 0 FAIL**. The matrix and Rules were copied into TEMP under the filenames expected by the preserved runner. |
| Existing frontend regressions | **11 chat checks and 2 QR checks passed**. |

The Firestore emulator needed its default browser transport in the headless run. Setting a separate WebChannel port to zero caused the dashboard's server read to report offline even when Node-based reads succeeded.

## Cross-module consistency

- `laporan-pelayanan.html` sends `submitSIPAPUAServiceReport` and uses the signed-in UID. One service report saves into `laporan_pelayanan` and awards 10 points to the owned profile in one transaction. A duplicate response and a failed request do not create additional records or award points.
- `baca-alkitab.html` sends `submitSIPAPUAReading` into `laporan_bacaan`. The exact WIT gate rejects 00:00:59, allows 00:01:00, and rejects 22:00:00. The date and UID form the duplicate key, with historical date aliases also checked.
- `kehadiran.html` sends `submitSIPAPUAAttendance`. Latihan PW produces matching records in `kehadiran_jemaat` and `statistik_jemaat_pusat`. Big Data selects the exact activity name. The mirror stays private to active Administrators.
- `rapor.html` reads only Auth-UID-filtered `laporan_bacaan`, `kehadiran_jemaat`, `laporan_komsel_umum`, and `laporan_doa`. The frontend scoring block and targets match baseline byte for byte after line-ending normalization. One synthetic Reading yields the existing frontend monthly and yearly values of 1/30 and 1/365 before percentage and 10-point conversion. The separate unchanged `functions/rapor-stats.js` calculator produces one completed Reading out of one observed opportunity and 100% for each synthetic week, month and year under its observed-event formula. Latihan and Pelayanan stay outside its six indicators.
- `admin-bigdata.html` resolves PDF source rows through the same filter as the table. The export-data check queries Firestore as Viewer and exercises the staged PDF assembly up to its model. It returns exactly the synthetic current and legacy KD rows and the selected JC ranking row. No ranking formula or writer was introduced.

## Remaining blockers and Owner acceptance

| Acceptance item | Required evidence |
|---|---|
| Administrator per-member Rapor | BLOCKED. The tracked `rapor.html` is a member self-view and `getRaporStatistics` is scoped to the caller. The dashboard provides aggregate reports. A separate authorized Administrator per-member Rapor view requires Owner scope. |
| Deployment-equivalent transport | NOT TESTED. Run the staged candidate through the Firebase CLI Functions emulator and verify App Check enforcement with an approved test provider before any release decision. |
| Historical KD and rank source shapes | Review representative approved synthetic schemas for KD class/material and ranking period formats. The verified candidate reads the known fields and does not write or migrate existing rows. |
| Device QR and UMKM browser integration | Keep the maintenance gates enabled. A separate QR-enabled demo fixture and browser sender/seller smoke test remain acceptance cases. |
| Additional exports | NOT TESTED. Compare other single-tab exports, the full multi-tab export, and the member Rapor PDF against approved synthetic expectations. |

**READY FOR OWNER REVIEW** YES
**PRODUCTION READINESS** NO

### Reproduction

Run from the verified repository root. The first command runs the connected callable, Rules, and calculation suite without Chrome. The second enables browser interaction. Provision the named JavaScript assets in the TEMP library folder for the chart/PDF case. Run positive Reading and Attendance checks within 00:01–21:59 Asia/Jayapura. The WIT boundary test uses a fixed clock.

```powershell
node candidates/phase5-e2e/verify.cjs
# Set SIPAPUA_PHASE5_BROWSER to the path of an installed Chrome executable.
$env:SIPAPUA_PHASE5_BROWSER_LIBS = Join-Path $env:TEMP 'sipapua-phase5-browser-libs'
node candidates/phase5-e2e/verify.cjs
node --test tests/release-blocker-closeout/chat.test.cjs
node --test --test-name-pattern 'card page scripts parse|browser handoff' tests/member-card-emulator.cjs
```

The browser library directory uses Chart.js 4.5.1 (`chart.umd.js`), jsPDF 2.5.1 (`jspdf.umd.min.js`), AutoTable 3.5.23 (`jspdf.plugin.autotable.min.js`), html2canvas 1.4.1 (`html2canvas.min.js`), and html2pdf.js 0.10.1 (`html2pdf.bundle.min.js`). Chrome requires a renderer-capable environment. The restricted workspace sandbox denied GPU process access, and the separately approved headless run retained the loopback-only network constraints.
