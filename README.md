# dex_endpoints

A stand-in for the Commsys ConnectCIC service, for testing Mark43 Universal Search (federated search plus
the interface agent) without a real state or federal data source. It speaks the same XML the interface
agent sends, answers like Commsys does, and posts results back asynchronously. A web UI shows every call:
what was sent, and the formatted response.

**All data is synthetic.** Do not put real person, vehicle or case data in here. The service is meant to be
reachable from the internet, so set `API_KEY` and `ADMIN_PASSWORD` before pointing anything at it.

## How the real flow works (and what this mocks)

```
Federated Search --websocket--> interface agent --POST ConnectCicApi XML--> [this service]  (Commsys)
                                      ^                                          |
                                      +----- POST result XML to callback URL ----+   (async, 1 per result)
```

1. The interface agent POSTs a `ConnectCicApi` request (REST) or a SOAP `SendMessage` envelope. The
   transaction id and `Request/Id` are `<queryId>_<ENTITY>` (for example `01ABC..._PERSON`).
2. This service answers immediately with an acknowledgement (`TransactionResult` Succeeded).
3. After a delay it POSTs each matching result to the callback URL (the agent's
   `/interface-agent/v2/query-result`). The result's `Response/Request/Id` echoes the request id, which is
   how Federated Search ties the result to the query. SOAP requests get SOAP callbacks.

## Endpoints

| Path | Purpose |
| --- | --- |
| `POST /connectcic` (also `/commsys`) | The Commsys endpoint. Detects REST vs SOAP per request. |
| `GET /` | Web UI: call log, send test query, records, settings. |
| `GET /health` | Liveness. |

Auth on the Commsys endpoint: header `x-api-key: <API_KEY>` (the interface agent adds this header to its
outbound calls), or `Authorization: <API_KEY>` / `Bearer <API_KEY>`. Without `API_KEY` set the endpoint is open.
The UI and `/api/*` use HTTP Basic auth with any username and `ADMIN_PASSWORD` as the password.

## Configuration (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `API_KEY` | none (open) | Required value of `x-api-key` on the Commsys endpoint. |
| `ADMIN_PASSWORD` | none (open) | Basic-auth password for the UI and `/api/*`. |
| `CALLBACK_URL` | none | Initial callback URL (editable in the UI Settings tab). |
| `ALLOW_REQUEST_RESPONSE_URL` | `false` | Honour the `ResponseURL` inside a SOAP request. Off by default so callers cannot make the server POST to arbitrary URLs. |
| `DATABASE_URL` | none | Postgres connection string. When set, records, settings and the call log (last 300) persist there. Railway sets this when you reference the Postgres service. Set `PGSSL=true` if the database requires TLS. |
| `DATA_DIR` | `./data` | Used only when `DATABASE_URL` is not set: records and settings persist to `store.json` here (the call log is then in memory only). |
| `PORT` | `3000` | Set by Railway. |

## Spreadsheet import

Records tab, Import CSV (template: `public/records-template.csv`). One row is one result. Rows that share a
`record_name` become one record with several results, so a license row plus a wanted-person row for the same
person is one person. Columns: `entity_type` (required), `record_name`, `result_class`, `hit`, `system`,
`message_data`, then any Commsys field names; the identifier columns (name, license number, plate, VIN, serials)
are what a query matches on. Re-importing a file updates the same records instead of duplicating them.

## Gateway endpoints and the Prismatic flow

`GET /allowlist` and `POST /resolve` are for the Prismatic gateway (see `prismatic/README.md`). They need
`x-api-key: <API_KEY>` and return 503 if `API_KEY` is not set. `/allowlist` lists every identifying value in
the records; `/resolve` runs the same pipeline as `/connectcic` but returns the acknowledgement and the
results instead of calling anyone back. For this setup `API_KEY` should be a mock-only secret, not the real
Federated Search key.

## Deploy on Railway

1. New project, deploy from this repo (Nixpacks detects Node; `npm start` is the start command).
2. Set `API_KEY`, `ADMIN_PASSWORD`, and `CALLBACK_URL`.
3. Add a Postgres database to the project and give this service a `DATABASE_URL` variable that references it
   (`${{Postgres.DATABASE_URL}}`). Tables are created on first start. Without it, data lives in a file and is lost on redeploy unless you mount a volume and set `DATA_DIR`.
4. Generate a public domain. Point the interface agent at it:
   - `COMMSYS_ENDPOINT=https://<your-domain>/connectcic`
   - `COMMSYS_PROTOCOL=REST` (or `SOAP`)
   - the agent's outbound `x-api-key` header must equal `API_KEY` (it is the agent's `interface-agent.authorization` value).
   - set the callback URL here to the agent's reachable `/interface-agent/v2/query-result`.

## Test data

Seed records cover person (license only, license plus wanted hit, missing person), vehicle (clean and
stolen), firearm, boat and article. In the Records tab, edit a record as JSON, add new ones from a template,
or bulk-import an array. A record matches when an identifier in the request equals the record's (name
compares surname and first name; other identifiers ignore case and punctuation). Each entry in `results`
becomes its own callback. No match returns a `NoRecord` result (switchable in Settings).

Failure modes in Settings: ack as HTTP 503, SOAP fault, or never answered; results never sent, or a
Status "Down" message instead.

## Run locally

```
npm install
npm test
PORT=3000 npm start
```

## Known gaps

- Built from the interface agent's and Federated Search's code and test fixtures, not from a live Commsys.
  Real Commsys behaviour (auth scheme, segmenting, interface-specific `MessageData` formats) may differ.
- The legacy DEx path is a different protocol (a framed TCP socket with XML bodies) and is not included.
- Without `DATABASE_URL` the call log is in memory only (last 300 calls). Calls that were mid-delivery when the server restarted keep their last recorded state.
