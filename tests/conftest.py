import os
import tempfile

import pytest
from fastapi.testclient import TestClient

_fd, _TEST_DB_PATH = tempfile.mkstemp(suffix=".db")
os.close(_fd)
os.environ["DATABASE_URL"] = f"sqlite:///{_TEST_DB_PATH}"


@pytest.fixture()
def client():
    from backend.main import app

    with TestClient(app) as c:
        yield c
