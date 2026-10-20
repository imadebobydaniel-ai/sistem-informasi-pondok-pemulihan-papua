# Lacak Domba — Kompatibilitas fungsi PostgreSQL lama

Status 20 Oktober 2026. Dokumen ini membandingkan dua fungsi yang sudah ada di
produksi dan masih dipanggil Edge Function `lacak-domba-nearby`:

- `lacak_domba_take_scan_slot(p_firebase_uid text, p_min_interval_seconds integer) → boolean`
- `lacak_domba_replace_own_blocks(p_blocker_uid text, p_blocked_uids text[]) → integer`

**Kedua fungsi tidak diganti.** Migrasi `20261010000000` tidak pernah menimpa
fungsi yang sudah ada, dan `20261017000000` tidak menyentuhnya. Uji lokal
membuktikan definisi dan ACL keduanya identik sebelum dan sesudah 20261017.

## 1. Yang diketahui dan yang tidak

| Aspek | Repository (`20261010000000`) | Produksi |
|---|---|---|
| Signature dan tipe hasil | seperti di atas | sama (audit read-only) |
| SECURITY DEFINER, `search_path = pg_catalog, public` | ya | sama (audit) |
| EXECUTE | hanya `service_role` | hanya `service_role` (RELEASE-PLAN §1) |
| Isi fungsi | ada di repository | **tidak tersedia**; belum pernah dibandingkan |
| Nilai kembali `replace_own_blocks` | jumlah baris yang **benar-benar disisipkan** (kirim ulang daftar sama → 0) | menurut audit: jumlah yang **dicoba** disisipkan (kirim ulang 3 → 3). Edge Function mengabaikan nilai ini. |
| Input tidak valid (`take_scan_slot`) | interval di luar 1–300 atau uid tidak valid → error 22023 | tidak diketahui; Edge Function selalu mengirim 15 |
| Penyimpanan waktu scan | `public.lacak_domba_scan_limits` | tabel ada; belum dipastikan fungsi produksi memakainya |

## 2. Cara repository mencegah race

- `take_scan_slot`: satu pernyataan `INSERT … ON CONFLICT DO UPDATE … WHERE last_scan_at <= now() - interval`.
  Panggilan kedua menunggu kunci baris, lalu memeriksa ulang terhadap nilai
  yang sudah commit. Dua scan bersamaan tidak bisa sama-sama lolos.
- `replace_own_blocks`: `pg_advisory_xact_lock` per pemilik, sehingga
  `DELETE` dan `INSERT` dua penggantian daftar untuk pemilik yang sama
  berjalan berurutan. Hasil akhirnya tepat satu daftar utuh.

## 3. Risiko race pada implementasi lama

Isi fungsi produksi tidak tersedia, jadi risikonya diperagakan dengan **model
hipotetis** pola naif (bukan salinan produksi) di PostgreSQL lokal. Pola
interleaving dibuat deterministik: panggilan A berada dalam transaksi terbuka,
panggilan B berjalan, lalu A commit.

| # | Kasus | Repository | Model naif |
|---|---|---|---|
| O1 | Dua scan bersamaan oleh satu pengguna (pola *baca lalu tulis* tanpa cek ulang) | pertama `true`, kedua `false` | **keduanya `true`** |
| O2 | Pemilik punya `[old]`; tab A mengganti dengan `[a1,a2]`, tab B dengan `[b1]` (delete+insert tanpa kunci per pemilik) | `[b1]` | **`[a1,a2,b1]`**: daftar tergabung |
| O3 | Tab A memblokir `[y]`, tab B melepas semua blokir `[]`; urutan serial menghasilkan `[]` | `[]` | **`[y]`**: pelepasan blokir hilang |
| O4 | Daftar 3 yang sama dikirim ulang | `0` | `3` (sesuai audit) |

Dampak bila produksi memakai pola seperti model naif:

- **O1 melemahkan rate limit scan.** Dengan token sendiri, penyerang bisa
  mengirim beberapa permintaan paralel yang semuanya lolos. Rate limit 15
  detik adalah salah satu pembatas terhadap trilaterasi rentang jarak
  ("menebak lokasi dari beberapa scan"), jadi ini relevan untuk keamanan.
- **O2/O3 tidak menghilangkan blokir** (hasilnya gabungan kedua daftar), tetapi
  pelepasan blokir dapat hilang dan daftar blokir bisa berbeda dari yang
  dikirim pengguna. Arahnya aman untuk privasi, salah dari sisi fungsi.
- Bila `INSERT` tidak memakai `ON CONFLICT`, dua daftar bersamaan yang memuat
  uid sama dapat gagal dengan `23505` dan Edge Function menjawab 500. Ini
  **tidak diuji**, hanya disimpulkan dari pola kodenya.

## 4. Pemeriksaan di produksi (read-only)

`preflight-readonly.sql` baris 6a membandingkan isi kedua fungsi dengan
repository tanpa menampilkan isinya:

- `OK (identical to the repository)`: isi sama, selain spasi.
- `OK (differs …; serializing pattern found …)`: isi berbeda, tetapi memuat
  pola yang menyerialkan panggilan, yaitu `ON CONFLICT … DO UPDATE … WHERE`,
  `FOR UPDATE`, `LOCK TABLE`, atau `pg_advisory*`. Ini heuristik teks. Isinya
  tetap perlu dibaca sekali.
- `REVIEW: …`: tidak ada pola itu, sehingga O1–O3 mungkin terjadi. Rilis
  berhenti di M2 sampai Project Owner memutuskan.

Untuk membaca isinya (metadata, tanpa data pengguna) di SQL Editor:
`select pg_get_functiondef('public.lacak_domba_take_scan_slot(text, integer)'::regprocedure);`
dan hal yang sama untuk `public.lacak_domba_replace_own_blocks(text, text[])`.

## 5. Rekomendasi

1. Jangan mengganti fungsi tanpa keputusan terpisah. Bila diperlukan, ikuti
   *MANUAL STEP* di bagian bawah `20261010000000_lacak_domba.sql`. Untuk
   `take_scan_slot`, pastikan dulu tabel penyimpanannya, karena pergantian
   tabel mereset rate limit setiap pengguna satu kali.
2. Bila preflight 6a menghasilkan `REVIEW`, tinjau isi fungsi sebelum
   staging. Risiko O1 adalah yang paling penting untuk keamanan.

## 6. Temuan terkait: jam transaksi pada fungsi sesi (sudah diperbaiki)

Ditemukan saat regresi dan sudah ada sebelum patch rekonsiliasi.
`lacak_domba_discovery_start` dan `lacak_domba_discovery_refresh` dulu menulis
`updated_at = now()`, padahal `now()` adalah waktu **mulai transaksi**.
Misalkan panggilan B memulai transaksinya sebelum panggilan A untuk pengguna
yang sama, tetapi mendapat advisory lock setelah A commit sesi baru. B lalu
menulis `updated_at` yang lebih tua dari awal sesi itu, sehingga
`discoverable_until > updated_at + 15 menit`, dan CHECK
`lacak_domba_presence_discoverable_until_cap` menolaknya dengan `23514`.
Edge Function menjawab 500 `presence_sync_failed`. Data tidak rusak.

Perbaikan di `20261017000000`: keempat fungsi sesi (`start`, `extend`,
`refresh`, `end`) membaca waktu sekali, `v_now := clock_timestamp()`, tepat
setelah `pg_advisory_xact_lock`, lalu memakai `v_now` untuk semua penulisan dan
perbandingan dalam panggilan itu. Karena panggilan satu pengguna berurutan
lewat kunci, `v_now` panggilan berikutnya tidak pernah lebih tua dari waktu yang
ditulis panggilan sebelumnya. `scan_candidates` dan `purge_stale` tetap
memakai `now()`: keduanya hanya membaca atau menghapus, tidak menulis waktu
sesi, dan tidak memakai kunci per pengguna.

Uji lokal sesudah perbaikan (skema fresh dan legacy): Z1–Z4 OK, 10 `start`
paralel x10 putaran 10/10, tes DB baru dengan interleaving "transaksi basi"
(start/start, start/refresh, extend/start, start/extend, extend/stop,
stop/extend, stres 10 koneksi), dan uji HTTP panggilan sesi bersamaan tanpa
respons 500. Sisa risiko: jam server yang mundur (koreksi NTP) di antara dua
panggilan dapat memunculkan kembali penolakan yang sama; tidak ada data rusak.
