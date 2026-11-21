# SIPAPUA QR-PREHOST-02

**GO untuk PREHOST-03 lokal. NO-GO untuk staging hosted dan produksi.** Pengujian utama selesai dengan **28 PASS, 0 FAIL, 0 BLOCKED**. Pemeriksaan statis runner mencatat **7 PASS dan 1 REVIEW** untuk cadence cleanup. Biaya tambahan Rp0.

## Runner dan integritas

`prehost-check.mjs` di direktori ini menggantikan runner PREHOST-01 untuk pengujian lokal. Runner membedakan batas path manifest dari pemeriksaan JAR emulator. File manifest tetap harus berada di dalam repository setelah resolusi symlink. JAR yang sudah terpasang boleh berada di luar repository, termasuk cache Firebase lokal. Runner memeriksa Java, JAR dan modul lokal sebelum memulai suite emulator serta melaporkan hitungan tes TAP.

- **55 entri SHA-256 dari 6 manifest PASS.** Semua 52 file kandidat identik byte-for-byte dengan blob checkpoint GitHub `c4218fd6c9beed5b07fb52886e08b30abddaa873`. Checkout utama tetap di `76cc5f8aac48618caf7411cc966f4665bcb57a6b`. Perbandingan dilakukan dengan objek Git yang sudah tersedia secara lokal. Tidak ada perubahan pada paket lama atau normalisasi byte.
- Pemindaian pola private key, token akses, kredensial JSON, path pengguna dan indikator PII lulus pada 52 file kandidat dan runner baru. Ini pemeriksaan berbasis pola. Rules aktif, `firebase.json` dan konfigurasi maintenance tetap sesuai checkpoint.
- Firebase Auth dan Firestore Emulator berjalan pada loopback `127.0.0.1` dengan proyek `demo-sipapua-qr-rest`, cache JAR yang tersedia, dan identitas sintetis. Tidak ada dependency baru atau akses layanan produksi.

## Hasil pengujian

| Suite | PASS | FAIL | BLOCKED | Cakupan |
|---|---:|---:|---:|---|
| QR Zero-Cost Worker | 17 | 0 | 0 | Replay, exactly-once concurrent scan, expiry, revocation dan owner checks sintetis, daily cap, storage failure, CORS dan adapter |
| RC-04A prototype | 4 | 0 | 0 | Race reservasi, reset UTC, penolakan saat penyimpanan gagal, pemisahan assertion workload dan replay mock |
| RC-03 Firebase Auth / Firestore | 7 | 0 | 0 | Satu induk dan enam subtes. Owner-only REST, penolakan anonim/list/write/cross-UID, binding invalid, disabled dan revoked di Auth Emulator |

Kontrol negatif terpisah menggunakan path JAR yang sengaja tidak ada. Runner melaporkan suite RC-03 sebagai **BLOCKED / EMULATOR_PREREQUISITES_MISSING** dan exit code 2, sementara kedua suite offline tetap PASS. Run utama dengan JAR cache keluar dengan kode 0. Konsumsi App Check masih menggunakan mock.

- Run utama: [Markdown](C:/Users/User/AppData/Local/Temp/sipapua-prehost-02-JKcmHZ/PREHOST-RESULT.md) dan [JSON](C:/Users/User/AppData/Local/Temp/sipapua-prehost-02-JKcmHZ/PREHOST-RESULT.json).
- Kontrol negatif: [JSON](C:/Users/User/AppData/Local/Temp/sipapua-prehost-02-nzzg1T/PREHOST-RESULT.json).

Reproduksi menggunakan `node candidates/qr-prehost-02/prehost-check.mjs .` dengan `SIPAPUA_TEST_DEPS` dan `SIPAPUA_TEST_AUTH_SERVER` mengarah ke dependency yang sudah terpasang. `SIPAPUA_FIRESTORE_JAR` dapat diisi dengan path absolut lokal; jika kosong runner memakai lokasi cache versi yang dipakai suite RC-03.

## Keputusan cleanup

Pertahankan cadence **30 menit** pada template lokal. Dengan anggaran desain 600 kredit per run dan 30.000 kredit cleanup per hari, 48 run per hari mereservasi 28.800 kredit. Interval 10 menit meminta 144 run atau 86.400 kredit per hari. Pada cap sekarang, maksimal 50 sweep mendapat reservasi. Dengan demikian, mengubah jadwal saja dapat menghabiskan cadangan lebih awal dan menunda cleanup berikutnya. Kredit adalah estimasi konservatif; meter D1 hanya bisa dibuktikan dengan `meta.rows_read` dan `meta.rows_written` hosted.

Setiap run menghapus maksimal 64 baris dari masing-masing tabel. Delay normal setelah expiry dapat mendekati 30 menit. Backlog atau penyimpanan/kuota yang gagal dapat memperpanjangnya. Token tetap ditolak setelah expiry dan tidak dapat dipakai ulang walaupun row belum dihapus. Target penghapusan 10 menit tetap memerlukan review retensi, metering, dan kapasitas. Tidak ada perubahan jadwal pada kandidat atau Cloudflare.

## PREHOST-03 dan batas hosted

**Dua perangkat: siap dilanjutkan sebagai uji lokal terisolasi, NOT TESTED pada PREHOST-02.** PREHOST-03 perlu fixture sintetis yang bisa dijangkau kedua perangkat melalui jaringan terisolasi, tanpa jalur ke produksi. Uji tampilan/scan, tepat satu redemption, self-scan, expiry, pergantian sesi dan kegagalan jaringan. Maintenance aplikasi aktif tetap menyala; fixture tidak menulis friendship.

Hosted staging tetap tertahan sampai tersedia identitas workload dan OAuth tanpa billing, bukti privileged Auth dan binding owner serta konsumsi App Check nyata, pengukuran kuota/cleanup D1, origin yang disetujui dan hasil dua perangkat. Registrasi HOLD, kartu maintenance ACTIVE dan QR friendship DISABLED. Tidak ada commit, push, deployment atau perubahan produksi, IAM maupun billing.
