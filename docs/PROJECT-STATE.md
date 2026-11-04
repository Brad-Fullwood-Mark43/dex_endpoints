# Project state: synthetic Commsys test environment

Reference notes for resuming this work. Written 2026-11-04. Local working note: contains no secrets, but review
before committing (this repo is public).

## 1. Goal (as the user stated it)

A dummy-data-only environment where a tenant can send transactions and get Commsys-consistent responses, so
engineers who lack public-safety knowledge can work on the **parsing** of Commsys results. They should be able to
see "what we send, what we get back". Nothing real is replaced or touched.

Constraints:
- Synthetic data only. No real Mark43 credentials, tenants or data. The user's own one-time keys on Railway are fine.
- The user does not want to run Kubernetes. A Prismatic websocket "relay loop" spike was declined ("not worth it").
- The user felt the project was "going off the rails": get expert (dex engineer) feedback before building further.

## 2. How the real flow works (verified in code)

```
Browser/CAD -> Federated Search (FS) -> websocket (AWS API Gateway) -> USx interface agent (IA) -> Commsys
```
- IA A side: websocket client to FS, plus REST posts (`query_results`, `query_statuses`, `log_heartbeat`) using `x-api-key`.
- IA B side: POSTs ConnectCicApi XML (REST or SOAP, `COMMSYS_PROTOCOL`) to `COMMSYS_ENDPOINT`; results come back
  asynchronously to the agent's `/interface-agent/v2/query-result` (`COMMSYS_RESPONSE_URL`).
- Request id contract: transaction id and `Request/Id` are `<queryId>_<ENTITY>`; results must echo it.
- Dex engineer: the IA runs in a k8s cluster (customer premises, or Mark43 EKS via OpenZiti). IA to Commsys A side is LAN only.
  Earlier statement: "USx IA is REST only". The latest proposal below contradicts this.

## 3. What exists today

Repo: `dex_endpoints` (GitHub Brad-Fullwood-Mark43/dex_endpoints, PUBLIC), live on Railway
(`dexendpoints-production.up.railway.app`), Postgres attached. See `README.md`, `CLAUDE.md`, `docs/RESPONSES.md`.
- Mock Commsys: `/connectcic` (+ `/commsys`, `/connectcic/soap`), `/resolve`, `/allowlist`, callback receiver, admin UI, call log.
- Records, 10 regions (profiles only reword), derived Normalized* fields, CSV import, SEED_VERSION upgrades, failure modes.
- Prismatic gateway (gov-east env, integration "DEX Demo Box"): Flow 1 sync webhook (key check, allowlist guard, sanitized
  forward to `/resolve`), Flow 2 async delivery. Code in `prismatic/*.cjs` (pasted by hand into Prismatic).
- Tests: 31 passing (`npm test`). Fidelity check: `node scripts/check-fidelity.mjs <federated-search path> [--region ID | --all-regions]`.
- Confluence draft page id 7350026593 ("DEX Connection Test Site", site mark43.atlassian.net, personal space). It has status,
  options, questions and the Appendix A setup guide. It does NOT yet cover the LAN topology, A-side emulator, OpenZiti /
  On-Prem Agent, or the TCP option.

## 4. Options on the table

| Id | Option | Status |
| --- | --- | --- |
| A | Response bank only (works now) | Available |
| B | Prismatic gateway plus the engineer's real agent; callback reachability open (direct HTTPS, OpenZiti, On-Prem Agent) | Open |
| B2 | A-side emulator container beside the IA in its cluster | Idea |
| C | Railway agent stand-in with the user's own key | Idea |
| D | Real agent image on Railway | Idea |
| E | Local FS compose rig | Idea |
| F | JSON uploader and mapping explorer (reuse validators; "identical rendering" not achievable) | Idea |
| G | M43Forms (poor fit for the upload, good for query forms; OnScene only) | Researched |
| H | **Railway TCP listener speaking the ConnectCIC frame protocol** | Latest, see section 5 |

Prismatic facts: runs capped at 15 min (sync ~30 s), no websocket component, so it cannot be the long-lived agent host.

## 5. Option H: TCP listener (engineer's latest proposal)

Proposal: add a TCP listener to the Railway service next to `/connectcic`, via Railway TCP Proxy (public host:port),
speaking the ConnectCIC frame format. The test tenant's agent (3000.30+, `COMMSY_TCP_ENABLED=true`) connects to it.
Prismatic drops out. Test tenant only, dummy credentials; request-body log masking is a must-fix.

Verified:
- Frame protocol (from DEx repo `ConnectCicFrame`, `EchoServer`, `ConnectCicHelper`): start `5A F0 C3 0F`; 4-byte total length;
  8-byte header (2 header length, 2 ackId, 1 frame type, 3 reserved); XML body; end `C3 0F 5A F0`. Frame types 0x00, 0x01
  (ack required), 0x02/0x03 (encrypted), 0x10 ACK, 0x11 NAK. Encryption AES/CBC/PKCS5Padding with a random 16-byte IV
  prepended. Heartbeat = empty ack-required frame.
- Agent TCP code exists on `origin/feat/RND-57457-wsi-tcp` and RND-61351 commits (`ia/tcp/*`: TcpConnection, TcpConnectionManager,
  ConnectCicFrame, FrameType, reader/writer runnables, IncomingFrameHandler). Config block `tcp-connections`
  (department-id, host, port default 5000, encryption-key, enabled). The agent is the TCP **client** per department.
  Not on origin/main in the local (stale, 2026-10-13) checkout.
- IncomingFrameHandler: ACKs ack-required frames, decrypts encrypted frames, deserializes `ResponseLawEnforcementTransaction`,
  extracts the query id from the response, ignores empty frames (heartbeat).
- TCP request model is a **bare `LawEnforcementTransaction`** (Session + Transaction), not the `ConnectCicApi` envelope the REST
  path uses. Our `src/xml.js` parser and `src/requests.js` need a small adapter for it.
- Our records, matching, regions and result builder can be reused unchanged.

Railway TCP Proxy (docs.railway.com/networking/tcp-proxy, specs-and-limits, deployments):
- Supported. Enabled per service under Settings, Networking, with the internal port you enter. Gives `<name>.proxy.rlwy.net:<port>`.
- HTTP domain and TCP proxy can coexist on one service. Docs do not say whether they can target different internal ports
  (the Express app would need a second `net` server on its own port; confirm in the UI).
- NOT documented: TCP idle timeout, max connection duration, whether the 10,000 connection limit applies, whether TLS applies to
  raw TCP (assume plaintext), whether host:port stays stable across redeploys, plan or cost.
- Deploys: old instance gets SIGTERM then SIGKILL after 0 s by default (`RAILWAY_DEPLOYMENT_DRAINING_SECONDS` changes it), so long-lived
  TCP connections are cut on every deploy or platform migration. The agent must reconnect. Inference, not documented.

Unverified / to confirm with the USx team (RND-57457, Jayanth Recherla named in the paste):
- Released version (3000.30?) and the exact env flag name, and that it matches this build.
- Whether the agent as TCP **client** to a host:port is the intended direction for this tenant.
- Whether the cluster allows outbound connections to the Railway TCP proxy host:port.
- Encryption: whether the test tenant uses a key (the listener must then decrypt and encrypt).
- Whether the IA expects the same frame behaviour as the DEx frames beyond what the code shows.

Must-fix if built:
- `src/engine.js` stores `txn.sent = clip(rawBody)` (raw body, incl. Authentication, Password, UserName, ORI) in the call log
  and Postgres. Mask Password/UserName/ORI/SSN/Mnemonic/DeviceID before storing when requests arrive directly.
- Frame parser must bound the length field and handle partial reads, bad magic and NAK.
- Keep dummy credentials only; never accept real keys. TCP on Railway is plaintext.
- Side benefit: the same listener could serve the legacy DEx path (currently out of scope).

## 5b. Option H: engineer answers and build status (2026-11-04)

Engineer confirmed: agent version OK; agent = TCP client, Railway = server; Railway sends heartbeats; NO encryption; guardrails
(test department only, dummy credentials) covered; Wireshark capture to come. Public endpoint = Railway TCP Proxy host:port
(internal port 4500). Cluster needs outbound internet only.

BUILT (not yet deployed or pushed; 43 tests pass): `src/tcp-frame.js`, `src/tcp-adapter.js`, `src/tcp-server.js`, `src/mask.js`,
engine masking (`sent`/`requestXml` masked for ALL origins; `maskAuth` for TCP), `scripts/tcp-client.mjs`, `test/tcp.test.js`,
README TCP section, env vars `TCP_PORT`, `TCP_HEARTBEAT_MS`, `TCP_ALLOWED_IPS`, `TCP_MAX_CONNECTIONS`, `TCP_RESULT_FORMAT`.
Results go back as bare `<LawEnforcementTransaction>` frames (the agent's reader extracts the query id from that shape).

Still unknown until the capture: exact request bytes (bare vs envelope; both accepted), heartbeat interval the agent expects,
whether FS accepts a bare result document as `rawResultContent` (REST path posts the envelope; flip with `TCP_RESULT_FORMAT=envelope`).

Deploy steps: set `TCP_PORT=4500` (+ `TCP_ALLOWED_IPS` if the cluster egress IP is known), push to main, enable Railway TCP Proxy
for internal port 4500, send the engineer the host:port, verify with `node scripts/tcp-client.mjs <host> <port>`.

## 6. Pending / next steps

1. Decide: update the Confluence draft with the LAN topology, A-side emulator, OpenZiti / On-Prem Agent and TCP option, or scope the build.
2. Ask the dex engineer / USx team the unverified items in section 5.
3. Deploy the TCP listener (see 5b), then smoke test with the real agent once the capture arrives.
4. Later, not approved: fixture pack, JSON uploader / mapping explorer, TX_TLETS fixtures (federated-search `api/src/test/resources/data/commsys/`),
   Slack note to Sree about the dev-vm43 box.
5. The dev-vm43 box `brad-fullwood-mark43-cad-caddexproto-kxll9b` may still be running (auto-stops 03:00 UTC).

## 7. Reference locations

- Federated Search repo (read-only, stale): `/Users/brad.fullwood/Developer/federated-search`
  (`interface-agent/src/main/java/com/mark43/ia/...`, `simulation-exemplars/.../simulated-responses/*.xml`,
  `api/src/test/resources/data/commsys/{request,response}/*.xml`, `.claude/skills/federated-search-config/references/*`).
- DEx repo: `/Users/brad.fullwood/Developer/dex/data-exchange/data-exchange-connectcic/` (frame code, sample response XML).
- Prismatic: CLI from `/Users/brad.fullwood/Developer/prismatic-integrations` with
  `PRISMATIC_URL=https://app.mark43-production-us-gov-east-1.prismatic.io` and `npx --no-install prism ...`;
  ziti notes in `docs/adding-ziti-to-an-integration.md`.
- Config tooling: Connector Manager, `USx_Connector_Builder/api/src/services/ValidationService.ts`, `DEX Validation Tool/validate_bundle.py`.
- Full prior conversation: `/Users/brad.fullwood/.claude/projects/-Users-brad-fullwood-Developer-cad/3781603e-8142-43a9-8c93-0752920642c5.jsonl`

## 8. Rules to keep

Synthetic data only; no secrets or internal hostnames in the repo; never log request or result contents; gateway fails closed;
`npm test` before every push (a push to `main` redeploys Railway). Prismatic step code changes need a manual paste and republish.
