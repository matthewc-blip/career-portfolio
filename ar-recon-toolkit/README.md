# AR Aging & Bank Reconciliation Toolkit

Two small pandas tools for the month-end work a bookkeeper or staff accountant does by hand:

1. **AR aging** – takes an invoice list and shows who owes what, how late it is, and which invoices deserve a phone call.
2. **Bank reconciliation** – matches bank deposits to payments recorded in the books and lists what is left over: items at the bank but not in the books, items in the books but not at the bank, and possible double-posted lines.

Everything runs on CSV files and writes an Excel workbook. All sample data is made up; no client information is in this repo.

## Try it

```bash
pip install pandas openpyxl
python -m arrecon demo --out examples                      # write made-up CSVs
python -m arrecon aging examples/invoices.csv --as-of 2026-10-15 --xlsx aging.xlsx
python -m arrecon recon examples/bank.csv examples/ledger.csv --xlsx recon.xlsx
```

Example output from the sample data:

```
Matched 40 lines.
Bank total 125,700.70 | Books total 133,490.29 | Difference -7,789.59
Unmatched at bank: 3 (3,095.15) | Unmatched in books: 3 (10,884.74)
Unmatched items fully explain the difference: yes

In the bank but not in the books:      an unknown wire, a bank fee, a double-posted deposit
In the books but not at the bank:      three deposits not yet cleared
```

## Input formats

`invoices.csv`: `invoice_id, customer, due_date, amount, paid`
`bank.csv` and `ledger.csv`: `date, amount, description`

## How matching works

- A bank line matches a ledger line when the amounts are equal to the cent and the dates are within `--window` days (default 5).
- Each line matches at most once, and when several fit, the closest date wins. Amounts are compared in whole cents, so floating-point noise (0.1 + 0.2) does not break a match.
- After matching, the tool checks that the unmatched items add up to the total difference. If they do not, it says so, which usually means a typo or a missing line.
- Bad input (unreadable dates, non-numeric amounts, duplicate invoice numbers, missing columns) stops with an error instead of silently skipping rows.

## Limits

This is a demonstration of the logic, not accounting software. It matches one-to-one by amount, so it does not handle one deposit that covers several invoices, partial payments split across deposits, or foreign currency. Real books would need a reviewer to confirm each match.

## Tests

```bash
python -m unittest discover -s tests -v
```

Ten tests cover bucket boundaries, partial payments, bad input, one-to-one matching, date windows, cents handling and the planted problems in the sample data.

## License

MIT
