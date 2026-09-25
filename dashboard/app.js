/* Amazon India Sales Dashboard: static, reads data/dashboard.json (built by scripts/build_data.py). */
(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const nf = new Intl.NumberFormat("id-ID");
  const nf1 = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 });
  const nf4 = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 4 });
  const compact = new Intl.NumberFormat("id-ID", { notation: "compact", maximumFractionDigits: 1 });
  const inr = (v) => "₹" + nf.format(Math.round(v));
  const inrCompact = (v) => "₹" + compact.format(v);
  const pct = (v, d = 1) => new Intl.NumberFormat("id-ID", { maximumFractionDigits: d, minimumFractionDigits: d }).format(v * 100) + "%";
  const pval = (p) => (p < 0.0001 ? "< 0,0001" : new Intl.NumberFormat("id-ID", { maximumSignificantDigits: 3 }).format(p));
  const MONTH_ID = { 3: "Maret", 4: "April", 5: "Mei", 6: "Juni" };
  const SHORT_MONTH = ["", "Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
  const fmtDate = (s) => `${+s.slice(8, 10)} ${SHORT_MONTH[+s.slice(5, 7)]}`;
  const titleCase = (s) => s.toLowerCase().replace(/(^|[\s&])([a-z])/g, (m, a, b) => a + b.toUpperCase());

  let D = null;
  const charts = {};
  const tables = {}; // chart id -> () => {head, rows}

  // ── Theme ────────────────────────────────────────────────────────────────
  const root = document.documentElement;
  try { const t = localStorage.getItem("theme"); if (t) root.dataset.theme = t; } catch (e) { /* storage unavailable */ }
  $("#themeBtn").addEventListener("click", () => {
    const dark = getComputedStyle(root).colorScheme === "dark";
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("theme", root.dataset.theme); } catch (e) { /* ignore */ }
    renderAll();
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => renderAll());
  const tok = (name) => getComputedStyle(root).getPropertyValue(name).trim();

  // ── Tabs ─────────────────────────────────────────────────────────────────
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", String(b === btn)));
      document.querySelectorAll(".panel").forEach((p) => { p.hidden = p.id !== "tab-" + btn.dataset.tab; });
      try { sessionStorage.setItem("tab", btn.dataset.tab); } catch (e) { /* ignore */ }
      // Charts drawn inside a hidden panel have zero size; redraw once visible.
      renderAll();
    });
  });

  // ── Chart.js defaults & helpers ──────────────────────────────────────────
  const crosshair = {
    id: "crosshair",
    afterDraw(chart) {
      const a = chart.tooltip && chart.tooltip.getActiveElements();
      if (!chart.options.plugins.crosshair || !a || !a.length) return;
      const x = a[0].element.x, { top, bottom } = chart.chartArea, ctx = chart.ctx;
      ctx.save(); ctx.strokeStyle = tok("--axis"); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke(); ctx.restore();
    },
  };

  function baseOptions({ horizontal = false, money = true, legend = false, pctAxis = false } = {}) {
    const ink2 = tok("--ink-2"), muted = tok("--muted"), grid = tok("--grid"), axis = tok("--axis");
    const tickFmt = (v) => (pctAxis ? pct(v, 0) : money ? inrCompact(v) : compact.format(v));
    const valueAxis = { beginAtZero: true, grid: { color: grid, drawTicks: false }, border: { display: false },
      ticks: { color: muted, padding: 6, callback: tickFmt, font: { size: 11 } } };
    const catAxis = { grid: { display: false }, border: { color: axis }, ticks: { color: ink2, font: { size: 11 }, autoSkip: true, maxRotation: 0 } };
    return {
      responsive: true, maintainAspectRatio: false, animation: false,
      indexAxis: horizontal ? "y" : "x",
      scales: horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis },
      plugins: {
        legend: { display: legend, position: "top", align: "start",
          labels: { color: ink2, boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 2, font: { size: 12 } } },
        tooltip: {
          backgroundColor: tok("--surface"), titleColor: ink2, bodyColor: tok("--ink"), borderColor: tok("--border"), borderWidth: 1,
          padding: 10, titleFont: { weight: "normal", size: 12 }, bodyFont: { weight: "600", size: 13 }, boxWidth: 10, boxHeight: 2, usePointStyle: false,
        },
      },
    };
  }

  const barStyle = (color) => ({ backgroundColor: color, hoverBackgroundColor: color + "cc", borderRadius: 4, borderSkipped: "start", maxBarThickness: 24, categoryPercentage: 0.8, barPercentage: 0.9 });

  function draw(id, config) {
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart(document.getElementById(id), config);
  }

  function renderTable(el, { head, rows }) {
    const table = document.createElement("table");
    const thead = table.createTHead().insertRow();
    head.forEach((h) => { const th = document.createElement("th"); th.textContent = h; thead.appendChild(th); });
    const tb = table.createTBody();
    rows.forEach((r) => { const tr = tb.insertRow(); r.forEach((c) => { tr.insertCell().textContent = c; }); });
    el.replaceChildren(table);
  }
  function refreshTables() {
    document.querySelectorAll("details.tbl").forEach((d) => {
      if (d.open && tables[d.dataset.for]) renderTable(d.querySelector("div"), tables[d.dataset.for]());
    });
  }
  document.querySelectorAll("details.tbl").forEach((d) => d.addEventListener("toggle", refreshTables));

  // ── Filters & aggregation over the cube ──────────────────────────────────
  const F = { month: "all", category: "all", fulfilment: "all", b2b: "all" };

  function aggregate() {
    const c = D.cube, dm = D.dims;
    const iCat = F.category === "all" ? -1 : dm.category.indexOf(F.category);
    const iFul = F.fulfilment === "all" ? -1 : dm.fulfilment.indexOf(F.fulfilment);
    const b2b = F.b2b === "all" ? -1 : +F.b2b;
    const monthOf = dm.date.map((d) => +d.slice(5, 7));
    const byDate = new Map(), byCat = {}, bySize = {}, failCat = {};
    let rev = 0, orders = 0, units = 0, failed = 0;
    for (let i = 0; i < c.n.length; i++) {
      if (F.month !== "all" && monthOf[c.date[i]] !== +F.month) continue;
      if (iCat >= 0 && c.category[i] !== iCat) continue;
      if (iFul >= 0 && c.fulfilment[i] !== iFul) continue;
      if (b2b >= 0 && c.b2b[i] !== b2b) continue;
      const cat = dm.category[c.category[i]];
      failCat[cat] = failCat[cat] || { ok: 0, failed: 0 };
      if (c.outcome[i] === 1) { failed += c.n[i]; failCat[cat].failed += c.n[i]; continue; }
      failCat[cat].ok += c.n[i];
      rev += c.amt[i]; orders += c.n[i]; units += c.qty[i];
      byDate.set(c.date[i], (byDate.get(c.date[i]) || 0) + c.amt[i]);
      byCat[cat] = byCat[cat] || { amt: 0, n: 0 };
      byCat[cat].amt += c.amt[i]; byCat[cat].n += c.n[i];
      const sz = dm.size[c.size[i]];
      bySize[sz] = (bySize[sz] || 0) + c.qty[i];
    }
    const s = D.stateCube, byState = {};
    for (let i = 0; i < s.n.length; i++) {
      if (s.outcome[i] !== 0) continue;
      if (F.month !== "all" && s.month[i] !== +F.month) continue;
      if (iCat >= 0 && s.category[i] !== iCat) continue;
      if (iFul >= 0 && s.fulfilment[i] !== iFul) continue;
      if (b2b >= 0 && s.b2b[i] !== b2b) continue;
      const st = dm.state[s.state[i]];
      byState[st] = byState[st] || { amt: 0, n: 0 };
      byState[st].amt += s.amt[i]; byState[st].n += s.n[i];
    }
    return { rev, orders, units, failed, byDate, byCat, bySize, failCat, byState };
  }

  function renderSales() {
    const A = aggregate();
    const s1 = tok("--series-1");
    $("#kRevenue").textContent = inrCompact(A.rev);
    $("#kRevenue").title = inr(A.rev);
    $("#kOrders").textContent = nf.format(A.orders);
    $("#kAov").textContent = A.orders ? inr(A.rev / A.orders) : "-";
    $("#kUnits").textContent = nf.format(A.units);
    const tot = A.orders + A.failed;
    $("#kFail").textContent = tot ? pct(A.failed / tot) : "-";
    $("#kFailN").textContent = `${nf.format(A.failed)} dari ${nf.format(tot)} order`;

    // Daily revenue
    const dates = [...A.byDate.keys()].sort((a, b) => a - b);
    const labels = dates.map((i) => D.dims.date[i]);
    const vals = dates.map((i) => A.byDate.get(i));
    const opt = baseOptions();
    opt.plugins.crosshair = true;
    opt.interaction = { mode: "index", intersect: false };
    opt.scales.x.ticks.callback = function (v) { return fmtDate(labels[v]); };
    opt.scales.x.ticks.maxTicksLimit = window.innerWidth < 640 ? 4 : 8;
    opt.plugins.tooltip.callbacks = { title: (it) => fmtDate(labels[it[0].dataIndex]) + " 2022", label: (it) => " " + inr(it.raw) };
    draw("cDaily", {
      type: "line", plugins: [crosshair],
      data: { labels, datasets: [{ label: "Pendapatan", data: vals, borderColor: s1, backgroundColor: tok("--accent-wash"), fill: true,
        borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, pointHoverBorderWidth: 2, pointHoverBorderColor: tok("--surface"), pointHoverBackgroundColor: s1, tension: 0.25 }] },
      options: opt,
    });
    tables.cDaily = () => ({ head: ["Tanggal", "Pendapatan (INR)"], rows: labels.map((d, i) => [d, nf.format(vals[i])]) });

    // Category revenue
    const cats = Object.entries(A.byCat).sort((a, b) => b[1].amt - a[1].amt);
    const co = baseOptions({ horizontal: true });
    co.plugins.tooltip.callbacks = { label: (it) => " " + inr(it.raw) + " · " + nf.format(cats[it.dataIndex][1].n) + " order" };
    draw("cCategory", { type: "bar", data: { labels: cats.map((c) => c[0]), datasets: [{ data: cats.map((c) => c[1].amt), ...barStyle(s1) }] }, options: co });
    tables.cCategory = () => ({ head: ["Kategori", "Pendapatan (INR)", "Order", "Rata-rata (INR)"],
      rows: cats.map(([k, v]) => [k, nf.format(v.amt), nf.format(v.n), nf.format(Math.round(v.amt / v.n))]) });

    // Failure rate by category (only categories with >= 30 orders to avoid noisy ratios)
    const fc = Object.entries(A.failCat).map(([k, v]) => [k, v.failed / (v.ok + v.failed), v.ok + v.failed, v.failed])
      .filter((r) => r[2] >= 30).sort((a, b) => b[1] - a[1]);
    const fo = baseOptions({ horizontal: true, pctAxis: true });
    fo.plugins.tooltip.callbacks = { label: (it) => " " + pct(it.raw) + " · " + nf.format(fc[it.dataIndex][3]) + " dari " + nf.format(fc[it.dataIndex][2]) + " order" };
    draw("cFailCat", { type: "bar", data: { labels: fc.map((r) => r[0]), datasets: [{ data: fc.map((r) => r[1]), ...barStyle(s1) }] }, options: fo });
    tables.cFailCat = () => ({ head: ["Kategori", "Tingkat gagal", "Order gagal", "Total order"], rows: fc.map((r) => [r[0], pct(r[1]), nf.format(r[3]), nf.format(r[2])]) });

    // Size
    const sizes = D.dims.size.filter((s) => A.bySize[s]);
    const so = baseOptions({ money: false });
    so.plugins.tooltip.callbacks = { label: (it) => " " + nf.format(it.raw) + " unit" };
    draw("cSize", { type: "bar", data: { labels: sizes, datasets: [{ data: sizes.map((s) => A.bySize[s]), ...barStyle(s1) }] }, options: so });
    tables.cSize = () => ({ head: ["Ukuran", "Unit"], rows: sizes.map((s) => [s, nf.format(A.bySize[s])]) });

    // States
    const st = Object.entries(A.byState).filter(([k]) => k !== "UNKNOWN").sort((a, b) => b[1].amt - a[1].amt);
    const top = st.slice(0, 10);
    const sto = baseOptions({ horizontal: true });
    sto.plugins.tooltip.callbacks = { label: (it) => " " + inr(it.raw) + " · " + nf.format(top[it.dataIndex][1].n) + " order" };
    draw("cState", { type: "bar", data: { labels: top.map((r) => titleCase(r[0])), datasets: [{ data: top.map((r) => r[1].amt), ...barStyle(s1) }] }, options: sto });
    tables.cState = () => ({ head: ["Negara bagian", "Pendapatan (INR)", "Order"], rows: st.map(([k, v]) => [titleCase(k), nf.format(v.amt), nf.format(v.n)]) });

    refreshTables();
  }

  function initFilters() {
    const sel = $("#fCategory");
    D.dims.category.forEach((c) => { const o = document.createElement("option"); o.value = c; o.textContent = c; sel.appendChild(o); });
    const bind = (id, key) => $(id).addEventListener("change", (e) => { F[key] = e.target.value; renderSales(); });
    bind("#fMonth", "month"); bind("#fCategory", "category"); bind("#fFulfil", "fulfilment"); bind("#fB2B", "b2b");
    $("#fReset").addEventListener("click", () => {
      Object.keys(F).forEach((k) => { F[k] = "all"; });
      ["#fMonth", "#fCategory", "#fFulfil", "#fB2B"].forEach((id) => { $(id).value = "all"; });
      renderSales();
    });
  }

  // ── Price & tests ────────────────────────────────────────────────────────
  function lum(hex) {
    const n = parseInt(hex.slice(1), 16), c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function lerpColor(ramp, t) {
    const pos = t * (ramp.length - 1), i = Math.min(Math.floor(pos), ramp.length - 2), f = pos - i;
    const a = parseInt(ramp[i].slice(1), 16), b = parseInt(ramp[i + 1].slice(1), 16);
    const ch = (sh) => Math.round(((a >> sh) & 255) * (1 - f) + ((b >> sh) & 255) * f);
    return "#" + [16, 8, 0].map((sh) => ch(sh).toString(16).padStart(2, "0")).join("");
  }

  const tip = $("#tooltip");
  function showTip(e, title, value) {
    const s = document.createElement("strong"); s.textContent = value;
    const t = document.createElement("span"); t.textContent = title;
    tip.replaceChildren(s, t); tip.hidden = false;
    const r = e.target.getBoundingClientRect();
    tip.style.left = Math.min(window.innerWidth - tip.offsetWidth - 8, r.left + r.width / 2 - tip.offsetWidth / 2) + "px";
    tip.style.top = Math.max(8, r.top - tip.offsetHeight - 6) + "px";
  }

  function renderHeatmap() {
    const H = D.heatmap, el = $("#heatmap");
    const ramp = tok("--seq").split(",").map((s) => s.trim());
    const all = H.values.flat().filter((v) => v != null);
    const lo = Math.min(...all), hi = Math.max(...all);
    el.style.gridTemplateColumns = `auto repeat(${H.cols.length}, minmax(46px, 1fr))`;
    const nodes = [document.createElement("div")];
    H.cols.forEach((c) => { const d = document.createElement("div"); d.className = "hh"; d.textContent = c; nodes.push(d); });
    H.rows.forEach((r, i) => {
      const rl = document.createElement("div"); rl.className = "hr"; rl.textContent = r; nodes.push(rl);
      H.cols.forEach((c, j) => {
        const v = H.values[i][j], d = document.createElement("div");
        d.className = "hc"; d.tabIndex = 0;
        if (v == null) { d.classList.add("empty"); d.textContent = "·"; }
        else {
          const bg = lerpColor(ramp, (v - lo) / (hi - lo || 1));
          d.style.background = bg; d.style.color = lum(bg) > 0.35 ? "#0b0b0b" : "#ffffff";
          d.textContent = nf.format(v);
        }
        const label = `${r} · ${c} · ${nf.format(H.counts[i][j])} transaksi`;
        const val = v == null ? "Tidak ada data" : inr(v) + " median";
        d.setAttribute("aria-label", `${label}: ${val}`);
        d.addEventListener("pointerenter", (e) => showTip(e, label, val));
        d.addEventListener("focus", (e) => showTip(e, label, val));
        d.addEventListener("pointerleave", () => { tip.hidden = true; });
        d.addEventListener("blur", () => { tip.hidden = true; });
        nodes.push(d);
      });
    });
    el.replaceChildren(...nodes);
    $("#hMin").textContent = inr(lo); $("#hMax").textContent = inr(hi);
  }

  function renderBox() {
    const B = D.box, s1 = tok("--series-1");
    const o = baseOptions({ horizontal: true });
    o.scales.x.beginAtZero = false;
    o.plugins.tooltip.callbacks = {
      label: (it) => {
        const b = B[it.dataIndex];
        return [` Median ${inr(b.median)}`, ` Q1-Q3 ${inr(b.q1)} - ${inr(b.q3)}`, ` P5-P95 ${inr(b.p5)} - ${inr(b.p95)}`, ` ${nf.format(b.n)} transaksi`];
      },
    };
    o.plugins.tooltip.filter = (it) => it.datasetIndex === 1;
    draw("cBox", {
      type: "bar",
      data: {
        labels: B.map((b) => b.category),
        datasets: [
          { label: "P5-P95", data: B.map((b) => [b.p5, b.p95]), backgroundColor: tok("--axis"), maxBarThickness: 2, borderSkipped: false, grouped: false },
          { label: "Q1-Q3", data: B.map((b) => [b.q1, b.q3]), backgroundColor: s1 + "55", hoverBackgroundColor: s1 + "77", borderRadius: 4, borderSkipped: false, maxBarThickness: 20, grouped: false },
          { type: "scatter", label: "Median", data: B.map((b, i) => ({ x: b.median, y: b.category })), backgroundColor: s1, borderColor: tok("--surface"), borderWidth: 2, pointRadius: 5, pointHoverRadius: 6 },
        ],
      },
      options: o,
    });
    tables.cBox = () => ({ head: ["Kategori", "n", "P5", "Q1", "Median", "Q3", "P95", "Mean"],
      rows: B.map((b) => [b.category, nf.format(b.n), nf.format(b.p5), nf.format(b.q1), nf.format(b.median), nf.format(b.q3), nf.format(b.p95), nf1.format(b.mean)]) });
  }

  function testCard({ title, question, rows, sig, take }) {
    const card = document.createElement("article"); card.className = "card test";
    const h = document.createElement("h3"); h.textContent = title;
    const q = document.createElement("p"); q.className = "q"; q.textContent = question;
    const dl = document.createElement("dl");
    rows.forEach(([k, v]) => { const dt = document.createElement("dt"); dt.textContent = k; const dd = document.createElement("dd"); dd.textContent = v; dl.append(dt, dd); });
    const b = document.createElement("span"); b.className = "badge " + (sig ? "sig" : "nsig"); b.textContent = sig ? "Signifikan (p < 0,05)" : "Tidak signifikan";
    const p = document.createElement("p"); p.className = "take"; p.textContent = take;
    card.append(h, q, dl, b, p);
    return card;
  }

  function renderTests() {
    const T = D.tests, amt = T.ab[0], qty = T.ab[1];
    const ps = T.promoShareByFulfilment;
    const cards = [
      testCard({ title: "Normalitas (Shapiro-Wilk)", question: "Apakah Amount berdistribusi normal?",
        rows: [["W tanpa promo", nf4.format(T.shapiro.wA)], ["W dengan promo", nf4.format(T.shapiro.wB)], ["p-value", pval(Math.max(T.shapiro.pA, T.shapiro.pB))], ["Sampel per grup", nf.format(T.shapiro.n)]],
        sig: T.shapiro.pA < 0.05, take: "Keduanya tidak normal, jadi uji non-parametrik (Mann-Whitney U) lebih tepat daripada t-test." }),
      testCard({ title: "One-way ANOVA", question: "Apakah rata-rata Amount berbeda antar kategori?",
        rows: [["F", nf1.format(T.anova.f)], ["p-value", pval(T.anova.p)], ["Eta² (effect size)", nf.format(T.anova.etaSq)]],
        sig: T.anova.p < 0.05, take: `Kategori menjelaskan sekitar ${pct(T.anova.etaSq, 0)} variasi Amount. Ini juga batas atas kasar untuk model yang hanya tahu kategori.` }),
      testCard({ title: "Chi-square: B2B vs promo", question: "Apakah segmen B2B/B2C berhubungan dengan pemakaian promo?",
        rows: [["χ²", nf1.format(T.chi2.chi2)], ["p-value", pval(T.chi2.p)], ["Cramér's V", new Intl.NumberFormat("id-ID", { maximumFractionDigits: 4 }).format(T.chi2.cramersV)]],
        sig: T.chi2.p < 0.05, take: "Signifikan secara statistik, tapi Cramér's V < 0,01 artinya hubungannya praktis tidak ada. Sampel besar membuat efek kecil pun jadi signifikan." }),
      testCard({ title: "A/B: promo vs Amount", question: "Apakah order dengan promotion-id punya Amount lebih tinggi?",
        rows: [["Rata-rata tanpa promo", inr(amt.meanA)], ["Rata-rata dengan promo", inr(amt.meanB)], ["Mann-Whitney p", pval(amt.pMWU)], ["Cohen's d", nf.format(Math.abs(amt.d))]],
        sig: amt.pMWU < 0.05,
        take: `Selisih +${inr(amt.meanB - amt.meanA)} (efek kecil). Hati-hati: ini data observasi, bukan eksperimen acak. Promo muncul di ${pct(ps.Merchant, 0)} order Merchant vs ${pct(ps.Amazon, 0)} order Amazon, dan sebagian besar promotion-id adalah penawaran cicilan ("PLCC Free-Financing"), bukan potongan harga.` }),
      testCard({ title: "A/B: promo vs Qty", question: "Apakah promo menaikkan jumlah item per order?",
        rows: [["Rata-rata tanpa promo", new Intl.NumberFormat("id-ID", { maximumFractionDigits: 4 }).format(qty.meanA)], ["Rata-rata dengan promo", new Intl.NumberFormat("id-ID", { maximumFractionDigits: 4 }).format(qty.meanB)], ["Mann-Whitney p", pval(qty.pMWU)], ["Cohen's d", nf.format(Math.abs(qty.d))]],
        sig: qty.pMWU < 0.05, take: "Hampir semua order berisi 1 item. Selisih 0,003 item tidak bermakna secara bisnis." }),
    ];
    $("#tests").replaceChildren(...cards);
  }

  // ── Model ────────────────────────────────────────────────────────────────
  function renderModelStatic() {
    const M = D.model, s1 = tok("--series-1"), s2 = tok("--series-2");
    const rows = [
      ["Baseline RF (100 trees)", M.baseline],
      ["Tuned RF (dipakai di dashboard)", M.tuned],
      ["Eksperimen: + fitur Style", M.withStyle],
    ];
    renderTable($("#metricTable"), { head: ["Model", "R²", "MAE", "RMSE", "MAPE"],
      rows: rows.map(([n, m]) => [n, nf.format(m.r2), inr(m.mae), inr(m.rmse), nf1.format(m.mape) + "%"]) });

    const v = $("#verdict");
    const strong = document.createElement("strong"); strong.textContent = "Kesimpulan evaluasi: ";
    const intro = document.createTextNode(`model sudah benar secara metodologi, tapi performanya sedang (R² ${nf.format(M.tuned.r2)}, rata-rata meleset ${inr(M.tuned.mae)} atau sekitar ${nf1.format(M.tuned.mape)}%).`);
    const ul = document.createElement("ul");
    [
      `Tuning tidak membantu: R² test turun dari ${nf.format(M.baseline.r2)} ke ${nf.format(M.tuned.r2)} walau CV naik 0,002. Baseline lebih ringan dan sama akuratnya.`,
      "Batasnya ada di fitur, bukan algoritma. Harga ditentukan oleh produk (Style/SKU), yang di-drop di notebook.",
      `Dengan Style (target encoding, fit di train saja) R² naik ke ${nf.format(M.withStyle.r2)} dan MAE turun ke ${inr(M.withStyle.mae)}.`,
      "Data hanya April-Juni 2022, jadi encoding bulan siklis tidak bisa dipakai untuk bulan lain.",
    ].forEach((t) => { const li = document.createElement("li"); li.textContent = t; ul.appendChild(li); });
    v.replaceChildren(strong, intro, ul);

    // CV per fold (two series: legend on)
    const folds = M.baseline.cv.map((_, i) => "Fold " + (i + 1));
    const co = baseOptions({ money: false, legend: true });
    co.scales.y.beginAtZero = false; co.scales.y.min = 0.45; co.scales.y.max = 0.55;
    co.scales.y.ticks.callback = (x) => nf.format(x);
    co.plugins.tooltip.callbacks = { label: (it) => ` ${it.dataset.label}: ${nf.format(it.raw)}` };
    co.interaction = { mode: "index", intersect: false };
    draw("cCV", { type: "bar", data: { labels: folds, datasets: [
      { label: "Baseline", data: M.baseline.cv, ...barStyle(s1), borderSkipped: false },
      { label: "Tuned", data: M.tuned.cv, ...barStyle(s2), borderSkipped: false },
    ] }, options: co });
    tables.cCV = () => ({ head: ["Fold", "Baseline R²", "Tuned R²"], rows: folds.map((f, i) => [f, nf.format(M.baseline.cv[i]), nf.format(M.tuned.cv[i])]) });

    // Importance
    const imp = M.importance;
    const io = baseOptions({ horizontal: true, pctAxis: true });
    io.plugins.tooltip.callbacks = { label: (it) => " " + pct(it.raw) };
    draw("cImp", { type: "bar", data: { labels: imp.map((d) => d.feature), datasets: [{ data: imp.map((d) => d.value), ...barStyle(s1) }] }, options: io });
    tables.cImp = () => ({ head: ["Fitur", "Importance"], rows: imp.map((d) => [d.feature, pct(d.value, 2)]) });

    // Residuals
    const R = M.residuals;
    const ro = baseOptions({ legend: true });
    ro.interaction = { mode: "index", intersect: false };
    ro.plugins.tooltip.callbacks = { title: (it) => `Aktual ${R[it[0].dataIndex].bucket} INR · ${nf.format(R[it[0].dataIndex].n)} order`, label: (it) => ` ${it.dataset.label}: ${inr(it.raw)}` };
    draw("cResid", { type: "bar", data: { labels: R.map((r) => r.bucket), datasets: [
      { label: "Aktual", data: R.map((r) => r.actual), ...barStyle(s1) },
      { label: "Prediksi", data: R.map((r) => r.pred), ...barStyle(s2) },
    ] }, options: ro });
    tables.cResid = () => ({ head: ["Rentang aktual (INR)", "Order", "Rata-rata aktual", "Rata-rata prediksi", "MAE"],
      rows: R.map((r) => [r.bucket, nf.format(r.n), nf.format(r.actual), nf.format(r.pred), nf.format(r.mae)]) });
  }

  function initEstimator() {
    const P = D.prediction, dims = P.dims;
    const fields = [
      ["category", "Kategori", (v) => v],
      ["size", "Ukuran", (v) => v],
      ["fulfilment", "Fulfilment", (v) => (v === "Amazon" ? "Amazon (FBA)" : "Merchant (Easy Ship)")],
      ["service", "Layanan kirim", (v) => v],
      ["qty", "Jumlah item", (v) => String(v)],
      ["month", "Bulan", (v) => MONTH_ID[v]],
      ["discounted", "Ada promotion-id", (v) => (v ? "Ya" : "Tidak")],
      ["b2b", "Segmen", (v) => (v ? "B2B" : "B2C")],
    ];
    const defaults = { category: "kurta", size: "M", fulfilment: "Amazon", service: "Expedited", qty: 1, month: 5, discounted: 1, b2b: 0 };
    const form = $("#estForm");
    fields.forEach(([key, label, fmt]) => {
      const l = document.createElement("label"); l.textContent = label;
      const s = document.createElement("select"); s.name = key;
      dims[key].forEach((v, i) => { const o = document.createElement("option"); o.value = i; o.textContent = fmt(v); if (v === defaults[key]) o.selected = true; s.appendChild(o); });
      l.appendChild(s); form.appendChild(l);
    });
    const order = Object.keys(dims);
    const update = () => {
      const pick = {}; fields.forEach(([k]) => { pick[k] = +form.elements[k].value; });
      pick.channel = 0;
      let idx = 0; order.forEach((k) => { idx = idx * dims[k].length + pick[k]; });
      const val = P.values[idx], mae = D.model.tuned.mae;
      $("#estValue").textContent = inr(val);
      $("#estRange").textContent = `Rentang wajar sekitar ${inr(Math.max(0, val - mae))} sampai ${inr(val + mae)} (± MAE ${inr(mae)})`;
      const cat = dims.category[pick.category], size = dims.size[pick.size];
      const n = P.support[cat + "|" + size] || 0;
      const w = $("#estWarn");
      if (n < 50) {
        w.hidden = false;
        w.textContent = n === 0
          ? `Tidak ada transaksi ${cat} ukuran ${size} di data latih. Prediksi ini ekstrapolasi, jangan terlalu dipercaya.`
          : `Hanya ${nf.format(n)} transaksi ${cat} ukuran ${size} di data. Prediksi kurang stabil.`;
      } else w.hidden = true;
    };
    form.addEventListener("change", update);
    update();
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  function renderAll() {
    if (!D) return;
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    renderSales(); renderHeatmap(); renderBox(); renderModelStatic();
  }

  fetch("data/dashboard.json")
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((data) => {
      D = data;
      const m = D.meta;
      $("#period").textContent = `${fmtDate(m.dateMin)} ${m.dateMin.slice(0, 4)} sampai ${fmtDate(m.dateMax)} ${m.dateMax.slice(0, 4)} · ${nf.format(m.rowsRaw)} baris data mentah`;
      $("#nClean").textContent = nf.format(m.rowsClean);
      initFilters(); initEstimator(); renderTests(); renderAll();
      let t = null; try { t = sessionStorage.getItem("tab"); } catch (e) { /* ignore */ }
      if (t) { const b = document.querySelector(`.tab[data-tab="${t}"]`); if (b) b.click(); }
    })
    .catch((err) => { $("#period").textContent = "Gagal memuat data (" + err.message + "). Jalankan scripts/build_data.py lalu buka lewat server."; });
})();
