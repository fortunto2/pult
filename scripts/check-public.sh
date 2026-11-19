#!/usr/bin/env bash
# Is this tree safe to publish? Greps the files git would commit for
#   1. generic shapes that never belong in a public repo (workers.dev hosts, long numeric Telegram ids, key and token shapes, home paths, real e-mail addresses), and
#   2. your own patterns from a LOCAL file outside the repo: ${PULT_SCRUB_FILE:-~/.config/pult/scrub-patterns.txt}, one extended regex per line, # comments.
# The personal list never enters the repo. A missing file is a warning, not a failure, so a fresh clone and CI still pass on the generic rules.
# Known-fine matches go in scripts/scrub-allow.txt as `path-regex<TAB>content-regex` lines (each with a reason in a # comment above it).
#   scripts/check-public.sh            working tree (tracked and new, not ignored)
#   scripts/check-public.sh --history  also every commit message, author line and diff
# Exit 0 clean, 1 a match, 2 could not run.
set -u
cd "$(git rev-parse --show-toplevel)" || exit 2
SCRUB_FILE="${PULT_SCRUB_FILE:-$HOME/.config/pult/scrub-patterns.txt}"
HISTORY=0; [ "${1:-}" = "--history" ] && HISTORY=1

GENERIC=(
  '[A-Za-z0-9-]+\.workers\.dev'
  '[A-Za-z0-9-]+\.pages\.dev'
  '(^|[^0-9A-Za-z_.:-])[0-9]{8,12}([^0-9A-Za-z_.-]|$)'
  '[0-9]{8,10}:[A-Za-z0-9_-]{35}'
  'sk-[A-Za-z0-9_-]{20,}'
  'gh[pousr]_[A-Za-z0-9]{30,}'
  'github_pat_[A-Za-z0-9_]{30,}'
  'AKIA[0-9A-Z]{16}'
  'xox[abprs]-[A-Za-z0-9-]{10,}'
  'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.'
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  '/Users/[A-Za-z0-9._-]+/'
  '/home/[A-Za-z0-9._-]+/'
  '[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
)
# History lines carry no path to match scrub-allow.txt against, so its fixtures are listed here as content patterns (epoch seconds in tests, all-zero and sequential short ids).
HISTORY_FINE='1[0-9]{9}[,}) ]|0{10}|0123456789|^(\+\+\+|---) '
ALLOW_EMAIL='(noreply|no-reply)@|@example\.(com|org)|@users\.noreply\.github\.com'
# Commits already public whose author address is not a noreply one. History is not rewritten (tags are public);
# each entry is a short hash, and the identity check below keeps the list from growing.
KNOWN_AUTHOR_SLIPS='^(commit )?(21900ef|64eb711) '

files() { git ls-files -co --exclude-standard | grep -vE '^scripts/(scrub-allow\.txt|check-public\.sh)$|(^|/)(node_modules|\.venv|_work)/|(^|/)(package-lock\.json|uv\.lock)$|\.(png|jpg|ico|woff2?)$'; }
allowed() {  # $1 path, $2 matching line
  [ -f scripts/scrub-allow.txt ] || return 1
  local p c
  while IFS=$'\t' read -r p c; do
    case "$p" in ''|'#'*) continue ;; esac
    if printf '%s' "$1" | grep -qE -- "$p" && printf '%s' "$2" | grep -qE -- "$c"; then return 0; fi
  done < scripts/scrub-allow.txt
  return 1
}

bad=0
scan() {  # $1 label, stdin: "path:line:text"
  local hit path text
  while IFS= read -r hit; do
    path="${hit%%:*}"; text="${hit#*:*:}"
    if [ "$1" = generic ] && printf '%s' "$text" | grep -qiE -- "$ALLOW_EMAIL" && ! printf '%s' "$text" | grep -qE -- '[0-9]{8,}|workers\.dev|sk-|ghp_|AKIA|/Users/|/home/'; then continue; fi
    allowed "$path" "$text" && continue
    printf '%s: %s\n' "$1" "${hit:0:200}"; bad=1
  done
}

FILES="$(files)"
for re in "${GENERIC[@]}"; do
  # shellcheck disable=SC2086
  scan generic < <(printf '%s\n' "$FILES" | xargs grep -HnE -- "$re" 2>/dev/null)
done

# The identity this commit will carry: a real address in the author or committer line is as public as the code.
# Fix: git config user.email <login>@users.noreply.github.com (in every checkout, including a submodule one).
for who in AUTHOR COMMITTER; do
  ident="$(git var "GIT_${who}_IDENT" 2>/dev/null)" || continue
  email="$(printf '%s' "$ident" | sed -n 's/.*<\(.*\)>.*/\1/p')"
  if [ -n "$email" ] && ! printf '%s' "$email" | grep -qiE -- "$ALLOW_EMAIL"; then
    echo "identity: the $(printf '%s' "$who" | tr A-Z a-z) address of this commit is not a noreply one; run: git config user.email <login>@users.noreply.github.com"
    bad=1
  fi
done

if [ -f "$SCRUB_FILE" ]; then
  while IFS= read -r re; do
    case "$re" in ''|'#'*) continue ;; esac
    scan personal < <(printf '%s\n' "$FILES" | xargs grep -HniE -- "$re" 2>/dev/null)
    if [ "$HISTORY" = 1 ]; then
      hist="$(git log --all --format='%h %an <%ae>%n%B' | grep -vE -- "$KNOWN_AUTHOR_SLIPS" | grep -niE -- "$re" | head -3)"
      [ -n "$hist" ] && { printf 'personal (history): %s\n' "$hist"; bad=1; }
    fi
  done < "$SCRUB_FILE"
else
  echo "warning: no personal scrub list at $SCRUB_FILE (set PULT_SCRUB_FILE, see examples/scrub-patterns.example.txt); only the generic rules ran" >&2
fi

if [ "$HISTORY" = 1 ]; then
  for re in "${GENERIC[@]}"; do
    hist="$(git log --all -p --format='commit %h %an <%ae>%n%B' -- . ':!uv.lock' ':!worker/package-lock.json' ':!scripts/check-public.sh' ':!scripts/scrub-allow.txt' 2>/dev/null | sed 's/^[+ -]//' | grep -E -- "$re" | grep -vE "$ALLOW_EMAIL" | grep -vE "$HISTORY_FINE" | grep -vE -- "$KNOWN_AUTHOR_SLIPS" | head -3 | cut -c1-200)"
    [ -n "$hist" ] && { printf 'generic (history, %s): %s\n' "$re" "$hist"; bad=1; }
  done
fi

[ "$bad" = 0 ] && echo "check-public: clean"
exit "$bad"
