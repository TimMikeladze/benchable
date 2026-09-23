# HTTP API (no Node, no MCP)

Send `Authorization: Bearer $BENCHABLE_KEY` with every request. Add `Accept: text/plain` to get a
compact digest instead of JSON. Errors come back as `{ "error": { "code", "message" } }`.

```bash
# A tool's own output, format detected
curl -sS -X POST "$BENCHABLE_URL/api/v1/import?label=baseline&branch=main" \
  -H "Authorization: Bearer $BENCHABLE_KEY" -H "Accept: text/plain" \
  --data-binary @bench.json

# Native payload
curl -sS -X POST "$BENCHABLE_URL/api/v1/runs" -H "Authorization: Bearer $BENCHABLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"label":"after","metrics":{"build.time_ms":4210},"idempotencyKey":"my-retry-key"}'

# Attach a file (the body is the raw bytes)
curl -sS -X POST "$BENCHABLE_URL/api/v1/runs/$RUN_ID/artifacts?name=flame.svg&kind=flamegraph" \
  -H "Authorization: Bearer $BENCHABLE_KEY" --data-binary @flame.svg

# Comment with the conclusion
curl -sS -X POST "$BENCHABLE_URL/api/v1/comments" -H "Authorization: Bearer $BENCHABLE_KEY" \
  -H "Content-Type: application/json" -d "{\"runId\":\"$RUN_ID\",\"body\":\"Automated analysis: …\"}"
```

Ingest responses include `runId`, `url` (the run page), `shareUrl` (only when the project is
shared), and a per-metric `verdict`, `deltaPct`, `reason` and `significance`. They also set these
headers: `x-benchable-run-id`, `x-benchable-run-url`, `x-benchable-regressions` and
`x-benchable-budget-failures`.

Other endpoints: `GET /api/v1/summary`, `GET /api/v1/runs`, `GET /api/v1/runs/{id}`,
`GET /api/v1/compare?base=&head=`, `GET /api/v1/regressions`, and `GET /llms.txt` for the full
list.

## Login without the CLI

1. `POST /api/v1/connect` with `{"client":"other"}` returns `deviceCode`, `userCode` and
   `verificationUrl`.
2. Show the user the URL and code.
3. Poll `POST /api/v1/connect/token` with `{"deviceCode":"…"}` every 2 seconds. You get
   `pending` until the user approves, then `approved` with the `key`, exactly once.
