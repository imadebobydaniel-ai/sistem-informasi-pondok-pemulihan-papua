# SIPAPUA QR-FIX-02 — Demo internet HTTPS

**Artefak statis siap untuk review publikasi. Publikasi HTTPS BLOCKED. Kamera Android fisik NOT TESTED.** Biaya tambahan Rp0.

## Cakupan dan audit

QR-FIX-01 pada commit `275f739924580501ba70d59569ae6c271b86c159` menggunakan server loopback, Worker kandidat, mock Auth dan SQLite. Kandidat web ini tidak memakai server tersebut, endpoint Worker, Firebase, akun pengguna, database, USB, atau ADB. Pengujian browser otomatis memakai server aset statis loopback yang ditutup setelah tes. Jalur uji fisik yang direncanakan khusus HTTPS internet.

Direktori `public/` berisi Demo QR Card, Demo QR Scanner, modul, CSS, dua library QR dan lisensinya. qrcodejs 1.0.0 (MIT) dan jsQR 1.4.0 (Apache 2.0) identik dengan aset lokal QR-FIX-01. Keduanya dilayani relatif dari origin demo. Paket publik tidak berisi tes, laporan, konfigurasi backend, kredensial, atau data jemaat.

QR memuat namespace `SIPAPUA-STATIC-DEMO-V1`, satu ID fixture dan waktu kedaluwarsa. Profil yang ditampilkan ditentukan oleh fixture lokal **Nara Demo / DEMO-NIJ-001 / Komsel Demo**. Tidak ada URL atau kredensial SIPAPUA di dalam QR. Halaman menampilkan **DEMO — BUKAN KARTU JEMAAT RESMI**.

Pemindai meminta kamera setelah tombol ditekan dengan preferensi kamera belakang dan tanpa audio. Ia mencoba `BarcodeDetector` untuk QR dan memakai jsQR lokal jika detektor tidak tersedia, gagal atau tidak menemukan QR. Frame hanya dipakai di browser. CSP `connect-src 'none'` memblokir koneksi aplikasi. Stream dihentikan setelah hasil, saat tombol tutup ditekan, saat meninggalkan halaman, dan saat tab disembunyikan.

## Hasil

| Pemeriksaan | Status | Bukti |
|---|---|---|
| Format, identitas, TTL lima menit, dan batas expiry | PASS | 3 unit test. Payload asing, namespace kartu asli, fixture lain dan expiry di luar jendela ditolak. |
| Render, decode dan identitas | PASS otomatis | Chrome merender kanvas QR, lalu scanner mendekode piksel hasil render lewat jalur video dengan stream sintetis dan jsQR. Hasil fixture cocok. |
| Permintaan izin, penolakan izin, dan penutupan stream | PASS otomatis | Stub mencatat `getUserMedia({audio:false, video:{facingMode:{ideal:"environment"}}})`. Stub penolakan izin menampilkan pesan jelas. Track sintetis berakhir setelah pembacaan. |
| Jalur BarcodeDetector | PASS dengan mock | Detektor mock mengembalikan payload kedaluwarsa dan namespace kartu asli. UI menolak keduanya. Implementasi native Android belum diuji. |
| Isolasi jaringan | PASS otomatis | DevTools mencatat resource origin lokal dan URI data. Server hanya menerima GET aset. Tidak ada POST, unggahan frame, atau request sistem produksi dalam alur uji. |
| Laptop melalui internet | BLOCKED | Belum ada URL HTTPS demo yang diterbitkan. |
| Android melalui internet, izin kamera nyata dan pemindaian fisik | NOT TESTED | Menunggu publikasi terisolasi dan dua perangkat. |
| Backend hosted dan replay global | BLOCKED | Demo statis tidak mempunyai backend otoritatif. |

**Total Node: 4 PASS, 0 FAIL, 0 BLOCKED.** Satu tes browser mencakup beberapa pemeriksaan pada tabel. Dua run awal menemukan masalah pada harness: URI gambar lokal salah dihitung sebagai request jaringan dan polling dapat membaca DOM sebelum tersedia. Kedua pemeriksaan dikoreksi dan run akhir lulus. Izin kamera dan video pada run otomatis memakai mock/stream sintetis. Validasi expiry memakai jam perangkat dan payload demo yang tidak ditandatangani. Pembacaan ulang selama masih berlaku dapat diterima. Tidak ada klaim identitas terverifikasi, revocation, atau replay protection lintas perangkat.

Reproduksi otomatis menggunakan `node --test candidates/qr-fix-02-web/browser.test.mjs candidates/qr-fix-02-web/demo-core.test.mjs` dengan `SIPAPUA_QR_CHROME` mengarah ke Chrome yang sudah terpasang.

## Publikasi dan uji dua perangkat

**URL HTTPS: belum ada.** Tidak ditemukan workflow Pages, `CNAME`, atau branch Pages yang membuktikan target demo terpisah pada checkout/ref yang diperiksa. Endpoint metadata Pages tidak dapat diverifikasi secara publik. Status Pages produksi tidak diubah. GitHub Pages mendukung HTTPS untuk repository publik dengan GitHub Free; opsi yang direkomendasikan adalah target Pages demo terpisah yang disetujui Owner. Pembuatan repo demo, perubahan publishing source, serta commit/push berada di luar persetujuan saat ini.

Setelah persetujuan terpisah, publikasikan **isi `public/` saja** ke root target demo. Rencana alamat mengikuti pola proyek Pages `https://<owner>.github.io/<repository-demo>/` untuk kartu dan `https://<owner>.github.io/<repository-demo>/scanner.html` untuk scanner. Ini pola, bukan URL aktif. Pastikan URL HTTPS yang diterbitkan betul-betul dapat dibuka dari laptop dan Android sebelum tes fisik. [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages) · [Sumber publikasi Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

1. Sinkronkan jam laptop dan Android. Di laptop, buka URL HTTPS kartu lalu klik **Buat QR Demo**.
2. Di Chrome Android, buka URL HTTPS scanner, klik **Buka Kamera Belakang**, beri izin, dan arahkan kamera ke layar laptop.
3. Cocokkan ketiga nilai fixture. Buat QR baru dan tunggu melewati lima menit sebelum menguji penolakan expiry. Uji juga penolakan izin dan tombol tutup. Catat model perangkat, versi Chrome dan hasil tanpa menyimpan frame.

Syarat produksi tetap mencakup verifier privat dan OAuth tanpa billing, revocation akun/pemilik dan konsumsi App Check nyata, Rules yang disetujui, pengukuran D1 hosted, uji fisik, serta keputusan Owner terpisah. Registrasi tetap HOLD, maintenance QR ACTIVE dan QR friendship DISABLED. Tidak ada deployment, commit, push, merge, atau perubahan website aktif.

Artefak publikasi adalah direktori [public/](./public/). Konfigurasi Git pada direktori kandidat mempertahankan byte pustaka dan lisensi vendor. Pengecualian whitespace terbatas pada spasi akhir baris dan indentasi campuran yang sudah ada pada qrcodejs serta baris kosong EOF pada lisensi jsQR.
