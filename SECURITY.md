# Security Policy

## Prinsip

SIPAPUA mengikuti prinsip least privilege, defense in depth, validasi authorization pada data layer, minimisasi data sensitif, dan audit sebelum perubahan production.

## Firestore

Firestore Rules merupakan bagian penting dari authorization data. Perubahan rules wajib direview dan diuji sebelum deployment.

## Authentication

SIPAPUA menggunakan Firebase Authentication. UID pengguna digunakan sebagai identifier untuk sinkronisasi akun dengan data aplikasi.

Jangan menjadikan localStorage, hidden element, atau kontrol UI sebagai satu-satunya mekanisme authorization.

## Data Sensitif

Jangan memasukkan Document ID internal, struktur field database, metadata internal, credential, secret, atau konfigurasi keamanan ke laporan publik.

## Client-Side Security

Kode client harus dianggap dapat dilihat pengguna. Jangan menaruh password atau secret privat di source client. Validasi authorization harus tetap dilakukan pada data layer.

## Dependency dan External Script

Setiap library atau script eksternal baru harus ditinjau sumber, versi, lisensi, integrity bila tersedia, risiko supply-chain, dan dampak performance.

## Incident Response

Jika ditemukan kebocoran data atau bypass authorization:
1. hentikan perubahan lanjutan;
2. identifikasi scope;
3. amankan bukti dan log yang relevan;
4. perbaiki authorization;
5. audit data exposure;
6. uji ulang;
7. dokumentasikan incident.

## Prinsip Perubahan

Security improvement tidak boleh dilakukan dengan merusak fitur yang sudah stabil. Perubahan harus sekecil mungkin dan dapat diaudit.
