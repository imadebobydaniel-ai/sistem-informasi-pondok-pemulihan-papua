# Firebase SIPAPUA

## Komponen

SIPAPUA menggunakan Firebase sebagai fondasi layanan aplikasi yang mencakup:

- Firebase Authentication;
- Cloud Firestore;
- Firestore Security Rules.

## Firestore Rules

Konfigurasi Firebase saat ini menunjuk ke file:

`	ext
firestore.rules
`

melalui irebase.json.

## Authentication

Firebase Authentication digunakan untuk identitas pengguna.

UID pengguna digunakan sebagai identifier sinkronisasi akun pada modul yang membutuhkan identitas user.

## Security Principles

- authorization tidak boleh hanya bergantung pada UI;
- jangan menyimpan password atau service credential di client;
- jangan mempublikasikan secret;
- validasi akses pada Firestore Rules;
- gunakan prinsip least privilege.

## Query Principles

Query Firestore harus dibatasi sesuai kebutuhan.

Hindari:

- membaca seluruh collection untuk KPI sederhana;
- listener realtime yang tidak dilepas;
- query berulang tanpa kebutuhan;
- pemrosesan data besar di browser bila aggregation lebih tepat.

## Perubahan Rules

Setiap perubahan irestore.rules harus diuji dan diaudit sebelum deployment.
