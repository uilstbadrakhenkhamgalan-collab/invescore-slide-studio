"""Test configuration: ensure backend/ is on sys.path for direct module imports."""
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client_factory():
    """Returns a factory that builds TestClient instances on demand."""
    def _make():
        from main import app
        return TestClient(app)
    return _make
