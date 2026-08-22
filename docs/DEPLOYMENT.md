# Deployment SIPAPUA

## Branch Utama

Branch utama repository adalah main.

## Alur Deployment

`	ext
Local Development
      |
      v
Testing
      |
      v
Diff Audit
      |
      v
Commit
      |
      v
Push
      |
      v
Deployment Verification
`

## Pre-Deployment Checklist

- fitur yang berubah sudah diuji;
- git diff --check bersih;
- staged diff sudah diaudit;
- tidak ada credential atau backup ikut commit;
- source code tidak mengalami perubahan di luar scope.

## Post-Deployment Verification

Setelah push:

1. periksa branch remote;
2. periksa pipeline/deployment bila tersedia;
3. buka aplikasi;
4. uji fitur yang berubah;
5. periksa browser console;
6. pastikan fitur lama tetap berjalan.

## Rollback

Gunakan commit yang diketahui stabil sebagai titik rollback. Jangan menghapus history production tanpa kebutuhan teknis dan prosedur yang jelas.
