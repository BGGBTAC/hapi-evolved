"""Durable per-operation spend ceiling, including ambiguous requests after a crash."""
import json
import math
import sqlite3
from decimal import Decimal, ROUND_CEILING


class BudgetExceeded(Exception):
    pass


class OperationConflict(Exception):
    pass


def micros(tokens: int, dollars_per_million: str) -> int:
    rate = Decimal(dollars_per_million)
    if not rate.is_finite() or rate < 0 or tokens < 0:
        raise ValueError("Invalid pricing")
    return int((tokens * rate).to_integral_value(rounding=ROUND_CEILING))


class OperationLedger:
    def __init__(self, path: str):
        self.db = sqlite3.connect(path, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA secure_delete=ON")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS operations (
                id TEXT PRIMARY KEY, project_id TEXT NOT NULL, generation INTEGER NOT NULL,
                fingerprint TEXT NOT NULL, budget INTEGER NOT NULL, spent INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL, result TEXT
            );
            CREATE TABLE IF NOT EXISTS generations (project_id TEXT PRIMARY KEY, generation INTEGER NOT NULL);
        """)
        # Never repeat an uncertain paid request after process death.
        self.db.execute("UPDATE operations SET status='indeterminate',result=NULL WHERE status='running'")

    def begin(self, operation: str, project: str, generation: int, fingerprint: str, budget: int):
        row = self.db.execute("SELECT * FROM operations WHERE id=?", (operation,)).fetchone()
        if row:
            if (row["project_id"], row["generation"], row["fingerprint"], row["budget"]) != (project, generation, fingerprint, budget):
                raise OperationConflict("Operation identifier reused with different input")
            return dict(row)
        self.db.execute("INSERT INTO operations(id,project_id,generation,fingerprint,budget,status) VALUES(?,?,?,?,?,'running')",
                        (operation, project, generation, fingerprint, budget))
        return None

    def charge(self, operation: str, maximum: int):
        # One statement is atomic even if model extraction schedules concurrent calls.
        updated = self.db.execute("UPDATE operations SET spent=spent+? WHERE id=? AND status='running' AND spent+?<=budget",
                                  (maximum, operation, maximum)).rowcount
        if not updated:
            raise BudgetExceeded("Operation budget exhausted before model call")

    def reconcile(self, operation: str, reserved: int, actual: int):
        if actual > reserved:
            raise BudgetExceeded("Configured model pricing/token bound is insufficient")
        self.db.execute("UPDATE operations SET spent=spent-? WHERE id=?", (reserved - actual, operation))

    def spent(self, operation: str) -> int:
        return self.db.execute("SELECT spent FROM operations WHERE id=?", (operation,)).fetchone()[0]

    def finish(self, operation: str, success: bool, result: dict):
        self.db.execute("UPDATE operations SET status=?,result=? WHERE id=?",
                        ("complete" if success else "failed", json.dumps(result), operation))

    def generation(self, project: str) -> int:
        row = self.db.execute("SELECT generation FROM generations WHERE project_id=?", (project,)).fetchone()
        return row[0] if row else 0

    def reset(self, project: str, generation: int):
        self.db.execute("INSERT INTO generations VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET generation=MAX(generation,excluded.generation)",
                        (project, generation))
        # Search receipts must not retain facts or deleted source identifiers.
        self.db.execute("UPDATE operations SET result=NULL,status='purged' WHERE project_id=? AND generation<?", (project, generation))
        self.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
