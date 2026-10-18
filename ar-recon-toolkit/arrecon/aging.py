"""Accounts receivable aging: how late is each open invoice, and who owes the most."""
import pandas as pd

BUCKETS = ["Current", "1-30", "31-60", "61-90", "90+"]


def _bucket(days_past_due):
    if days_past_due <= 0:
        return "Current"
    if days_past_due <= 30:
        return "1-30"
    if days_past_due <= 60:
        return "31-60"
    if days_past_due <= 90:
        return "61-90"
    return "90+"


def age_invoices(invoices, as_of):
    """Return open invoices with days past due and an aging bucket.

    invoices needs columns: invoice_id, customer, due_date, amount, paid (amount paid so far).
    Invoices that are fully paid are dropped. Bad rows raise ValueError, not a silent skip.
    """
    need = {"invoice_id", "customer", "due_date", "amount", "paid"}
    missing = need - set(invoices.columns)
    if missing:
        raise ValueError("missing columns: " + ", ".join(sorted(missing)))
    df = invoices.copy()
    df["due_date"] = pd.to_datetime(df["due_date"], errors="coerce")
    if df["due_date"].isna().any():
        bad = df.loc[df["due_date"].isna(), "invoice_id"].tolist()
        raise ValueError("unreadable due_date for invoices: %s" % bad)
    for col in ("amount", "paid"):
        df[col] = pd.to_numeric(df[col], errors="coerce")
        if df[col].isna().any():
            raise ValueError("non-numeric values in column '%s'" % col)
    if df["invoice_id"].duplicated().any():
        raise ValueError("duplicate invoice_id values: %s" % df.loc[df["invoice_id"].duplicated(), "invoice_id"].tolist())
    as_of = pd.Timestamp(as_of)
    df["balance"] = (df["amount"] - df["paid"]).round(2)
    df = df[df["balance"] > 0].copy()
    df["days_past_due"] = (as_of - df["due_date"]).dt.days
    df["bucket"] = df["days_past_due"].apply(_bucket)
    return df.sort_values(["days_past_due", "balance"], ascending=False).reset_index(drop=True)


def aging_summary(aged):
    """Balance per customer split into aging buckets, largest total first."""
    table = aged.pivot_table(index="customer", columns="bucket", values="balance", aggfunc="sum", fill_value=0.0)
    for b in BUCKETS:
        if b not in table.columns:
            table[b] = 0.0
    table = table[BUCKETS]
    table["Total"] = table.sum(axis=1)
    table = table.sort_values("Total", ascending=False).round(2)
    total = table.sum().rename("ALL CUSTOMERS").to_frame().T
    return pd.concat([table, total])


def collection_list(aged, min_days=31):
    """Invoices worth a phone call or email: past due by at least min_days."""
    return aged[aged["days_past_due"] >= min_days][["customer", "invoice_id", "due_date", "balance", "days_past_due"]]
