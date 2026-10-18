"""Made-up data so the tools can be tried without any real client information."""
import random
import pandas as pd

CUSTOMERS = ["Harbor Plumbing", "Eastside Dental", "Maple Auto Group", "Bergen Logistics", "Cedar Property Mgmt",
             "Northfield Roofing", "Lakeview Pediatrics", "Summit HVAC"]


def make_sample(seed=7, as_of="2026-10-15"):
    rng = random.Random(seed)
    today = pd.Timestamp(as_of)
    inv, pay = [], []
    for n in range(1, 61):
        cust = rng.choice(CUSTOMERS)
        issued = today - pd.Timedelta(days=rng.randint(5, 150))
        due = issued + pd.Timedelta(days=30)
        amount = round(rng.uniform(250, 6500), 2)
        r = rng.random()
        paid = amount if r < 0.55 else (round(amount * rng.choice([0.25, 0.5]), 2) if r < 0.65 else 0.0)
        inv.append({"invoice_id": "INV-%04d" % n, "customer": cust, "issue_date": issued.date(),
                    "due_date": due.date(), "amount": amount, "paid": paid})
        if paid > 0:
            when = min(due + pd.Timedelta(days=rng.randint(-5, 20)), today)
            pay.append({"date": when.date(), "amount": paid, "description": "%s %s" % (cust, "INV-%04d" % n)})
    invoices = pd.DataFrame(inv)
    ledger = pd.DataFrame(pay)

    # The bank mostly agrees with the books; plant realistic differences to find.
    bank = ledger.copy()
    bank["date"] = [(pd.Timestamp(d) + pd.Timedelta(days=rng.randint(0, 3))).date() for d in bank["date"]]
    bank["description"] = ["DEPOSIT " + s.split(" INV")[0].upper() for s in bank["description"]]
    drop = bank.sample(3, random_state=seed).index          # in the books, not yet at the bank
    bank = bank.drop(index=drop)
    extra = pd.DataFrame([
        {"date": (today - pd.Timedelta(days=6)).date(), "amount": 412.50, "description": "DEPOSIT UNKNOWN WIRE"},
        {"date": (today - pd.Timedelta(days=9)).date(), "amount": -35.00, "description": "MONTHLY BANK FEE"},
    ])
    bank = pd.concat([bank, extra], ignore_index=True)
    bank = pd.concat([bank, bank.iloc[[0]]], ignore_index=True)   # accidental double-posted deposit
    return invoices, ledger, bank
