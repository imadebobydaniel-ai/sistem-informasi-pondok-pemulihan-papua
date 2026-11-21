# SIPAPUA QR-INTEGRATION-01

**QR muncul pada area kartu halaman Kartu Digital SIPAPUA asli yang diberi patch di salinan lokal. GO untuk review kandidat lokal. Aktivasi produksi BLOCKED.**

## Baseline dan perubahan

Checkout `test/sipapua-emulator-guard-20261110` berada di `76cc5f8aac48618caf7411cc966f4665bcb57a6b` dengan remote `imadebobydaniel-ai/sistem-informasi-pondok-pemulihan-papua`. Status tracked bersih. Tidak ditemukan `AGENTS.md` pada root atau jalur kandidat yang diperiksa. QR-FIX-01 menyediakan fixture Worker dan aset QR lokal. QR-FIX-02 Web adalah demo statis terpisah dan tidak digunakan sebagai jalur aplikasi ini. Backend pengujian memakai Zero-Cost Final.

| File aplikasi | Perubahan dalam application.patch |
|---|---|
| `menu.html` | Kartu dalam menu memakai `SIPAPUA_MEMBER_CARD.issue()`. Guard maintenance dan pekerjaan menu di luar QR tetap ada. |
| `kartu-digital.html` | Modal kartu asli memakai fungsi issue yang sama dan menampilkan nama, NIJ, komsel dari respons Worker. Tidak meminta field jemaat yang tidak ada pada kontrak Worker. |
| `sipapua-member-card.js` | Memulihkan sesi Auth dan mendelegasikan issue/lookup ke adapter HTTP; guard tetap diperiksa. Scanner hanya menerima QR dengan prefix kartu dan token opaque 43 karakter, serta memakai handoff sekali baca melalui sessionStorage. Fallback email dan skema QR lama dihapus pada kandidat. |
| `qrcode.html` | Callback scanner menyerahkan token ke bio. Maintenance menjaga kamera tetap mati. UI menampilkan pesan jika kamera gagal. |
| `bio-singkat-jemaat.html` | Lookup read-only menggantikan Callable scan-introduction dan alur receipt. Hanya nama, NIJ dan komsel terverifikasi ditampilkan; tombol friendship tidak ada. |

Tiga dependensi kandidat yang harus tersedia bersama halaman adalah `sipapua-qr-http.js`, `bootstrap.mjs`, dan `limited-app-check.mjs` dari `candidates/qr-rc-02/frontend/`. Patch memakai nama file itu pada root aset aplikasi. Adapter aslinya masih memiliki `workerOrigin = null`. Tidak ada konfigurasi URL dari query, storage, atau tombol debug. `application.patch` bisa diperiksa menggunakan `git apply --check --ignore-space-change candidates/qr-integration-01/application.patch`. Jangan pasang overlay pada aplikasi aktif sampai review terpisah selesai.

## Kontrak dan fail-closed

Issue mengirim `POST /v1/issue` dengan body kosong sebagai objek. Worker mengembalikan token acak, `expiresAt` dan profil. Lookup mengirim `POST /v1/lookup` dengan token saja dalam body. UI menampilkan `profile` setelah adapter memeriksa `verified:true`. Firebase ID token dan limited-use App Check dikirim lewat header. Adapter memeriksa origin HTTPS yang ditetapkan di source, sesi, maintenance, timeout/redirect dan bentuk respons. Worker mengecek UID/NIJ, status akun serta pemilik sebelum pengungkapan profil, kemudian memakai conditional update untuk konsumsi sekali pakai. QR berlaku lima menit dan berisi token opaque, tanpa NIJ, nama, email atau kontak. Tidak ada identitas sintetis sebagai fallback aplikasi.

## Hasil verifikasi

| Lapisan | PASS | FAIL | Cakupan |
|---|---:|---:|---|
| Chrome dengan salinan halaman aplikasi asli | 1 | 0 | Klik modal asli, render kanvas, decode PNG lewat fixture kamera pada callback `qrcode.html`, navigasi ke bio, profil sintetis cocok, handoff sekali baca, replay ditolak, expiry menghapus tampilan, outage tampil aman, guard maintenance mencegah request dan start kamera. |
| Worker final, SQLite dan verifier/App Check mock | 17 | 0 | Expiry backend, replay/concurrent redemption, kepemilikan, revocation/disabled mock, verifier outage, kuota, storage failure, CORS dan session-change adapter. |
| Firebase Auth dan Firestore Emulator | 7 | 0 | Owner-only allocation REST, penolakan anonymous/list/write/cross-UID, binding salah, profil nonaktif, akun disabled dan sesi revoked. App Check tetap mock. |
| SDK limited-use | 3 | 0 | Ekspor API SDK terpasang, token baru per operasi dan fail-closed bila provider tidak tersedia. |

**Total 28 PASS, 0 FAIL.** Browser menampilkan **Penerbit Sintetis / NIJ-PPP-ABE-001-2026 / Komsel Demo** pada area kartu dan bio. `local-pages.mjs` menerapkan patch ke salinan TEMP, melayani halaman asli lewat loopback dan mengganti hanya dependency/config lingkungan uji saat melayani HTTP. Origin HTTPS fixture di adapter diterjemahkan ke loopback oleh shim browser; verifikasi TLS hosted tidak diuji. Worker tetap menjalankan issue dan consume terhadap SQLite dengan authority fixture. Kamera browser memakai PNG dari kanvas yang didekode jsQR sampai callback halaman asli, bukan perangkat fisik. Timer UI dipercepat; TTL backend, disabled akun dan revocation diverifikasi pada suite Worker/emulator terpisah. Integrasi modal di `menu.html` diperiksa lewat patch dan kontrak bersama; alur menu penuh serta Android fisik belum diuji.

Run browser: `node --test candidates/qr-integration-01/browser.test.mjs` dengan `SIPAPUA_QR_CHROME` mengarah ke Chrome lokal. Regresi: `node --test candidates/qr-zero-cost-final/test/worker.test.mjs candidates/qr-rc-03/test/allocation-rules.test.mjs candidates/qr-rc-02/test/limited-app-check.test.mjs` menggunakan dependency emulator PREHOST-02.

## Governance dan aktivasi

Checkout lokal masih memiliki `registration: true, memberCard: true` pada objek `paused`. Ref lokal `origin/main` di `cb3ed58eceb8a9abb9630a561c19469fd9e95e92` berisi `registration: false, memberCard: true`. Nilai registrasi itu berlawanan dengan keputusan HOLD. Ini temuan governance terpisah dari QR dan tidak membuktikan status produksi saat ini. File aktif, Rules, dan maintenance tidak diubah.

**BLOCKED untuk hosted dan produksi.** Verifier privat dengan identitas workload/OAuth Rp0 belum tersedia. Konsumsi App Check nyata, Rules/origin staging, metering D1, pengujian browser penuh dan perangkat fisik masih perlu bukti dan persetujuan Owner. Sampai gate terpenuhi, maintenance QR ACTIVE, registrasi HOLD dan friendship DISABLED. Tidak ada deployment, commit, push, merge, billing, perubahan IAM atau akses data jemaat.
