import pytest


@pytest.fixture(autouse=True)
def _isolation(tmp_path, monkeypatch):
    """No test reads the real config dir or a real deny file."""
    monkeypatch.setenv("PULT_CONFIG_DIR", str(tmp_path / "cfg"))
    monkeypatch.delenv("PULT_DENY_FILE", raising=False)
    monkeypatch.delenv("PULT_URL", raising=False)
    monkeypatch.delenv("PULT_PLUGINS", raising=False)
    monkeypatch.delenv("PULT_WORKFLOWS", raising=False)
    monkeypatch.delenv("PULT_PROGRESS", raising=False)
