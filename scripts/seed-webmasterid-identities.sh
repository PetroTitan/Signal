#!/usr/bin/env bash
# Runs once, after the f5-3 PR is deployed to signal.webmasterid.com.
# Calls signal.accounts.prepare via the HTTP MCP bridge for each of
# the 11 WebmasterID publishing identities, using review_status=confirmed
# so they land active (operator-authorized seed run, not unattended bot).

set -euo pipefail

ENDPOINT="${SIGNAL_MCP_ENDPOINT:-https://signal.webmasterid.com/api/mcp}"
TOKEN="${SIGNAL_MCP_TOKEN:?must set SIGNAL_MCP_TOKEN}"
PAYLOAD_FILE="$(dirname "$0")/seed-webmasterid-identities.json"

PRODUCT_ID=$(python3 -c "import json; print(json.load(open('$PAYLOAD_FILE'))['product_id'])")

python3 -c "
import json, os, urllib.request

endpoint = os.environ['ENDPOINT']
token = os.environ['TOKEN']
payload = json.load(open(os.environ['PAYLOAD_FILE']))
product_id = payload['product_id']

results = []
for ident in payload['identities']:
    args = {
        'platform': ident['platform'],
        'display_name': ident['display_name'],
        'handle': ident['handle'],
        'product_id': product_id,
        'voice_profile': ident['voice_profile'],
        'review_status': 'confirmed',
        'source_note': 'Seeded via signal.accounts.prepare batch run',
    }
    req = urllib.request.Request(
        endpoint,
        method='POST',
        headers={
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json',
        },
        data=json.dumps({'tool': 'signal.accounts.prepare', 'args': args}).encode(),
    )
    try:
        resp = urllib.request.urlopen(req)
        body = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = json.loads(e.read())
    summary = body.get('summary', '')
    acct = (body.get('data') or {}).get('account') or {}
    idempotent = (body.get('data') or {}).get('idempotent')
    results.append({
        'platform': ident['platform'],
        'ok': body.get('ok'),
        'idempotent': idempotent,
        'id': acct.get('id'),
        'summary': summary,
    })
    print(f\"{ident['platform']:15s}  ok={body.get('ok')!s:5s}  idempotent={idempotent!s:5s}  id={acct.get('id')}  {summary}\")

print()
print(f'created  : {sum(1 for r in results if r[\"ok\"] and r[\"idempotent\"] is False)}')
print(f'updated  : {sum(1 for r in results if r[\"ok\"] and r[\"idempotent\"] is True)}')
print(f'failed   : {sum(1 for r in results if not r[\"ok\"])}')
" ENDPOINT="$ENDPOINT" TOKEN="$TOKEN" PAYLOAD_FILE="$PAYLOAD_FILE"
