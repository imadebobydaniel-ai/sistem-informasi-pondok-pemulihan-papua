# SIPAPUA QR-RC-04A — Validasi arsitektur Rp0

**BLOCKED untuk hosted staging dan rilis. GO untuk emulator dan prototipe lokal.** Belum ada bukti identitas workload Cloudflare yang diterima Google pada proyek tanpa billing, dan belum ada bukti OAuth tersebut dapat melakukan Auth revocation/current-owner lookup dan App Check consumption pada proyek itu. Tidak ada perubahan keamanan untuk menghindari biaya.

## Identitas dan akses Google

- Worker menggunakan service binding untuk membatasi pemanggil RPC. Binding tersebut bukan penerbit identitas Google. Penelusuran dokumentasi tidak menemukan assertion OIDC bawaan Workers Free yang dapat dipakai sebagai identitas runtime untuk arsitektur ini. Origin, IP dan token browser tidak membuktikan identitas workload. OIDC CI hanya membuktikan identitas job CI, bukan identitas Worker yang menangani permintaan QR.
- Jika Owner sudah memiliki issuer workload independen, issuer harus membatasi assertion ke verifier tertentu dan menerbitkan token singkat dengan issuer, subject dan audience yang disetujui. Google WIF memvalidasi assertion terhadap issuer/JWKS atau trust material yang disetujui dan kondisi atribut yang membatasi workload. Google STS menukarnya dengan federated OAuth token. Gunakan direct resource access jika ketiga API mendukung principal federasi. Jika tidak, uji impersonasi service account staging khusus melalui IAM Credentials dengan hak impersonasi hanya untuk subject verifier tersebut. Keduanya tidak memerlukan service-account key. Tidak ada token pengguna atau App Check yang masuk ke STS.
- Jalur OAuth harus membuktikan tiga operasi: lookup akun Auth berizin `firebaseauth.users.get` untuk membandingkan `auth_time` dengan `validSince` dan menolak akun disabled atau hilang, point reads Firestore untuk mengikat UID dan NIJ serta memeriksa status owner saat scan, dan `projects.verifyAppCheckToken` berizin `firebaseappcheck.appCheckTokens.verify`. Tetap validasi tanda tangan, issuer, audience, umur token, App ID dan status akun. Gunakan limited-use App Check yang baru per operasi dan tolak replay. Respons REST 200 yang menghilangkan `alreadyConsumed` berarti pertama kali dipakai menurut kontrak Google. Status gagal, respons tak dikenal dan replay harus ditolak.
- IAM API gratis menurut Google, tetapi ini belum membuktikan eligibilitas seluruh rantai tanpa billing. Khususnya belum ada bukti pool/issuer dan STS (serta IAM Credentials bila dibutuhkan) bekerja dengan API target pada staging Spark. Firebase Functions dan Cloud Run tetap gugur karena memerlukan billing. Tidak ada verifikasi Google live yang dijalankan.

[Google Workload Identity Federation](https://docs.cloud.google.com/iam/docs/workload-identity-federation) · [Praktik WIF](https://docs.cloud.google.com/iam/docs/best-practices-for-using-workload-identity-federation) · [IAM pricing](https://cloud.google.com/iam/pricing) · [Auth account lookup](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v1/accounts/lookup) · [App Check consume API](https://firebase.google.com/docs/reference/appcheck/rest/v1beta/projects/verifyAppCheckToken) · [Cloudflare RPC](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/) · [Cloud Billing](https://docs.cloud.google.com/docs/get-started/learn-about-billing)

## Kuota D1

| Jalur RC-03 | Operasi logis D1, sebelum biaya indeks |
|---|---|
| Ditolak sebelum autentikasi/validasi selesai | 0 |
| Global minute quota penuh | Satu upsert kondisional, 0 mutasi |
| UID minute quota penuh | Satu mutasi global, satu percobaan upsert UID |
| Verifier menolak atau gagal setelah admission | Sampai dua mutasi counter. Tidak ada mutasi kartu |
| Issue sukses | Dua mutasi counter, satu insert/upsert kartu |
| Lookup kartu hilang, self-scan atau owner ditolak | Dua mutasi counter, satu SELECT kartu. Tidak ada konsumsi |
| Lookup sukses | Dua mutasi counter, satu SELECT kartu, satu update kondisional |
| Cleanup | Dua DELETE batch yang masing-masing memilih hingga 100 baris. Indeks dan backlog ikut memakai kuota |

D1 menagih row reads/writes termasuk dampak indeks, sehingga hitungan SQL tersebut bukan angka tagihan. Pada 60 admission per menit, dua counter dapat menghasilkan 172.800 mutasi dasar per hari, melewati kuota 100.000 bahkan sebelum operasi kartu. Rancang reservasi harian atomik berdasarkan hari UTC setelah validasi awal dan sebelum query operasional maupun verifier. Prototipe memakai satu upsert kondisional, 32 kredit per request dan 32.000 kredit per hari, sehingga maksimal 1.000 admission/hari. Tahap desain mengalokasikan maksimal 32.000 row writes untuk admission + jalur request, 30.000 untuk cleanup dan pemeliharaan counter, serta menyisakan 38.000 untuk headroom dan pemakaian di luar jalur utama. Nilai ini adalah anggaran desain. Ukur `meta.rows_written` dan `meta.rows_read` setiap jalur di D1 yang disetujui, buktikan batas per request dan per batch, lalu sesuaikan biaya dan cadence sebelum menerima traffic. Siapkan guard terpisah untuk cleanup yang membatasi batch/day dan pemantauan sisa kuota akun. Tanpa isolasi pemakaian akun, beban Worker/D1 lain bisa menghabiskan anggaran. Prototipe belum terhubung ke Worker RC-03.

Jika batas aplikasi tercapai, tolak dengan 429 sebelum verifier atau operasi kartu. Jika binding/kuota D1 gagal, kembalikan 503 tanpa jalur alternatif yang melewati otorisasi. Query yang ditolak masih dapat menghabiskan read/Worker quota. Pertahankan Free account sebagai batas biaya platform, pakai rate limiting ingress, ukur failed-attempt traffic dan jaga cadangan untuk cleanup. Cloudflare menghentikan kueri saat kuota harian tercapai hingga 00.00 UTC. Expiry kartu tetap dievaluasi walaupun cleanup tertunda. Time Travel Free menyimpan riwayat tujuh hari. Batalkan token lama sebelum melanjutkan scan setelah pemulihan database agar restore tidak menghidupkan kembali token yang telah dikonsumsi.

[D1 pricing dan indeks](https://developers.cloudflare.com/d1/platform/pricing/) · [D1 enforcement](https://developers.cloudflare.com/d1/platform/release-notes/) · [Workers Free](https://developers.cloudflare.com/workers/platform/limits/) · [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)

## Perbandingan dan rekomendasi

| Opsi | Hasil |
|---|---|
| Emulator lokal dan SQLite/mock | **GO Rp0** untuk pengembangan dan bukti lokal. Tidak dapat menggantikan hosted release. |
| Worker privat + issuer workload independen yang telah tersedia, dengan WIF dan OAuth singkat | **Rekomendasi untuk review Owner.** Mempertahankan keamanan tanpa key. Ketersediaan issuer, biaya tambahan Rp0 dan akses API target tanpa billing belum terbukti. |
| Host Node milik Owner yang sudah dibiayai, dengan private transport dan WIF | **Bersyarat.** Mempertahankan verifier referensi, tetapi belum ada host, transport atau bukti biaya tambahan Rp0. |
| Worker dengan JWT publik saja, bearer pengguna atau replay cache lokal sebagai pengganti App Check consume | **Ditolak.** Tidak membuktikan status pemilik saat scan atau konsumsi provider. |
| Cloud Run / Firebase Functions | **NO-GO.** Model identitas terkelola layak secara teknis, tetapi billing wajib. |

Gate sebelum GO hosted: pilih issuer tanpa biaya tambahan yang menegakkan identitas runtime, buktikan OAuth diterima tiga API pada proyek Spark tanpa billing, validasi real limited-use attestation dan replay, serta buktikan batas per operasi dan cadangan cleanup D1. Jika tahap mana pun tetap tidak terbukti, pertahankan BLOCKED dan maintenance.

## Bukti lokal

- **7 PASS, 0 FAIL, Firebase Auth/Firestore Emulator.** Ulangi harness yang ada dengan proyek demo loopback. Owner-only REST, binding tidak sah, revocation dan disabled lulus. App Check dalam harness ini adalah mock.
- **4 PASS, 0 FAIL, prototipe terpisah.** SQLite menguji admission atomik dan reset UTC. Mock menguji penolakan saat binding/kuota habis, pemisahan assertion workload dari token browser, konsumsi pertama, replay dan respons layanan tidak sah. SQLite dan STS/App Check mock tidak menguji meter D1 atau trust Google hosted.
- Baseline `76cc5f8aac48618caf7411cc966f4665bcb57a6b`, manifest RC-04 `b9f4d1eae8313261d50a9ac1941ff40aef76fe8d428b3c479351eb2a3d65a653`. RC-01 sampai RC-04 dipertahankan. Registrasi HOLD, maintenance QR ACTIVE dan QR friendship DISABLED.

Perintah reproduksi lokal:

```text
node --test candidates/qr-rc-04a/prototype.test.mjs
node --test candidates/qr-rc-03/test/allocation-rules.test.mjs
```

Emulator menggunakan dependensi lokal yang dicatat pada RC-03. Tidak ada panggilan API hosted, resource eksternal, perubahan billing/IAM/Rules aktif, atau deployment.

