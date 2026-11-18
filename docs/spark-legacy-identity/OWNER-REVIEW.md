# SPARK LEGACY IDENTITY — PARTIAL / TESTED / BLOCKED / OWNER REVIEW REQUIRED

Tanggal: 2026-11-13. Implementasi dan pengujian lokal saja. Tidak ada Blaze,
Cloud Functions, Admin SDK browser, akses produksi, migrasi jemaat, commit,
push, merge, atau deploy. Integrasi UI dihentikan sesuai instruksi Owner karena
satu invariant keamanan gagal pada emulator.

## Workspace dan preservation

CWD dan writable root: `D:\MASTER PROJECT\SIPAPUA\APLIKASI SIPAPUA`.
Seluruh perubahan existing dipertahankan. Tidak ada reset/checkout.
Tidak ada perubahan HTML, Database Jemaat, dokumen profil, Rules aktif,
firebase.json, atau konfigurasi produksi dari pekerjaan ini. Tidak ada emulator
existing yang digunakan. Adapter registrasi existing tetap seperti baseline.

## File pekerjaan sesi ini

- `sipapua-legacy-linking.js`: factory pasif untuk permintaan, persetujuan,
  pembacaan persetujuan, konfirmasi, dan resolusi profil melalui binding.
  Tidak dimuat oleh halaman mana pun.
- `docs/spark-legacy-identity/linking-fragment.rules`: kandidat Rules baru.
- `docs/spark-legacy-identity/firestore.proposed.rules`: kandidat gabungan baru,
  diberi label BLOCKED / DO NOT integrate or deploy.
- `scripts/build-spark-legacy-proposal.cjs`: membangun kandidat dari proposal
  26-PASS; tidak mengubah proposal baseline maupun Rules aktif.
- `tests/spark-legacy-identity/security.cjs`: pengujian SDK client nyata,
  termasuk regresi yang mereproduksi blocker.
- `tests/spark-legacy-identity/registration-results.txt`: 26 PASS baseline
  ketika dijalankan terhadap proposal gabungan.
- `tests/spark-legacy-identity/linking-results.txt`, `result.json`,
  `last-failure.log`: hasil dan bukti kegagalan lokal.
- `tests/spark-implementation/rules.cjs`: hanya menambahkan pilihan path Rules
  melalui `SIPAPUA_TEST_RULES`; 26 assertion baseline dipertahankan.

## Mekanisme yang diimplementasikan sebagai kandidat

1. UID pemohon terautentikasi membuat `legacy_link_requests/{uid}` berstatus
   pending. UID tidak diperoleh dari input email. Permintaan tidak memberikan
   akses ke profil legacy.
2. Administrator aktif master/super_admin dengan canActivateMembers memverifikasi
   identitas melalui organisasi dan menyetujui pasangan UID/profileId existing.
   `legacy_link_approvals/{grantId}` menyimpan UID, profileId, NIJ, approverUid,
   identityVerified, approvedAt, expiresAt. Semua field persetujuan immutable.
   Client meminta masa berlaku 10 menit; Rules membatasi maksimum 15 menit.
   Dokumen persetujuan sendiri menjadi rekaman permanen tindakan persetujuan.
3. UID pemohon mengonfirmasi dalam transaksi yang membuat
   `member_identity/{uid}` dan `legacy_profile_owners/{profileId}` identik,
   mengubah permintaan menjadi completed, dan membuat audit final
   `registration_audit/legacy-link_{grantId}`. Tidak ada write profil lama.
4. Rules mengikat empat write final, UID pemohon, approver, izin approver saat
   konfirmasi, NIJ, timestamp, persetujuan, serta masa berlakunya. Index dan audit
   tidak dapat dipindahkan, diubah, atau dihapus client.
5. Kepemilikan legacy pada kandidat ditentukan dari kedua indeks, bukan email.
   Dokumen kanonis baru memerlukan pasangan profil/alokasi. Registrasi baru
   memeriksa ketiadaan binding UID. Claim reservation tetap create-only dengan
   timestamp commit yang sama; tidak ada izin overwrite/delete reservation.

Aktivasi tidak dijalankan sebagai efek pengaitan. Dokumen profil legacy,
NIJ, counter, reservasi, dan status akun tidak disentuh. Persetujuan bukan bukti
bahwa email pemohon terverifikasi dan tidak mengubah verifikasi Firebase Auth.

## Hasil pengujian

Registrasi baseline pada kandidat gabungan: **26 PASS / 0 FAIL**.
Pengaitan: **23 PASS / 1 FAIL**. Total: **49 PASS / 1 FAIL**.
Satu FAIL adalah kegagalan invariant produk, bukan kegagalan startup emulator.
Exit code suite pengaitan sengaja nonzero. Tidak ada pengubahan ekspektasi test
menjadi PASS untuk menerima perilaku yang tidak aman.

Runner menjalankan JAR Firestore lokal pada port loopback baru dan temporary
directory baru; hanya proses child itu yang dihentikan. Project pengaitan:
`demo-sipapua-legacy-linking`. Token pemohon/admin adalah konteks sintetis
rules-unit-testing, bukan akun produksi. Transaksi factory dijalankan melalui
adapter tipis Firebase JavaScript SDK modular nyata; evaluasi Rules tidak dimock.
Seeding bypass Rules hanya untuk fixture pengujian sintetis.

23 kasus PASS mencakup jalur valid, resolusi doc.id lama, preservasi data,
email terverifikasi tidak memberikan akses, tanpa persetujuan, UID berbeda,
kedaluwarsa, replay, dua UID bersaing, izin dicabut, setiap indeks/audit yang
hilang, request tidak dikonsumsi, indeks/audit tidak konsisten, profil kanonis
existing, alokasi existing, binding existing, forgery/mutasi approval, role
admin/viewer vs super_admin, immutability, konflik registrasi setelah binding,
dan penolakan write pada profil lama.

Perintah reproduksi PowerShell:

```powershell
node scripts/build-spark-legacy-proposal.cjs
$env:SIPAPUA_TEST_RULES = 'docs/spark-legacy-identity/firestore.proposed.rules'
node tests/spark-implementation/rules.cjs
Remove-Item Env:SIPAPUA_TEST_RULES
node tests/spark-legacy-identity/security.cjs
```

## Blocker yang dibuktikan

Kode existing `functions/member-lifecycle.js`, resolveOwnedProfile, secara
eksplisit mendukung `users/<randomDocumentId>` yang mempunyai field uid,
melalui query `where('uid','==',user.uid).limit(2)`. Database Jemaat juga memakai
doc.id, bukan mengasumsikan semua ID adalah UID Auth.

Regresi terakhir menyiapkan:

```text
users/historical-random-id.uid = existing-field-uid
users/old-existing-field-uid = profil legacy tanpa uid
legacy_link_requests/existing-field-uid = pending
persetujuan administrator sah untuk profil kedua
```

UID tersebut tidak mempunyai `users/{uid}`, nij_allocations/{uid}, atau
member_identity/{uid}. Konfirmasi pengaitan ke profil kedua **berhasil**,
padahal harus ditolak karena UID telah tercatat pada profil pertama.
Assertion `assertFails` menghasilkan `Expected request to fail, but it succeeded`.

Rules hanya dapat membaca path dokumen yang diketahui; tidak dapat menjalankan
query untuk membuktikan ketiadaan semua `users/*` dengan uid tertentu. Query dari
browser sebelum approval juga bukan bukti yang dapat diwajibkan Rules. Checklist
administrator saja tidak menjadi jaminan invariant ini pada level Rules.
Tidak ada akses produksi sehingga keberadaan atau ketiadaan format konflik
ini pada data nyata belum diketahui; dukungannya pada kode existing jelas.

Karena persyaratan Owner mencakup UID yang sudah mempunyai profil, bukan hanya
UID yang sudah mempunyai indeks baru, kandidat belum aman untuk integrasi.
Kandidat tidak dihubungkan ke editor/login/profil, dan tidak digunakan untuk
menulis data jemaat. Ini juga berarti alur callable existing belum digantikan.

## Prasyarat untuk menutup blocker

Diperlukan indeks kepemilikan deterministik yang lengkap dan tepercaya untuk
relasi UID existing, termasuk profil dengan ID acak. Indeks harus mempertahankan
doc.id, NIJ, profil, reservasi, dan counter; tidak boleh dibangun otomatis hanya
berdasarkan email. Relasi uid existing yang konflik perlu pemeriksaan manusia.
Setelah indeks tersedia, semua writer pembentuk relasi UID harus menggunakan
dan menjaga indeks yang sama; kelengkapan indeks tidak boleh hanya diasumsikan
dari satu flag atau klaim browser.

Inventaris read-only serta prosedur pengisian indeks secara terkontrol memerlukan
scope/keputusan Owner berikutnya. Tidak ada inventaris produksi, backfill,
atau migrasi otomatis yang dilakukan. Pemeriksaan disabled/revoked Auth dan
pencabutan akses Firestore juga tetap memerlukan kontrak lifecycle tersendiri.

## Kompatibilitas dan keputusan integrasi

Database Jemaat existing tidak berubah: tetap membaca users dan membuka editor
dengan doc.id. Module kandidat mengembalikan snapshot dengan doc.id asli setelah
pengaitan. Namun integrasi editor untuk approval dan login/profil untuk request
serta confirmation **belum dilakukan**, sebab gerbang keamanan gagal.

Jangan menyatakan status IMPLEMENTED / TESTED untuk integrasi keseluruhan.
Status yang benar: kandidat lokal diimplementasikan dan diuji; **BLOCKED,
OWNER REVIEW REQUIRED**. Tidak ada pelonggaran keamanan, produksi, deployment,
atau pemindahan ke Blaze untuk memaksakan kelulusan.
