# SIPAPUA Architecture

## Gambaran Umum

SIPAPUA merupakan sistem informasi Pondok Pemulihan Papua yang menghubungkan aplikasi pengguna, Firebase Authentication, Firestore, Admin Portal, dan Big Data.

## Alur Utama

`	ext
Pengguna
   |
   v
Aplikasi SIPAPUA
   |
   +--> Firebase Authentication
   |
   +--> Firestore
           |
           +--> Admin Portal
           |
           +--> Big Data
                  |
                  +--> Statistik
                  +--> Grafik
                  +--> Insight AI
                  +--> PDF Report
`

## Prinsip Arsitektur

1. Setiap sumber data harus jelas.
2. Fitur yang menghasilkan data harus dipertimbangkan integrasinya dengan Big Data.
3. Authorization tidak boleh bergantung pada UI saja.
4. Query harus dibatasi sesuai kebutuhan.
5. Listener realtime harus dilepas ketika tidak lagi dibutuhkan.
6. Laporan publik tidak boleh membocorkan struktur database internal.
7. Perubahan harus mempertahankan fitur yang sudah stabil.

## Stability

Perubahan harus fokus pada scope yang sedang dikerjakan. Refactor besar tidak dilakukan tanpa alasan teknis yang jelas dan audit dampak.
