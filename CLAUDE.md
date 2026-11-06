# CLAUDE.md

Guidance for Claude (and people) changing this repository. Read this first; `docs/RESPONSES.md` is the
reference for what the responses look like and why.

## What this is

A test double for Commsys (ConnectCIC) that a USx interface agent can talk to, with a web UI that shows every
call. Engineers use it to check the agent, Federated Search ingestion and the CAD/USx UI against **made-up data**.
Most work in this repo is **adjusting the responses** so they look like what a real Commsys interface returns.

## Rules that are not negotiable

1. **Synthetic data only.** Every name, plate, VIN, serial, address, SSN, ORI and case number in this repo is
   invented (999-prefixed SSNs, `TEST ST`, `MOCKORI..`, `TEST-0001`). Never copy real person, vehicle, case or
   agency data from an exemplar, a log, a ticket or a tenant. Copy the *shape* (field names, formats), invent the values.
2. **No secrets in the repo.** No keys, passwords, tokens, webhook URLs or internal hostnames in code, tests,
   docs or commit messages. Configuration comes from environment variables (see the README).
3. **Never log request or result contents.** The gateway, delivery steps and the TCP listener log counts, ids, entity types and status
   only. Credentials in request bodies (Password, UserName, ORI, SSN, Mnemonic...) are masked by `src/mask.js` before they reach the call
   log or database. Keep it that way (CJIS-style rule: no PII/CJI in logs, even synthetic, so the habit never slips).
4. **The gateway fails closed.** `prismatic/gateway-step.cjs` refuses any query whose identifying value is not on
   the allowlist (built from the records) or whose field name is not permitted. Do not loosen that to make a test
   pass; add the record or field deliberately instead.
5. **Tests must pass before every push** (`npm test`). Pushing to `main` redeploys the live service.

## How a call flows

Two ways in; both end in the same `processRequest` (`src/engine.js`), so records, regions, settings and the call log behave identically.

**TCP (the live path).** The interface agent runs in TCP mode and connects to this service as a client:

```
interface agent --TCP, ConnectCIC frames--> Railway TCP Proxy --> src/tcp-server.js (internal port TCP_PORT)
   request frame (0x01) -> ACK frame (0x10, same ackId) -> one 0x01 result frame per result (bare LawEnforcementTransaction)
   heartbeat: this service sends an empty 0x01 frame every TCP_HEARTBEAT_MS; each side ACKs the other's
```

**REST (older path, still deployed).** The agent POSTs ConnectCicApi XML:

```
interface agent --POST ConnectCicApi XML--> Prismatic gateway (code in prismatic/, not run from this repo)
   gateway: key check -> GET /allowlist -> rebuild a minimal request -> POST /resolve
   /resolve: match records -> build result XML (regions + derived fields) -> return ack + results as JSON
   gateway: returns the ack to the agent; a second flow POSTs each result to the agent's /v2/query-result
```

`POST /connectcic` is the direct HTTP variant (this service answers and posts callbacks itself). The TCP path does not use
Prismatic. The Prismatic gateway has an allowlist guard (rule 4); the TCP path has none and answers `NoRecord` for unknown values.

## Map of the code

| File | What it owns |
| --- | --- |
| `src/seed.js` | The seed test records (the data) and default settings. **`SEED_VERSION`** lives here. |
| `src/regions.js` | Region profiles: how each state's interface words results (interface names, dates, names, state codes...). |
| `src/normalize.js` | Derives `Normalized*` copies and name parts from plain fields, for every record. |
| `src/matcher.js` | Which identifiers a query can match on (`MATCH_KEYS`), name matching, the allowlist, the no-record result. |
| `src/xml.js` | Parsing requests, building acks and result XML, SOAP wrappers. `buildResultXml` fixes element order. |
| `src/engine.js` | The request lifecycle, the call log, delivery, the callback receiver. |
| `src/csv-import.js` | Spreadsheet import (one row = one result; rows sharing `record_name` merge). |
| `src/store.js`, `src/db.js` | Persistence: Postgres when `DATABASE_URL` is set, otherwise a JSON file. Seed upgrades. |
| `src/server.js` | HTTP routes, auth, the admin API; starts the TCP listener when `TCP_PORT` is set. |
| `src/tcp-server.js`, `src/tcp-frame.js`, `src/tcp-adapter.js` | The ConnectCIC TCP listener: frame codec, bare-vs-envelope conversion, per-connection ACK/heartbeat/result delivery. See README. |
| `docs/AGENT-TCP-CONTRACT.md`, `scripts/agent-conformance.mjs` | What the real interface agent requires of the TCP listener (from its source, with file references), and an independent agent stand-in that checks a running listener against it. Read before changing `src/tcp-*.js`. |
| `src/replay.js` | Replay: answers a request from a region with uploaded **captured, scrubbed reply sets** (match, region by device ORI, frames). Pure; wired into `tcp-server.js`; packs via `/api/replays`. Read `docs/REPLAY.md` first: a replayed region never falls back to generated results. |
| `src/label.js` | The `*** USx SIMULATION ***` first line on every reply's MessageData (replays and generated results). |
| `src/mask.js` | Masks credentials in request bodies before they reach the call log, database or UI. Keep new request paths going through it. |
| `public/index.html` | The whole web UI (one file, no build step). |
| `public/render.html`, `public/vendor/usx-parsing-embed.js` | The Records tab's **Render** view: one replay record shown the way Universal Search would, through the USx Parsing view. The vendor file is built in Gordon's `Projects/USx-Parsing` (`tools/build-embed.js`); never edit it here, copy a new build in. |
| `prismatic/` | The two Prismatic Code steps (gateway, delivery) and their build guide. |
| `scripts/check-fidelity.mjs` | Measures our results against the real Federated Search source. |
| `test/` | `node:test` suites. They run the real Prismatic step code against a real server instance. |

## "I want to change X" playbook

| Goal | Do this |
| --- | --- |
| Change a test person or vehicle | Web UI Records tab (no deploy), or a CSV import. To change the *shipped* seed, edit `src/seed.js` **and bump `SEED_VERSION`** (deployed instances refresh `seed-*` records only when it changes; custom records are kept). |
| Add or remove a field in a result class | Edit the result's `fields` in `src/seed.js`, bump `SEED_VERSION`. Confirm the name exists with `check-fidelity` (rule: it must be an element declared in Federated Search's `Response.java`). Update `REQUIRED` in `test/fidelity.test.js`. |
| Make a region word things differently | Edit its profile in `src/regions.js`. Only encode differences you can point to in an exemplar; say which one in a comment. Add or adjust a case in `test/regions.test.js`. |
| Add a region | Add a profile, keep `note` honest about how well-evidenced it is, add a test, run `check-fidelity --region NEW`, then update the Confluence page's region table. |
| Change derived `Normalized*` fields or name parts | `src/normalize.js` plus `test/fidelity.test.js`. Explicit values in a record always win. |
| Change a result's `MessageData` text | The record's `messageData` in `src/seed.js`. Today only the state code and `MOCKORI..` agency ids are region-swapped. |
| Support a new query identifier or query type | `src/matcher.js` (`MATCH_KEYS`, `IDENTIFYING_KEYS`), `src/requests.js` (`MESSAGE_TYPE`), `src/csv-import.js` if it is a column, **and** the lists at the top of `prismatic/gateway-step.cjs`. A test fails if the gateway's identifying list drifts from `IDENTIFYING_KEYS`. |
| Change what the gateway permits | Edit `prismatic/gateway-step.cjs`. **That code runs inside Prismatic**, not here: after merging, someone must paste it into the gateway step, publish a new integration version and upgrade the instance (see `prismatic/README.md`). |

## Current state and open points

Read `docs/HANDOFF.md` for the history and what is verified. Short version: the TCP path is deployed and answered a real query from a
test tool through Railway's TCP Proxy. A real interface agent has not yet been confirmed end to end against it.

## What "real" looks like (sources of truth)

All paths are inside a local checkout of the **federated-search** repository. Pass its path to
`node scripts/check-fidelity.mjs <path>`; the script reads these for you.

| Question | Where to look |
| --- | --- |
| What does a real result look like? | `simulation-exemplars/src/main/resources/simulated-responses/*.xml` (about 54, across CA, LA, FL, SD, KS, HI interfaces) |
| Which field names are valid? | `api/src/main/java/**/models/commsys/transactions/Response.java`: every `@XmlElement(name = ...)` |
| Which fields do result mappings read? | `api/src/main/resources/RESULTS_<PROVIDER>_<ENTITY>.json` (`sourceField` lists; only TN_TIES ships here) and `configurations/*.json` |
| What does a request look like? | `api/src/test/resources/data/commsys/request/*.xml`; request id is `<queryId>_<ENTITY>` |
| Which `Class` values exist? | `interface-agent/.../constants/Constants.java` (`CLASS_*`) |
| How does the agent parse and forward? | `interface-agent/src/main/java/com/mark43/ia/` (`ConnectCICController`, `ConnectCICService`, `domain/connectcic`) |

Limits to keep in mind: tenant result mappings come from a remote configuration service that is **not** in
those repos; the repos contain full result mappings for only two providers (TN_TIES, SD_CA_eSUN) and they read
the same fields; there are no TN response exemplars. Anything beyond that is inference. Say so in comments and docs.

## Verifying a change

```bash
npm test                                                        # all suites, a few seconds
node scripts/check-fidelity.mjs <federated-search path>          # GENERIC region
node scripts/check-fidelity.mjs <federated-search path> --all-regions
PORT=3000 npm start                                              # then open http://localhost:3000
```

The fidelity script exits non-zero if a result carries an element name Federated Search does not know and the
real exemplars do not carry either. "Common in exemplars, not ours" is a to-do list, not a failure.

## Deploy and operate

- Pushing to `main` redeploys on Railway. Env vars: `API_KEY`, `ADMIN_PASSWORD`, `DATABASE_URL`, `CALLBACK_URL`,
  `RECEIVER_TOKEN`, `ALLOW_REQUEST_RESPONSE_URL` (see README). Never set `API_KEY` to a real tenant key: it must be a
  mock-only secret known to the gateway.
- Postgres holds records, settings and the last 300 calls. Records you add in the UI survive deploys; edits to a
  `seed-*` record are replaced when `SEED_VERSION` changes, so copy a seed record before customising it.
- The Prismatic copy of the steps is separate from this repo. Repo changes to `prismatic/*.cjs` do nothing until
  they are pasted into Prismatic.

## Conventions

- Node 20+, ES modules, no TypeScript, no build step. Runtime dependencies are `express`, `fast-xml-parser` and `pg`;
  adding one needs a reason.
- Match the surrounding style. Comments explain why, not what. Keep functions small and pure where possible
  (`normalize.js`, `regions.js` and `csv-import.js` are pure and easy to test).
- Every behaviour change gets a test in `test/`. Prefer testing through `processRequest` or the real HTTP server
  over testing internals.
- Use `node:test` and `node:assert/strict`. Tests that need a server listen on port 0.
