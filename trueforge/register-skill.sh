#!/usr/bin/env bash
# Register the safe-migration skill with the running TrueForge harness.
# Skills are git-sourced (SkillType = "git"): the harness clones REPO@ref and mounts
# <path> into the sandbox. So the skill must be pushed to that ref first, and a sandbox
# provider must be configured (skills require a sandbox). Idempotent create-or-replace.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a

TRUEFORGE_URL="${TRUEFORGE_URL:-http://localhost:8790}"
SKILL_REPO_URL="${SKILL_REPO_URL:-https://github.com/Yasas-Sri/Shadow}"
SKILL_REF="${SKILL_REF:-main}"

curl -fsS -X PUT "${TRUEFORGE_URL}/api/v1/settings/skills" \
  -H 'Content-Type: application/json' \
  -d "{\"manifest\":{\"type\":\"git\",\"name\":\"safe-migration\",\"url\":\"${SKILL_REPO_URL}\",\"path\":\"trueforge/skills/safe-migration\",\"ref\":\"${SKILL_REF}\",\"description\":\"Use for every Postgres schema-change request: forward+rollback generation, shadow dry-run, validation, and the human-approval gate before production.\"}}"
echo
echo "registered safe-migration skill <- ${SKILL_REPO_URL}@${SKILL_REF}:trueforge/skills/safe-migration"
