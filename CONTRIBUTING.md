# Contributing to SIPAPUA

## Prinsip Utama

Kontribusi harus fokus pada masalah yang sedang dikerjakan, tidak merusak fitur yang sudah solved, mempertahankan kompatibilitas, mempertimbangkan keamanan, dan memperhatikan performance.

## Sebelum Mengubah Kode

Periksa status repository, diff, struktur file terkait, dan alur data yang terdampak.

## Setelah Mengubah Kode

Minimal lakukan testing, git diff --check, syntax validation bila relevan, dan staged diff audit.

## Commit

Gunakan pesan commit yang jelas dan spesifik.

Contoh:

- feat: add monthly Big Data report
- fix: correct wilayah report filter
- security: harden Firestore authorization
- docs: update architecture documentation

## Jangan

- menggunakan git add . secara buta;
- memasukkan backup atau recovery file;
- memasukkan credential atau secret;
- mengubah modul di luar scope;
- menghapus aset yang masih digunakan;
- melakukan refactor besar tanpa kebutuhan teknis.

## Pull Request

PR harus menjelaskan masalah, perubahan, file terdampak, testing, risiko, dan rollback plan bila diperlukan.
