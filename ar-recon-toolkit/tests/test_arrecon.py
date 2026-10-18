import unittest
import pandas as pd
from arrecon import age_invoices, aging_summary, reconcile, make_sample


def inv(rows):
    return pd.DataFrame(rows, columns=["invoice_id", "customer", "due_date", "amount", "paid"])


class AgingTests(unittest.TestCase):
    def test_buckets_and_balance(self):
        df = inv([("A", "X", "2026-10-20", 100, 0),     # not due yet
                  ("B", "X", "2026-10-05", 200, 50),    # 10 days late, balance 150
                  ("C", "Y", "2026-09-01", 300, 0),     # 44 days
                  ("D", "Y", "2026-06-01", 400, 0),     # 136 days
                  ("E", "Y", "2026-09-01", 100, 100)])  # paid, dropped
        aged = age_invoices(df, "2026-10-15").set_index("invoice_id")
        self.assertEqual(sorted(aged.index), ["A", "B", "C", "D"])
        self.assertEqual(aged.at["A", "bucket"], "Current")
        self.assertEqual(aged.at["B", "bucket"], "1-30")
        self.assertEqual(aged.at["B", "balance"], 150)
        self.assertEqual(aged.at["C", "bucket"], "31-60")
        self.assertEqual(aged.at["D", "bucket"], "90+")

    def test_boundary_days(self):
        df = inv([("A", "X", "2026-09-15", 10, 0), ("B", "X", "2026-08-16", 10, 0), ("C", "X", "2026-07-17", 10, 0)])
        got = age_invoices(df, "2026-10-15").set_index("invoice_id")["bucket"].to_dict()
        self.assertEqual(got, {"A": "1-30", "B": "31-60", "C": "61-90"})   # 30, 60, 90 days late

    def test_summary_totals_match(self):
        aged = age_invoices(make_sample()[0], "2026-10-15")
        summ = aging_summary(aged)
        self.assertAlmostEqual(summ.loc["ALL CUSTOMERS", "Total"], aged["balance"].sum(), places=2)

    def test_bad_input_is_an_error_not_a_skip(self):
        with self.assertRaises(ValueError):
            age_invoices(inv([("A", "X", "not a date", 10, 0)]), "2026-10-15")
        with self.assertRaises(ValueError):
            age_invoices(inv([("A", "X", "2026-10-01", 10, 0), ("A", "X", "2026-10-01", 5, 0)]), "2026-10-15")
        with self.assertRaises(ValueError):
            age_invoices(pd.DataFrame({"invoice_id": ["A"]}), "2026-10-15")


def tx(rows):
    return pd.DataFrame(rows, columns=["date", "amount", "description"])


class ReconTests(unittest.TestCase):
    def test_basic_match_and_leftovers(self):
        bank = tx([("2026-10-02", 100.0, "dep a"), ("2026-10-03", 55.5, "dep b"), ("2026-10-04", -20.0, "fee")])
        books = tx([("2026-10-01", 100.0, "a"), ("2026-10-03", 55.5, "b"), ("2026-10-05", 70.0, "c")])
        r = reconcile(bank, books)
        self.assertEqual(r["summary"]["matched_count"], 2)
        self.assertEqual(r["unmatched_bank"]["amount"].tolist(), [-20.0])
        self.assertEqual(r["unmatched_ledger"]["amount"].tolist(), [70.0])
        self.assertTrue(r["summary"]["explained"])

    def test_each_row_matches_once(self):
        bank = tx([("2026-10-02", 100.0, "x"), ("2026-10-02", 100.0, "x again")])
        books = tx([("2026-10-02", 100.0, "one payment")])
        r = reconcile(bank, books)
        self.assertEqual(r["summary"]["matched_count"], 1)
        self.assertEqual(len(r["unmatched_bank"]), 1)
        self.assertEqual(len(r["possible_duplicates"]), 2)

    def test_window_respected_and_closest_date_wins(self):
        books = tx([("2026-10-01", 80.0, "early"), ("2026-10-10", 80.0, "late")])
        r = reconcile(tx([("2026-10-09", 80.0, "d")]), books, window_days=3)
        self.assertEqual(r["matched"]["ledger_description"].tolist(), ["late"])
        far = reconcile(tx([("2026-10-30", 80.0, "d")]), books, window_days=3)
        self.assertEqual(far["summary"]["matched_count"], 0)

    def test_float_cents_do_not_break_matching(self):
        bank = tx([("2026-10-02", 0.1 + 0.2, "x")])
        books = tx([("2026-10-02", 0.3, "x")])
        self.assertEqual(reconcile(bank, books)["summary"]["matched_count"], 1)

    def test_sample_finds_planted_problems(self):
        _, led, bank = make_sample()
        r = reconcile(bank, led)
        self.assertEqual(r["summary"]["unmatched_ledger_count"], 3)       # 3 deposits not yet at the bank
        self.assertGreaterEqual(r["summary"]["unmatched_bank_count"], 3)  # wire, fee, double-posted line
        self.assertTrue(r["summary"]["explained"])
        self.assertGreaterEqual(len(r["possible_duplicates"]), 2)

    def test_empty_inputs(self):
        r = reconcile(tx([]), tx([]))
        self.assertEqual(r["summary"]["matched_count"], 0)


if __name__ == "__main__":
    unittest.main()
