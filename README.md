# DA-Amazon_India_analyst

Analisis penjualan Amazon India (31 Mar - 29 Jun 2022, 128.975 baris) plus model Random Forest untuk memprediksi nilai transaksi (`Amount`).

- `DataAnalytics_Fixed.ipynb`: data wrangling, EDA, uji hipotesis (Shapiro-Wilk, OLS, ANOVA + Tukey, Chi-square, A/B Mann-Whitney), model Random Forest + tuning.
- `Amazon Sale Report.csv`: dataset mentah.
- `dashboard/`: dashboard web statis (HTML + Chart.js), siap deploy ke Vercel.

## Dashboard

Tiga tab:

1. **Penjualan**: KPI, pendapatan harian, pendapatan per kategori, tingkat order gagal, unit per ukuran, 10 negara bagian teratas. Bisa difilter per bulan, kategori, fulfilment, dan segmen B2B/B2C.
2. **Harga & uji statistik**: heatmap median harga kategori x ukuran, rentang harga per kategori, ringkasan uji hipotesis.
3. **Model & estimasi**: estimator nilai transaksi interaktif, metrik model, CV per fold, feature importance, aktual vs prediksi.

Estimator tidak butuh backend Python: prediksi model tuned dihitung di muka untuk semua kombinasi input (14.256 kombinasi) dan disimpan di `dashboard/data/dashboard.json`.

### Jalankan lokal

```bash
cd dashboard
python -m http.server 8000
# buka http://localhost:8000
```

### Deploy ke Vercel

`vercel.json` di root sudah mengatur `outputDirectory: dashboard` tanpa build step.

- **Lewat GitHub**: di vercel.com pilih *Add New > Project*, import repo ini, biarkan Framework Preset = *Other*, lalu *Deploy*.
- **Lewat CLI**: `npm i -g vercel` lalu `vercel --prod` dari root repo.

### Update data

Kalau CSV atau model berubah, bangun ulang data dashboard:

```bash
pip install pandas numpy scipy scikit-learn
python dashboard/scripts/build_data.py
```

Script ini mengulang cleaning, uji statistik, dan training model persis seperti notebook (hasil R² baseline 0,5103 dan tuned 0,5054 sama dengan notebook).
