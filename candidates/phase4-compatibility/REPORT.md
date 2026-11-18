# SIPAPUA Phase 4 compatibility candidate

**Owner review ready. Production readiness NO.** The candidate integrates the preserved P0 authorization policy with the member and Administrator workflows. It passed Auth and Firestore emulator checks with synthetic identities. Browser E2E and the callable transport are still acceptance gates.

## Baseline and workspace

- The Git root and writable workspace were both `.`. The branch was `test/sipapua-emulator-guard-20261110` at `36a402024f5c040d4cc07caa5416922c4d55ec45`.
- Git reported zero tracked changes before and after. `firestore.rules`, `firebase.json`, the active `functions/member-lifecycle.js`, and `sipapua-maintenance.js` match HEAD. The maintenance script still sets `registration: true` and `memberCard: true`.
- All six files in `candidates/admin-security-p0/` match the original SHA-256 manifest. Phase 4 created five untracked candidate files. Git reports **69,698 untracked entries** after creation, up from 69,693 at entry.

## Untracked inventory

| Scope at entry | Entries | Finding |
|---|---:|---|
| `docs/activation-restoration/` | 63,127 | 55,184 release-check artifacts and 7,893 corrected release artifacts, plus 50 scripts, snapshots, status files, and evidence entries. |
| `docs/lacak-domba-restoration/` | 6,542 | 6,532 cached tooling entries, primarily under `.cache/`, plus 10 evidence, schema, and snapshot entries outside the cache. |
| `candidates/admin-security-p0/` | 6 | Preserved source and test evidence for P0. |
| Other paths | 18 | Test results, review snapshots and diffs, inventory evidence, and two irregular root-level filenames. Counted as existing material. |

There are 62,712 untracked paths under `assets/wilayah/` **inside** release artifacts, compared with 7,839 tracked paths under the application’s top-level `assets/wilayah/`. The release artifacts account for the apparent asset explosion. Repository source and intentional candidate source were identified by their Git paths and purpose. The untracked evidence includes backups and identity or access-related filenames. Classification used paths and counts without reading sensitive payloads. No existing file was staged, overwritten, or removed.

## Login and Administrator implementation

- `index.html` uses the restored Firebase Auth user even when the cached UID is absent. `menu.html` resolves the member header from Auth and stops using cached UID as the inbox identity fallback. `sipapua-login.js` and `sipapua-member-session.js` bind callable results to the expected user across asynchronous boundaries.
- The session facade now calls the existing regional backend operations for login status, own profile, profile updates, audited activation, and profile deletion. App Check is required by the candidate client. The facade retains the own-profile snapshot interface and uses a callable result for legacy document IDs.
- `functions/registration-paket-a.js` checks that an allocated NIJ belongs to the canonical activation target. It rejects uncertain legacy ownership, including duplicate matching profiles. It keeps the existing activation transaction and shares its override-audit validation with reporting through `functions/member-lifecycle.js`. It leaves Auth email verification and NIJ allocation intact.
- `edit-jemaat-administrator.html` and `database-jemaat.html` route writes through the audited lifecycle callables. Bulk delete keeps the existing four-profile batches and reports only confirmed batches when a later request fails. The emulator test deletes disposable profile documents and never deletes an Auth account.

| Scenario | Verified result |
|---|---|
| Master and Super Admin | Member/profile-manager permissions, report reads and ordinary report updates. Super Admin can manage lower roles. Master protection remains in Rules. Activation also requires `canActivateMembers: true` and explicit identity attestation. |
| Admin and Viewer | Active roles can list members and read family, regional, and report data. Denied activation, writes to another member’s profile, report mutations, and bulk delete. |
| Inactive administrator | Denied privileged reads, activation, profile edits, report mutations, and bulk delete. |
| Member and legacy identity | Own profile access remains available through validated ownership. A conflicting UID, ambiguous email match, or mismatched activation target fails closed. Direct UID or NIJ reassignment is denied. |

## Reporting dependency map

| Flow | Member form, validation and authorized write | Administrator query, aggregation and output |
|---|---|---|
| Menu Laporan | The **Laporan & Akun** section in `menu.html` links to `kehadiran.html` and `baca-alkitab.html`. The same page exposes Rapor and Laporan Pelayanan elsewhere in the menu. Navigation has no report write. | `admin.html` links to Big Data and the separate annual-report module. |
| Pembacaan Alkitab | `baca-alkitab.html` collects the main book and chapter range, Amsal chapter, and optional extension. The callable validates the 00:01–22:00 WIT window and chapters, derives UID and email from Auth and name and JC from the owned profile, then writes `laporan_bacaan`. It retains `kitab`, `pasal_dari`, `pasal_sampai`, `pasal_utama_full`, `pasal_hikmat`, optional `pasal_extension`, `tanggal`, `tanggal_str`, server `timestamp`, and numeric `created_at`. One report per UID and WIT day, including historical rows with either date field. | `admin-bigdata.html` uses a collection listener, then applies period, region and JC filters when those dimensions exist. The Bacaan tab shows name, JC, reading date and wisdom. `rapor.html` uses an explicit `where("uid", "==", state.user.uid)` listener. A saved matching reading counts as a completed reading under the existing formula. |
| Laporan Latihan | `kehadiran.html` offers **Semua Jenis Latihan**, stored as `kegiatan: "Absen Latihan PW"`. It collects attendance status, the absence reason when applicable, and browser GPS/location. The callable validates the WIT date, activity, status, and GPS shape. It derives UID and name from Auth/owned profile and atomically writes `kehadiran_jemaat` and the `statistik_jemaat_pusat` mirror with `type: "Umum_Entry"`. The saved fields include `status`, `tanggal`, `timestamp`, `kegiatan`, `lokasi_koordinat`, `alamat_fisik`, and `keterangan`. | Big Data reads `kehadiran_jemaat` and filters exact `kegiatan === "Absen Latihan PW"` plus selected period and available dimensions. It displays name, date, status, reason and GPS/address. Latihan is outside the six scored Rapor indicators. |
| Laporan Pelayanan | `laporan-pelayanan.html` validates category, activity, location, and calendar date. The callable writes `laporan_pelayanan` with Auth UID/email, `kategori`, `nama_kegiatan`, `lokasi`, `tanggal`, server `created_at`, and `poin: 10`. The same transaction adds 10 to `users/{resolvedProfileId}.total_poin`. Exact normalized repeats by UID, category, activity, location, and date return the saved report without awarding points twice. Existing rows are checked using UID/date and the remaining fields. | Big Data uses an auxiliary collection read and `created_at` for the period, with existing date fallbacks. It displays email, category, activity, location, date and points. This points update is separate from the Rapor scoring formula. No active reader of `total_poin` was identified in the tracked HTML/JS. |
| Rapor Jemaat | `rapor.html` is a read-only member view. It reads the owner profile through the lifecycle callable and listens to `laporan_bacaan`, `kehadiran_jemaat`, `laporan_komsel_umum`, and `laporan_doa` using Auth UID. Attendance uses the same form and callable as Latihan. Komsel routes to `laporan_komsel_umum` and Doa Puasa to `laporan_doa`; other attendance goes to `kehadiran_jemaat`. The existing daily lock applies to Ibadah Raya, Komsel Reguler, and Doa Puasa. | `rapor.html` uses activity names, dates, and `status` or `status_doa == HADIR` for attendance. The baseline targets remain Alkitab 30/month and 365/year, Ibadah/Komsel/Doa 4/month and 52/year, Gabungan 1/quarter and 4/year, and the existing ad hoc treatment for Pertemuan Pemimpin. Each indicator still converts percentage to a maximum of 10 points. The separate `getRaporStatistics` callable in `functions/index.js` uses `functions/rapor-stats.js` to count distinct observed events by week, month, year and applicable region/Komsel. Its denominators were also retained. |
| Administrator Big Data | The dashboard consumes the saved report collections above. Its active member population comes from `users.where("status_akun", "==", "Aktif")`. The four core sources are `kehadiran_jemaat`, `laporan_komsel_umum`, `laporan_bacaan`, and `laporan_doa`; Pelayanan uses an auxiliary read. | `admin-bigdata.html` requires an active `admin_users/{uid}` role. It filters exact activities, region, JC and date, then builds charts, tables, insights and PDF. PDF now uses the same filter and time-field resolution as the table, including service reports written with `created_at`. An inaccessible auxiliary source shows a read error. A PDF with an unreadable source is never saved as a complete export. |

The annual report in `laporan-tahunan.html` gates access through `admin_users/{uid}` and reads the published agenda, events and annual activities REST views. It is a separate dataset from the members’ Firebase reports. This mapping used local source only.

### Report privacy and failure behavior

- Rules preserve member UID-filtered reads and active Administrator reads for the core report collections. New submissions go through authenticated callables. Managers can still edit ordinary report fields, while the candidate protects the stored UID, email, name and JC from direct reassignment.
- `statistik_jemaat_pusat` is a private raw mirror. Rapor’s listener to that collection only assigned an unused variable; its removal leaves the score functions unchanged. Neither reporting path requires widening access to the mirror.
- New Reading and daily attendance writes serialize duplicate checks with the save. Non-daily attendance keeps the prior ability to log multiple activities and uses a request ID for same-page retries. Fresh-page retries for non-daily attendance are a Phase 5 acceptance case.
- Attendance writes its source and mirror together. Pelayanan saves the report and points together. The frontend displays success after receiving a saved ID. Unreadable historical point totals require review before the transaction can commit.
- Historical identity fields are left in place. A historical row with no trustworthy UID is outside the owner’s UID-filtered Rapor and outside UID-based duplicate checks. Phase 4 performs no relinking or migration.

## Created files

All deliverables are in `candidates/phase4-compatibility/`.

| File | Purpose |
|---|---|
| `compatibility.patch` | Review overlay for `index.html`, `menu.html`, `sipapua-login.js`, `sipapua-member-session.js`, `edit-jemaat-administrator.html`, `database-jemaat.html`, `baca-alkitab.html`, `laporan-pelayanan.html`, `kehadiran.html`, `rapor.html`, `admin-bigdata.html`, `functions/index.js`, `functions/registration-paket-a.js`, and `functions/member-lifecycle.js`. |
| `firestore.phase4.rules` | Isolated P0-derived Rules covering report ownership, reads, and callable-only creation. |
| `member-reports.js` | New Functions source for `functions/member-reports.js` when staged with the overlay. |
| `verify.cjs` | Stages just the candidate into a temporary directory. Starts loopback Auth and Firestore emulators under a demo project, verifies candidate code, and stops the emulators. |
| `REPORT.md` | This handoff and Phase 5 matrix. |

Run `node candidates/phase4-compatibility/verify.cjs` from the repository root to reproduce the integrated checks with the installed SDKs, Java and locally cached Firebase emulator tooling. `SIPAPUA_FIRESTORE_JAR` and `SIPAPUA_AUTH_EMULATOR_MODULE` can point to equivalent local tooling. The test runner leaves its isolated staging directory in the system TEMP folder.

## Verification results

| Suite | Status | Coverage |
|---|---|---|
| Phase 4 integrated candidate | PASS | 16 checks. Real Auth sign-in, refresh and Admin Auth reads against local Auth. Real Firestore transactions and Rules against local Firestore. Candidate callable handlers invoked directly and browser scripts exercised in a VM for session restoration and filters. |
| Preserved P0 authorization matrix rerun against Phase 4 Rules | PASS | 16 checks, including Master protection, lower-role administration, identity invariants and legacy UID reads. |
| Existing QR frontend checks | PASS | 2 checks for inline scripts and token handoff. The maintenance gate is enabled. |
| Existing UMKM chat frontend checks | PASS | 11 synthetic checks for Auth identity, App Check and read/write UI behavior. |
| Registration safety | PASS | The candidate’s local registration readiness rejects disabled control. Local registration and member-card maintenance flags remain enabled. |
| Rapor calculation consistency | PASS | The candidate frontend’s scoring code and targets match the baseline. The existing backend calculator returned the expected synthetic counts, targets and percentages. |
| Big Data KD and Peringkat JC | BLOCKED | The existing tabs query `kehadiran_kd` and `peringkat_jc`. No tracked writer was identified, and the candidate Rules deny both sources. Full multi-tab PDF export has the same dependency. |
| Live chat compatibility with candidate Rules | BLOCKED | The P0-derived policy still denies the shared `chats` collection used by UMKM. The local Rules test confirms this boundary. Personal and group chat flows need their separately reviewed policies and emulator E2E. |
| Browser E2E, Functions HTTP/App Check transport, full QR scan and GPS/device behavior | NOT TESTED | Local handler invocation and VM checks cover narrower contracts. |

## Phase 5 E2E acceptance matrix

| Scenario | Acceptance criteria | Phase 4 status |
|---|---|---|
| Browser login and restored session | Sign in, clear member UID/email cache while retaining Firebase Auth persistence, reload and reach the member menu with the correct profile. Switch or sign out and verify stale calls and inbox identity are discarded. | NOT TESTED in browser |
| Verified activation and legacy override | Verified allocated account activates once, emits one audit, and keeps NIJ and UID. Super Admin with activation permission can attest the correct legacy record. Verify Auth remains email-unverified for the override. Ambiguous or unapproved targets stay closed. | PASS in handler/emulators, browser NOT TESTED |
| Administrator role and data coverage | Exercise Master, Super Admin, Admin, Viewer, and inactive identities through dashboard navigation, regional filters, family views, and editing. Confirm employee roles outside member-management permissions cannot write. | PASS in Rules/handlers, browser NOT TESTED |
| Bulk delete partial failure | In a synthetic profile-only run, fail a later batch and confirm earlier batches and audits are accurate, the rest remain present, and the UI shows only confirmed progress. Verify repeat requests and permissions changes between batches. | PASS in handler/emulator, browser NOT TESTED |
| Reading, service, and attendance forms | Verify rejection of invalid or unauthorized submissions, correct UID attribution, old-data duplicate behavior, atomic report/points or report/mirror writes, and no success UI after rejection. Check WIT boundary and lost-response retry. | PASS in handler/emulator, browser NOT TESTED |
| Rapor Jemaat and Big Data output | Compare member Rapor totals and charts with the baseline fixtures. Compare UI/PDF row counts across activity, month, year, region and JC, including historical dates and service `created_at`. Verify the private raw statistics stays restricted. | PASS for scoring parity, filters and core Rules. Browser/PDF NOT TESTED. KD/ranking BLOCKED. |
| Registration and QR | Confirm both maintenance paths remain on in candidate pages. Run approved synthetic QR compatibility tests separately with isolated emulator fixtures. | PASS for local maintenance/registration gates, full QR NOT TESTED |
| Chat | Validate authorized participants, read and write paths, and denial of unrelated parties through UMKM, personal and group chat pages. | BLOCKED for UMKM policy integration. Personal/group browser NOT TESTED. |

Owner decisions are needed for the two Big Data auxiliary collections, authorized chat policy integration, and any historical records with unsupported identity or point formats. Browser E2E must establish the deployed callable contract and App Check handling in a fully local environment before any release decision. Registration remains on HOLD and member-card maintenance stays enabled.
