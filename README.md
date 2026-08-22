# SIPAPUA

## Sistem Informasi Pondok Pemulihan Papua

SIPAPUA adalah sistem informasi Pondok Pemulihan Papua yang mengintegrasikan pelaporan kegiatan, autentikasi pengguna, Firebase/Firestore, Admin Portal, dan Big Data untuk monitoring serta analitik.

## Tujuan

- Pencatatan kegiatan secara terstruktur.
- Sinkronisasi data kegiatan ke Big Data.
- Monitoring dan statistik untuk administrator.
- Laporan dan export PDF.
- Fondasi Insight AI yang berkembang mengikuti data.

## Modul Utama

SIPAPUA mencakup autentikasi, dashboard administrator, Big Data, Ibadah, Komsel, Doa Puasa Jemaat, Kingdom Discipleship, Baca Alkitab, Pelayanan PW, Pelayanan Non PW, Extension, Peringkat JC, dan modul pendukung lainnya.

## Arsitektur Tingkat Tinggi

`	ext
Pengguna -> SIPAPUA -> Firebase Authentication -> Firestore
                                              |-> Admin Portal
                                              |-> Big Data -> Statistik -> Insight AI -> PDF Report
`

## Prinsip Pengembangan

### Stability First
Fitur yang sudah solved tidak boleh dirombak tanpa alasan teknis yang jelas.

### Security by Design
Setiap perubahan mempertimbangkan authentication, authorization, data exposure, XSS, abuse, dependency, dan Firestore Rules.

### Big Data Synchronization
Setiap fitur yang menghasilkan data harus mempunyai jalur monitoring di Big Data.

### Performance by Design
Query, listener, grafik, PDF, dan analitik harus tetap efisien ketika data dan traffic meningkat.

### Audit Before Commit
Testing -> diff -> git diff --check -> staged audit -> commit -> push -> deployment verification.

## Big Data

Big Data merupakan pusat monitoring dan analitik SIPAPUA. Laporan publik tidak boleh membocorkan struktur database internal atau metadata sensitif.

## Security

Firestore Rules menjadi bagian penting dari authorization data. Lihat SECURITY.md dan dokumentasi di docs/.
