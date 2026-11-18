# FINAL RELEASE EXECUTION — NO-GO

Pemeriksaan 12 November 2026. Tidak ada commit, push, merge, deployment,
perubahan Firebase produksi atau akses data jemaat. Kode aplikasi tahap sebelumnya
tidak diubah pada pemeriksaan ini. Penambahan lokal hanya script preflight dan
manifest/laporan di direktori ini.

## Blocker dan tindakan yang diperlukan

### 1. Konfigurasi resmi Firebase / App Check — BLOCKED

Konfigurasi lokal konsisten menggunakan:

- Project ID: `boby-apps-project`.
- Project number: `125984859692`.
- Web App ID: `1:125984859692:web:09f75df5d2e4b6e3bcd389`.
- Auth domain: `boby-apps-project.firebaseapp.com`.
- Region callable: `asia-southeast2`.
- Provider yang diimplementasikan helper: **reCAPTCHA v3**.

Identitas ini belum dapat dicocokkan dengan konfigurasi cloud: pemeriksaan CLI
read-only dengan izin di luar sandbox menemukan **0 akun lokal terotorisasi** dan
tidak melakukan login/refresh token. `sipapua-app-check.js` masih `siteKey:null`.

Langkah Owner:

1. Firebase Console → project `boby-apps-project` → Project settings → General →
   Your apps → aplikasi Web. Cocokkan App ID, project number dan SDK config di atas.
   Jika berbeda, sediakan konfigurasi Web resmi untuk patch yang sesuai; jangan
   menganggap nilai lokal telah diverifikasi oleh cloud.
2. Pada reCAPTCHA Admin Console, pilih/buat pendaftaran **v3** yang sah untuk
   `imadebobydaniel-ai.github.io` (hostname tanpa skema, port atau path repository).
   Daftarkan custom domain hanya jika memang digunakan. Pertahankan validasi domain.
3. Firebase Console → Security → App Check → Apps → aplikasi Web yang sama →
   register dengan provider reCAPTCHA v3. Secret key dimasukkan **hanya di Console**;
   pasangan public site key dipakai untuk konfigurasi helper lokal. Jangan menaruh
   secret/private key, password atau token CLI di repository.
4. Authentication → Settings → Authorized domains: verifikasi hostname GitHub Pages
   dan domain resmi yang digunakan untuk tautan verifikasi/kelanjutan login.
   Pastikan Email/Password provider dan template/link verifikasi sesuai alur existing.
   Jangan mengaktifkan Anonymous Auth produksi.
5. Sediakan akses akun resmi untuk pemeriksaan metadata atau bukti read-only Apps,
   domain dan enforcement. Jangan mengirim access token/refresh token sebagai file.
   Pertahankan enforcement yang sudah aktif. Verifikasi callables memakai
   `enforceAppCheck:true` di produksi dan verifikasi layanan lain sebelum rilis;
   jangan mengaktifkan enforcement tambahan secara buta pada client legacy yang
   belum terbukti mengirim token.

Dokumentasi resmi:
[Firebase reCAPTCHA v3 setup](https://firebase.google.com/docs/app-check/web/recaptcha-provider),
[validasi domain reCAPTCHA](https://developers.google.com/recaptcha/docs/domain_validation).
Firebase kini menyarankan Enterprise untuk integrasi baru; kode yang telah diaudit
di sini memakai v3. Jangan mendaftarkan key Enterprise lalu memasukkannya ke helper
v3 tanpa patch provider dan pengujian terpisah.

### 2. Browser E2E positif dengan attestation sah — BLOCKED

Site key belum tersedia dan belum ada konfigurasi staging resmi. Alur positif
registrasi → NIJ → verifikasi email → aktivasi → login belum dapat dibuktikan
pada browser dengan App Check sah. Tes emulator/mock sebelumnya bukan bukti ini.

Runner `tests/release-gate-005a/browser.cjs` saat ini sengaja hanya memeriksa
fail-closed: ia memaksa project demo tanpa Web App ID dan memblokir seluruh network
selain SDK lokal/loopback. **Menambahkan site key saja tidak menjadikannya runner
positif.** Demo project bukan aplikasi cloud terdaftar untuk attestation.

Setelah konfigurasi resmi tersedia, siapkan runner positif terpisah dengan aplikasi
Firebase Web staging yang benar-benar terdaftar, provider/key/domain staging sah,
dan allowlist endpoint attestation yang diperlukan. Ikat Auth, Firestore dan Functions
ke proses emulator baru dengan identitas sintetis, sebelum operasi SDK apa pun;
blokir endpoint data produksi. Jangan mengubah runner fail-closed yang sudah PASS
menjadi bypass. Untuk guest anonymous, guard aplikasi tetap membatasi data ke
proyek demo yang disetujui: runner memerlukan rancangan attestation staging yang
terpisah dari target data demo dan pengujian atas pemisahan tersebut. Jangan
mengganti project demo dengan produksi agar anonymous sign-in lolos.

App Check tidak didukung sebagai enforcement emulator yang setara produksi.
Attestation browser sah dan penolakan backend tanpa token harus dibuktikan pada
lingkungan staging cloud resmi bila diperlukan; akun/NIJ sintetis tetap tidak
boleh dibuat di Firebase produksi. Akses/target staging tersebut belum tersedia.

### 3. Rules final dan kesiapan produksi — BLOCKED

`firebase.json` masih menunjuk `firestore.rules` baseline; file itu bukan proposal
privat final dan tidak boleh dideploy sebagai perbaikan keamanan. Proposal teruji
ada di `docs/release-gate-005a/firestore.final-proposed.rules`. Jangan memilihnya
untuk deployment sebelum mandatory gates lulus. Registry produksi, permission
aktivasi administrator, index query produksi dan Functions yang benar-benar
terpasang belum diverifikasi melalui akun resmi. Tidak ada migrasi/readiness
bootstrap otomatis atau perubahan counter/ledger yang dilakukan.

Guest chat memakai UID Auth, bukan ID lokal. Pesan legacy tidak diklaim atau
dimigrasikan. Pembeli lama tanpa bukti UID tidak otomatis mendapat akses riwayat;
penjual tetap bisa membaca percakapannya. Jangan membuka query publik untuk
memaksakan kompatibilitas identitas lama.

### 4. Tautan modul legacy tidak tersedia — BLOCKED

Preflight menemukan tiga `href` existing pada `informasi-email.html` ke file
yang tidak ada: `laporan-komsel.html`, `capaian-doa.html`, dan `saran.html`.
Tautan tersebut juga ada di HEAD baseline, bukan regresi integrasi baru. Diperlukan
file modul asli atau keputusan pemetaan tujuan yang benar. Jangan menghapus menu,
membuat halaman pengganti kosong, atau menyamakan fungsi modul tanpa bukti.

### 5. Cloudinary sintetis — BLOCKED / tidak dijalankan

Tidak tersedia cloud/preset pengujian dan persetujuan upload sintetis dalam
konfigurasi lingkungan. Tidak ada upload ke akun existing. Untuk gate upload
nyata, sediakan target test disposable resmi dan cleanup token sesuai kontrak
`tests/release-gate-005a/cloudinary.cjs`. Mock foto/callback yang sudah PASS tetap
dipertahankan; mock tidak menggantikan bukti provider.

### 6. Akses rilis GitHub / konfigurasi Pages — BLOCKED

Remote origin sesuai repository Owner. Branch kerja
`test/sipapua-emulator-guard-20261110`, HEAD
`ed272d43621f1e211bec9898503ee2d91e362414`. Tidak ada staged file saat pemeriksaan.
Koneksi GitHub resmi mengembalikan `pull:true`, `push:false`, `admin:false`.
Jangan menganggap koneksi ini dapat push atau mengatur Pages. API Pages tanpa
autentikasi mengembalikan 404; ini tidak membuktikan Pages tidak aktif.

URL publik berikut benar-benar merespons HTTP 200 pada pemeriksaan read-only:

https://imadebobydaniel-ai.github.io/sistem-informasi-pondok-pemulihan-papua/

Judul: `Index Jemaat - Pondok Pemulihan Papua`. Ini situs existing, **bukan verifikasi
deployment integrasi lokal**. Repo metadata melaporkan default branch `main` dan
`has_pages:true`; tidak ada CNAME atau workflow Pages di tree remote main.
Source branch/folder dan kebijakan penerbitan harus dikonfirmasi Owner melalui
Repository Settings → Pages dengan akses resmi. Untuk mencegah tests, fixtures,
Functions dan proposal Rules menjadi artefak publik, gunakan paket statis
allowlist, bukan upload seluruh repository. Manifest calon paket ada di
`MANIFEST.json`; manifest belum merupakan konfigurasi/pipeline deployment aktif.

## Bukti lokal yang tetap berlaku

- SHA-256 semua file yang dicatat Guest Chat Closeout masih cocok; kode aplikasi,
  proposal Rules dan tes terkait belum berubah sehingga tes sukses tidak diulang.
- Guest closeout: **11 static/mock PASS; 12 Rules groups PASS**, tanpa klaim browser.
- Baseline 005A mencatat **39 static/mock PASS, 31 Rules groups PASS,
  13 API emulator groups PASS, 4 browser scoped checks PASS** sebelum patch chat.
  Kelulusan chat terbaru melengkapi cakupan yang berubah; angka ini tidak dijumlahkan
  sebagai satu eksekusi suite terbaru dan bukan full interactive regression.
- Syntax keempat entry/modul Functions dan script preflight: PASS.
- Semua **7.838** endpoint JSON wilayah cocok checksum manifest dan masuk calon
  paket. Loader tetap relatif `./assets/wilayah/v2`, kompatibel project subpath.
- Pemindaian pola private key/token/service-account/literal password pada calon
  aset publik dan backend yang berubah: **0 temuan**. Bukan audit seluruh riwayat
  Git atau sertifikasi data pribadi semua konten legacy.
- `LOCAL-PREFLIGHT.json` sengaja menghasilkan status gagal sampai tiga rute legacy
  terselesaikan. Pemeriksaan mandatory cloud/browser tetap BLOCKED, bukan PASS.

Status commit: **tidak dibuat**. Status push/deployment: **tidak dilakukan**.
Keputusan: **NO-GO** sampai blocker di atas memiliki bukti penyelesaian.
