# Lacak Domba — Rencana Rilis (belum dieksekusi)

Status per 19 Oktober 2026: **staging NO-GO, produksi NO-GO** sampai butir "Keputusan Project Owner" dan "Gerbang staging" di bawah selesai. Dokumen ini adalah rencana; tidak ada langkah di dalamnya yang telah dijalankan terhadap produksi.

Project Supabase: `cfnimvrxrnmefmxtzqks` · Firebase: `boby-apps-project` · Branch: `fix/lacak-domba-backend-supabase` (HEAD `f178b33`).

## 1. Fakta produksi yang menjadi titik awal (diverifikasi read-only)

- Tabel `lacak_domba_presence`, `lacak_domba_blocks`, `lacak_domba_scan_limits` ada; RLS aktif; anon/authenticated tidak punya SELECT.
- `lacak_domba_take_scan_slot` dan `lacak_domba_replace_own_blocks`: EXECUTE hanya service_role.
- Kolom `discoverable_until` dan `discovery_session_id` **belum ada**. Riwayat migrasi **kosong**.
- Edge Function `lacak-domba-nearby` **belum ter-deploy**. Tiga fungsi admin aktif: `admin-event`, `admin-delete-event-jemaat`, `admin-delete-annual-records`.
- Halaman `lacak-domba.html` yang live (HEAD) masih memanggil Firebase callable `findNearbyMembers`.

Catatan penting: definisi tabel di `20261010000000_lacak_domba.sql` **tidak diekspor dari produksi** (lihat header file). Karena itu langkah M2 wajib.

## 2. Keputusan Project Owner yang dibutuhkan sebelum rilis

| # | Keputusan | Kondisi saat ini (teruji) |
|---|---|---|
| K1 | Semantik menutup tab | Menutup/reload tab terakhir mengirim `leave` (keepalive) dan mengakhiri sesi. Bila request gagal (crash, jaringan putus), pengguna tetap terdaftar **paling lama 180 detik setelah heartbeat terakhir** (batas kehadiran 3 menit, LD-16/R2). Terukur nyata: tampil sampai +168–175 s setelah crash, hilang pada +178–185 s. |
| K2 | Membuka lagi halaman setelah crash, masih dalam 15 menit | Halaman mengadopsi sesi server yang masih berjalan (toggle menyala, hitung mundur tampil) dengan lokasi dari awal sesi. Alternatif lebih ketat: selalu akhiri sesi lama saat halaman dibuka. **Belum diubah.** |
| K3 | Perubahan development baru (perlu review sebelum ikut rilis) | (a) Server membaca ulang daftar blokir pemanggil pada **setiap** `sync` (flag `syncBlocks` diabaikan), juga pada `discovery_start`/`discovery_extend`; bila daftar blokir gagal dibaca, presence tidak diperbarui. Akibatnya blokir dari `kontak.html` berlaku pada sync berikutnya pemblokir, dan **paling lambat 180 detik setelah sync sukses terakhir** walau heartbeat gagal, tab tidur, atau jaringan putus. (b) Pesan "paling lambat pukul …" memakai batas atas akhir sesi server, dibulatkan ke atas per menit; "Anda tidak lagi muncul" tidak tampil sebelum batas itu terlewati bila server tidak terjangkau. (c) Waktu sesi di halaman memakai jam monotonic (`performance`), sehingga mengubah jam perangkat tidak memanjangkan/memotong hitung mundur; antar-tab dikirim sisa waktu relatif. (d) Fungsi sesi kini juga mengembalikan `expires_at` (akhir sesi pada jam database); halaman menampilkan jam akhir itu dengan label **"(waktu server)"** dan catatan bila jam perangkat selisih ≥1 menit. Bila server tidak memberi waktu akhir, jam ditampilkan sebagai **"(perkiraan dari jam perangkat)"**. Hitung mundur tetap memakai durasi relatif. (e) Pesan antar-tab (BroadcastChannel) **tidak membawa status sesi**: hanya petunjuk agar tab lain menanyakan server; tampilan hanya mengikuti jawaban server (satu pemeriksaan sekaligus, pesan beruntun digabung). `sessionId` harus UUID dan `expiresInMs` bilangan terhingga >0 sebelum sesi ditampilkan. |
| K4 | Temuan `users/{uid}` publik | Lihat bagian 7. Tidak diubah. |
| K5 | Akun uji sintetis di Firebase produksi | Dua akun (mis. `qa-lacak-a`, `qa-lacak-b`), dibuat dan diaktifkan (`status_akun: "Aktif"`) oleh administrator; tanpa data jemaat. Diperlukan untuk staging/smoke test. |

## 3. Rencana migrasi (M)

| Langkah | Tindakan | Kriteria lanjut |
|---|---|---|
| M1 | Ambil cadangan skema objek `lacak_domba_*` (`pg_dump --schema-only -t 'public.lacak_domba_*'`). Data presence bersifat sementara (sesi ≤15 menit), tidak perlu dicadangkan isinya. | File cadangan tersimpan di luar repo. |
| M2 | Jalankan `docs/lacak-domba/preflight-readonly.sql` (SELECT-only, hanya metadata dan jumlah baris). | **Semua baris `OK`.** Satu baris non-OK = berhenti dan rekonsiliasi dulu. |
| M3 | Terapkan **hanya** `20261017000000_lacak_domba_discovery_session.sql` sebagai satu transaksi, dengan batas tunggu kunci: `PGOPTIONS="-c lock_timeout=5s -c statement_timeout=60s" psql "<koneksi langsung>" --single-transaction -v ON_ERROR_STOP=1 -f <file>`. Bila gagal (kunci, tipe hasil), seluruh transaksi batal tanpa perubahan; ulangi di jam sepi. Jangan jalankan ulang `20261010000000` kecuali M2 menunjukkan objek yang hilang. | Exit 0. |
| M4 | Catat riwayat agar `db push` di masa depan tidak menjalankan ulang: `supabase migration repair --status applied 20261010000000 20261017000000 --project-ref cfnimvrxrnmefmxtzqks`. **Jangan pernah** `supabase db push` otomatis untuk rilis ini. | `supabase migration list` menunjukkan keduanya applied. |
| M5 | Jalankan `docs/lacak-domba/postcheck-readonly.sql`. | **Semua baris `OK`.** |

Catatan M3: tipe hasil keempat fungsi `lacak_domba_discovery_*` kini memiliki kolom keempat `expires_at`. Produksi belum pernah memiliki fungsi ini (M2 baris 5 harus kosong), jadi `create or replace` berjalan normal. Hanya database development yang pernah memakai draf lama yang perlu menghapus fungsi itu dulu (lihat header migrasi).

Efek M3 pada data: tidak ada baris yang diubah. Baris presence lama (tanpa sesi) tidak lagi tampil sampai pemiliknya mengaktifkan sesi baru. Kedua CHECK baru terpenuhi oleh baris lama (kolom baru NULL).

Teruji lokal (PostgreSQL 17.6): preflight pada keadaan "hanya migrasi dasar" → 0 baris non-OK; preflight menangkap grant anon yang sengaja disuntikkan; migrasi diterapkan dua kali (idempoten); postcheck → semua OK; rollback → preflight kembali 0 non-OK; migrasi dapat diterapkan ulang setelah rollback.

### 3a. Keamanan migrasi: tipe hasil RPC berubah (diuji lokal, PostgreSQL 17.6)

| Aspek | Temuan | Bukti lokal |
|---|---|---|
| Signature fungsi | Argumen keempat fungsi `discovery_*` tidak berubah; hanya tipe hasil yang mendapat kolom `expires_at`. `create or replace` **tidak dapat** mengubah tipe hasil fungsi yang sudah ada. | Dengan draf 3 kolom terpasang: `ERROR: cannot change return type of existing function`; transaksi batal, 0 kolom baru, fungsi lama utuh. |
| Keberadaan di produksi | Fungsi `discovery_*` belum ada di produksi (verifikasi metadata 19 Okt; preflight baris 5 harus kosong). Bila ternyata ada: **berhenti**, jangan DROP tanpa review. | Preflight melaporkan "EXISTS BEFORE MIGRATION". |
| Dependensi | Preflight baris 6b mendaftar view/rule pada `lacak_domba_presence` dan fungsi lain yang menyebut objek Lacak Domba. | View dan fungsi uji yang disuntikkan muncul sebagai REVIEW. |
| GRANT/REVOKE | EXECUTE dicabut dari public/anon/authenticated dan diberikan ke service_role untuk keenam fungsi; tanpa perubahan grant tabel; tanpa policy. | Postcheck semua OK; uji DB: anon/authenticated "permission denied". |
| Downtime/kunci | `ADD COLUMN` (nullable), `ADD CONSTRAINT CHECK` (memvalidasi semua baris) dan `CREATE INDEX` mengambil kunci tabel singkat pada `lacak_domba_presence` saja. Fitur belum live, jadi tidak ada pengguna terdampak. | 10.000 baris sintetis: seluruh migrasi 598 ms. Dengan transaksi lain memegang kunci: berhenti setelah 3,4 s karena `lock_timeout`, rollback penuh. |
| Kompatibilitas | Edge Function baru menerima hasil dengan atau tanpa `expires_at` (null → halaman menampilkan "perkiraan dari jam perangkat"). Halaman lama (HEAD) tidak memakai fungsi ini. Halaman baru tanpa Edge Function → error layanan, karena itu frontend dipublikasikan terakhir. | Unit test `discoveryFromRow` (expires_at hilang/rusak → null); E2E step 28. |
| Rollback | Blok rollback di header migrasi (DROP FUNCTION + DROP COLUMN) — **hanya dengan persetujuan terpisah**, setelah frontend dan Edge Function dikembalikan. | Diuji lokal: rollback → preflight 0 non-OK → apply ulang → postcheck 0 non-OK. |

## 4. Rencana deployment (D) — urutan wajib

1. **D0** Pindahkan dua file cadangan `index.ts.*.bak` (0 dan 3 byte) keluar dari `supabase/functions/lacak-domba-nearby/` sebelum deploy (jangan dihapus; tidak ikut bundle, tetapi jangan ikut diunggah).
2. **D1** M1–M5 selesai dan OK.
3. **D2** `supabase functions deploy lacak-domba-nearby --project-ref cfnimvrxrnmefmxtzqks --no-verify-jwt`
   - **Selalu dengan nama fungsi.** `supabase functions deploy` tanpa nama akan men-deploy ulang `admin-delete-event-jemaat` dan `admin-delete-annual-records` dari source lokal. `admin-event` tidak punya source di repo ini.
   - `verify_jwt = false` sudah diatur di `supabase/config.toml` (bagian baru, tidak mengubah bagian lain); fungsi memverifikasi token Firebase sendiri (RS256, JWKS Google, issuer/audience `boby-apps-project`).
   - Sebelum dan sesudah: `supabase functions list` — versi tiga fungsi admin harus **tidak berubah**.
4. **D3** Smoke test backend tanpa data pengguna: `SIPAPUA-QA-KIT/http-contract-smoke.mjs` (OPTIONS, tanpa token → 401, token palsu → 401), hanya dengan izin eksplisit `LD_ALLOW_REMOTE_DIAGNOSTICS=YES_READ_ONLY`.
5. **D4** Smoke test dua akun sintetis (K5) dengan salinan uji halaman yang menunjuk ke fungsi produksi, sebelum halaman publik diganti.
6. **D5** Publikasikan `lacak-domba.html` (GitHub Pages) setelah D3–D4 lulus.
7. **D6** Pantau log fungsi 24 jam; ulangi postcheck M5.

## 5. Rollback

| Lapisan | Tindakan | Dampak |
|---|---|---|
| Frontend | Kembalikan `lacak-domba.html` ke versi HEAD (`f178b33`, memakai `findNearbyMembers`). | Pengguna kembali ke alur lama. |
| Edge Function | `supabase functions delete lacak-domba-nearby --project-ref cfnimvrxrnmefmxtzqks` (belum ada versi sebelumnya). | Hanya fungsi ini; fungsi admin tidak tersentuh. |
| Database | Blok "Rollback (manual)" di header `20261017000000_...sql`, sebagai satu transaksi. Teruji lokal. | Hanya data sesi sementara yang hilang. |
| Riwayat | `supabase migration repair --status reverted 20261017000000`. | — |

Urutan rollback: frontend → Edge Function → database.

## 6. Dampak terhadap fungsi administrator

- Migrasi hanya menyentuh objek `lacak_domba_*`. `admin-delete-event-jemaat` dan `admin-delete-annual-records` tidak mereferensikan objek tersebut (diperiksa dengan grep). Source `admin-event` tidak ada di repo, jadi tidak dapat diperiksa di sini; migrasi tidak mengubah objek di luar `lacak_domba_*`.
- `supabase/config.toml`: hanya menambah bagian `[functions.lacak-domba-nearby]`.
- Risiko satu-satunya adalah deploy tanpa nama fungsi (lihat D2).

## 7. Temuan keamanan: koleksi `users` (didokumentasikan, tidak diubah)

Uji emulator dengan `firestore.rules` repo:

- `users/{uid}` dapat **dibaca dan di-list tanpa login** (`allow read: if true`). Field yang terlihat pada data uji: `email`, `nama`, `status_akun`, `uid`. Subkoleksi `users/{uid}/**` juga terbuka.
- Akibat: pencacahan seluruh akun dan email jemaat tanpa autentikasi.
- Tidak memengaruhi Lacak Domba secara langsung: Edge Function hanya membaca `users/{uid}` milik pemanggil dengan token pemanggil, dan itu tetap diizinkan bila baca publik ditutup (diuji).
- Saran untuk review terpisah: batasi `get` ke pemilik/admin aktif dan hentikan `list` publik, setelah memetakan halaman yang membutuhkan lookup tanpa login (komentar rules menyebut "registration lookups").

Koleksi lain dengan `allow read, write: if true` (`jemaat`, `portal_media`, `config`, `login_logs`, `chats`, dll.) di luar cakupan rilis ini.

## 8. Audit Git

| Path | Status | Rekomendasi |
|---|---|---|
| `lacak-domba.html`, `supabase/config.toml` | modified | commit setelah review |
| `supabase/functions/lacak-domba-nearby/{index,discovery}.ts` | untracked | commit |
| `supabase/functions/lacak-domba-nearby/*.bak` | untracked | **jangan commit**; pindahkan ke folder cadangan di luar repo |
| `supabase/migrations/*.sql` | untracked | commit |
| `supabase/functions/tests/*`, `tests/lacak-domba-e2e/*`, `tests/lacak-domba-firebase/*` | untracked | commit (tidak ada `index.ts` di folder tests, jadi tidak dapat ter-deploy) |
| `docs/lacak-domba/*` | untracked | commit |
| `supabase/.temp/` | untracked (cache CLI, berisi ref project) | **jangan commit**; tambahkan `supabase/.temp/` ke `.gitignore` |
| `deno.lock` | untracked | putuskan: semua tes dijalankan dengan `--no-lock`; jangan commit kecuali sengaja mengunci dependensi |
| `firestore-debug.log` | diabaikan oleh `*.log` | — |

Pemindaian pola rahasia pada semua file berubah/baru: tidak ada service_role key, JWT, private key, atau `sb_secret_`. Yang ditemukan hanya konfigurasi publik klien (Firebase `apiKey`, `sb_publishable_…`), keduanya sudah ada di versi sebelumnya.

## 9. Matriks pengujian staging (dua akun sintetis A dan B)

Lingkungan: Supabase terpisah **tanpa branch berbayar** (mis. project gratis terpisah, migrasi + fungsi yang sama) atau, dengan persetujuan, produksi sebelum D5. Firebase `boby-apps-project` dengan akun K5. Tanpa data jemaat.

| # | Skenario | Langkah | Hasil yang diharapkan |
|---|---|---|---|
| S1 | Login dan status | A dan B login | Toggle mati, tidak ada baris sesi |
| S2 | Mulai sesi | A aktifkan Bisa Ditemukan | Sesi 15:00; pesan "paling lambat sampai pukul" ≥ akhir di DB |
| S3 | Penemuan | B pindai radius 1/5/10 km | A tampil dengan rentang jarak saja, tanpa koordinat |
| S4 | Heartbeat | Tunggu 2 heartbeat | Akhir sesi tidak bergeser |
| S5 | Perpanjang | A tekan Perpanjang | Akhir = waktu klik + 15 menit |
| S6 | Dua tab | A buka tab kedua; tutup salah satu | Sesi tetap; menutup tab terakhir mengakhiri sesi |
| S7 | Dua perangkat | A di ponsel dan laptop; tutup di laptop | Sesi berakhir; ponsel mengikuti, tidak menghidupkan ulang |
| S8 | Matikan | A tekan Matikan | Hilang dari pindaian B seketika |
| S9 | Matikan saat offline | A mode pesawat lalu Matikan | Pesan jujur "server belum dapat dihubungi … paling lambat pukul"; terhapus setelah online |
| S10 | Crash/force-close | Tutup paksa aplikasi browser A | B masih menemukan A ≤180 s setelah heartbeat terakhir, lalu tidak |
| S11 | Blokir dari Lacak Domba | B blokir A | Keduanya saling tidak terlihat |
| S12 | Blokir dari Kontak | A blokir B di `kontak.html` saat sesi A berjalan di perangkat lain | B tidak menemukan A setelah sync A berikutnya (normalnya ≤90 s); bila A offline/tab tidur: paling lambat 180 s setelah sync sukses terakhir A |
| S19 | Jam perangkat diubah | Ubah jam perangkat A ±1 jam saat sesi berjalan | Hitung mundur tetap sesuai server; jam akhir ditampilkan sebagai "(waktu server)" dengan catatan selisih jam perangkat |
| S13 | Akun nonaktif | Admin menonaktifkan B | B ditolak 403 dan langsung tersembunyi |
| S14 | Token tidak valid | Token kedaluwarsa/rusak | 401, tidak ada perubahan data |
| S15 | GPS ditolak | Tolak izin lokasi | Tidak ada sesi, pesan jelas |
| S16 | Batas pemindaian | Pindai dua kali dalam 15 s | 429 |
| S17 | Ponsel 360 px | Buka di ponsel | Tidak ada scroll horizontal |
| S18 | Fungsi admin | Jalankan satu aksi baca di tiap fungsi admin | Perilaku dan versi tidak berubah |

## 10. Cara menjalankan pengujian lokal

Lingkungan lokal dipakai pada 19 Oktober 2026: PostgreSQL 17.6 portable (127.0.0.1:54329), PostgREST 16.4 (127.0.0.1:54331) dengan gateway `/rest/v1` (127.0.0.1:54330), Firebase Auth/Firestore Emulator (9099/8080), Chrome via `playwright-core`.

```
deno test --no-lock --no-config supabase/functions/tests/lacak-domba-discovery_test.ts
LD_TEST_DB_URL=... deno test --no-lock --no-config --allow-env --allow-net supabase/functions/tests/lacak-domba-db_test.ts
LD_TEST_SUPABASE_URL=... LD_TEST_SERVICE_ROLE_KEY=... LD_TEST_DB_URL=... deno test --no-lock --no-config --allow-env --allow-net --allow-read --allow-sys supabase/functions/tests/lacak-domba-nearby_test.ts
(+ emulator)  ... supabase/functions/tests/lacak-domba-emulator_test.ts
(+ emulator)  deno test --no-lock --no-config --allow-net --allow-read --allow-env tests/lacak-domba-firebase/rules_test.ts
node tests/lacak-domba-e2e/e2e.cjs     (LD_E2E_ONLY=22,23 untuk sebagian langkah)
```
