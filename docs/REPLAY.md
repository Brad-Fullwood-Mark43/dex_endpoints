# Replay: capture-derived reply sets per USx region

Status: **built, partly verified** (2026-11-04, Gordon Hallof with Claude). `src/replay.js` and `test/replay.test.js` were run
(8/8 pass), and the LA_LEMS pack was checked against `replay.js` (32/32 records answer their own query, 104 frames well formed).
**The wiring in `tcp-server.js`, `server.js`, `engine.js` and `store.js` has not been run**: Gordon's side couldn't install
this repo's dependencies. First step for Brad's Claude: `npm test`, then the manual check in "Verify" below.

## Why

A USx region must be represented **exactly** as the real CommSys server and state switch do (Gordon, 2026-11-04). Records
built from exemplars (`src/seed.js`) are not that quality. Replay sends reply sets **captured from a real CommSys talking to
a real state switch**, with every person and vehicle value replaced by a realistic fake and every photo blurred. Nothing is
generated.

## How it works

```
TCP request -> readRequest() -> device ORI -> settings.regionByOri -> region
   region has replay records?  no  -> the existing pipeline (processRequest), unchanged
                               yes -> findReplay(): the best matching record in that region
                                        match    -> ACK, then each captured <Response> as its own frame, at its captured spacing,
                                                    Request/Id set to the incoming id (replayFrames)
                                        no match -> ACK, then the query catalog (below) headed "NO TEST RECORD MATCHES
                                                    THIS QUERY", call log replay id catalog-<region>-no-match, noMatch true
                                                    (a certified region never falls back to generated results)
```

- **Region:** `settings.regionByOri` maps a device ORI (exact, 9 characters) or a 2-letter state prefix to a USx region name
  (`LA1000001 → LA_LEMS`). It's set in Settings (`PUT /api/settings`, validated); real ORIs never go in code. See
  `docs/REGION-BY-ORI.md`. Replay uses this map. The global `region` setting still drives the old pipeline.
- **Match rules** (`src/replay.js` `matches`), on the CommSys request fields:
  - `OLN`: `OperatorLicenseNumber` equal, ignoring case and **leading zeros** (LA DMV echoes an 8-digit OLN as 9 digits with a
    leading 0); `State` equal, where in-state means no `<State>` (the agent sends none for in-state queries) or the home state.
  - `NAME_DOB`: `Name` (`LAST, FIRST M`) or `NameLast`/`NameFirst`; last and first equal; middle compared by initial only when
    both have one; `BirthDate` the same date, in either order (`YYYYMMDD` or `MMDDYYYY`, with or without `-`; TX_TLETS requests send
    `MMDDYYYY`, packs store `YYYYMMDD`); `SexCode`: a record with one needs the request to send the same sex (first letter); a record without one
    matches with or without a sex in the request; `State` as above.
  - `PLATE`: `LicensePlateNumber` equal (case-insensitive); `State` as above. Plate year and type are not matched.
  - `VIN`: `VehicleIdentificationNumber` equal.
  When several records match, the one with the most replies (then the most full envelopes) wins.
- **Frames:** each reply is a bare `<LawEnforcementTransaction version="1.0"><Transaction><Response>…` (what the agent's TCP
  reader expects; see `docs/AGENT-TCP-CONTRACT.md` R5/R6). If the captured reply has `Response/Request/Id` it is replaced;
  replies Federated Search stored as message text only get one inserted. A photo Federated Search had moved out of a
  text-only reply goes back as `<Image><ImageData>` at the end of the `<Response>` (placement inferred: that envelope wasn't captured).
- **Not captured, so not reproduced:** the outer `Session` block (`IntTransId`, segment counters) CommSys puts around a reply.
  The agent doesn't read it.
- **Failure modes** (`ackMode`, `resultMode`) don't apply to replayed regions; captured behaviour is what you get.

## Query catalog (plate X1X1)

A vehicle plate query for `X1X1` (any state, case and spaces ignored) from a device whose ORI maps to a region (see
`regionByOri`) is not matched against the records. Instead it gets one reply listing every query that region can answer:
OLN, name / DOB, plate and VIN sections, one line per distinct query, with the State to send (`TX or blank` = in-state),
the number of replies and `HIT` when a reply carries `<Detected>1</Detected>`. Testers search X1X1 to see what to search. A query that matches no record in the region gets the same list, headed
"NO TEST RECORD MATCHES THIS QUERY" (entity PERSON or VEHICLE from the request's fields).

- The reply uses one of the region's own captured full envelopes (a neutral `Response` / `Accept` class first, never a
  data class), with the list as `MessageData`, `<System>Mark43 TEST DATA Response</System>` (the source label USx shows),
  `<Detected>0</Detected>` and no image, so Universal Search parses it the
  way it parses that region. A mapped region with no replays yet gets a plain envelope saying none are loaded.
- The call log shows it as VEHICLE, replay id `catalog-<region>`, `CATALOG replay`.
- An unmapped ORI is not a region, so X1X1 from it goes to the generated pipeline like any other query.
- Code: `isCatalogRequest`, `catalogText`, `catalogRecord` in `src/replay.js`; wired in `src/tcp-server.js`.

## Packs

A pack is one region's records, built outside this repo from scrubbed captures (Gordon's `Projects/USx-Railway-Mock`, steps
extract → scrub → verify → pack). **Packs are never committed here**: they're uploaded to the running service.

```
POST   /api/replays            body: the pack JSON  -> replaces that region's replay records (validated: validatePack)
POST   /api/replays?mode=merge same body             -> adds to the region; a record with the same id or match replaces
                                                        the old one; the region's other records stay
GET    /api/replays            summary: id, region, entityType, match, reply counts
GET    /api/replays/:region/pack the region's records as a re-importable pack (download <region>-<UTC>.json; 404 if none)
DELETE /api/replays/:region    removes a region's replay records
GET    /api/replay-records/:id one full replay record (the Records tab editor)
PUT    /api/replay-records/:id replaces one record (validated like a pack; id and region fixed; marked edited: true)
DELETE /api/replay-records/:id removes one record
```

Packs exported by the USx Railway Capture browser extension (Gordon's `Projects/USx-Railway-Capture`: captures or pasted
replies, scrubbed in the browser) are imported with **Import replay pack** on the Records tab, which uses `mode=merge`.
Either upload maps the pack's `testOri` to its region when that ORI isn't mapped yet (an existing mapping is never
changed). The replay routes accept up to 25 MB (photos); the rest of `/api` keeps its 2 MB limit.

The Records tab shows one set at a time, chosen under **Show**: the original (synthetic) records, a region with replays, or
one of the USx regions with none yet (`USX_REGIONS` in `src/replay.js`, each with its invented test ORI, sent as
`usxRegions` in `/api/state`). A region view has **Import replay pack** (it refuses a pack for a different region),
**Export pack** (`GET /api/replays/:region/pack`), a summary, filters (query type, source, HIT only, search) and
**Delete all <region> replays**. Each replay row has **Render** (a modal with `render.html?id=…`: the replies turned into Universal Search's federated-search shapes and shown with the USx Parsing view, in a frame) and **Edit** (the JSON editor, opened under the row). Each replay row shows kind, state, reply count,
photo, envelope (full / text only) and EDITED tags, and a red HIT tag after the state when any reply has
<Hit><Detected>1</Detected></Hit> (`replayHasHit` in `src/replay.js`, worked out on every listing, so uploads, imports and edits
are always reflected; text-only replies have no envelope and never count). The editor is the same JSON editor; blurred photos show as a placeholder
and are put back on save. An edited record is no longer exactly as captured, hence the tag. Uploading the region's pack
again replaces its records, edits included.

Record shape:

```json
{ "id": "replay-la_lems-…", "type": "replay", "region": "LA_LEMS", "provenance": "capture", "certified": true,
  "entityType": "PERSON", "match": { "kind": "OLN", "OperatorLicenseNumber": "…", "State": null },
  "replies": [ { "offsetMs": 1000, "dataSource": "OSW", "fullEnvelope": true, "response": "<Response>…</Response>", "attachedImage": null } ] }
```

Stored like records: Postgres `kv` key `replays`, or `store.json` without a database. Note: `/api` has a global 2 MB JSON limit
(`server.js`); the LA_LEMS pack is about 340 KB. A pack over 2 MB needs that limit raised.

## Verify (for Brad's Claude)

1. `npm test`: everything passes, including `test/replay.test.js`.
2. Start locally with `TCP_PORT=4500`. Set `regionByOri` to `{ "XX1000001": "XX_TEST" }`, then POST a small synthetic pack for
   `XX_TEST` (one OLN record with two replies, built like the fixtures in `test/replay.test.js`).
3. `node scripts/agent-conformance.mjs 127.0.0.1 4500 --ori XX1000001 --field OperatorLicenseNumber=<the record's OLN> --expect 2`. Expect R1–R10 PASS, the two
   replies in order, and the call log showing protocol TCP, region `XX_TEST` by `ori`, state `delivered`.
4. Same, with an OLN not in the pack: one reply, the query catalog headed "NO TEST RECORD MATCHES THIS QUERY" (`--expect 1`),
   call log replay id `catalog-xx_test-no-match`, `noMatch: true`.
5. A request whose ORI isn't in `regionByOri`: the old pipeline answers, exactly as before.
6. Suggested test to add: the above as a `node:test` case against `createTcpServer()` on port 0 with an in-memory store.

## Not done

- UI: `regionByOri` has no editor yet (use `PUT /api/settings`).
