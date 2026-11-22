# SIPAPUA — Production Feature Recovery

**GO review kandidat lokal. NO-GO deployment. Ketiga fitur belum PRODUCTION VERIFIED.** Checkout `test/sipapua-emulator-guard-20261110` berada di `76cc5f8aac48618caf7411cc966f4665bcb57a6b`. Enam lapis patch berhasil diterapkan bersama pada salinan TEMP halaman dan modul asli. File tracked aktif tetap utuh.

| Fitur | CODE FIXED | EMULATOR TEST PASSED | BACKEND INTEGRATION VERIFIED | PRODUCTION VERIFIED |
|---|---|---|---|---|
| Hapus Data Jemaat | PASS kandidat | PASS Auth dan Firestore | PASS lokal, jalur transaksi Spark dengan Rules kandidat. Callable hosted belum diuji | NOT VERIFIED |
| Lacak Domba | PASS kandidat | PASS browser dan Firebase Auth/Firestore | PASS lokal pada handler Edge dan RPC PostgreSQL. Penyambungan browser–Edge sebenarnya belum diuji dalam satu run | NOT VERIFIED |
| QR Kartu Jemaat | PASS kandidat | PASS Auth/Firestore untuk alokasi, disabled dan revocation pada suite terpisah | PARTIAL, Worker/SQLite dan halaman asli terhubung lewat fixture; verifier identitas dan App Check hosted BLOCKED | NOT VERIFIED |

## A. Hapus Data Jemaat

Transaksi Spark di `sipapua-spark-member.js` menghapus `users/{profileId}` dan membuat `registration_audit/profile-delete_{profileId}`. Baseline emulator menolak pembuatan audit meski SuperAdmin aktif sudah login, sehingga seluruh transaksi batal. `member-delete.patch` dari recovery sebelumnya mengikat delete dengan create audit dalam satu transaksi. Delete profil pihak lain memerlukan Master atau SuperAdmin aktif; Admin biasa serta SuperAdmin inaktif ditolak. Callable juga memakai allowlist role delete yang diperketat. Alur pemilik sendiri tetap dibatasi ke kepemilikan yang dapat dicocokkan.

Tambahan `delete-confirmation.patch` membuat transaksi menghitung profil yang benar-benar dihapus dan profil yang sudah tidak ada. Facade `sipapua-registration.js` memvalidasi jumlah tersebut sebelum UI memakainya. Dashboard menunggu konfirmasi per kelompok dan membedakan kedua jumlah pada pesan sukses maupun kegagalan sebagian. Kontrak ini dipakai oleh jalur Spark client; Callable opsional tetap memakai kontraknya sendiri.

**Bukti baru:** SuperAdmin aktif menghapus satu profil dan Master aktif menghapus empat. Pembacaan ulang server emulator memastikan profil hilang dan setiap penghapusan tercatat. Delete tanpa audit dan audit yang berdiri sendiri ditolak. Handler bulk asli melaporkan **4 dari 6 terkonfirmasi, 3 dihapus dan 1 sudah tidak ada** ketika kelompok kedua ditolak atomik. Dua profil pada kelompok kedua tetap ada. Uji dashboard menjalankan handler asli dengan DOM fixture; browser dashboard penuh belum diuji. Role akun admin aktif dan revisi Rules Firebase produksi belum dapat diperiksa dengan akses resmi yang tersedia pada run ini.

## B. Lacak Domba

Merge presence lama dapat mempertahankan key legacy yang ditolak Rules sehingga kontrol dan sinkronisasi tidak mulai. `lacak-domba.patch` memperbaiki proyeksi presence dan guard sesi. `edge-distance.patch` menghapus cutoff longitude yang terbukti membuang titik 999,5 m sebelum perhitungan Haversine pada radius 1 KM. RPC tetap menyaring online, opt-in aktif, umur heartbeat dan lokasi, serta blokir dua arah. Kontak dan permintaan pertemanan tidak menjadi filter jarak pada handler/RPC.

Tambahan `lacak-relationships.patch` menampilkan **SUDAH BERTEMAN** untuk kontak yang tetap muncul dalam hasil dan **TAMBAH TEMAN** untuk profil baru. Sebelum menulis, UI membaca ulang kontak dan pending masuk/keluar dari server. Bila penulisan kalah balapan, UI membaca ulang status dan menampilkan pending yang sudah ada. Dokumen deterministik satu per pasangan serta Rules create/update yang sudah ada tetap menjadi pembatas server. Tidak ada perubahan Rules friendship atau koordinat.

**Bukti baru:** Chrome dengan Auth dan Firestore Emulator menampilkan teman, calon teman, dan pending masuk dengan aksi berbeda. Permintaan baru tersimpan. Saat state tab sengaja dibuat tertinggal, UI memulihkan pending keluar maupun masuk dari Firestore. Timestamp request keluar dan pengirim request masuk tetap sama. Logout menonaktifkan kontrol. Endpoint nearby di run browser adalah fixture; hasil tersebut khusus alur UI dan penyimpanan pertemanan.

**Bukti backend yang berlaku:** suite jarak sebelumnya menjalankan handler Edge dengan JWT sintetis dan PostgreSQL in-memory sesuai migrasi. Dua akun online dan opt-in saling menemukan. Hasil benar untuk 500 m pada 1 KM, 3 KM di luar 1 KM dan masuk 5 KM, serta 8 KM di luar 5 KM dan masuk 10 KM. Offline, opt-out tersinkron, expiry, lokasi basi dan blok dua arah dikecualikan. Respons tidak memuat koordinat atau jarak presisi. Level integrasi ini memakai transport Firestore dan RPC fixture serta SQL nyata. Belum ada satu run yang menghubungkan Chrome, Edge runtime dan PostgREST sungguhan.

**Produksi read-only:** Supabase melaporkan Edge `lacak-domba-nearby` ACTIVE v1. Metadata RPC cocok dengan signature scan dan mengizinkan `service_role`, sementara `authenticated` ditolak. Snapshot pada audit jarak sebelumnya menunjukkan 0 sesi opt-in. Pemeriksaan ini tidak membuktikan pengguna sistem aktif sudah dapat saling menemukan. Privasi target mengikuti clear/sinkron yang berhasil dan batas freshness; pencabutan seketika saat sinkronisasi gagal belum dibuktikan.

## C. QR Kartu Jemaat

Maintenance menghentikan penerbitan sebelum token diminta. Jalur lama memakai Callable, sementara adapter Worker belum dikonfigurasi. `qr-integration-01/application.patch` diterapkan ke salinan kerja lima file aplikasi asli. Adapter issue/lookup dipakai bersama, bio menampilkan hasil verifikasi baca-saja, dan friendship QR tetap nonaktif. Worker menerbitkan token opaque lima menit serta mengonsumsi secara atomik sekali pakai.

**Bukti:** smoke test Chrome baru membuka modal Kartu Digital asli, menampilkan kanvas QR, mendekode gambar melalui callback scanner asli, membuka bio dengan identitas sintetis yang sesuai, serta menolak replay. Timer tampilan menghapus gambar, dan simulasi outage gagal aman. Regresi Worker/SQLite sebelumnya membuktikan expiry backend, satu pemenang scan bersamaan, serta kegagalan verifier yang ditolak. Auth/Firestore Emulator memverifikasi akun disabled/revoked; browser memakai fixture kamera, Auth dan App Check.

**Blocker:** verifier privat dengan workload identity dan OAuth tanpa billing belum tersedia. Konsumsi App Check nyata, akses Firebase otoritatif, origin staging, metering D1, dan uji perangkat fisik masih perlu bukti. Maintenance QR tetap aktif. Ref lokal `origin/main` memuat `registration: false`; keputusan registrasi HOLD tercatat sebagai temuan governance terpisah dan pengaturan tidak diubah.

## Artefak review dan verifikasi setelah deployment

**Aman untuk review commit kandidat:** `delete-confirmation.patch`, `delete-confirmation.test.mjs`, `lacak-relationships.patch`, `lacak-browser.test.mjs`, `lacak-pages.mjs`, dan laporan ini. Pertahankan referensi kandidat sebelumnya. Run saat ini **9 PASS, 0 FAIL** termasuk subtes, dengan bukti radius terdahulu **14 PASS**. Jalankan `node --test --test-concurrency=1 candidates/sipapua-production-recovery/delete-confirmation.test.mjs candidates/sipapua-production-recovery/lacak-browser.test.mjs candidates/qr-integration-01/browser.test.mjs` dengan Chrome dan dependency emulator PREHOST-02. Gunakan proyek demo dan loopback. Kedua patch baru berlapis pada patch recovery sebelumnya, bukan langsung pada baseline.

**Memerlukan persetujuan deployment:** pemasangan Rules dan client hapus yang sudah direkonsiliasi, pemasangan perubahan Lacak Domba dan Edge, serta seluruh pekerjaan hosted QR. Jangan memublikasikan file fixture. Untuk review gabungan, urutan patch ialah `member-delete.patch` → `delete-confirmation.patch`, `lacak-domba.patch` → `lacak-relationships.patch` + `edge-distance.patch`, lalu `qr-integration-01/application.patch` dengan dependensi adapter yang dicatat pada laporan integrasi. Urutan ini sudah diperiksa dalam salinan TEMP. Deploy masing-masing hanya setelah otorisasi dan bukti staging.

1. **Hapus:** cocokkan revisi Rules, identitas dan role akun uji aktif. Di website yang disetujui, gunakan profil sintetis saja. Coba satu delete, bulk, penolakan Admin, dan kelompok gagal. Baca ulang profil serta audit sebelum menerima hasil.
2. **Lacak Domba:** pada dua akun sintetis, verifikasi GPS, opt-in, heartbeat, radius 1/5/10 KM, dan hilangnya hasil setelah offline, expiry atau blokir. Terima pertemanan lalu pastikan keduanya tetap muncul saat memenuhi syarat dan labelnya benar. Uji stale pending dari tab lain dan pastikan hanya ada satu request. Periksa respons tanpa merekam data lokasi asli.
3. **QR:** biarkan maintenance aktif sampai verifier, App Check, Rules, origin dan kuota lulus gate. Setelah otorisasi terpisah, uji issue, camera scan dan bio sintetis pada dua perangkat, lalu replay, expiry, revocation dan outage. Jika salah satu gagal, hentikan uji rilis dan pertahankan maintenance.

Tidak ada penghapusan data nyata, commit, push, PR, merge, deployment, atau perubahan produksi, IAM maupun billing. Biaya tambahan Rp0.
