# The interface agent's TCP contract (what the listener must do)

Written 2026-11-04 by Gordon Hallof's Claude for Brad and his Claude. In the agent's TCP mode the **USx
interface agent is the client** and this service plays **CommSys ConnectCIC** (the server). This file is
the agent's side of that conversation, taken from the agent's source, so the listener can match it
exactly. Each requirement says where in the agent it comes from and whether `src/tcp-*.js` (as of
commit `f1df566`, after the end-to-end test with a real agent) already meets it.

Check a running listener against it with `scripts/agent-conformance.mjs` (section 6).

> **For Claude:** the agent's source is the authority, not this file. Every claim below names the file it
> comes from. Before changing behaviour because of this document, re-read that file in a current checkout
> of `mark43/federated-search`. The agent moved quickly in late October 2026; see section 1 for the versions
> this was read from, and section 8 for how to verify.

---

## 1. Which agent this describes

| | |
| --- | --- |
| Source | `mark43/federated-search`, `interface-agent/src/main/java/com/mark43/ia/tcp/` (+ `service/WebsocketService.java`, `configuration/properties/TcpProperties.java`, `src/main/resources/application.yml`) |
| Read at | `main` `198c85af` (2026-11-04) and release tag **`3000.30`** (`70f28295`, 2026-10-28) |
| TCP added | RND-57457, PR #2494 (2026-10-28), first released in `3000.30` |
| Later fix | **RND-81401, PR #2536, commit `87a681e7` (2026-10-29): NOT in `3000.30`** (see the warning below) |

> **Version warning.** On `3000.30` the agent stores a TCP result but never marks the query SUCCESS.
> The query stays IN_PROGRESS and the stuck-query finalization job later fails it, even though the result
> is stored. PR #2536 adds the SUCCESS update (`IncomingFrameHandler` → `ConnectCICService.markQueryResultsSuccessful`).
> The demo tenant's agent needs a build that contains `87a681e7` (the first release after `3000.30`, or a
> build of `main`). The end-to-end test in `docs/HANDOFF.md` proves results arrive and render; to confirm the image has the fix,
> check that the test query's status is SUCCESS a few minutes later rather than failed by the stuck-query job.

### Agent configuration (application.yml, `commsys.tcp.*`; same in `3000.30` and `main`)

| Env var | Default | Meaning |
| --- | --- | --- |
| `COMMSYS_TCP_ENABLED` | `false` | `true` switches the agent from WSI (HTTP) to TCP. |
| `COMMSYS_TCP_HOST` / `COMMSYS_TCP_PORT` | none | Where it connects: the Railway TCP Proxy host and port. There is no default port. |
| `COMMSYS_TCP_ENCRYPTION_KEY` | blank | Blank = plaintext frames. Otherwise exactly 16 characters, used as raw UTF-8 bytes (not Base64). **Keep it blank for this service** (see R8). |
| `COMMSYS_TCP_SOCKET_TIMEOUT_SECONDS` | 90 | Silence this long and the agent drops and reconnects. |
| `COMMSYS_TCP_ACK_TIMEOUT_SECONDS` | 30 | How long it waits for the ACK of a query. |
| `COMMSYS_TCP_HEARTBEAT_INTERVAL_SECONDS` | 30 | Its keep-alive interval when idle. |
| `COMMSYS_TCP_CONNECT_TIMEOUT_MS` | 10000 | Connect timeout. |
| `COMMSYS_TCP_MAX_FRAME_BYTES` | 16777216 | Largest frame it will read. |

**One connection per agent** (the agent is deployed one per department; `TcpConnectionManager`). The
`tcp-connections` list with a per-department entry and a default port of 5000, mentioned in
in the README (and in earlier local notes), comes from the older branch `origin/feat/RND-57457-wsi-tcp`
and is **not** what `3000.30` or `main` read. With TCP on, `COMMSYS_ENDPOINT` / `COMMSYS_RESPONSE_URL`
(the WSI path and its callback) are unused.

---

## 2. The conversation, end to end

```
agent                                                     this service (CommSys)
  | TCP connect to COMMSYS_TCP_HOST:PORT                       |
  |----------------------------------------------------------->|
  |                    (real CommSys) Status frame on connect  |   optional, see R9
  |<-----------------------------------------------------------|
  | 0x01 ackId=n  body = bare <LawEnforcementTransaction> query|
  |----------------------------------------------------------->|
  |                              0x10 ACK ackId=n (empty body) |   within 30 s (R2)
  |<-----------------------------------------------------------|
  |      0x01 ackId=m  body = bare <LawEnforcementTransaction> |   one result per frame (R5, R6)
  |<-----------------------------------------------------------|
  | 0x10 ACK ackId=m                                           |
  |----------------------------------------------------------->|
  |   ... more results ...                                     |
  | 0x01 ackId=43/43 empty (keep-alive, every 30 s when idle)  |
  |----------------------------------------------------------->|
  |                                         0x10 ACK 43/43     |   (R3)
  |<-----------------------------------------------------------|
```

The agent then wraps each result in `ConnectCicApi` itself (`ConnectCicPayload.wrapForApi`) and posts it
to Federated Search as the query's `rawResultContent`, then marks the query SUCCESS (with #2536). On the
TCP path, Federated Search never sees the bare form.

---

## 3. Requirements

Ids match `scripts/agent-conformance.mjs`. "Ours" is the state of `src/tcp-*.js` at `f1df566`.

| Id | Requirement | Agent source | Ours |
| --- | --- | --- | --- |
| R1 | **Frame layout**, big-endian: `5A F0 C3 0F` · int32 total length **including** both markers · int16 header length `8` · 2-byte ackId · 1-byte type · 3 reserved bytes (send `00 00 00`) · body · `C3 0F 5A F0`. The agent accepts a header length from 5 up and rescans for a start marker after any bad frame. | `tcp/ConnectCicFrame.java`, `tcp/ConnectCicReaderRunnable.java` | Meets it |
| R2 | **ACK every query frame** (types `0x01`/`0x03`) with a `0x10` frame carrying **the same ackId** and an empty body, **within 30 s**. Otherwise the query fails with "CommsYS did not acknowledge the query". | `tcp/TcpConnection.sendMessage` | Meets it |
| R3 | **ACK the agent's keep-alive**: an empty `0x01` frame with ackId **43/43** (`0x2B2B`) every 30 s when idle. Query ackIds skip 43/43. | `tcp/ConnectCicWriterRunnable` (`HEARTBEAT_ACK_ID`), `TcpConnection.nextAckId` | Meets it (empty frame → ACK) |
| R4 | **Never be silent for 90 s.** The agent sets `SO_TIMEOUT` 90 s; on timeout it treats the link as half-open and reconnects (5 s delay). The ACK of its own keep-alive counts as traffic, and so do our heartbeats. | `ConnectCicReaderRunnable` (`SocketTimeoutException`), `TcpConnection.connectLoop` | Meets it (`TCP_HEARTBEAT_MS` 30000) |
| R5 | **Result body = a bare `<LawEnforcementTransaction version="1.0">`**, root element exactly that. A `ConnectCicApi` envelope is **dropped**: Jackson ignores the root name, finds no `Transaction`, so there is no query id. | `IncomingFrameHandler.handleMessageFrame` + `extractQueryId`, `tcp/model/ResponseLawEnforcementTransaction` | Bare by default ✔. **`TCP_RESULT_FORMAT=envelope` breaks every result**: remove it or keep it only as a negative test. |
| R6 | **Correlation:** the first `Transaction/Response/Request/Id` that isn't blank must equal the request's `Request/Id` (echo it exactly, whatever its form: tenants on the configuration-driven handlers (`CommsysWsiOutgoingMessageHandler`) send the **bare 26-character query id**, as seen in a real agent log on 2026-11-04; only the older `DefaultConnectCicApiService` path appends `_<ENTITY>`. Derive the entity from `MessageType` when there is no suffix, as `matcher.entityTypeOf` already does). The whole frame body becomes that query's one stored result. | `IncomingFrameHandler.extractQueryId` | Meets it (request id echoed) |
| R7 | **One result per frame.** Several `<Response>` elements in one frame are stored as a single result under the first Request/Id. A record plus its photo should be two frames, each with the Request/Id. | as R6 | Meets it (one frame per result) |
| R8 | **Encryption** (only if a key is set): body = random 16-byte IV + AES-128-CBC/PKCS5 ciphertext, key = 16 UTF-8 bytes. With a key, the agent sends `0x03` and **refuses plaintext message frames**. Without one, it sends `0x01` and can't read `0x03`. | `tcp/ConnectCicHelper.encrypt/decrypt`, `IncomingFrameHandler.acceptPlaintextFrame`, `TcpProperties.encryptionKeyBytes` | Not supported; encrypted frames are NAKed. Fine if `COMMSYS_TCP_ENCRYPTION_KEY` is blank. With a key, every query fails "CommsYS rejected the frame (NAK)". |
| R9 | **Status frames** (what real CommSys pushes on connect and periodically): a bare LET whose `Response` has `MessageType=Status`, `Interface`, `Status`, `TransManStatus`. The agent sends them to FS as the **CommSys heartbeat** (`HeartbeatService.sendCommsysHeartbeat` → `COMMSYS: "<Interface>, <Status>, <TransManStatus>"`), never as a result. | `IncomingFrameHandler.handledAsStatusMessage`, `tcp/model/Response` (`@JacksonXmlProperty(localName="Interface")`) | **Not sent.** Results still work, but FS never gets a CommSys health signal for the tenant. Recommended (section 4, G3). |
| R10 | **NAK (`0x11`) only to fail a query on purpose:** the agent fails that query with "CommsYS rejected the frame (NAK)". | `IncomingFrameHandler` NAK case | Used for ackMode `http503`/`soapFault` ✔ |
| R11 | **The request the agent sends** is a bare `<LawEnforcementTransaction>` (the agent strips the FS `ConnectCicApi` envelope; only the first LET is sent; no XML declaration). `Session/Id` is the device identifier (FS rule CS-002: filled from the device name). `Authentication` carries the device's real `UserName`, `Password`, `SSN`, `OriginatingAgencyORI`, `ORI`, `Mnemonic`, `DeviceId`, `DeviceAlias`, `UserAlias`, `Agency`. `Request` holds `MessageType`, the query fields and `Id`. Don't depend on element order. | `service/WebsocketService` (line ~116, `ConnectCicPayload.unwrapIfWrapped`), FS `DefaultConnectCicApiService`, fixtures `api/src/test/resources/data/commsys/request/*.xml` | Accepted (`tcp-adapter.toEnvelope`). Masked by `src/mask.js` ✔. Use dummy credentials on the demo tenant anyway. |
| R12 | **Reconnects:** on any close or read failure the agent fails pending queries and reconnects every 5 s. A query sent while it reconnects fails at once with "No active CommsYS TCP connection; the agent is reconnecting". | `TcpConnection.connectLoop`, `sendMessage` | Railway redeploys cut the socket. Don't deploy during a demo. |

---

## 4. Gaps and suggestions for `src/tcp-*.js`, most useful first

- **G1. Config names in the docs.** The README "TCP listener" section says to give the host
  and port to "the agent's `tcp-connections` entry" (port default 5000). The released agent reads
  `COMMSYS_TCP_ENABLED=true`, `COMMSYS_TCP_HOST`, `COMMSYS_TCP_PORT`, and `COMMSYS_TCP_ENCRYPTION_KEY` must be blank
  (section 1). I corrected the README sentence on this branch.
- **G2. Agent version.** The demo agent needs `87a681e7` (section 1); otherwise queries end failed despite stored results.
- **G3. Send Status frames.** On connect, and then every ~60 s (well under the 90 s socket timeout), send:
  ```xml
  <LawEnforcementTransaction version="1.0"><Session><Id>MOCK</Id></Session><Transaction><Response>
    <MessageType>Status</MessageType><Interface>MOCK_INTERFACE</Interface><Status>Up</Status>
    <TransManStatus>Connected</TransManStatus></Response></Transaction></LawEnforcementTransaction>
  ```
  This mirrors real CommSys and gives FS the CommSys heartbeat. A Settings toggle to send `Status=Down`
  would let a demo show an interface outage. The `Interface` value could follow the region profile's `interface`.
- **G4. `TCP_RESULT_FORMAT=envelope`** silently loses every result (R5). Remove it, or rename it and say it's a negative test.
- **G5. `resultMode: status` over TCP.** `buildStatusXml` produces `MessageType=Status`, which the agent treats as a
  heartbeat (R9), so the query gets no result and stays IN_PROGRESS until FS's stuck-query job fails it. That may be
  the outage you want to show; say so in Settings, since over REST it behaves differently.
- **G6. `ackDelayMs` doesn't apply over TCP** (`processRequest` with `deliver: false` skips it). To show a slow switch,
  sleep before the ACK, under 30 s. `ackMode: timeout` already covers "no ACK" (the agent fails it after 30 s).
- **G7. Images.** If photo results are added (the `Image` class, `DLPHOTO`), send each as its own frame with the
  Request/Id (R7), keep frames under 16 MB, and note that FS rule CS-006 expects image transactions to carry
  several XML roots.
- **G8. Frame bounds.** Our decoder caps incoming frames at 1 MB (the agent caps at 16 MB). That's fine for requests,
  which are small. Nothing to change.

---

## 5. Answers to "Not verified yet" in `docs/HANDOFF.md` (from the agent's source)

| Question | Answer (from the agent's code) |
| --- | --- |
| Exact request bytes: bare or envelope? | **Bare** `<LawEnforcementTransaction>`, no XML declaration (`WebsocketService` → `ConnectCicPayload.unwrapIfWrapped`). If stripping fails the agent sends the payload unchanged (an envelope), so keep accepting both. |
| Heartbeat interval the agent expects | It sends its own every 30 s when idle (ackId 43/43) and drops the link after **90 s** of silence. Our 30 s heartbeat is fine. |
| Does FS accept a bare result as `rawResultContent`? | Not applicable: the agent re-wraps bare results in `ConnectCicApi` before posting (`ConnectCicPayload.wrapForApi`). Send **bare**; an envelope is dropped (R5). |
| Agent = TCP client to host:port? | Yes. `TcpConnection.connect` opens one socket to `COMMSYS_TCP_HOST:PORT`. |
| Released version / env flag | TCP is in `3000.30`, flag `COMMSYS_TCP_ENABLED`; the SUCCESS-status fix is only after `3000.30` (section 1). |
| Cluster egress | Needs outbound TCP to the Railway proxy host:port. Earlier internal TCP work hit network routing problems (see FDSE's RND-61351 notes in `mark43/fdse-context`, internal), so **test from the agent's pod first**, e.g. `nc -vz <proxy-host> <port>`, then run section 6 from the same place if Node is available. |

---

## 6. Checking a listener: `scripts/agent-conformance.mjs`

An agent stand-in that doesn't share code with `src/tcp-frame.js`, so it can't share a bug with it. It does what
the agent does (ackIds skipping 43/43, keep-alives, ACKing ack-required frames, rejecting plaintext on an
encrypted link, extracting the query id the way `IncomingFrameHandler` does) and reports R1 to R10 as
PASS/FAIL/WARN. Exit code 1 means a real agent would fail or drop something.

```bash
# local
TCP_PORT=4500 PORT=3000 npm start
node scripts/agent-conformance.mjs 127.0.0.1 4500
node scripts/agent-conformance.mjs 127.0.0.1 4500 --entity VEHICLE --field LicensePlateNumber=STL9999 --expect 2
node scripts/agent-conformance.mjs 127.0.0.1 4500 --field "Name=NOBODY, NONE" --expect 1     # NoRecord result
node scripts/agent-conformance.mjs 127.0.0.1 4500 --idle 100 --heartbeat 30                  # R3/R4: survives idling past the 90 s timeout
# Railway (TCP Proxy host and port from Settings, Networking)
node scripts/agent-conformance.mjs <name>.proxy.rlwy.net <port> --queries 3
# machine-readable
node scripts/agent-conformance.mjs 127.0.0.1 4500 --json
```

Bodies are not printed unless `--show` (CLAUDE.md rule 3). The script was verified on 2026-11-04 against a
scratch server with deliberate faults: correct behaviour passes, and each of these is caught: envelope result,
wrong Request/Id, NAK, missing ACK (fails after 30 s, as the agent does), plaintext result on an encrypted link,
plus status frames and AES in both directions. **It has not been run against `src/tcp-server.js`**: Gordon's
side couldn't install this repo's dependencies. First step for Brad's Claude: run it against a local listener.

Suggested test (not added, because it couldn't be run here): in `test/tcp.test.js`, start `createTcpServer()` on
port 0, spawn `node scripts/agent-conformance.mjs 127.0.0.1 <port> --wait 3` with `child_process.spawnSync`,
and assert exit code 0. Add `--field "Name=NOBODY, NONE"` for the NoRecord path, and set ack mode `http503`
expecting exit 1 with R10 failed.

---

## 6b. The request says nothing about the DEx region

Checked 2026-11-04 against six real requests in a test tenant's agent log (values not copied) and the FS source.
**No element in a CommSys request names the region, provider or interface.** A request carries only:

| Part | Content | Region signal |
| --- | --- | --- |
| `Route/Source`, `Session/Id` | the device name | none |
| `Route/Destinations/Destination` | always `ConnectCic` | none |
| `Session/Authentication` | per the provider's AUTH configuration; on that tenant `UserName`, `ORI`, `Mnemonic` | **indirect:** an ORI's first two letters are the agency's state |
| `Transaction/Request` | `MessageType`, `Id`, query fields | none (`State`, when sent, is the state being *queried*, not the region) |

Why: FS knows the provider. `CommsysWsiOutgoingMessageHandler` puts `PROVIDER` (e.g. `LA_LEMS`, `FL_FCIC`) and the
department id next to the XML in the event it sends the agent, but the agent forwards **only the XML** to CommSys.
Real CommSys doesn't need the region, because each CommSys install belongs to one agency and is configured with its
state's interfaces; that is where `IntInterfaceName` in replies comes from.

**Here:** `engine.processRequest` takes the region from the global Settings value (`cfg.region`), or from
`/api/simulate`. So every caller gets the same region. Ways to make it per tenant, in order of preference:

1. **ORI → region map in Settings:** exact ORI first, then the 2-letter ORI prefix (`FL` → `FL_FCIC`), then the global
   default. A prefix alone can't tell `CA_CLETS` from `CA_ESUN`, or `LA_LEMS` from `LA_LEMS_OFML`, so those need exact ORIs.
   **Read the ORI before the TCP path's `maskAuth` blanks it** (`t.auth.ori` right after `parseRequest`), and don't log it.
2. **Per connection:** one agent opens one TCP connection, so a TCP Proxy port per region, or the source IP, can pick it.
3. **Per API key** on the REST path.

Guessing the region from which auth/request fields are present (they vary by provider configuration) is possible but fragile.

---

## 7. Response content: rules worth knowing (federated-search `.claude/rules/commsys.md`)

The listener's results are rendered by FS and the CAD/USx client, so these FS rules affect what "looks real":

- **CS-001** Don't branch on `IntSystemName`/`IntTransId`/`IntInterfaceName`; FS uses `<System>`. Give every result a
  meaningful `<System>` (empty → FS labels it `Unknown`).
- **CS-003** Motor-vehicle `<System>` names vary by state (`DMV`, FL `DMVR`/`DHSMV`) and FS only parses names it knows.
  A new name renders as raw text, so copy real per-state values.
- **CS-006** Stored raw content can be the "No Returns" placeholder, JSON, or several XML roots (image transactions).
- Real LA_LEMS_OFML replies seen in Gordon's captures (2026-11-02/03, values not copied): `Hit/Detected` `0` (not blank);
  `IntSystemName`/`ResponseType` pairs `DMV_DRIVER_LICENSE`/"DMV Driver License", `DMV_VEHICLE_REGISTRATION`/"DMV Vehicle
  Registration", `NCIC_NO_RECORD`/"NCIC", `NCIC_PERSON_NORECORD`/"NCIC Person No Record", `NLETS_<ST>_DRIVER_LICENSE`,
  `DLPHOTO_IMAGE`/"Image"; and an `OSW_ACCEPT` / "Accepted" / `Class=Accept` response first on most queries. Today's
  `LA_LEMS_OFML` profile says "DMV Person Record" / `DMV_Person`; the captures disagree.

---

## 8. Verifying any of this (for Claude)

1. `git -C <federated-search> fetch && git -C <federated-search> log -1 origin/main`, then compare with section 1. If newer,
   `git diff 198c85af origin/main -- interface-agent/src/main/java/com/mark43/ia/tcp interface-agent/src/main/resources/application.yml`.
2. Which release a tenant runs: ask the USx team. To see if a fix is in a tag: `git merge-base --is-ancestor 87a681e7 <tag>`.
3. Frame layout: `tcp/ConnectCicFrame.java`. Timeouts and defaults: `configuration/properties/TcpProperties.java`.
   ACK/NAK/status/result handling: `tcp/IncomingFrameHandler.java`. Request shaping: `tcp/ConnectCicPayload.java` and
   `service/WebsocketService.java`.
4. Don't rely on `origin/feat/RND-57457-wsi-tcp` or `origin/jayanth/rnd-57457-ia-tcp`. They predate the merged design.
5. This repo's rules still apply: synthetic data only, no secrets or internal hostnames, never log contents, `npm test`
   before pushing (a push to `main` redeploys Railway).
