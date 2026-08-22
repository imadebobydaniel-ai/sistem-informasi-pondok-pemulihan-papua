# Big Data SIPAPUA

## Tujuan

Big Data merupakan pusat monitoring, statistik, dan analitik SIPAPUA.

## Alur Data

`	ext
Input Kegiatan
      |
      v
Firestore
      |
      v
Filter Periode / Wilayah
      |
      v
Normalisasi Data
      |
      +--> Tabel
      +--> Statistik
      +--> Grafik / Trend
      +--> Insight AI
      +--> PDF Report
`

## Prinsip Sinkronisasi

Setiap fitur yang menghasilkan data harus mempunyai jalur monitoring di Big Data.

Contoh alur:

`	ext
Fitur Baru
   -> Data Firestore
   -> Konfigurasi Big Data
   -> Statistik
   -> Insight
   -> Export Report
`

## Reporting

Export PDF harus mengikuti periode dan wilayah yang dipilih administrator.

PDF tidak boleh menampilkan struktur database internal, tipe field, Document ID, metadata internal, atau lampiran field sensitif.

## Insight AI

Insight AI dikembangkan untuk membaca:

- jumlah laporan;
- kehadiran;
- ketidakhadiran;
- persentase;
- wilayah;
- periode;
- trend aktivitas;
- perkembangan historis.

Target jangka panjang:

`	ext
Data
  |
  v
Trend
  |
  v
Anomali
  |
  v
Insight
  |
  v
Rekomendasi
  |
  v
Evaluasi
`

## Performance

Big Data harus menghindari pembacaan seluruh collection ketika dashboard hanya membutuhkan subset berdasarkan periode, wilayah, atau kegiatan.
