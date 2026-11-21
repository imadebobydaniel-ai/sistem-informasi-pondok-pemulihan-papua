# SIPAPUA QR — Owner decision update

**GO untuk evaluasi offline. NO-GO untuk staging hosted dan produksi pada batas Rp0 tanpa billing.**

## Bukti lokal

ZIP handoff cocok dengan kedua entri SHA-256. Workspace yang diperiksa adalah `D:\MASTER PROJECT\SIPAPUA\APLIKASI SIPAPUA`, branch `test/sipapua-emulator-guard-20261110`, HEAD `76cc5f8aac48618caf7411cc966f4665bcb57a6b`, tanpa perubahan tracked. Entri manifest RC-01/02/03/04/04A dan kandidat final masing-masing **11/18/12/4/4/6**, seluruhnya cocok. Angka tersebut adalah jumlah entri, termasuk referensi antarpaket. Tidak ada arsip yang ditimpa.

Handoff menyebut guard masih berupa prototipe terpisah. Pada checkout ini guard sudah terpasang di **Worker kandidat final lokal**, sementara Worker RC-03 dan aplikasi aktif tetap seperti sebelumnya. Audit baru menghasilkan **4 PASS, 0 FAIL** di SQLite in-memory, mencakup batas admission, rollover UTC dan penolakan hari lama dalam satu pemeriksaan, lalu tiga pemeriksaan indeks token dan expiry. Bukti lama **17 PASS Worker final** dan **11 PASS RC-04A** dicatat terpisah. Suite lama tidak diulang. Tidak ada pengujian layanan hosted.

## Verifier dan biaya

| Pemeriksaan | Jalur dan izin minimum |
|---|---|
| Signature JWT, issuer, audience, expiry dan App ID | Public keys dan klaim tepercaya. Tidak memerlukan OAuth layanan. |
| Revocation, disabled, user hilang atau cutoff sesi pemilik | Admin Auth `verifyIdToken(token,true)` dan `getUser(uid)`; lookup akun berizin `firebaseauth.users.get`. Cocokkan UID dan `auth_time` terhadap cutoff. Gunakan OAuth workload untuk lookup otoritatif. |
| Binding dan status anggota | Request caller membaca profil dan alokasi sendiri dengan bearer pengguna melalui Rules. Lookup profil/alokasi pemilik kartu lain menggunakan Admin Firestore `getAll`/BatchGet pada path tetap, dengan `datastore.entities.get` melalui OAuth workload. |
| App Check limited-use consumption | Admin SDK `verifyToken(token,{consume:true})` atau `projects.verifyAppCheckToken`; OAuth `cloud-platform` atau `firebase` dan `firebaseappcheck.appCheckTokens.verify` dalam `roles/firebaseappcheck.tokenVerifier`. Tolak replay, App ID salah, kegagalan dan hasil ambigu. |

Cloudflare RPC mengisolasi panggilan antarlayanan. Tidak ditemukan identitas runtime Worker yang sudah dapat dipakai SIPAPUA untuk Google. WIF membutuhkan assertion dari issuer tepercaya dan konfigurasi audience serta subject yang ketat. STS menukarnya menjadi OAuth berumur pendek. Direct access perlu diuji pada API target; impersonasi akun staging melalui IAM Credentials bisa dipertimbangkan bila direct access tidak diterima. Token pengguna, App Check, dan klaim browser tetap di jalurnya masing-masing. Host Node mandiri masih membutuhkan issuer, transport privat dan bukti biaya tambahan Rp0. Auth email/password dan Firestore tersedia pada Spark; App Check tunduk pada kuota provider; Workers dan D1 punya batas Free. Cloud Run dan Firebase Functions tidak memenuhi syarat tanpa billing. **Tidak ada bukti bahwa keseluruhan jalur OAuth dan ketiga operasi Google tersebut berfungsi pada proyek tanpa billing.**

[Google WIF](https://docs.cloud.google.com/iam/docs/workload-identity-federation) · [Cloudflare RPC](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/) · [Auth lookup](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v1/accounts/lookup) · [Auth revocation](https://firebase.google.com/docs/auth/admin/manage-sessions) · [Firestore IAM](https://cloud.google.com/iam/docs/roles-permissions/firestore) · [App Check consume](https://firebase.google.com/docs/reference/appcheck/rest/v1beta/projects/verifyAppCheckToken) · [Firebase plans](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans) · [Cloud Billing](https://docs.cloud.google.com/docs/get-started/learn-about-billing)

## Peta D1, kandidat final lokal

| Jalur | SQL dan estimasi kerja lokal |
|---|---|
| Preflight atau validasi gagal sebelum admission | 0 statement D1. |
| Kuota harian penuh | 1 upsert ledger kondisional, 1 keyed probe, 0 mutasi. |
| Kuota per menit penuh, atau verifier menolak | 2–3 upsert termasuk ledger dan counter. 1–3 mutasi tabel, hingga 4 perubahan entri indeks bila dua counter baru. |
| Issue/rotasi | 4 statement, hingga 4 mutasi tabel. Model konservatif maksimum 10 perubahan entri indeks untuk counter dan insert/rotasi kartu. Probe ledger, dua counter, UID dan keunikan token. Cooldown menolak mutasi kartu. |
| Lookup | 4 statement sampai SELECT kartu, 5 saat konsumsi. Hingga 3–4 mutasi tabel; hingga 4 entri indeks pada counter baru. SELECT memakai indeks token lalu membaca baris kartu untuk status/expiry. UPDATE menangani race secara kondisional dan mengubah kolom tanpa indeks. |
| Cleanup | 3 statement termasuk ledger, dua DELETE dengan indeks expiry dan maksimal 64 baris per tabel. Hingga 129 mutasi tabel dan sekitar 320 penghapusan entri indeks. Dua range scan mengambil hingga 128 kandidat; penghapusan juga menyentuh baris dan indeks. |

Ini estimasi pekerjaan logis, bukan maksimum terukur dari meter D1. Tidak ada transaksi lintas layanan atau retry aplikasi di Worker. Retry klien membayar admission baru; D1 mendokumentasikan hingga dua retry otomatis untuk query read-only pada error yang dapat diulang, sehingga perlu mengukur read retries dan checks secara hosted. Budget request 32.000 kredit/UTC day dengan 32 kredit per admission memberi plafon 1.000. Budget cleanup 30.000 kredit dengan 600 per run dan cron 30 menit memberi nominal 28.800 kredit/hari. Headroom desain 38.000 dibanding batas Free 100.000 writes/hari. Batas reads Free 5 juta/hari terpisah dan turut dipakai akun lain. Worker mengembalikan `429` ketika guard menolak dan `503` ketika D1 gagal. Tidak ada jalur penerbitan atau konsumsi yang mengabaikan verifier. Query D1 Free gagal setelah limit platform habis sampai reset UTC. Meter aktual, retry, lag cleanup dan retensi pemulihan tujuh hari masih perlu diterima Owner.

[D1 pricing dan indeks](https://developers.cloudflare.com/d1/platform/pricing/) · [D1 retry](https://developers.cloudflare.com/d1/observability/debug-d1/) · [D1 daily quota](https://developers.cloudflare.com/d1/platform/release-notes/) · [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)

## Keputusan dan langkah terkecil

Pertahankan QR dalam maintenance. Buka kembali review hanya jika ada bukti issuer workload yang sudah tersedia dengan Rp0 dan audit dapat menunjukkan OAuth, lookup Auth, Firestore dan konsumsi App Check berhasil tanpa billing di staging sintetis. Setelah persetujuan terpisah, ukur `meta.rows_read` dan `meta.rows_written`, uji quota, retensi dan rollback, lalu jalankan browser dan QR fisik sebelum release. Jangan menyalakan billing atau melemahkan revocation dan replay untuk memenuhi target waktu.

Registrasi HOLD, maintenance member-card ACTIVE dan QR friendship DISABLED. Tidak ada perubahan kode, Rules aktif, layanan eksternal, billing, maupun deployment. Biaya tambahan Rp0.

