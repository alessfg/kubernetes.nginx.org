#!/usr/bin/env bash
# Stop hook: run the checks before a turn is allowed to end.
#
# AGENTS.md records six occasions where a mistyped shell construct reported
# "clean" for a check that never ran. Every one was an end-of-turn failure: the
# agent asserted a verification it had not performed, and the human believed the
# summary. The mitigation so far has been prose asking the model to type the
# commands correctly, which is the same mitigation that failed six times.
#
# This runs them outside the model's control, at the moment the claim would be
# made. It cannot be forged, mistyped or skipped.
#
# Three guards decide whether it survives contact with real use:
#
#   1. It is a no-op on a clean tree, so a read-only turn costs milliseconds.
#   2. It exits 0 when stop_hook_active is already true, so it can never block
#      twice in a row and trap a session.
#   3. SKIP_REPO_VERIFY=1 disables it, so a turn that began with an already
#      broken tree can still be ended.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 0

[ "${SKIP_REPO_VERIFY:-0}" = "1" ] && exit 0

# The hook receives JSON on stdin. Re-entrancy is the one thing that must not
# happen: blocking a stop that was itself triggered by this hook would loop.
INPUT="$(cat 2>/dev/null || true)"
case "$INPUT" in
  *'"stop_hook_active":true'*|*'"stop_hook_active": true'*) exit 0 ;;
esac

# Nothing changed, nothing to verify.
if [ -z "$(git status --porcelain 2>/dev/null)" ]; then
  exit 0
fi

# One runner, in Python, for the reason its own header gives: a shell loop over
# command strings is the exact construct in the incident list.
OUTPUT="$(python3 .github/scripts/check-all.py 2>&1)"
STATUS=$?

if [ "$STATUS" -ne 0 ]; then
  {
    echo "The repository checks do not pass, so this turn cannot be reported as done."
    echo
    echo "$OUTPUT" | tail -40
    echo
    echo "Fix the failures above, or re-run 'python3 .github/scripts/check-all.py'"
    echo "for the full output. If the tree was already broken when this turn"
    echo "started, set SKIP_REPO_VERIFY=1 and say so explicitly in your summary."
  } >&2
  exit 2
fi

exit 0
