import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient

from backend.core.db.session import get_session_factory, init_db
from backend.main import app, get_db


class CareEngineSmokeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()
        cls.factory = get_session_factory()

        def override_db():
            s = cls.factory()
            try:
                yield s
                s.commit()
            except Exception:
                s.rollback()
                raise
            finally:
                s.close()

        app.dependency_overrides[get_db] = override_db
        cls.client = TestClient(app)

    def test_chat_and_symptom_and_medication_escalation(self):
        uid = "u-smoke-1"
        r = self.client.post("/chat", json={"user_id": uid, "message": "hello", "history": []})
        self.assertEqual(r.status_code, 200)
        self.assertIn("reply", r.json())

        r2 = self.client.post(
            "/events",
            json={"event_type": "symptom_reported", "user_id": uid, "payload": {"severity": "high"}},
        )
        self.assertEqual(r2.status_code, 200)

        st = self.client.get(f"/users/{uid}/state").json()
        self.assertEqual(st["risk_level"], "high")

        for _ in range(3):
            rr = self.client.post("/events", json={"event_type": "medication_missed", "user_id": uid, "payload": {}})
            self.assertEqual(rr.status_code, 200)


if __name__ == "__main__":
    unittest.main()
