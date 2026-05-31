#!/usr/bin/env bash
# Repo-hygiene gate (runs in the husky pre-commit hook).
#
# Blocks committing internal-only / unprofessional files into a repo that
# represents production work: planning notes, review findings, scratch files,
# local drafts, and real .env files. Internal design iteration belongs in the
# wiki / local notes — never in git history.
set -uo pipefail

staged=$(git diff --cached --name-only --diff-filter=ACMR || true)
[ -z "$staged" ] && exit 0

# Internal-only patterns (portable ERE — no Perl lookahead).
blocked='(^|/)docs/planning/|FINDINGS.*\.md$|\.draft\.md$|(^|/)scratch/|\.local\.[^/]+$|(^|/)TODO\.local\.md$'
violations=$(printf '%s\n' "$staged" | grep -Ei "$blocked" || true)

# .env files (real secrets) — allow only .env.example.
env_hits=$(printf '%s\n' "$staged" | grep -E '(^|/)\.env($|\.)' | grep -Ev '\.env\.example$' || true)
[ -n "$env_hits" ] && violations=$(printf '%s\n%s' "$violations" "$env_hits")

violations=$(printf '%s\n' "$violations" | grep -v '^$' || true)
if [ -n "$violations" ]; then
  echo "✖ repo-hygiene: refusing to commit internal-only / unprofessional files:"
  printf '%s\n' "$violations" | sed 's/^/      /'
  echo ""
  echo "  These belong in the wiki or local notes, not in git history."
  echo "  Unstage them:  git restore --staged <file>"
  exit 1
fi

# Warn (do not block) on large additions > 1 MB — usually a mistaken binary.
while IFS= read -r f; do
  [ -f "$f" ] || continue
  size=$(wc -c < "$f" 2>/dev/null || echo 0)
  if [ "$size" -gt 1048576 ]; then
    echo "⚠ repo-hygiene: '$f' is $((size / 1024)) KB — large file; confirm it belongs in git."
  fi
done <<< "$staged"

exit 0
