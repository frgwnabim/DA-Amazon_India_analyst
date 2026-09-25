"""
Build dashboard/data/dashboard.json from "Amazon Sale Report.csv".

Replicates the cleaning, statistical tests and Random Forest model from
DataAnalytics_Fixed.ipynb, then exports compact aggregates plus a precomputed
prediction grid so the dashboard can run as a static site (no Python backend).

Usage (from repo root):
    pip install pandas numpy scipy scikit-learn
    python dashboard/scripts/build_data.py
"""
import json
import time
from pathlib import Path

import numpy as np
import pandas as pd
import scipy.stats as stats
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import KFold, cross_val_score, train_test_split
from sklearn.preprocessing import LabelEncoder, TargetEncoder

ROOT = Path(__file__).resolve().parents[2]
CSV = ROOT / "Amazon Sale Report.csv"
OUT = ROOT / "dashboard" / "data" / "dashboard.json"

SIZE_ORDER = ["XS", "S", "M", "L", "XL", "XXL", "3XL", "4XL", "5XL", "6XL", "Free"]
SERVICE_MAP = {"Standard": 0, "Expedited": 1}
MONTHS = {4: "April", 5: "May", 6: "June"}
STATE_FIX = {
    "NEW DELHI": "DELHI", "RAJSHTHAN": "RAJASTHAN", "RAJSTHAN": "RAJASTHAN", "RJ": "RAJASTHAN",
    "ORISSA": "ODISHA", "PB": "PUNJAB", "PUNJAB/MOHALI/ZIRAKPUR": "PUNJAB", "NL": "NAGALAND",
    "AR": "ARUNACHAL PRADESH", "PONDICHERRY": "PUDUCHERRY", "APO": "UNKNOWN",
}
# Best params from the notebook's RandomizedSearchCV + GridSearchCV (CV R² 0.5019)
TUNED_PARAMS = dict(n_estimators=500, max_depth=None, max_features=0.5,
                    min_samples_leaf=2, min_samples_split=20, bootstrap=False)


def r(x, n=4):
    return None if x is None or (isinstance(x, float) and np.isnan(x)) else round(float(x), n)


def metrics(y_true, y_pred):
    return {
        "r2": r(r2_score(y_true, y_pred)),
        "mae": r(mean_absolute_error(y_true, y_pred), 2),
        "rmse": r(np.sqrt(mean_squared_error(y_true, y_pred)), 2),
        "mape": r(np.mean(np.abs((y_true - y_pred) / y_true)) * 100, 2),
    }


t0 = time.time()
df = pd.read_csv(CSV, low_memory=False)
df["Date"] = pd.to_datetime(df["Date"], format="%m-%d-%y")
df["MonthNum"] = df["Date"].dt.month
df["Month"] = df["Date"].dt.month_name()

# ── Split failed vs shipped (same rules as the notebook) ─────────────────────
status_cond = df["Status"].isin([
    "Cancelled", "Shipped - Lost in Transit", "Shipped - Rejected by Buyer",
    "Shipped - Returned to Seller", "Shipped - Returning to Seller",
])
courier_cond = (df["Courier Status"] == "Cancelled") | df["Courier Status"].isna()
unshipped_cond = df["Status"].isin(["Shipped", "Shipping"]) & (df["Courier Status"] == "Unshipped")
failed_mask = status_cond | courier_cond | unshipped_cond
df_failed = df[failed_mask].copy()
df_model = df[~failed_mask].copy()

df_model["Discounted"] = np.where(df_model["promotion-ids"].notna() & (df_model["promotion-ids"] != ""), 1, 0)
df_model["fulfilled-by"] = df_model["fulfilled-by"].fillna("other")
df_model = df_model.dropna(subset=["Amount", "Courier Status"])
df_model = df_model[df_model["Amount"] > 0]

# ── Cubes for the filterable overview ────────────────────────────────────────
df_model["outcome"] = "ok"
df_failed["outcome"] = "failed"
both = pd.concat([df_model, df_failed], ignore_index=True)
both = both[both["MonthNum"].isin([3, 4, 5, 6])]
both["state"] = (both["ship-state"].fillna("UNKNOWN").str.upper().str.strip()
                 .replace(STATE_FIX))
both["Amount"] = both["Amount"].fillna(0)
both["B2B"] = both["B2B"].astype(int)
both["dateStr"] = both["Date"].dt.strftime("%Y-%m-%d")

dims = {
    "date": sorted(both["dateStr"].unique()),
    "category": sorted(both["Category"].unique()),
    "fulfilment": sorted(both["Fulfilment"].unique()),
    "size": [s for s in SIZE_ORDER if s in set(both["Size"])],
    "state": sorted(both["state"].unique()),
    "outcome": ["ok", "failed"],
}
idx = {k: {v: i for i, v in enumerate(vals)} for k, vals in dims.items()}


def cube(cols, key_map):
    g = both.groupby(cols, observed=True).agg(n=("Amount", "size"), qty=("Qty", "sum"), amt=("Amount", "sum")).reset_index()
    out = {}
    for c in cols:
        name = key_map[c]
        out[name] = [idx[name][v] for v in g[c]] if name in idx else g[c].astype(int).tolist()
    out["n"] = g["n"].astype(int).tolist()
    out["qty"] = g["qty"].astype(int).tolist()
    out["amt"] = g["amt"].round(0).astype(int).tolist()
    return out


main_cube = cube(["dateStr", "Category", "Fulfilment", "B2B", "Size", "outcome"],
                 {"dateStr": "date", "Category": "category", "Fulfilment": "fulfilment",
                  "B2B": "b2b", "Size": "size", "outcome": "outcome"})
state_cube = cube(["MonthNum", "Category", "Fulfilment", "B2B", "state", "outcome"],
                  {"MonthNum": "month", "Category": "category", "Fulfilment": "fulfilment",
                   "B2B": "b2b", "state": "state", "outcome": "outcome"})
failed_status = df_failed["Status"].value_counts().to_dict()

# ── Static EDA pieces (whole cleaned dataset) ────────────────────────────────
pivot = df_model.pivot_table(index="Category", columns="Size", values="Amount", aggfunc="median")
pivot = pivot.reindex(columns=[s for s in SIZE_ORDER if s in pivot.columns])
heatmap = {
    "rows": pivot.index.tolist(),
    "cols": pivot.columns.tolist(),
    "values": [[r(v, 0) for v in row] for row in pivot.values],
    "counts": [[int(df_model[(df_model.Category == c) & (df_model.Size == s)].shape[0]) for s in pivot.columns] for c in pivot.index],
}

box = []
for cat, g in df_model.groupby("Category"):
    q = g["Amount"].quantile([0.05, 0.25, 0.5, 0.75, 0.95])
    box.append({"category": cat, "n": int(len(g)), "mean": r(g["Amount"].mean(), 1),
                "p5": r(q[0.05], 0), "q1": r(q[0.25], 0), "median": r(q[0.5], 0),
                "q3": r(q[0.75], 0), "p95": r(q[0.95], 0)})
box.sort(key=lambda b: -b["median"])

# ── Hypothesis tests ─────────────────────────────────────────────────────────
group_A = df_model[df_model["Discounted"] == 0]["Amount"]
group_B = df_model[df_model["Discounted"] == 1]["Amount"]
rng = np.random.default_rng(42)
n_s = min(5000, len(group_A), len(group_B))
w_A, p_A = stats.shapiro(rng.choice(group_A.values, size=n_s, replace=False))
w_B, p_B = stats.shapiro(rng.choice(group_B.values, size=n_s, replace=False))

f_stat, p_anova = stats.f_oneway(*[g["Amount"].values for _, g in df_model.groupby("Category")])
ss_between = sum(len(g) * (g["Amount"].mean() - df_model["Amount"].mean()) ** 2 for _, g in df_model.groupby("Category"))
ss_total = ((df_model["Amount"] - df_model["Amount"].mean()) ** 2).sum()

contingency = pd.crosstab(df_model["B2B"].map({True: "B2B", False: "B2C"}),
                          df_model["Discounted"].map({1: "Ada diskon", 0: "Tanpa diskon"}))
chi2, p_chi2, dof, _ = stats.chi2_contingency(contingency)
cramers_v = np.sqrt(chi2 / (contingency.values.sum() * (min(contingency.shape) - 1)))


def cohen_d(x, y):
    nx, ny = len(x), len(y)
    pooled = np.sqrt(((nx - 1) * x.std(ddof=1) ** 2 + (ny - 1) * y.std(ddof=1) ** 2) / (nx + ny - 2))
    return (x.mean() - y.mean()) / pooled


ab = []
for col in ["Amount", "Qty"]:
    a = df_model[df_model["Discounted"] == 0][col]
    b = df_model[df_model["Discounted"] == 1][col]
    t, p_t = stats.ttest_ind(a, b, equal_var=False)
    _, p_u = stats.mannwhitneyu(a, b, alternative="two-sided")
    ab.append({"metric": col, "meanA": r(a.mean()), "meanB": r(b.mean()), "nA": int(len(a)), "nB": int(len(b)),
               "t": r(t), "pT": float(p_t), "pMWU": float(p_u), "d": r(cohen_d(a, b))})

promo_share = df_model.groupby("Fulfilment")["Discounted"].mean().round(4).to_dict()

tests = {
    "shapiro": {"wA": r(w_A), "pA": float(p_A), "wB": r(w_B), "pB": float(p_B), "n": n_s},
    "anova": {"f": r(f_stat, 2), "p": float(p_anova), "etaSq": r(ss_between / ss_total)},
    "chi2": {"chi2": r(chi2), "p": r(p_chi2, 6), "dof": int(dof), "cramersV": r(cramers_v),
             "table": {"rows": contingency.index.tolist(), "cols": contingency.columns.tolist(),
                       "values": contingency.values.tolist()}},
    "ab": ab,
    "promoShareByFulfilment": promo_share,
}

# ── Model (same features + encoding as the notebook) ─────────────────────────
feature_cols = ["Fulfilment", "Sales Channel ", "ship-service-level", "Category", "Size",
                "Qty", "B2B", "fulfilled-by", "MonthNum", "Discounted"]
x = df_model[feature_cols].copy()
x["B2B"] = x["B2B"].astype(int)
x["Size"] = x["Size"].map({s: i for i, s in enumerate(SIZE_ORDER)}).fillna(len(SIZE_ORDER))
x["ship-service-level"] = x["ship-service-level"].map(SERVICE_MAP).fillna(0)
x["Month_sin"] = np.sin(2 * np.pi * x["MonthNum"] / 12)
x["Month_cos"] = np.cos(2 * np.pi * x["MonthNum"] / 12)
x = x.drop(columns=["MonthNum"])
le_dict = {}
for col in ["Category", "Fulfilment", "Sales Channel ", "fulfilled-by"]:
    le = LabelEncoder()
    x[col] = le.fit_transform(x[col].astype(str))
    le_dict[col] = le
y = df_model["Amount"]

x_train, x_test, y_train, y_test = train_test_split(x, y, test_size=0.2, random_state=42)
kf = KFold(n_splits=5, shuffle=True, random_state=42)

rf_base = RandomForestRegressor(n_estimators=100, random_state=42, n_jobs=-1).fit(x_train, y_train)
rf_tuned = RandomForestRegressor(random_state=42, n_jobs=-1, **TUNED_PARAMS).fit(x_train, y_train)
cv_base = cross_val_score(RandomForestRegressor(n_estimators=100, random_state=42, n_jobs=-1),
                          x_train, y_train, cv=kf, scoring="r2")
cv_tuned = cross_val_score(RandomForestRegressor(random_state=42, n_jobs=-1, **TUNED_PARAMS),
                           x_train, y_train, cv=kf, scoring="r2")
pred_tuned = rf_tuned.predict(x_test)

# Residual summary by actual-amount bucket (where does the model miss?)
res = pd.DataFrame({"actual": y_test.values, "pred": pred_tuned})
bins = [0, 400, 600, 800, 1000, 1500, 10000]
labels = ["<400", "400-600", "600-800", "800-1.000", "1.000-1.500", ">1.500"]
res["bucket"] = pd.cut(res["actual"], bins=bins, labels=labels)
resid = [{"bucket": str(b), "n": int(len(g)), "actual": r(g["actual"].mean(), 0), "pred": r(g["pred"].mean(), 0),
          "mae": r((g["actual"] - g["pred"]).abs().mean(), 0)}
         for b, g in res.groupby("bucket", observed=True)]

# Diagnostic: adding product Style (target-encoded on train only): shows the feature ceiling
te = TargetEncoder(target_type="continuous")
style_tr = te.fit_transform(df_model.loc[x_train.index, ["Style"]], y_train).ravel()
style_te = te.transform(df_model.loc[x_test.index, ["Style"]]).ravel()
rf_style = RandomForestRegressor(n_estimators=100, min_samples_leaf=5, random_state=42, n_jobs=-1)
rf_style.fit(x_train.assign(Style_te=style_tr), y_train)
pred_style = rf_style.predict(x_test.assign(Style_te=style_te))

model = {
    "features": x.columns.tolist(),
    "trainRows": int(len(x_train)), "testRows": int(len(x_test)),
    "baseline": {**metrics(y_test, rf_base.predict(x_test)), "cv": [r(v) for v in cv_base]},
    "tuned": {**metrics(y_test, pred_tuned), "cv": [r(v) for v in cv_tuned], "params": TUNED_PARAMS},
    "withStyle": metrics(y_test, pred_style),
    "importance": sorted([{"feature": f, "value": r(v)} for f, v in zip(x.columns, rf_tuned.feature_importances_)],
                         key=lambda d: -d["value"]),
    "residuals": resid,
    "target": {"min": r(y.min(), 0), "median": r(y.median(), 0), "mean": r(y.mean(), 1), "max": r(y.max(), 0)},
}

# ── Prediction grid for the static estimator ─────────────────────────────────
grid_dims = {
    "category": le_dict["Category"].classes_.tolist(),
    "size": SIZE_ORDER,
    "fulfilment": ["Amazon", "Merchant"],
    "channel": le_dict["Sales Channel "].classes_.tolist(),
    "service": ["Standard", "Expedited"],
    "b2b": [0, 1],
    "discounted": [0, 1],
    "month": [4, 5, 6],
    "qty": [1, 2, 3],
}
mesh = pd.MultiIndex.from_product(list(grid_dims.values()), names=list(grid_dims.keys())).to_frame(index=False)
gx = pd.DataFrame({
    "Fulfilment": le_dict["Fulfilment"].transform(mesh["fulfilment"]),
    "Sales Channel ": le_dict["Sales Channel "].transform(mesh["channel"]),
    "ship-service-level": mesh["service"].map(SERVICE_MAP),
    "Category": le_dict["Category"].transform(mesh["category"]),
    "Size": mesh["size"].map({s: i for i, s in enumerate(SIZE_ORDER)}),
    "Qty": mesh["qty"],
    "B2B": mesh["b2b"],
    # fulfilled-by is fully determined by Fulfilment in this dataset
    "fulfilled-by": le_dict["fulfilled-by"].transform(np.where(mesh["fulfilment"] == "Merchant", "Easy Ship", "other")),
    "Discounted": mesh["discounted"],
    "Month_sin": np.sin(2 * np.pi * mesh["month"] / 12),
    "Month_cos": np.cos(2 * np.pi * mesh["month"] / 12),
})[x.columns]
grid_pred = rf_tuned.predict(gx)
support = df_model.groupby(["Category", "Size"]).size()
prediction = {
    "dims": grid_dims,
    "values": np.round(grid_pred).astype(int).tolist(),
    "support": {f"{c}|{s}": int(n) for (c, s), n in support.items()},
}

payload = {
    "meta": {"source": "Amazon Sale Report.csv", "rowsRaw": int(len(df)), "rowsClean": int(len(df_model)),
             "rowsFailed": int(len(df_failed)), "dateMin": dims["date"][0], "dateMax": dims["date"][-1],
             "months": MONTHS},
    "dims": dims,
    "cube": main_cube,
    "stateCube": state_cube,
    "failedStatus": failed_status,
    "heatmap": heatmap,
    "box": box,
    "tests": tests,
    "model": model,
    "prediction": prediction,
}
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(payload, separators=(",", ":")))
print(f"Wrote {OUT} ({OUT.stat().st_size / 1024:.0f} KB) in {time.time() - t0:.0f}s")
print("baseline", model["baseline"]); print("tuned", model["tuned"]); print("withStyle", model["withStyle"])
