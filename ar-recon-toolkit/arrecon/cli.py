import argparse
import os
import sys
import pandas as pd
from .aging import age_invoices, aging_summary, collection_list
from .recon import reconcile
from .report import write_workbook
from .sample import make_sample


def _money(x):
    return "{:,.2f}".format(x)


def cmd_demo(a):
    os.makedirs(a.out, exist_ok=True)
    inv, led, bank = make_sample()
    inv.to_csv(os.path.join(a.out, "invoices.csv"), index=False)
    led.to_csv(os.path.join(a.out, "ledger.csv"), index=False)
    bank.to_csv(os.path.join(a.out, "bank.csv"), index=False)
    print("Wrote made-up invoices.csv, ledger.csv and bank.csv to %s/" % a.out)


def cmd_aging(a):
    aged = age_invoices(pd.read_csv(a.invoices), a.as_of)
    summ = aging_summary(aged)
    print(summ.to_string(float_format=_money))
    calls = collection_list(aged)
    print("\n%d invoices are 31+ days past due, %s outstanding:" % (len(calls), _money(calls["balance"].sum())))
    print(calls.head(10).to_string(index=False, float_format=_money))
    if a.xlsx:
        write_workbook(a.xlsx, {"Aging summary": summ, "Open invoices": aged, "Call list": calls})
        print("\nSaved %s" % a.xlsx)


def cmd_recon(a):
    r = reconcile(pd.read_csv(a.bank), pd.read_csv(a.ledger), a.window)
    s = r["summary"]
    print("Matched %d lines." % s["matched_count"])
    print("Bank total %s | Books total %s | Difference %s" % (_money(s["bank_total"]), _money(s["ledger_total"]), _money(s["difference"])))
    print("Unmatched at bank: %d (%s) | Unmatched in books: %d (%s)" % (
        s["unmatched_bank_count"], _money(s["unmatched_bank_total"]), s["unmatched_ledger_count"], _money(s["unmatched_ledger_total"])))
    print("Unmatched items fully explain the difference: %s" % ("yes" if s["explained"] else "NO - look for a typo or a missing line"))
    for key, title in (("unmatched_bank", "In the bank but not in the books"), ("unmatched_ledger", "In the books but not at the bank"),
                       ("possible_duplicates", "Possible double-posted bank lines")):
        if len(r[key]):
            print("\n" + title + ":")
            print(r[key].to_string(index=False))
    if a.xlsx:
        write_workbook(a.xlsx, {"Matched": r["matched"], "Bank only": r["unmatched_bank"],
                                "Books only": r["unmatched_ledger"], "Possible duplicates": r["possible_duplicates"]})
        print("\nSaved %s" % a.xlsx)


def main(argv=None):
    p = argparse.ArgumentParser(prog="arrecon", description="AR aging and bank reconciliation.")
    sub = p.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("demo", help="write made-up sample CSVs")
    d.add_argument("--out", default="sample_data")
    d.set_defaults(fn=cmd_demo)
    g = sub.add_parser("aging", help="aging report from an invoices CSV")
    g.add_argument("invoices")
    g.add_argument("--as-of", required=True, help="report date, YYYY-MM-DD")
    g.add_argument("--xlsx")
    g.set_defaults(fn=cmd_aging)
    r = sub.add_parser("recon", help="match a bank CSV to a ledger CSV")
    r.add_argument("bank")
    r.add_argument("ledger")
    r.add_argument("--window", type=int, default=5, help="days a deposit may differ from the books")
    r.add_argument("--xlsx")
    r.set_defaults(fn=cmd_recon)
    a = p.parse_args(argv)
    try:
        a.fn(a)
    except (ValueError, FileNotFoundError, KeyError) as e:
        print("error: %s" % e, file=sys.stderr)
        return 1
    return 0
