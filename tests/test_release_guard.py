"""release-guard.sh: a tag is only ever put on a commit that origin/main already holds."""
import subprocess
from pathlib import Path

GUARD = Path(__file__).resolve().parent.parent / "scripts/release-guard.sh"


def git(cwd, *a):
    return subprocess.run(["git", *a], cwd=cwd, check=True, capture_output=True, text=True, env={"PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin", "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@users.noreply.github.com", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@users.noreply.github.com"}).stdout.strip()


def repo(tmp_path):
    origin = tmp_path / "origin.git"
    git(tmp_path, "init", "-q", "--bare", "-b", "main", str(origin))
    work = tmp_path / "work"
    git(tmp_path, "clone", "-q", str(origin), str(work))
    (work / "a").write_text("1")
    git(work, "add", "a")
    git(work, "commit", "-q", "-m", "one")
    git(work, "push", "-q", "origin", "HEAD:main")
    return work


def run(work, *a):
    return subprocess.run([str(GUARD), *a], cwd=work, capture_output=True, text=True)


def test_a_pushed_commit_may_be_tagged(tmp_path):
    assert run(repo(tmp_path)).returncode == 0


def test_a_commit_on_no_branch_or_unpushed_is_refused(tmp_path):
    work = repo(tmp_path)
    git(work, "switch", "-q", "--detach")
    (work / "a").write_text("2")
    git(work, "commit", "-q", "-am", "orphan")
    r = run(work)
    assert r.returncode == 1 and "not on origin/main" in r.stderr
