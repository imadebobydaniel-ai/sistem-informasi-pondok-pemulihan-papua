# SPARK IMPLEMENTATION — PARTIAL / TESTED / BLOCKED / OWNER REVIEW REQUIRED

Tanggal: 2026-11-13. Firebase Spark only; tanpa Blaze atau Cloud Functions produksi.

## Workspace dan baseline

CWD dan writable root resmi: `D:\MASTER PROJECT\SIPAPUA\APLIKASI SIPAPUA`.
Seluruh perubahan tracked dan untracked yang ada saat mulai dipertahankan.
Pekerjaan ini hanya menambahkan file di `docs/spark-implementation/`,
`tests/spark-implementation/`, dan `sipapua-spark-registration.js`.
Tidak ada reset, checkout, commit, push, merge, deploy, akses Firebase produksi,
atau akses emulator kandidat existing. Tidak ada perubahan UI, firebase.json,
firestore.rules, atau modul existing.

Baseline kode adalah working tree saat resume, termasuk helper registrasi,
persiapan registry, login, dan member-session existing. Proposal Rules dibangun
dari `docs/release-gate-005a/firestore.final-proposed.rules`; bagian di luar root
profil/registry dipertahankan. Laporan terpisah bernama SPARK REGISTRATION
RESTORATION tidak ditemukan dalam file workspace yang tersedia; tidak dilakukan
restorasi/reset tambahan atau asumsi bahwa working tree sama dengan HEAD.

## Implementasi yang tersedia

`sipapua-spark-registration.js` menyediakan factory pasif tanpa callable:
`create(db, auth, serverTimestamp)`, `preflight(region)`, dan
`registerProfile(user, code, input)`. Kontrak database menggunakan compat-style
Firestore seperti modul browser existing. Lima write dilakukan atomik:
counter wilayah, alokasi permanen UID, reservasi email, reservasi WhatsApp,
dan profil UID. Konfirmasi hasil memakai server read profil dan alokasi.

Rules mengikat counter +1 ke alokasi dan profil UID pemanggil, format NIJ dan
tahun Jayapura berdasarkan request.time, status awal Menunggu Verifikasi,
email token Auth, normalisasi telepon, dan kedua reservasi pada commit yang
sama. Alokasi dan reservasi tidak dapat diubah/dihapus/dipindah. Pembuatan
reservasi ekstra dan write counter tanpa alokasi ditolak.

Saat transaksi paralel, emulator dapat mengembalikan permission-denied ketika
proof counter menjadi stale, sebelum SDK memperoleh aborted untuk retry.
Client melakukan maksimal dua retry tambahan hanya jika server read membuktikan
counter telah maju. Setiap attempt membaca ulang seluruh dokumen dan memeriksa
sesi. Tidak ada fallback write atau pelonggaran Rules.

Ini **kandidat creation untuk invariant NIJ/identitas**, belum pengganti lengkap
validator form existing. Validasi demografi, tautan keluarga ber-consent,
perubahan kontak, penghapusan profil, dan seluruh lifecycle belum diport.
Helper baru sengaja belum dimuat oleh HTML. Jangan memasang proposal Rules
sebagai Rules aktif: write profil/aktivasi tetap fail closed dan alur existing
masih bergantung callable.

## Pengujian

Jalankan `node tests/spark-implementation/rules.cjs` dari repository utama.
Runner hanya menjalankan JAR Firestore lokal, port loopback baru yang dipilih OS,
project `demo-sipapua-spark-isolated`, dan direktori temporary baru. Runner
menghentikan hanya proses yang dibuatnya sendiri, tanpa reset/import/export
atau koneksi emulator existing. Tidak ada download otomatis.

Rules diuji melalui Firebase JavaScript SDK nyata dan
`@firebase/rules-unit-testing`; token pengguna adalah konteks pengujian sintetis,
bukan akun Firebase Auth produksi. Factory client dijalankan melalui adapter
tipis SDK modular; pengujian bukan mock evaluasi Rules. Lihat
`tests/spark-implementation/results.txt` untuk hasil terakhir.

Kasus meliputi commit lima dokumen, retry akun sama, paralel pada counter sama,
lima wilayah, duplicate phone, counter tanpa alokasi/lompatan counter, pemalsuan
NIJ/email/status, reservasi hilang/UID asing/ekstra, mutasi dan penghapusan
alokasi/reservasi, mutasi NIJ profil, UID-less legacy, pemalsuan binding oleh
manager, alokasi permanen tanpa profil, reservasi email legacy, kontrol registry,
dan maintenance. Pemeriksaan sintaks Node juga dijalankan pada dua file JS baru.

## Blocker yang tidak boleh disamarkan sebagai PASS integrasi

Backend existing `adminActivateSIPAPUAProfile` menyelesaikan target legacy yang
tidak mempunyai uid melalui Firebase Admin Auth `getUserByEmail`, lalu memeriksa
email/disabled sebelum menulis aktivasi dan audit. `resolveOwnedProfile` juga
memakai bukti identitas legacy. Rules hanya menerima identitas pemanggil dalam
request.auth dan dokumen Firestore; Rules tidak menyediakan lookup record Auth
pengguna target. Saat pemanggil adalah administrator, token tersebut adalah
token administrator, bukan bukti email/UID target.

Karena itu, memindahkan kode tersebut ke client dengan menerima targetUid dari
browser atau mengandalkan email belum terverifikasi akan menghapus pembuktian
identitas existing. Kandidat menolak binding dan aktivasi tersebut, termasuk
untuk manager berizin, dan menguji penolakannya. Ini tidak membuktikan bahwa
semua desain Spark mustahil; ini menunjukkan prasyarat identitas yang belum
tersedia untuk mempertahankan kontrak legacy existing secara aman.

Langkah yang diperlukan sebelum integrasi penuh adalah pemetaan UID Auth ke
profil legacy yang tepercaya dan dapat diverifikasi Rules, melalui prosedur
offline administrator yang disetujui, atau keputusan Owner membatasi akses
legacy sampai pengguna sendiri membuktikan email terverifikasi. Tidak ada
pemetaan/ekspor/import atau perubahan kebijakan itu yang dilakukan di sesi ini.
NIJ existing dan reservasi harus tetap permanen selama prosedur tersebut.
Status disabled target Auth juga tidak tersedia sebagai lookup langsung Rules;
kesetaraan dengan pemeriksaan backend memerlukan kontrak pencabutan akses yang
jelas, bukan boolean yang boleh ditulis anggota.

Setelah prasyarat tersedia: implementasikan proof kepemilikan legacy, audit
aktivasi atomik pada form administrator existing, pembacaan sesi langsung,
validator form dan lifecycle/profile-contact transactions; jalankan matriks SDK
client lengkap sebelum menghubungkan adapter ke HTML. Jangan melepas callable
hanya agar pemeriksaan statis terlihat lulus.

Rujukan primer: [Auth dalam Rules](https://firebase.google.com/docs/rules/rules-and-auth)
dan [kondisi/getAfter serta batas akses Rules](https://firebase.google.com/docs/firestore/security/rules-conditions).

Status IMPLEMENTED / TESTED untuk keseluruhan permintaan **belum dapat dinyatakan**.
Kandidat transaksi creation telah diimplementasikan dan diuji; integrasi Spark
login/profil/aktivasi masih BLOCKED. Tidak ada klaim kesiapan produksi.
