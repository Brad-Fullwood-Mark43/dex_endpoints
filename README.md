# dex_endpoints

> Changing responses, or working on this repo with Claude? Start with `CLAUDE.md` and `docs/RESPONSES.md`.

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
| `RECEIVER_TOKEN` | none (receiver off) | Turns on the callback receiver (see below). A long random string; it is part of the receiver's URL and is never logged. |
| `ALLOW_REQUEST_RESPONSE_URL` | `false` | Honour the `ResponseURL` inside a SOAP request. Off by default so callers cannot make the server POST to arbitrary URLs. |
| `DATABASE_URL` | none | Postgres connection string. When set, records, settings and the call log (last 300) persist there. Railway sets this when you reference the Postgres service. Set `PGSSL=true` if the database requires TLS. |
| `DATA_DIR` | `./data` | Used only when `DATABASE_URL` is not set: records and settings persist to `store.json` here (the call log is then in memory only). |
| `PORT` | `3000` | Set by Railway. |
| `TCP_PORT` | none (off) | Turns on the TCP listener on this port. See the TCP section. |
| `TCP_HEARTBEAT_MS` | `30000` | Heartbeat interval; `0` disables. |
| `TCP_ALLOWED_IPS` | none (open) | Comma-separated IPs allowed to connect. |
| `TCP_MAX_CONNECTIONS` | `10` | Connection cap. |
| `TCP_RESULT_FORMAT` | `bare` | `envelope` wraps results in `ConnectCicApi`. |

## TCP listener (interface agent TCP mode)

Set `TCP_PORT` (for example `4500`) and the service also listens for ConnectCIC TCP frames, the transport the
interface agent's TCP mode (and legacy DEx) uses. The agent is the client and connects to this port; this service is
the Commsys server.

- Frame: `5A F0 C3 0F`, 4-byte total length, 8-byte header (header length, ackId, type, reserved), XML body, `C3 0F 5A F0`.
  Code: `src/tcp-frame.js`, taken from the DEx and agent frame classes.
- A request frame (type `0x01`) is answered with an ACK frame (`0x10`, same ackId), then each result is sent as its own
  `0x01` frame holding a bare `<LawEnforcementTransaction>` with `Response/Request/Id` echoing the request id. The agent
  ACKs those. Both a bare request and the `ConnectCicApi` envelope are accepted (`src/tcp-adapter.js`).
- This service sends an empty ack-required frame every `TCP_HEARTBEAT_MS` (default 30000, `0` = off) and ACKs the agent's.
- The same records, region, and Settings (ack mode, result mode, delays) apply. Ack mode `http503` or `soapFault` sends a
  NAK, `timeout` sends nothing. Calls show in the web UI with protocol `TCP`.
- Not supported: encryption (an encrypted frame is NAKed). The test tenant runs without a key.
- Credentials (Password, UserName, UserAlias, ORI, OriginatingAgencyORI, SSN, Mnemonic) are masked in the call log, the
  database and the UI, and not echoed in results.
- There is no authentication on this port. It only serves the synthetic records. `TCP_ALLOWED_IPS` (comma separated)
  restricts who may connect; `TCP_MAX_CONNECTIONS` (default 10) caps connections.
- `TCP_RESULT_FORMAT=envelope` sends the results wrapped in `ConnectCicApi` instead of bare. Bare is what the agent's TCP
  reader parses for the query id; keep it unless a packet capture shows otherwise.

On Railway: enable TCP Proxy for the service with internal port `4500` (Settings, Networking). Railway assigns a public
`<name>.proxy.rlwy.net:<port>`; give that host and port to the agent's `tcp-connections` entry. Deploys cut open TCP
connections, so the agent must reconnect. Check the proxy without an agent:
`node scripts/tcp-client.mjs <host> <port>`.

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

## Callback receiver (stand-in for the interface agent)

To test delivery without a real agent, set `RECEIVER_TOKEN` and point the gateway's Callback URL at
`https://<this service>/receiver/<RECEIVER_TOKEN>/interface-agent/v2/query-result`. It accepts the results the
way the agent's `/v2/query-result` does (REST or SOAP), replies with a `Succeeded` acknowledgement, shows each
callback in the call log, and marks the matching results on the original call as delivered. The delivery step
cannot send headers, so the secret is in the path; with `RECEIVER_TOKEN` unset, or a wrong token, the route is a
404. Anyone with the URL can add entries to the log, so treat the URL as a secret and rotate the token if it leaks.

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

Regions: Settings has a Region choice (CA CLETS/eSUN, LA LEMS, FL, SD, KS, HI, TN) that rewords results the way that
state's interface does. See `docs/RESPONSES.md` for exactly what each region changes and how well each is evidenced.

Result fidelity: results carry the field names real Commsys responses use (checked against the interface
agent's and Federated Search's exemplar responses). Normalized copies and split names (`NormalizedName`,
`NameFirst`, `NormalizedBirthDateYear`, `NormalizedAddress`, ...) are derived automatically from the plain
fields for every record, including CSV imports and UI edits; a value you set explicitly is never overridden.
Seed records are versioned (`SEED_VERSION` in `src/seed.js`): when the seed changes, existing deployments
refresh the records whose ids start with `seed-` and keep everything you added or imported. Edits made to a
seed record itself are replaced, so copy a seed record to a new one before customising it.

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
- The TCP listener is built from the DEx and agent frame code, not from a packet capture of a real agent. The exact request
  bytes (bare or enveloped), heartbeat interval and result framing still need confirming against a capture.
- The legacy DEx path uses the same frame transport; its request and response XML are not modelled separately.
- Without `DATABASE_URL` the call log is in memory only (last 300 calls). Calls that were mid-delivery when the server restarted keep their last recorded state.
