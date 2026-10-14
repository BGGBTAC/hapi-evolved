import unittest
from budget import OperationLedger, BudgetExceeded, OperationConflict, micros

class BudgetTests(unittest.TestCase):
    def test_ceiling_and_idempotence(self):
        ledger = OperationLedger(":memory:")
        self.assertIsNone(ledger.begin("job", "p", 0, "hash", 100))
        ledger.charge("job", 60)
        with self.assertRaises(BudgetExceeded): ledger.charge("job", 41)
        ledger.reconcile("job", 60, 15)
        ledger.charge("job", 80)
        self.assertEqual(ledger.spent("job"), 95)
        self.assertIsNotNone(ledger.begin("job", "p", 0, "hash", 100))
        with self.assertRaises(OperationConflict): ledger.begin("job", "other", 0, "hash", 100)

    def test_forget_removes_cached_fact_response(self):
        ledger = OperationLedger(":memory:")
        ledger.begin("job", "p", 0, "hash", 100)
        ledger.finish("job", True, {"results": [{"body": "forget me"}]})
        ledger.reset("p", 1)
        row = ledger.begin("job", "p", 0, "hash", 100)
        self.assertIsNone(row["result"])
        self.assertEqual(row["status"], "purged")
        self.assertEqual(ledger.generation("p"), 1)

    def test_fractional_pricing_rounds_up(self):
        self.assertEqual(micros(1, "0.02"), 1)
        self.assertEqual(micros(1000, "0.02"), 20)

if __name__ == "__main__": unittest.main()
