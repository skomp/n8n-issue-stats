#!/usr/bin/env bash
set -euo pipefail

: "${N8N_API_KEY:?set N8N_API_KEY (Settings > n8n API). Unavailable on the free trial: the n8n public API is not exposed until the account is upgraded off the free trial plan. See docs/superpowers/specs/2026-09-06-n8n-github-triage-analytics-design.md section 9.}"
BASE="${N8N_BASE_URL:-https://skomp.app.n8n.cloud}/api/v1"

for wf in workflows/*.json; do
  name=$(jq -r .name "$wf")
  id=$(curl -sf -H "X-N8N-API-KEY: $N8N_API_KEY" "$BASE/workflows" \
       | jq -r --arg n "$name" '.data[] | select(.name==$n) | .id' | head -1)

  if [ -n "$id" ]; then
    echo "updating $name ($id)"
    curl -sf -X PUT -H "X-N8N-API-KEY: $N8N_API_KEY" -H 'Content-Type: application/json' \
      --data @"$wf" "$BASE/workflows/$id" > /dev/null
  else
    echo "creating $name"
    curl -sf -X POST -H "X-N8N-API-KEY: $N8N_API_KEY" -H 'Content-Type: application/json' \
      --data @"$wf" "$BASE/workflows" > /dev/null
  fi
done
echo "done"
