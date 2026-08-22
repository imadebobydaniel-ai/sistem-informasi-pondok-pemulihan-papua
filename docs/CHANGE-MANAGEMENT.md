# Change Management SIPAPUA

Dokumen ini menetapkan tata cara perubahan SIPAPUA agar fitur yang sudah stabil tetap aman dan perubahan baru dapat diaudit.

## 1. Identifikasi Masalah

Tuliskan masalah atau kebutuhan secara spesifik sebelum menyentuh kode.

## 2. Tentukan Scope

Tentukan file, modul, data, dan dependency yang benar-benar terdampak.

## 3. Analisis Dampak

Periksa:

- UI;
- authentication;
- authorization;
- Firestore;
- Big Data;
- PDF/reporting;
- performance;
- security;
- kompatibilitas modul lama.

## 4. Implementasi

Perubahan harus sekecil mungkin dan hanya menyentuh bagian yang diperlukan.

Jangan merombak fitur yang sudah solved tanpa alasan teknis yang jelas.

## 5. Testing

Uji fitur baru dan fitur lama yang berpotensi terdampak.

Untuk JavaScript, lakukan syntax validation bila relevan.

## 6. Audit Diff

Gunakan minimal:

`	ext
git status -sb
git diff
git diff --check
git diff --name-only
git diff --cached
git diff --cached --check
`

## 7. Staging

Gunakan staging terkontrol. Hindari git add . secara buta ketika repository memiliki backup, recovery file, log, atau file lokal lainnya.

## 8. Commit

Commit harus menggambarkan perubahan sebenarnya.

Contoh:

-
eat: untuk fitur;
-
ix: untuk perbaikan;
- security: untuk keamanan;
- docs: untuk dokumentasi;
-
efactor: untuk refactor yang terkontrol.

## 9. Push

Push dilakukan setelah staged diff dinyatakan aman.

## 10. Deployment Verification

Setelah push, verifikasi deployment, fitur yang berubah, console browser, dan fungsi lama yang relevan.

## 11. Prinsip Permanen

### Stability First
Jangan merusak fitur yang sudah solved.

### Security by Design
Perubahan harus mempertimbangkan risiko security sejak awal.

### Big Data Synchronization
Setiap fitur yang menghasilkan data harus memiliki jalur monitoring dan analitik di Big Data.

### Performance by Design
Query, listener, rendering, PDF, dan analitik harus tetap smooth saat traffic dan volume data meningkat.

### Minimal Blast Radius
Hindari perubahan di luar scope pekerjaan.
