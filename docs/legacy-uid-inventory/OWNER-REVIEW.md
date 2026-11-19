# LEGACY UID INVENTORY — OWNER REVIEW REQUIRED

Status saat penyusunan: **NO-GO untuk pengaitan identitas**. Alat inventaris
read-only siap dijalankan Owner; inventaris produksi belum dijalankan.
Jumlah produksi **belum diketahui**, bukan nol.

## Hasil lokal dan batas akses

Workspace dan writable root sesuai repository utama. Perubahan existing serta
suite registrasi 26 PASS dan pengaitan 23 PASS / 1 FAIL dipertahankan dan tidak
dijalankan ulang. Tidak ada akses autentikasi/produksi dari sesi Codex ini.
Tidak ada kredensial yang dicari, disalin, atau diekspor. Tidak ada penulisan
profil, NIJ, counter, reservasi, status akun, indeks, atau Rules aktif.

File baru:

- `scripts/legacy-uid-inventory.cjs`: collector read-only dan analisis agregat.
- `tests/legacy-uid-inventory/inventory.test.cjs`: pengujian sintetis offline.
- Dokumen ini dan `tests/legacy-uid-inventory/results.txt`: petunjuk dan hasil uji.

## Struktur existing yang diperiksa dari kode

`functions/member-lifecycle.js:22` mencari `users/{uid}`, lalu
`users.where('uid','==',uid).limit(2)`. Ini membuktikan kode mendukung dokumen
ber-ID acak yang mempunyai field uid. Jalur terakhir memakai email; inventaris
ini tidak membaca email dan tidak menggunakan jalur tersebut sebagai bukti.

`database-jemaat.html:3008` membaca users dan memakai doc.id;
`database-jemaat.html:6960` membuka editor existing dengan doc.id. Helper
persiapan registry juga menggunakan ID profil lama untuk pemilik reservasi.
NIJ dan doc.id tidak boleh diganti dalam penyelesaian konflik.

## Metode resmi dan pemeriksaan izin

Tool hanya berjalan jika dua argumen project dan persetujuan read-only persis
`boby-apps-project` diberikan. Tanpa argumen itu proses berhenti sebelum auth.
Token diperoleh di memori proses dari `gcloud auth print-access-token` dengan
stdout ditangkap internal dan stderr tidak dicetak. Tidak ada token pada argumen
command line, laporan, atau log tool. Tool tidak melakukan login otomatis.

Sebelum membaca anggota, tool memanggil RPC
`projects.testIamPermissions` untuk memastikan:

- `datastore.entities.get`
- `datastore.entities.list`
- `firebaseauth.users.get`

RPC tersebut memakai POST, tetapi hanya menguji izin, tidak mengubah IAM.
Ini satu-satunya POST yang diizinkan transport. Tidak ada endpoint mutasi.
Jika izin belum terverifikasi, proses berhenti. Kebijakan IAM bersyarat pada
resource tertentu dapat membuat preflight gagal; jangan melewati pemeriksaannya.
Owner menggunakan akun organisasi resmi dan akses baca minimum yang disetujui;
tool tidak memberikan izin baru atau memerlukan upgrade billing.

Setelah preflight, endpoint data hanya GET ke host/path project yang diizinkan:

| Sumber | Field yang diminta |
| --- | --- |
| Firebase Auth accounts:batchGet | localId dan disabled; partial response fields |
| users | uid, nij, nij_number, wilayah |
| nij_allocations | uid, nij, nij_number, wilayah, lokasi |
| member_identity | uid, profileId, grantId, linkedAt |
| legacy_profile_owners | uid, profileId, grantId, linkedAt |

Nama, email, telepon, password hash, token akun jemaat, dan seluruh field
demografi tidak diminta. Counter dan registration_unique tidak dibaca atau
ditulis. Pagination menyelesaikan seluruh koleksi yang dicakup. Firestore
menggunakan satu readTime untuk semua halaman/koleksi; data Auth tidak mempunyai
snapshot atomik bersama Firestore. Proses terlalu lama, token kedaluwarsa,
izin ditolak, atau pagination tidak konsisten menghasilkan kegagalan tanpa
laporan parsial yang diklaim lengkap. Auth tenant tambahan tidak dicakup;
scope default tenant harus dikonfirmasi Owner.

Sumber primer yang diperiksa:
[Auth batchGet](https://cloud.google.com/identity-platform/docs/reference/rest/v1/projects.accounts/batchGet),
[Firestore list/mask/readTime](https://firebase.google.com/docs/firestore/reference/rest/v1/projects.databases.documents/list),
[testIamPermissions](https://cloud.google.com/resource-manager/reference/rest/v1/projects/testIamPermissions).

## Perintah Owner di PowerShell

Prasyarat: Node 22+ dan Google Cloud CLI resmi sudah terpasang. Owner memeriksa
akun organisasi dan izin melalui Google Cloud Console resmi. Jika belum login,
jalankan login interaktif resmi sendiri. Jangan mengirimkan token/credential
kepada Codex dan jangan menjalankan print-access-token secara terpisah untuk
menyalinnya.

```powershell
Set-Location -LiteralPath 'D:\MASTER PROJECT\SIPAPUA\APLIKASI SIPAPUA'
gcloud auth login

$inventoryDir = Join-Path $env:LOCALAPPDATA 'SIPAPUA-Owner-Inventory'
New-Item -ItemType Directory -Path $inventoryDir -Force | Out-Null
$inventoryOutput = Join-Path $inventoryDir ('uid-inventory-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json')

node .\scripts\legacy-uid-inventory.cjs --project boby-apps-project --owner-approved-read-only boby-apps-project --output $inventoryOutput
if ($LASTEXITCODE -ne 0) { throw 'Inventaris tidak selesai; jangan gunakan sebagai dasar GO.' }
```

Lewati `gcloud auth login` jika sesi organisasi yang benar sudah aktif. Tool
menolak environment variable emulator; gunakan terminal Owner terpisah dengan
environment produksi resmi, bukan terminal emulator kandidat. Tidak ada
`gcloud config set`, enable API, deploy, import, atau operasi penulisan Firebase.
Pembacaan Firestore tetap menggunakan kuota baca Spark; tool tidak membuat
billing upgrade. Simpan laporan di folder Owner dengan ACL Windows yang sesuai,
bukan dalam repository atau folder publik. Mode file POSIX tidak menggantikan
ACL Windows. File existing tidak ditimpa.

Jika token/izin tidak tersedia, tool hanya mengeluarkan kode statis seperti
OFFICIAL_GCLOUD_AUTH_UNAVAILABLE atau READ_PERMISSIONS_NOT_VERIFIED. Error dari
layanan tidak dicetak beserta body, URL halaman, atau data mentahnya. Jangan
mengubah Rules untuk mengatasi kegagalan IAM; gunakan akses organisasi resmi.

## Membaca laporan

| Output | Arti |
| --- | --- |
| canonicalWithMatchingUid | doc.id sama dengan field uid; keberadaan Auth dinilai terpisah |
| canonicalWithoutUidField | field uid kosong, doc.id cocok UID Auth yang benar-benar terdaftar |
| noncanonicalWithUidField | field uid terisi valid dan berbeda dari doc.id |
| noUidAndNoAuthIdMatch | field uid kosong, doc.id tidak ditemukan di Auth; bukan bukti pasti bahwa ID dibuat acak |
| invalidUidField | uid bukan string valid yang dapat digunakan sebagai ID referensi |
| docIdAndUidDisagree | kategori tambahan: doc.id adalah UID Auth lain; tidak dijumlah ulang ke total profil |
| uidsClaimingMultipleProfiles | jumlah UID unik yang diklaim lebih dari satu profil melalui doc.id Auth/field uid |
| uidsWithConflictOrReviewFlags | UID unik pada seluruh kategori konflik/perlu pemeriksaan, termasuk disabled/orphan |
| structurallyMatchedProfiles | profil kanonis, Auth aktif, alokasi konsisten, dan tidak berkonflik secara struktur |
| structurallyUnverifiedProfiles | profil yang belum memenuhi konsistensi struktural minimum |
| unverifiedUidProfileRelations | pasangan UID–profil unik yang ditemukan dari doc.id Auth, field uid, dan indeks forward; provenance identitas belum diattestasi oleh tool |
| profilesRequiringIdentityProvenanceReview | semua profil; alat tidak mengesahkan bukti identitas manusia atau provenance audit |
| consistentBindingPairs | dua indeks konsisten secara struktur; bukan pengesahan historis atas auditnya |

Laporan mendeteksi UID ganda, doc.id/uid berbeda, Auth tidak ditemukan/disabled,
NIJ dipakai beberapa profil, alokasi tidak cocok atau tidak mempunyai target
yang dapat diselesaikan, binding berkonflik dengan profil lain, serta indeks
orphan/tidak konsisten. Flag dapat tumpang tindih; jumlah event konflik bukan
jumlah orang. Koleksi yang kosong atau belum dibuat menghasilkan jumlah nol
untuk koleksi tersebut; izin baca gagal tidak dianggap koleksi kosong.

Referensi menggunakan HMAC-SHA256 128 bit dengan kunci acak setiap run. UID,
profileId, NIJ, dan ID indeks mentah tidak ditulis. Kunci dan tabel pemetaan
tidak disimpan. Referensi hanya menghubungkan item dalam laporan yang sama;
tidak stabil lintas run dan tidak dapat langsung digunakan sebagai path dokumen.
Pencarian/verifikasi kasus dilakukan Owner di Console organisasi yang dibatasi
aksesnya, bukan dengan memperlakukan pseudonim sebagai ID produksi. Laporan
tetap perlu dibatasi aksesnya karena jumlah dan relasi dapat sensitif.

## Prosedur administrator dan rencana indeks tepercaya

1. Owner memeriksa cakupan, hasil selesai, tenant, dan rentang waktu pembacaan.
   Rekonsiliasi perubahan akun/profil yang terjadi selama inventaris sebelum
   mengambil keputusan; data lintas layanan bukan snapshot atomik.
2. Master/super_admin aktif berizin canActivateMembers memeriksa kasus pada
   Database Jemaat/Console resmi, tanpa memberikan pencarian legacy ke pemohon.
3. Untuk UID ganda, bandingkan asal dokumen, alokasi NIJ dan catatan organisasi;
   jangan memilih profil dari email yang kebetulan sama. Semua relasi yang
   ambigu tetap diblokir sampai konflik diputuskan oleh pihak berwenang.
4. Konfirmasi identitas jemaat melalui prosedur organisasi dan sesi Auth
   pemilik sendiri. Catat keputusan, pemeriksa, waktu, dasar pemeriksaan,
   dan persetujuan pemilik dalam audit yang aksesnya terbatas. Akun disabled,
   UID tidak ditemukan, dan NIJ ganda memerlukan resolusi kasus tersendiri.
5. Siapkan daftar keputusan terverifikasi melalui proses organisasi terkontrol.
   Tahap ini belum membuat indeks. Pemisahan pemeriksa dan pemberi persetujuan
   dianjurkan untuk kasus konflik; kebijakan akhirnya ditetapkan Owner.
6. Pada scope penulisan terpisah yang disetujui kemudian, buat hanya sidecar
   indeks per relasi yang sudah diverifikasi, dengan dua arah, audit, dan
   pemeriksaan konflik atomik. Doc.id/profil lama, NIJ, counter, reservasi, dan
   status akun tetap utuh. Tidak ada backfill otomatis berdasarkan email.
7. Pastikan seluruh relasi UID existing tercakup, kasus belum terselesaikan
   diblokir, dan seluruh writer relasi UID menjaga indeks deterministik yang
   sama. Jangan menyatakan lengkap hanya karena flag browser bernilai true.
8. Uji ulang kasus keamanan yang gagal sebelumnya terhadap desain indeks
   lengkap sebelum menghubungkan fitur ke UI. Tidak ada GO otomatis dari
   laporan inventaris yang menunjukkan nol konflik.

## Keputusan saat ini

Kategori/jumlah profil produksi, UID konflik, dan relasi belum terverifikasi:
**BELUM DIKETAHUI — menunggu Owner menjalankan collector resmi**.

**NO-GO pengaitan identitas tetap berlaku.** Alat analisis ini tidak menutup
blocker kelengkapan indeks sendirian, tidak mengubah relasi ownership, dan tidak
menyembunyikan 1 FAIL pada suite pengaitan. Tidak ada commit/push/merge/deploy.
