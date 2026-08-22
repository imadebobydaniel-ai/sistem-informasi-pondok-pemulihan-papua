# Operations Guide

## Prinsip Performance

SIPAPUA harus tetap smooth ketika traffic dan jumlah data meningkat.

Prioritas operasional:

- query Firestore harus terfilter;
- listener realtime hanya digunakan bila diperlukan;
- unsubscribe listener yang tidak lagi digunakan;
- hindari query berulang;
- minimalkan rendering ulang;
- batasi jumlah data yang diproses browser;
- gunakan pagination atau aggregation untuk dataset besar.

## Big Data

Big Data tidak boleh membaca seluruh collection ketika kebutuhan hanya mencakup periode, wilayah, atau kegiatan tertentu.

## PDF Reporting

Export PDF harus menggunakan data yang sudah difilter dan tidak boleh membocorkan struktur database internal.

## Monitoring

Perubahan besar harus diperiksa melalui:

- browser console;
- network request;
- penggunaan query Firebase;
- grafik;
- export PDF;
- tampilan mobile bila relevan.

## Stability

Jangan melakukan refactor besar pada modul yang sudah stabil hanya untuk menyelesaikan pekerjaan yang lebih kecil.
