import unittest
import sqlite3
import tempfile
from pathlib import Path
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

    def test_legacy_binding_migrates_provider_without_touching_existing_operations(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "ledger.db")
            db = sqlite3.connect(path)
            db.execute("CREATE TABLE embedding_bindings(project_id TEXT PRIMARY KEY, embedding_model TEXT NOT NULL, dimensions INTEGER NOT NULL)")
            db.execute("INSERT INTO embedding_bindings VALUES('project','embedding',1024)")
            db.commit()
            db.close()
            ledger = OperationLedger(path)
            self.assertEqual(ledger.binding("project"), ("openai", "embedding", 1024))
            ledger.bind("project", "voyage", "embedding", 1024)
            self.assertEqual(ledger.binding("project"), ("voyage", "embedding", 1024))
            ledger.db.close()
            reopened = OperationLedger(path)
            self.assertEqual(reopened.binding("project"), ("voyage", "embedding", 1024))
            reopened.db.close()

    def test_fractional_pricing_rounds_up(self):
        self.assertEqual(micros(1, "0.02"), 1)
        self.assertEqual(micros(1000, "0.02"), 20)

if __name__ == "__main__": unittest.main()
