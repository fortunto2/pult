"""pult-run: a network outage is one log line at the start, one at the end, and a growing quiet backoff in between."""

def load():
    from pult import runner

    return runner


def test_outage_logs_twice_and_backs_off(monkeypatch):
    g = load()
    lines = []
    monkeypatch.setattr(g, "log", lines.append)
    o = g.Outage("interactive")
    waits = [o.failed(OSError("Remote end closed connection without response")) for _ in range(6)]
    assert waits == [15, 30, 60, 120, 120, 120]
    assert len(lines) == 1 and "retrying quietly" in lines[0]
    o.ok()
    assert len(lines) == 2 and "network back" in lines[1] and "6 tries" in lines[1]
    o.ok()
    assert len(lines) == 2                       # a healthy poll logs nothing
