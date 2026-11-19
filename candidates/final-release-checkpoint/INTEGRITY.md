# Checkpoint path remediation integrity

The four originals were retained byte for byte in a new directory under system TEMP, outside this repository. Their SHA-256 values were verified before editing.

| File | Preserved original SHA-256 | Portable checkpoint SHA-256 |
|---|---|---|
| `candidates/admin-security-p0/matrix.cjs` | `75143461afffb5f876a92a9c1390a104aa77626881f08efa9ca367488059a9ae` | `e15361712058782244c45d5b9b111e121984fb98bfa2ec7261556df938dd9b21` |
| `candidates/phase4-compatibility/REPORT.md` | `8461af898d1d2bcc0a2d871619104f08e67d0eebe317b757c10602a5a93ce56b` | `4486efc21cb3cbf210e9841e335393ebca443ce40b5572acad82b09a5b6c5e84` |
| `candidates/phase5-e2e/REPORT.md` | `a6a931d7fba7418ac83a6ada38df1fef36a45c06d78e8b75882864f88d412a24` | `ba946dcb1f76aea767089dca13e77393dddfa0521b9080138443c4eb09efbe26` |
| `candidates/final-release-checkpoint/REPORT.md` | `179f91c53233e305e947bda3ac75e4afdf304c72589cf2a14520e125eed39fd1` | `9442bea961f8a0f893302e21c3da8f1a5fe2d2daad9e64b82494f6fc445a34b2` |

The P0 matrix now resolves the workspace relative to its own directory by default. For a standalone copy, set `SIPAPUA_WORKSPACE` or use the existing `source-path.txt` mechanism. Set `SIPAPUA_FIRESTORE_JAR` to use a specific local Firestore emulator JAR. The default uses the Firebase emulator cache under the current user's home directory.

The previous immutable SHA-256 for the P0 matrix applies only to the preserved original. The three report hashes recorded at prior checkpoints likewise identify their original versions. This table records the replacement versions. Fixtures, assertions, reported results and release blockers were preserved. The original P0 matrix result transcript remains outside the checkpoint allowlist.

The portable P0 matrix passed 16 checks. The connected local Chrome and emulator suite passed 33 checks. The existing chat and QR regressions passed 11 and 2 checks respectively.

Git's pre-staging whitespace check flagged existing whitespace in five selected files, including unified-diff context lines in the three overlay patches. The checkpoint stopped before staging under the path-remediation scope.


## Candidate patch whitespace policy

Byte-for-byte pre-policy backups are in system TEMP directory `sipapua-policy-originals-o7iz6nck`. The previous path-remediation SHA-256 history above still identifies the original and intermediate versions.

| File | Pre-policy SHA-256 | Checkpoint SHA-256 | Change |
|---|---|---|---|
| `candidates/admin-security-p0/matrix.cjs` | `e15361712058782244c45d5b9b111e121984fb98bfa2ec7261556df938dd9b21` | `e761b3aa6a3a1b4fc70410e16212033f003b67f36e6d14163a0499fcd723c063` | Removed the extra EOF blank line. |
| `candidates/phase5-e2e/REPORT.md` | `ba946dcb1f76aea767089dca13e77393dddfa0521b9080138443c4eb09efbe26` | `0a1a3d9ee266bf4ad86c3926032c8d47d9afc74ab2cd93e163bd60a0563718bf` | Removed trailing spaces on line 79. |

All three patch bytes were preserved and each patch passed `git apply --check --ignore-space-change` in sequence in a disposable copy of the baseline. The root attributes disable only the end-of-line and end-of-file blank checks for these three exact patch paths. This preserves their original unified-diff context and removed lines. Other Git whitespace diagnostics remain enabled, and the retained whitespace was not corrected.

| Unchanged patch | SHA-256 |
|---|---|
| `candidates/phase4-compatibility/compatibility.patch` | `27f051ae6f39f6e522f95d6a89949e30857a2d744108e5f57adae25f95355849` |
| `candidates/phase5-e2e/big-data.patch` | `d03797a342e191102bb34d12eeee0a33fe9d588471cb6ebf4396d9baac756146` |
| `candidates/final-release-checkpoint/administrator-rapor.patch` | `a8570e6ad18bb4be88d053c23e9a1fec8c48beac871b639288405e8858f3183e` |

Post-policy rerun: 33 connected Chrome and emulator checks, 16 P0 matrix checks, 11 chat checks and two QR checks passed with zero failures.
