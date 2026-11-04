# Design: choose the region per query from the device ORI

Status: **proposed** (2026-11-04, Gordon Hallof with Claude). Not built. Background: `docs/AGENT-TCP-CONTRACT.md` §6b
(a CommSys request carries no region field; the ORI is the usable signal).

## Problem

`engine.processRequest` picks one region for every caller: the `/api/simulate` override, otherwise the global Settings
value (`src/engine.js:50`). Several agents can be connected at once (one TCP connection each, up to `TCP_MAX_CONNECTIONS`),
and each belongs to a test department in a particular state and interface. They should each get their own region's wording
**and** their own region's test records.

## What the request gives us

`Session/Authentication/ORI`: the ORI of the device the officer is logged in on. It was present in every real request
checked (6 of 6, from a test tenant's agent log). Its first two letters are the agency's state. It's absent when a provider's
AUTH configuration omits it, and on the Prismatic gateway path (the gateway rebuilds the request without Authentication).

## Design

### 1. Region resolution, per transaction, after parsing

```
override (/api/simulate region)          -> that region            reason "override"
else exact ORI in settings.regionByOri   -> mapped region          reason "ori"
else 2-letter prefix in settings.regionByOri -> mapped region      reason "state"
else                                     -> settings.region        reason "default" (or "default (no ORI)")
```

- Move the decision after `parseRequest` (`src/engine.js:83`) and before `maskAuth` blanks the ORI (`src/engine.js:85`).
  Read `t.auth.ori` from each parsed transaction; a request can carry more than one.
- Keep `txn.region` as today, and when a request mixes regions, record per-query `region` and `regionReason` on `txn.queries[]`
  as well.
- Pass the resolved region into `findRecords` (§3) and `applyRegion` (`src/engine.js:108` and `:112`).
- Normalise the ORI before lookup: trim, upper-case, strip anything that isn't A–Z or 0–9.

### 2. The mapping lives in Settings, not in the repo

- New setting `regionByOri`: an object, `{ "<ORI or 2-letter prefix>": "<region id>" }`, stored with the other settings
  (Postgres `kv` or `store.json`). Validate on save: keys are 2 letters (prefix) or 9 alphanumerics (ORI), values are
  `isRegion()`.
- **Real test ORIs never go in code, tests, seed data or docs.** They're real agency identifiers and this repo is public.
  Tests use invented ORIs (`XX0000000`, `ZZ1234567`).
- UI: a small table under Settings → Region (ORI or prefix, region, delete), and the global region relabelled
  "Default region".
- Add `regionByOri` to `DEFAULT_SETTINGS` (`src/seed.js:340`) as `{}`. `updateSettings` in `src/store.js` treats it as a
  replace-whole-object field.

### 3. Records tagged by region

- New optional record field `regions: ["LA_LEMS_OFML", ...]`.
  - **No `regions` (or empty) = shared:** the record matches in every region. Every existing seed record stays shared, so
    nothing changes until records are tagged.
  - With `regions`: the record matches only queries whose resolved region is in the list.
- `findRecords(records, entityType, fields, region)` (`src/matcher.js:75`) filters on it. Two records may share the same
  identifiers in different regions (the same synthetic plate answering differently in LA and FL). If both a shared record and a
  region-tagged one match, use the region-tagged one only (most specific wins).
- CSV import: new meta column `regions`, a `;`-separated list (`src/csv-import.js:33` `META_COLUMNS`).
- `allowlist()` (Prismatic path) is unaffected: it lists identifiers across all enabled records.

### 4. Logging and the call log

- The call log shows `region` and `regionReason` per call. **Never the ORI**: keep it masked (`src/mask.js`) and keep it out
  of `tcp-server.js` connection logs.
- A missing ORI isn't an error. It shows as "default (no ORI)".

## Tests to add (`node:test`)

- Exact ORI wins over prefix; prefix wins over default; unknown ORI → default; no ORI → "default (no ORI)".
- The `/api/simulate` region override still wins.
- The ORI is resolved before `maskAuth`; `txn.sent` and `txn.requestXml` still show `ORI` masked.
- A tagged record matches only in its region; untagged records match everywhere; tagged beats shared on the same identifier.
- Two TCP connections with different ORIs, with queries in flight at the same time, each get their own region's result on
  their own socket.
- CSV `regions` column round-trips; an invalid region in `regionByOri` or `regions` is rejected on save.
- `scripts/agent-conformance.mjs` still passes (it sends the invented ORI `XX0000000`, which resolves to the default region).

## Out of scope / later

- Choosing the region by TCP Proxy port or by REST API key (§6b, options 2–3); add one if an agent can't send an ORI.
- Per-region failure modes (e.g. one region "down"). Today ack/result modes stay global.
- Texas TLETS profile (`docs/HANDOFF.md`: not modelled).
