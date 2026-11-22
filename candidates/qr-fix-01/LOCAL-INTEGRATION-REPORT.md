# SIPAPUA QR-FIX-01

**GO untuk demo satu mesin dalam lingkungan lokal. NO-GO untuk staging hosted dan produksi.** Seluruh implementasi baru berada di direktori kandidat ini. Data kartu sintetis dan tersimpan sementara di memori. Biaya tambahan Rp0.

## Akar penyebab dan jalur yang diperiksa

| Sumber aktif | Jalur QR saat ini |
|---|---|
| `menu.html`, `kartu-digital.html` | Keduanya memanggil `SIPAPUA_MEMBER_CARD.call("getMyCardToken", {})` sebelum merender QR. Menu juga memakai `scanDestination`. |
| `sipapua-member-card.js`, `sipapua-maintenance.js`, `sipapua-app-check.js` | Guard member-card menghentikan panggilan sebelum token diperoleh. Apabila guard mengizinkan, client memulihkan Auth, memperoleh App Check compat, lalu memakai Firebase Callable region `asia-southeast2`. |
| `qrcode.html` | Memindai token, lalu menyerahkan token lewat sessionStorage ke halaman profil. Komentar lama menyebut `lookupMemberCard`. |
| `bio-singkat-jemaat.html` | Jalur aktual memanggil Callable `scanQrIntroduction` untuk profil dan `requestQrIntroduction` untuk pertemanan berbasis receipt. Jalur ini berbeda dari kontrak profil baca-saja Worker. |
| `candidates/qr-rc-02/frontend/sipapua-qr-http.js` dan Worker final | Kandidat adapter memetakan issue/lookup ke `/v1/issue` dan `/v1/lookup`. Origin Worker masih `null`. Halaman aktif memakai client Callable, sehingga adapter kandidat belum menjadi rute aktif. |

QR aktif tidak muncul karena `memberCard: true` menghentikan penerbitan sesuai maintenance. Apabila hanya guard diabaikan, jalur Callable lama dan adapter Worker yang belum dikonfigurasi tetap menjadi masalah integrasi. Demo memisahkan lookup profil dari receipt dan pertemanan. QR berisi awalan `SIPAPUA-CARD ` diikuti token acak 43 karakter. Raw email, telepon dan NIJ tidak dipakai sebagai QR atau fallback di demo.

## Kandidat yang ditambahkan

- `index.html` dan `demo.js` menyediakan sesi sintetis penerbit/pemindai, adapter same-origin yang hanya menerima loopback dan endpoint tetap, render kanvas, decode gambar, penghapusan QR saat expiry, dan pesan kegagalan. ID token serta App Check hanya dikirim lewat header pada request Worker. Pergantian sesi menolak hasil sesi sebelumnya.
- `server.mjs` menjalankan HTTP di `127.0.0.1` dan menggunakan Worker final serta verifier referensi yang sudah ada. Fixture menandatangani JWT sendiri, mensimulasikan App Check sekali pakai dan lookup Auth/Firestore, serta memakai schema SQLite asli di memori. Worker menjalankan validasi JWT, verifikasi pemilik, expiry, conditional consume, dan kuota. Fixture tidak memiliki rute pertemanan, koneksi upstream, atau kredensial produksi.
- `assets/` berisi qrcodejs 1.0.0 (MIT) dan jsQR 1.4.0 (Apache 2.0) dari paket publik npm beserta lisensinya. Demo melayani kedua aset secara lokal dengan CSP. Browser tidak mengambil pustaka dari CDN.
- `browser.test.mjs` menjalankan alur browser yang terhubung ke server loopback. Untuk demo manual di mesin pengembang, jalankan `node candidates/qr-fix-01/server.mjs` dan gunakan alamat loopback yang dicetak.

## Bukti pengujian

| Lapisan | PASS | FAIL | BLOCKED |
|---|---:|---:|---:|
| Chrome headless dan HTTP loopback | 1 | 0 | 0 |
| Worker final dengan SQLite dan verifier/App Check mock | 17 | 0 | 0 |
| Firebase Auth dan Firestore Emulator RC-03 | 7 | 0 | 0 |
| **Total lokal** | **25** | **0** | **0** |

- **Browser** membuka halaman asli demo, masuk sebagai penerbit, menerbitkan QR dan mengekspor piksel kanvas sebagai PNG. Sesi kedua membuka PNG tersebut melalui input unggah, jsQR mendekode gambar, dan lookup menampilkan profil penerbit sintetis dengan NIJ serta komsel yang tepat. Scan ulang ditolak dan UI membersihkan profil lama. Tes juga mempercepat timer UI untuk memverifikasi QR dihapus saat timer expiry, kemudian mensimulasikan koneksi putus untuk memverifikasi pesan layanan tidak tersedia. Masa berlaku QR di Worker diuji terpisah dengan jam fixture.
- **Worker dan SQLite** menguji self-scan, scan bersamaan dengan tepat satu pemenang, expiry kartu/credential, replay App Check, rotasi kartu, revocation mock, owner recheck, verifier outage, kuota habis dan storage failure. Bukti ini menjalankan SQL di SQLite, bukan D1 hosted.
- **Emulator Firebase** terikat ke `127.0.0.1` pada proyek demo `demo-sipapua-qr-rest`. Pengujian mencakup alokasi owner-only, anonymous/list/write/cross-UID denial, profil nonaktif, akun disabled dan sesi revoked. App Check di sini masih mock. Login browser adalah login sintetis fixture; tes Auth Emulator tersendiri membuktikan perilaku Firebase lokal.
- Chrome sempat mengalami renderer crash ketika dijalankan di sandbox. Run akhir lulus menggunakan Chrome headless dengan izin eksekusi lokal, profil sementara, dan resolusi host luar diblokir.

Perintah reproduksi: `node --test candidates/qr-fix-01/browser.test.mjs` dengan `SIPAPUA_QR_CHROME` mengarah ke Chrome lokal, serta `node --test candidates/qr-zero-cost-final/test/worker.test.mjs candidates/qr-rc-03/test/allocation-rules.test.mjs` dengan prasyarat emulator PREHOST-02 yang sama.

## Governance dan batas demo

Checkout lokal `76cc5f8aac48618caf7411cc966f4665bcb57a6b` menampilkan `registration: true, memberCard: true` pada objek `paused`. Referensi lokal `origin/main` di `cb3ed58eceb8a9abb9630a561c19469fd9e95e92` menampilkan `registration: false, memberCard: true`. Karena `false` pada objek itu berarti registrasi tidak di-pause, terdapat perbedaan governance dengan keputusan HOLD. Temuan berasal dari ref yang tersedia secara lokal. Tidak ada pembacaan status produksi atau perubahan pengaturan. Checkpoint pengembangan yang dilaporkan `62c3c6d8f5b51cecb0b83dd12f2fb3452d12d47a` tersedia sebagai objek Git lokal.

**Dua perangkat fisik: NOT TESTED.** Demo ini sengaja hanya listen di loopback. Pengujian lintas dua perangkat masih membutuhkan jaringan uji sintetis yang terisolasi, transport yang direview, dan uji kamera. Penerbit dan pemindai pada tes ini adalah dua sesi sintetis dalam Chrome yang sama, bukan dua perangkat.

Hosted staging masih tertahan oleh identitas workload/OAuth dan akses Firebase privat tanpa billing, konsumsi App Check nyata, metering/retensi D1, origin serta Rules staging yang disetujui, dan bukti perangkat fisik. Maintenance QR tetap aktif pada checkout, keputusan registrasi tetap HOLD, dan QR friendship tetap DISABLED. Tidak ada deployment, commit, push, merge, perubahan Rules aktif, IAM, billing, atau akses data jemaat.
