#!/usr/bin/env bash
#
# Deploys workflows/*.json through n8n's public REST API.
#
# THIS SCRIPT HAS NEVER BEEN EXECUTED. The public API is not exposed on the n8n
# Cloud free trial this account is on, so no call below has ever been made. It
# conforms to the published OpenAPI schema; that is not the same claim as
# "known to work". Every deployment in this project went through the instance
# MCP server instead. See README "Deployment".
#
# Two schema facts shape the body it sends, both from n8n's published spec for
# POST /workflows and PUT /workflows/{id}:
#
#   1. `active` is readOnly and REJECTED in a request body — activation is a
#      separate endpoint — and additionalProperties is false, so an extra
#      property is a 400 rather than something the server drops. The generated
#      files carry `active: false` deliberately (it documents that nothing runs
#      on a schedule), so the body is shaped here rather than in the generator.
#
#   2. Nothing in the API preserves ids across instances. On an instance where
#      these workflows do not exist yet, all three are created with NEW ids —
#      but workflows/orchestrator.json addresses its two sub-workflows by the
#      ids they carry on THIS instance. So the sub-workflows are deployed
#      first, and the ids the API returns are substituted into the orchestrator
#      before it is sent. Deploy order is explicit below for that reason; it
#      must never go back to iterating a glob.
#
# The shaping and the substitution live in scripts/deploy-payload.js so they can
# be unit tested (tests/deploy.test.js) — the API cannot verify them.

set -euo pipefail

: "${N8N_API_KEY:?set N8N_API_KEY (Settings > n8n API). Unavailable on the free trial: the n8n public API is not exposed until the account is upgraded off the free trial plan. See docs/superpowers/specs/2026-09-06-n8n-github-triage-analytics-design.md section 9.}"
BASE="${N8N_BASE_URL:-https://skomp.app.n8n.cloud}/api/v1"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHAPE="$ROOT/scripts/deploy-payload.js"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

api() { curl -sS -f -H "X-N8N-API-KEY: $N8N_API_KEY" "$@"; }

# Prints the id of the workflow with this name, or nothing if the instance has
# no such workflow.
id_of() {
  api "$BASE/workflows" | jq -r --arg n "$1" '.data[] | select(.name==$n) | .id' | head -1
}

# Creates or updates one workflow from a shaped body file. Prints the id it has
# on the instance afterwards; all progress output goes to stderr so the id can
# be captured.
deploy() {
  local body="$1" name id
  name=$(jq -r .name "$body")
  id=$(id_of "$name")

  if [ -n "$id" ]; then
    echo "updating $name ($id)" >&2
    api -X PUT -H 'Content-Type: application/json' --data @"$body" "$BASE/workflows/$id" > /dev/null
  else
    echo "creating $name" >&2
    id=$(api -X POST -H 'Content-Type: application/json' --data @"$body" "$BASE/workflows" | jq -r .id)
    echo "created $name ($id)" >&2
  fi

  printf '%s' "$id"
}

# --- the two sub-workflows, first, to learn their ids on this instance -------

node "$SHAPE" payload "$ROOT/workflows/ingest.json" > "$TMP/ingest.json"
ingest_id=$(deploy "$TMP/ingest.json")

node "$SHAPE" payload "$ROOT/workflows/report.json" > "$TMP/report.json"
report_id=$(deploy "$TMP/report.json")

# --- then the orchestrator, pointed at the ids that were just returned -------

node "$SHAPE" orchestrator-payload "$ROOT/workflows/orchestrator.json" \
  "$ingest_id" "$report_id" > "$TMP/orchestrator.json"
deploy "$TMP/orchestrator.json" > /dev/null

echo "done"
