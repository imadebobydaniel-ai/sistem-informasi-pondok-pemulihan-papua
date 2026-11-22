# SIPAPUA — Lacak Domba Real-Distance Recovery

**GO untuk review kandidat lokal. NO-GO untuk deployment.** Lima skenario radius lulus pada handler Edge dan RPC PostgreSQL lokal. Dua sesi sintetis dengan opt-in aktif juga berhasil saling menemukan. Pemindaian pada sistem aktif belum diuji.

## Bukti read-only Supabase

- Project `cfnimvrxrnmefmxtzqks` melaporkan Edge Function `lacak-domba-nearby` **ACTIVE**, versi 1. Fingerprint dan panjang setelah normalisasi LF cocok dengan `index.ts` dan `discovery.ts` di workspace. Kontrak `discovery_start`, `sync`, `scan` dengan `radiusKm`, dan `clear` selaras dengan frontend yang diaudit. Gateway dikonfigurasi `verify_jwt=false`; verifikasi Firebase JWT RS256 dilakukan di handler.
- Katalog PostgreSQL memuat RPC `lacak_domba_scan_candidates(text, double precision, double precision, integer, integer, integer)` sesuai argumen handler. RPC scan, start, refresh dan rate-limit dapat dieksekusi oleh `service_role` dan tidak oleh `anon` atau `authenticated`. Kueri membaca metadata saja.
- Snapshot agregat tabel presence pada 21 November 2026 menunjukkan **0 baris, 0 sesi opt-in aktif, dan 0 pengguna online yang lolos freshness**. Tanpa baris eligible, scan pada saat snapshot tidak memiliki kandidat untuk ditemukan. Snapshot ini tidak menetapkan penyebab sinkronisasi akun aktif.
- Kueri agregat 24 jam menemukan 16 log yang cocok dengan slug pada `function_edge_logs`, dengan 0 marker `presence_sync_failed` atau `location_query_failed` pada atribut yang dicari. Cakupan tersebut tidak membuktikan semua aksi sinkronisasi berhasil. Tidak ada response live pengguna, UID, token, koordinat atau pesan log mentah yang disalin. SQL dijalankan dalam transaksi READ ONLY.

## Akar masalah yang direproduksi dan kandidat

1. **Presence gagal sebelum sinkronisasi.** Pada salinan halaman asli dengan Firebase Emulator, dokumen legacy membuat write merge ditolak karena `validPresence()` mensyaratkan field tertentu dan menolak key tambahan. Kontrol tetap disabled. [Patch Lacak Domba sebelumnya](../recovery-3-features-01/lacak-domba.patch) mengganti merge dengan transaksi proyeksi presence yang valid, menjaga preferensi dan mengikat kontrol ke sesi aktif. Reproduksi tersebut menjelaskan jalur yang dapat mencegah sinkronisasi. Dokumen Firebase produksi tidak diperiksa.
2. **False negative tepat di dalam radius.** Handler baseline memakai perkiraan `111.320 × cos(latitude)` untuk cutoff longitude sebelum Haversine. Pada fixture equator dengan offset timur **999,5 meter**, baseline mengembalikan hasil kosong pada radius 1 KM. Setelah [patch Edge](./edge-distance.patch), titik tersebut ditemukan. Patch menghapus cutoff longitude yang terlalu ketat dan memakai Haversine sebagai keputusan akhir, dengan clamp numerik. Filter latitude, batas shortlist, kuota, dan RPC consent tetap sama. RPC sudah membatasi kandidat berdasarkan latitude sebelum handler menerima hasil. Tidak ada migrasi atau pelebaran hak.

Pipeline yang diperiksa: Auth pulih, presence owner dikonfirmasi, geolocation diminta saat opt-in/scan, koordinat disimpan di dokumen privat pemilik, Edge memeriksa profil aktif serta token, RPC membuka sesi 15 menit menurut jam database, heartbeat memperbarui freshness tanpa memperpanjang sesi, RPC menyaring calon, dan Haversine menerapkan radius. UI menerima bucket jarak dan menjaga indikator online sesuai preferensi. Posisi radar bersifat ilustratif dan tidak digunakan sebagai bukti jarak.

## Hasil radius dan privasi

| Jarak sintetis | Radius | Hasil |
|---|---:|---|
| 500 m | 1 KM | PASS ditemukan |
| 3 KM | 1 KM | PASS tidak ditemukan |
| 3 KM | 5 KM | PASS ditemukan |
| 8 KM | 5 KM | PASS tidak ditemukan |
| 8 KM | 10 KM | PASS ditemukan |
| 999,5 m ke timur pada equator | 1 KM | Baseline gagal, kandidat PASS ditemukan |

- **Sinkronisasi PASS lokal.** Dua akun sintetis menandatangani sesi, membuka opt-in melalui handler, dan RPC menyimpan presence. Heartbeat menjaga session ID dan waktu akhir yang sama. Dua peserta online opt-in saling menemukan; peserta offline dikecualikan.
- **Privasi PASS lokal.** Opt-out yang tersinkron, sesi dan lokasi kedaluwarsa, serta heartbeat basi dikecualikan. Blok dua arah ditolak setelah sinkronisasi. Caller nonaktif dan aktivasi penemuan akun nonaktif mendapat HTTP 403. Akun target yang baru dinonaktifkan dihapus dari hasil pada refresh-nya. Respons pemindaian tidak berisi latitude, longitude atau jarak presisi; preferensi menyembunyikan indikator online tetap dihormati. Browser/Firebase Emulator sebelumnya membuktikan koordinat milik UID lain tidak dapat dibaca atau ditulis.
- **Batas freshness tetap berlaku.** Status target, opt-out, dan blokir tercermin setelah clear/sinkronisasi berhasil. Perubahan yang belum tersinkron tidak dibuktikan berlaku seketika; record basi dikeluarkan oleh batas heartbeat dan sesi. Tidak ada klaim pencabutan instan pada sistem aktif.

## Lingkungan pengujian dan keputusan

**14 PASS, 0 FAIL** pada `distance.test.mjs`. Tes memakai handler Edge lokal dengan JOSE 5.9.6 untuk JWT sintetis, serta dua migrasi repository pada PostgreSQL lokal in-memory melalui PGlite 0.3.16. Bridge menggantikan transport Supabase/PostgREST dan menjalankan SQL RPC nyata sebagai `service_role`; Firestore REST dan JWKS memakai fixture. Tidak ada permintaan jaringan dari harness. Cooldown dan umur record disimulasikan dengan timestamp pada database sintetis saja. Dependency test berada di TEMP, tidak masuk aplikasi.

**1 PASS browser terpisah** menggunakan salinan halaman Lacak Domba asli, pemulihan Auth dan presence/koordinat melalui Firebase Emulator, serta endpoint nearby fixture. Tidak ada run browser tunggal yang memakai Edge + PostgREST hosted. PostgreSQL lokal membuktikan hasil radius di sisi server; browser membuktikan alur kontrol dan rendering pada lapisan terpisah.

Jalankan suite jarak dengan `node --experimental-transform-types --test candidates/lacak-domba-real-distance/distance.test.mjs`. Variabel `SIPAPUA_DISTANCE_PGLITE` menunjuk modul `dist/index.js` PGlite 0.3.16, dan `SIPAPUA_DISTANCE_JOSE` menunjuk `dist/browser/index.js` jose 5.9.6. Uji browser memakai harness yang ada di `candidates/recovery-3-features-01/lacak-browser.test.mjs`. Kedua patch lulus `git apply --check --ignore-space-change`.

**NO-GO deploy** sampai review Owner dan uji satu alur lengkap pada lingkungan yang diotorisasi, dengan dua akun sintetis mengaktifkan Bisa Ditemukan, menyinkronkan presence, dan memindai pada ketiga radius. Verifikasi bahwa clear/expiry dan blokir mengikuti kebijakan privasi ketika sinkronisasi gagal. Supabase aktif hanya diperiksa read-only. Tidak ada deployment, commit, push, merge, atau perubahan database produksi, Edge Function, IAM, billing maupun Firestore Rules. Biaya tambahan Rp0.
