"""Bank reconciliation: match bank deposits to payments recorded in the books."""
import pandas as pd


def _cents(series):
    return (pd.to_numeric(series, errors="raise") * 100).round().astype("int64")


def reconcile(bank, ledger, window_days=5):
    """Match each bank line to one ledger line with the same amount within window_days.

    bank and ledger need columns: date, amount, description. Each row matches at most once;
    when several ledger rows fit, the closest date wins. Returns a dict with matched,
    unmatched_bank, unmatched_ledger, possible_duplicates and a totals summary.
    """
    for name, df in (("bank", bank), ("ledger", ledger)):
        miss = {"date", "amount", "description"} - set(df.columns)
        if miss:
            raise ValueError("%s is missing columns: %s" % (name, ", ".join(sorted(miss))))
    b = bank.copy().reset_index(drop=True)
    l = ledger.copy().reset_index(drop=True)
    b["date"] = pd.to_datetime(b["date"])
    l["date"] = pd.to_datetime(l["date"])
    b["cents"] = _cents(b["amount"])
    l["cents"] = _cents(l["amount"])

    used = set()
    pairs = []
    for bi in b.sort_values("date").index:
        cand = l[(l["cents"] == b.at[bi, "cents"]) & (~l.index.isin(used))]
        cand = cand[(cand["date"] - b.at[bi, "date"]).abs().dt.days <= window_days]
        if cand.empty:
            continue
        gap = (cand["date"] - b.at[bi, "date"]).abs()
        li = gap.idxmin()
        used.add(li)
        pairs.append((bi, li))

    matched = pd.DataFrame(
        [{
            "bank_date": b.at[bi, "date"], "ledger_date": l.at[li, "date"],
            "amount": b.at[bi, "amount"], "bank_description": b.at[bi, "description"],
            "ledger_description": l.at[li, "description"],
            "days_apart": abs((l.at[li, "date"] - b.at[bi, "date"]).days),
        } for bi, li in pairs],
        columns=["bank_date", "ledger_date", "amount", "bank_description", "ledger_description", "days_apart"],
    )
    ub = b.drop(index=[p[0] for p in pairs]).drop(columns="cents")
    ul = l.drop(index=[p[1] for p in pairs]).drop(columns="cents")

    dup = b[b.duplicated(subset=["date", "cents"], keep=False)].drop(columns="cents")
    summary = {
        "bank_total": round(float(b["amount"].sum()), 2),
        "ledger_total": round(float(l["amount"].sum()), 2),
        "difference": round(float(b["amount"].sum() - l["amount"].sum()), 2),
        "matched_count": len(pairs),
        "unmatched_bank_count": len(ub),
        "unmatched_ledger_count": len(ul),
        "unmatched_bank_total": round(float(ub["amount"].sum()), 2),
        "unmatched_ledger_total": round(float(ul["amount"].sum()), 2),
    }
    # If everything unmatched explains the gap, the books reconcile once those items are resolved.
    summary["explained"] = abs(summary["difference"] - (summary["unmatched_bank_total"] - summary["unmatched_ledger_total"])) < 0.005
    return {"matched": matched, "unmatched_bank": ub.reset_index(drop=True),
            "unmatched_ledger": ul.reset_index(drop=True), "possible_duplicates": dup.reset_index(drop=True),
            "summary": summary}
