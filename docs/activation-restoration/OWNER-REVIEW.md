# Pemulihan registrasi asli dan aktivasi administrator

Tanggal: 2026-11-14. Hasil lokal: **19 PASS / 0 FAIL**. Tidak ada perubahan
produksi, reset/clean/checkout, commit, push, merge, migrasi, inventaris ulang,
atau penerbitan uid_ownership. Tidak ada halaman administrator baru.

## Baseline yang dapat dibuktikan

- Git `2a81de8` memperkenalkan helper Firestore-only: profil users/{Auth UID},
  counter wilayah, alokasi NIJ permanen, dan dua reservasi identitas dalam transaksi.
- Blob helper pada commit tersebut dan HEAD `ed272d4` identik:
  `790e00d0a4526745935ed2f299c138fb2ecc2615`.
- `a642156` hanya mengganti flag maintenance registrasi menjadi false. Ini
  bukti perubahan konfigurasi dalam Git, bukan bukti keberhasilan produksi.
- Helper historis berlabel REVIEW CANDIDATE. Commit tersebut tidak memuat tes;
  Rules lokal historis juga mengizinkan public reads. Tidak ada dasar untuk
  menyatakan seluruh commit aman atau terakhir sukses di produksi dari Git saja.
- Pengujian sekarang benar-benar memuat kode helper Git `2a81de8` dan menjalankan
  registerProfile melalui SDK client pada emulator dengan proposal Rules privat.
  Protokol registrasinya lulus. Helper historis untuk menghapus reservasi/edit
  NIJ tidak dipulihkan karena bertentangan dengan permanensi yang diminta.

Jadi baseline terbukti adalah **protokol registrasi historis yang diuji ulang
secara lokal**, bukan klaim baru bahwa seluruh website pada commit itu aman.

## Perubahan minimum runtime sesi ini

1. `sipapua-spark-registration.js`: melepas pembacaan dan konsumsi uid_ownership.
   Registrasi kembali memakai lima dokumen identitas asli: profil, counter,
   alokasi dan dua reservasi. Tidak ada Functions atau pengaitan legacy.
   Validasi/kebutuhan registry dan counter existing tetap dipertahankan.
2. `sipapua-spark-member.js`: aktivasi otomatis untuk Pending/Menunggu Verifikasi
   setelah token Auth benar-benar terverifikasi; aktivasi manual berizin dengan
   audit; login unverified hanya menerima audit manual yang cocok dan terkonfirmasi
   server. Profil kanonis lama tanpa field uid menggunakan doc.id sebagai UID,
   tanpa menambahkan/mengubah uid, NIJ atau alokasi pada profil lama.
3. `edit-jemaat-administrator.html`: dropdown Status Akun -> Aktif -> Simpan
   memanggil jalur aktivasi yang sama dengan tombol audit existing. Wajib checklist
   pemeriksaan identitas, master/super_admin aktif, canActivateMembers=true.
   Status tidak dikirim sebagai edit profil biasa. Kegagalan dipropagasikan ke
   handler Simpan, sehingga tidak dilaporkan sebagai berhasil.

Perubahan status menjadi Pending dari akun aktif tetap tidak dibuka sebagai edit
biasa; prosedur penonaktifan berada di luar perbaikan aktivasi yang diminta.
Aktivasi ulang akun historis yang sudah bertanda Aktif namun belum mempunyai
audit dapat diattestasi administrator melalui checklist dan Aktif/Simpan.

Snapshot sebelum edit berada pada
`snapshot-20261114-113652879/`, termasuk file sebelum perubahan, SHA-256 dan
status working tree. Semua file lain yang tidak disentuh tetap dipertahankan.
Tool inventaris/issuer serta kandidat ownership sebelumnya tidak dihapus atau
dijalankan; bukan lagi ketergantungan alur pemulihan ini. Hasil uji lamanya
tetap historis dan tidak diklaim berlaku untuk kontrak registrasi yang telah
diubah oleh keputusan scope Owner terbaru.

## Rules minimum yang menyertai pemulihan

`firestore.proposed.rules` adalah kandidat privat terpisah. Root firestore.rules
dan firebase.json tidak berubah. Builder:
`scripts/build-activation-restoration-rules.cjs`.

- Create profil tetap hanya users/{request.auth.uid}; field uid harus cocok;
  NIJ/counter/alokasi/reservasi terikat atomik dan tidak dapat diubah sembarang.
- Tidak ada kebutuhan uid_ownership, tetapi tidak ada akses tulis publik ke
  ownership/linking lama. Lookup email bukan bukti kepemilikan.
- Aktivasi mengubah hanya status dan metadata audit. Aktivasi otomatis memakai
  email_verified token server dan binding profil yang sesuai; client tidak dapat
  mengubah emailVerified. Aktivasi tidak memerlukan pembuatan ulang alokasi legacy.
- Aktivasi manual memeriksa izin dalam evaluasi Rules commit dan wajib audit baru
  dengan actor, target UID, profileId, previous/new status dan timestamp yang cocok.
- Anggota hanya dapat membaca audit manual yang menarget dirinya; audit tidak
  dapat diubah/dihapus. Flag manual palsu tanpa audit tidak meloloskan login.
- Profil lain dan subkoleksi privat tidak dibuka. Profil historis tanpa alokasi
  yang cocok tidak dapat dihapus untuk menghilangkan satu-satunya catatan NIJ.

**Prasyarat data, bukan arsitektur baru:** Owner sebelumnya mengonfirmasi inventaris
lengkap 9 profil kanonis, 0 UID ganda, 0 profil nonkanonis ber-UID. Inilah dasar
menggunakan doc.id sebagai indeks kepemilikan existing, tanpa tabel clear baru.
Rules menjaga semua create profil web tetap kanonis dan uid tidak berubah.
Profil kanonis existing menutup slot registrasinya meskipun belum memiliki alokasi.
Data harus tetap dalam kondisi itu saat pemasangan; privileged IAM writer yang
membuat relasi nonkanonis di luar Rules akan membatalkan prasyarat ini. Kandidat
ini bukan jaminan umum untuk dataset nonkanonis arbitrer, dan tidak boleh
dipasang dengan asumsi bahwa dataset seperti itu sudah direkonsiliasi.

Tidak ada pembacaan atau perubahan produksi untuk memeriksa ulang prasyarat
tersebut di sesi ini. Tidak ada counter yang diinisialisasi/reset atau NIJ baru
yang diberikan pada 8 profil lama yang belum cocok struktural.

## Pengujian yang dijalankan

```powershell
node scripts/build-activation-restoration-rules.cjs
node tests/spark-release/e2e.cjs --activation-restoration-only
```

Hasil: `tests/activation-restoration/result.json` dan `results.txt`.
Runner yang sudah tersedia memulai Auth dan Firestore baru pada port loopback
dinamis, project demo, dan direktori temporary baru. Tidak ada Functions, cloud
credentials atau emulator kandidat existing yang dipakai. Fixtures sintetis
berada hanya pada emulator yang dibuat proses ini.

19 PASS mencakup kode registrasi historis, registrasi form tanpa clear, duplikasi,
link verifikasi gagal, dropdown/checklist dan izin, audit atomik, login manual
emailVerified=false melalui facade existing, flag audit palsu, verifikasi nyata
SDK untuk profil lama dan baru, kanonis tanpa field uid/alokasi, attestation ulang,
viewer/izin hilang/admin inactive, proteksi NIJ/role/status/audit, profil/subkoleksi
privat, Database Jemaat, data keluarga form, dan penolakan NIJ kedua pada slot
kanonis atau penghapusan catatan NIJ historis tanpa alokasi, serta penolakan
laporan Simpan berhasil ketika aktivasi lain masih berjalan.

Bagian dropdown menjalankan fungsi asli editor dalam DOM sintetis dengan backend
Firestore SDK nyata. Ini bukan klaim pengujian browser produksi penuh. App Check
facade memakai stub khusus emulator; konfigurasi Enterprise existing tidak diubah
dan attestation produksi tidak dinyatakan terbukti oleh tes ini.

## Kesiapan pemulihan publik

**Siap untuk review Owner atas perbaikan lokal ini; belum dipublikasikan.**
Maintenance registrasi sengaja masih true sampai Owner meninjau paket kode dan
Rules yang cocok. Jangan memasang kandidat Rules ownership lama bersama client
pemulihan ini: kandidat lama masih mengharuskan clear. Gunakan hanya proposal
pemulihan setelah persetujuan khusus; jangan deploy root firestore.rules yang
masih mengandung public reads.

Sebelum publikasi, Owner memastikan baseline kanonis di atas masih berlaku,
registry/counter/reservasi existing siap, administrator mempunyai izin existing,
dan Enterprise/domain serta live Rules sesuai. Tidak diperlukan inventaris UID
baru atau migrasi otomatis dari sesi ini. Ekspor Rules/live revision aktual
untuk rollback; jangan menganggap HEAD sama dengan versi website yang online.

Tiga file runtime di atas adalah delta perbaikan, bukan satu-satunya dependensi
deployment: HTML/helper working tree dari pekerjaan sebelumnya juga harus
ditinjau dan dipublikasikan sebagai pasangan yang cocok jika belum ada di website.
Tidak ada staging otomatis atau pemilihan semua untracked files.

Pemasangan dan pembukaan maintenance memerlukan persetujuan Owner berikutnya.
Jika rollback diperlukan, jeda registrasi dan pulihkan pasangan Rules/kode yang
benar-benar dicadangkan; jangan menghapus akun, audit, alokasi atau reservasi,
dan jangan menurunkan counter untuk membatalkan pendaftaran.
