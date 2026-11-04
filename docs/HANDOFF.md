# Handoff

Where this stands, what is verified, what is not, and what to do next. Written 2026-11-04. Synthetic data only; no secrets,
hostnames or customer details belong in this file.

## Goal

A place where engineers send transactions and get back Commsys-consistent responses, using made-up data, so they can see what
the interface agent sends and what comes back and work on parsing Commsys results. Nothing real is replaced; no real tenant,
credential or data is involved.

## How it is hooked up

The interface agent for a test department runs in TCP mode and connects out to a Railway TCP Proxy address that forwards to this
service's internal TCP port. See `README.md` (TCP listener section) and `CLAUDE.md` (How a call flows).

Agent settings (names as used by the agent): `COMMSYS_TCP_ENABLED=true`, `COMMSYS_TCP_HOST` (the Railway proxy host),
`COMMSYS_TCP_PORT` (the Railway proxy's public port, not the internal one), the TCP department id variable, no encryption key.
Service settings on Railway: `TCP_PORT` (internal listener port), `PORT` set explicitly (Railway otherwise injects one that can
collide with `TCP_PORT` and crash-loop the service with `EADDRINUSE`), `API_KEY`, `ADMIN_PASSWORD`, `DATABASE_URL`.

The agent image must be new enough to have TCP mode. Agents on older tags never try TCP and simply do not appear in the logs.

## Verified

- Frame codec, request/result handling, heartbeats, NAK paths, masking and matching: automated tests (`npm test`).
- A test client reached the service through Railway's TCP Proxy from a network that allows the port, got an ACK and a result frame.
- A query from a Mark43 test tool, sent as the `ConnectCicApi` envelope, returned a result through the proxy.
- The web UI shows TCP calls (protocol `TCP`) with credentials masked.
- **End to end with a real interface agent:** a test department's agent, running a TCP-capable image and pointed at the Railway proxy,
  returned mock results to a tenant. A person query appeared in the tenant's DEx view with the mock's driver-license response (the
  parsing prototype listed the labels it did not recognise in our message text). This confirms the agent connects, the bare
  `LawEnforcementTransaction` result is accepted by Federated Search, and the tenant renders it.

## Not verified yet

- Long-running behaviour of the agent connection (heartbeats over hours, behaviour under several departments).
- The exact bytes the agent sends over TCP (bare or enveloped; both are accepted) and the heartbeat timing it expects. A packet
  capture of agent traffic would settle this.
- Reconnect after a Railway redeploy (deploys cut open TCP connections; the agent is expected to retry).

## Things that will bite you

- **Corporate filters:** some managed laptops block non-HTTP ports; a TCP test from them times out silently. Test from a network
  that allows the port.
- **Caller address:** behind Railway's TCP Proxy the source address is the proxy's own (changing `100.64.0.x`), so
  `TCP_ALLOWED_IPS` cannot restrict callers there and logged IPs do not identify the caller.
- **No authentication on the TCP port.** It only serves the synthetic records and caps connections (`TCP_MAX_CONNECTIONS`). Treat
  that as an open security question to raise with the platform team; do not put real data behind it.
- **Request id:** results must echo `Response/Request/Id`; that is how Federated Search ties a result to its query.
- **Names:** a name without a comma matches in either order (`JANE DOE` and `DOE JANE`); with a comma the order is fixed.
- **Regions:** Texas TLETS is not modelled (different result types: registration, insurance, driver history). Only wording
  differences evidenced by exemplar responses are encoded; see `docs/RESPONSES.md`.
- **UI labels:** a TCP call still shows HTTP-flavoured labels ("Acknowledgement HTTP 200", "CALLBACK HTTP 200") and an HTTP-only
  "Re-send results to callback URL" button. For TCP they mean the ACK frame and the result frame sent over the socket.

## Next steps

1. Work the parsing: load realistic (anonymised) result text and fields, and watch how the tenant renders and parses each one. The
   tenant's parser already flags message-text labels it does not know, which is a good source of work.
2. Add the regions and records the team needs (Texas TLETS first if the test tenant is TX).
3. Optional: capture agent traffic to confirm the exact request bytes and heartbeat timing; adjust `src/tcp-adapter.js` if needed.
4. Optional: fix the TCP labels in `public/index.html`; add an application-level check if the port needs restricting.

## Working in this repo

- Read `CLAUDE.md` first; `docs/RESPONSES.md` is the response reference.
- `npm test` before every push. A push to `main` redeploys the live Railway service and drops open TCP connections for a few seconds.
- Local TCP check without an agent: start the service with `TCP_PORT=4500 npm start`, then
  `node scripts/tcp-client.mjs 127.0.0.1 4500`.
- Prismatic gateway code in `prismatic/` runs inside Prismatic, not from this repo; it is not used on the TCP path.
