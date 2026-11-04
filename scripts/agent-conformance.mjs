#!/usr/bin/env node
// Conformance check for the TCP listener: plays the USx interface agent's TCP mode byte for byte and
// reports, requirement by requirement, whether a real agent would accept what the server does.
//
//   node scripts/agent-conformance.mjs <host> <port> [options]
//
// It is deliberately independent of src/tcp-frame.js: it re-implements the agent's reader, ACK
// handling and result checks from the agent's Java source (federated-search, interface-agent
// src/main/java/com/mark43/ia/tcp/), so a bug in our codec cannot also hide in the check.
// The contract it enforces is written up in docs/AGENT-TCP-CONTRACT.md (requirement ids R1..R12).
//
// Options
//   --entity PERSON|VEHICLE|FIREARM|BOAT|ARTICLE   query type (default PERSON)
//   --field Key=Value       request field, repeatable (default for PERSON: Name="DOE, JANE A", OperatorLicenseNumber=D0000001)
//   --queries N             queries to send, one after another (default 1)
//   --key 16CHARKEY         encrypt like COMMSYS_TCP_ENCRYPTION_KEY (exactly 16 characters, used as raw UTF-8)
//   --wait SECONDS          how long to collect results after the last ACK (default 10)
//   --idle SECONDS          stay connected this long with no queries, to check the link survives (default 0)
//   --heartbeat SECONDS     agent keep-alive interval (agent default 30)
//   --expect N              results expected per query; a different count is a failure (default: at least 1)
//   --show                  print result bodies (synthetic data only; off by default, per CLAUDE.md rule 3)
//   --json                  print the report as JSON
//
// Exit code 0 when every check passes, 1 when any fails, 2 on bad usage.
import net from 'node:net';
import crypto from 'node:crypto';

// ---------------------------------------------------------------- agent constants (TcpProperties, TcpConnection)
const START = Buffer.from([0x5a, 0xf0, 0xc3, 0x0f]);
const END = Buffer.from([0xc3, 0x0f, 0x5a, 0xf0]);
const HEADER_BYTES = 8;
const MIN_FRAME = 20; // ConnectCicFrame.MIN_FRAME_SIZE
const MAX_FRAME = 16 * 1024 * 1024; // commsys.tcp.max-frame-bytes default
const ACK_TIMEOUT_MS = 30_000; // commsys.tcp.ack-timeout-seconds
const SOCKET_TIMEOUT_MS = 90_000; // commsys.tcp.socket-timeout-seconds: silence this long and the agent reconnects
const HEARTBEAT_ACK_ID = (43 << 8) | 43; // ConnectCicWriterRunnable.HEARTBEAT_ACK_ID = 43/43
const T = { MSG_NO_ACK: 0x00, MSG_ACK: 0x01, ENC_NO_ACK: 0x02, ENC_ACK: 0x03, ACK: 0x10, NAK: 0x11 };
const TYPE_NAME = Object.fromEntries(Object.entries(T).map(([k, v]) => [v, k]));
const MESSAGE_TYPE = { PERSON: 'DriverLicenseQuery', VEHICLE: 'VehicleRegistrationQuery', FIREARM: 'GunQuery', BOAT: 'BoatQuery', ARTICLE: 'ArticleSingleQuery' };
const DEFAULT_FIELDS = {
  PERSON: { Name: 'DOE, JANE A', OperatorLicenseNumber: 'D0000001' },
  VEHICLE: { LicensePlateNumber: 'TST1234' },
  FIREARM: { GunSerialNumber: 'TESTGUN001' },
  BOAT: { BoatHullIdNumber: 'TEST12345B606' },
  ARTICLE: { ArticleSerialNumber: 'TESTART777' },
};

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const [host, portArg] = argv;
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
if (!host || !portArg || flag('--help')) {
  console.error('usage: node scripts/agent-conformance.mjs <host> <port> [--entity E] [--field K=V]... [--queries N] [--key 16CHARS] [--wait S] [--idle S] [--expect N] [--show] [--json]');
  process.exit(2);
}
const entity = String(opt('--entity', 'PERSON')).toUpperCase();
if (!MESSAGE_TYPE[entity]) { console.error(`--entity must be one of ${Object.keys(MESSAGE_TYPE).join(', ')}`); process.exit(2); }
const fields = {};
argv.forEach((a, i) => { if (a === '--field') { const [k, ...v] = String(argv[i + 1]).split('='); fields[k] = v.join('='); } });
const requestFields = Object.keys(fields).length ? fields : DEFAULT_FIELDS[entity];
const queries = Math.max(1, Number(opt('--queries', 1)));
const waitMs = Number(opt('--wait', 10)) * 1000;
const idleMs = Number(opt('--idle', 0)) * 1000;
const heartbeatMs = Number(opt('--heartbeat', 30)) * 1000;
const expect = opt('--expect', null) === null ? null : Number(opt('--expect'));
const keyText = opt('--key', '');
if (keyText && Buffer.byteLength(keyText, 'utf8') !== 16) { console.error('--key must be exactly 16 bytes (TcpProperties.encryptionKeyBytes)'); process.exit(2); }
const key = keyText ? Buffer.from(keyText, 'utf8') : null;

// ---------------------------------------------------------------- report
const checks = new Map(); // id -> { ok, warn, detail[] }
function check(id, ok, detail, { warn = false } = {}) {
  const c = checks.get(id) ?? { ok: true, warn: false, detail: [] };
  if (!ok) { if (warn) c.warn = true; else c.ok = false; }
  if (detail && c.detail.length < 6) c.detail.push(detail);
  checks.set(id, c);
}
const DESCRIPTIONS = {
  R1: 'Frames are well formed (start/end markers, big-endian length incl. markers, header length 8, known type)',
  R2: 'Every ack-required query frame is ACKed with the same ackId within 30 s',
  R3: "The agent's keep-alive (empty frame, ackId 43/43) is ACKed",
  R4: 'The server is never silent for 90 s (agent socket timeout)',
  R5: 'Result bodies are a bare <LawEnforcementTransaction> (not a ConnectCicApi envelope)',
  R6: 'Each result carries Response/Request/Id equal to the request id',
  R7: 'Expected number of results per query arrived',
  R8: 'Encryption matches the configured key (no plaintext message frames when a key is set; decryptable when encrypted)',
  R9: 'Status frames (MessageType=Status), if sent, carry Interface/Status/TransManStatus',
  R10: 'No NAK for a well-formed query',
};

// ---------------------------------------------------------------- frame codec (agent's layout, ConnectCicFrame.java)
function encode(type, ackId, body = Buffer.alloc(0)) {
  const total = START.length + 4 + HEADER_BYTES + body.length + END.length;
  const out = Buffer.alloc(total);
  START.copy(out, 0);
  out.writeInt32BE(total, 4);
  out.writeInt16BE(HEADER_BYTES, 8);
  out.writeUInt16BE(ackId & 0xffff, 10);
  out[12] = type; // 13..15 reserved, left 0
  body.copy(out, 16);
  END.copy(out, total - END.length);
  return out;
}
const encrypt = (plain) => { const iv = crypto.randomBytes(16); const c = crypto.createCipheriv('aes-128-cbc', key, iv); return Buffer.concat([iv, c.update(plain), c.final()]); };
const decrypt = (data) => { if (data.length <= 16) throw new Error('too short for IV + ciphertext'); const d = crypto.createDecipheriv('aes-128-cbc', key, data.subarray(0, 16)); return Buffer.concat([d.update(data.subarray(16)), d.final()]); };

// Reader: same state machine as ConnectCicReaderRunnable (scan for start, read length, read the rest, check end marker).
let buf = Buffer.alloc(0);
function readFrames(chunk) {
  buf = Buffer.concat([buf, chunk]);
  const frames = [];
  for (;;) {
    const s = buf.indexOf(START);
    if (s < 0) { if (buf.length) check('R1', false, `${buf.length} byte(s) outside any frame`); buf = buf.subarray(Math.max(0, buf.length - 3)); break; }
    if (s > 0) { check('R1', false, `${s} byte(s) before a start marker`); buf = buf.subarray(s); }
    if (buf.length < 8) break;
    const len = buf.readInt32BE(4);
    if (len < MIN_FRAME || len > MAX_FRAME) { check('R1', false, `impossible frame length ${len} (agent skips it)`); buf = buf.subarray(1); continue; }
    if (buf.length < len) break;
    const raw = buf.subarray(0, len);
    if (!raw.subarray(len - 4).equals(END)) { check('R1', false, `end marker missing in a ${len}-byte frame (agent rewinds and rescans)`); buf = buf.subarray(1); continue; }
    buf = buf.subarray(len);
    const section = raw.subarray(8, len - 4); // header + body, as fromRawHeaderAndBody sees it
    const headerLength = section.readInt16BE(0);
    if (headerLength !== HEADER_BYTES) check('R1', headerLength >= 5 && headerLength <= section.length, `header length ${headerLength} (CommSys sends 8)`, { warn: headerLength >= 5 && headerLength <= section.length });
    if (headerLength < 5 || headerLength > section.length) continue;
    const type = section[4];
    if (TYPE_NAME[type] === undefined) { check('R1', false, `unknown frame type 0x${type.toString(16)} (agent drops it)`); continue; }
    frames.push({ type, ackId: section.readUInt16BE(2), body: Buffer.from(section.subarray(headerLength)) });
  }
  return frames;
}

// ---------------------------------------------------------------- requests (FS DefaultConnectCicApiService + agent ConnectCicPayload.unwrapIfWrapped)
function queryId() { // a ULID-shaped id, like Federated Search's query ids
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let t = Date.now(); let time = '';
  for (let i = 0; i < 10; i++) { time = alphabet[t % 32] + time; t = Math.floor(t / 32); }
  return time + Array.from(crypto.randomBytes(16), (b) => alphabet[b % 32]).join('');
}
const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function buildRequest(requestId) {
  // Bare LawEnforcementTransaction, no XML declaration: the agent strips the ConnectCicApi envelope
  // (unwrapIfWrapped, serialized with OMIT_XML_DECLARATION). Session/Id is the device name (rule CS-002).
  // Authentication values are dummies; the real agent sends the device's real ones, including Password.
  const f = Object.entries(requestFields).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('');
  return '<LawEnforcementTransaction version="1.0"><Session><Id>CONFORMANCE01</Id><Authentication>' +
    '<UserName>TESTUSER</UserName><Password>DUMMYPASSWORD</Password><ORI>XX0000000</ORI><Mnemonic>MOCK</Mnemonic>' +
    '<DeviceId>CONFORMANCE01</DeviceId><DeviceAlias>CONFORMANCE01</DeviceAlias></Authentication></Session>' +
    `<Transaction><Request><MessageType>${MESSAGE_TYPE[entity]}</MessageType>${f}<Id>${esc(requestId)}</Id></Request></Transaction></LawEnforcementTransaction>`;
}

// ---------------------------------------------------------------- result checks (IncomingFrameHandler.handleMessageFrame)
const firstTag = (xml, tag) => (new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([^<]*)</(?:\\w+:)?${tag}>`).exec(xml) || [])[1];
function inspectResult(xml, sentIds, results, statuses) {
  const root = (/^\s*(?:<\?xml[^>]*\?>\s*)?<(?:(\w+):)?(\w+)/.exec(xml) || [])[2];
  if (root !== 'LawEnforcementTransaction') {
    // Jackson ignores the root element name, so a ConnectCicApi envelope maps to a transaction-less
    // object: extractQueryId() finds nothing and the agent logs "carried no query id" and DROPS it.
    check('R5', false, root === 'ConnectCicApi' ? 'result wrapped in ConnectCicApi: the agent finds no query id and drops it' : `result root <${root || '?'}> is not LawEnforcementTransaction`);
    return;
  }
  check('R5', true);
  const responses = xml.match(/<Response(?:\s[^>]*)?>[\s\S]*?<\/Response>/g) || [];
  const status = responses.filter((r) => /^status$/i.test((firstTag(r, 'MessageType') || '').trim()));
  if (status.length) { // handledAsStatusMessage: routed to the CommSys heartbeat, never a result
    for (const s of status) {
      const parts = ['Interface', 'Status', 'TransManStatus'].map((t) => firstTag(s, t));
      check('R9', parts.every((p) => p && p.trim()), parts.every(Boolean) ? null : 'status frame missing Interface, Status or TransManStatus', { warn: true });
      statuses.push(parts.join(', '));
    }
    return;
  }
  // extractQueryId: the first Response whose Request/Id is not blank
  const id = responses.map((r) => firstTag(r.match(/<Request(?:\s[^>]*)?>[\s\S]*?<\/Request>/)?.[0] || '', 'Id')).find((v) => v && v.trim());
  if (!id) { check('R6', false, 'result has no Response/Request/Id: the agent drops it'); return; }
  if (!sentIds.has(id.trim())) { check('R6', false, `result Request/Id "${id}" matches no request sent (FS would store it against an unknown query)`); return; }
  check('R6', true);
  results.set(id.trim(), (results.get(id.trim()) || 0) + 1);
  if (flag('--show')) console.log(`\n--- result for ${id}\n${xml}\n`);
}

// ---------------------------------------------------------------- run
const sentIds = new Set();
const results = new Map();
const statuses = [];
const pendingAcks = new Map(); // ackId -> { resolve, reject, timer, what }
let ackCounter = 0;
let lastByteAt = Date.now();
let longestSilence = 0;
const log = (m) => { if (!flag('--json')) console.log(m); };
const nextAckId = () => { let id; do { id = ackCounter++ & 0xffff; } while (id === HEARTBEAT_ACK_ID); return id; }; // TcpConnection.nextAckId

function waitAck(ackId, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingAcks.delete(ackId); reject(new Error(`no ACK within ${ACK_TIMEOUT_MS / 1000}s`)); }, ACK_TIMEOUT_MS);
    pendingAcks.set(ackId, { resolve, reject, timer, what });
  });
}

const socket = net.connect({ host, port: Number(portArg) });
socket.setNoDelay(true);
socket.setKeepAlive(true);
const silenceTimer = setInterval(() => {
  const gap = Date.now() - lastByteAt;
  longestSilence = Math.max(longestSilence, gap);
  if (gap >= SOCKET_TIMEOUT_MS) check('R4', false, `no bytes for ${Math.round(gap / 1000)}s: the real agent would treat the link as half-open and reconnect`);
}, 1000);
let heartbeatAcked = null;
const heartbeat = setInterval(async () => {
  socket.write(encode(T.MSG_ACK, HEARTBEAT_ACK_ID)); // ConnectCicFrame.asHeartbeat: empty, ack required
  try { await waitAck(HEARTBEAT_ACK_ID, 'keep-alive'); heartbeatAcked = true; } catch { heartbeatAcked = false; check('R3', false, 'keep-alive (ackId 43/43) not ACKed'); }
}, heartbeatMs);

socket.on('data', (chunk) => {
  lastByteAt = Date.now();
  for (const f of readFrames(chunk)) {
    if (f.type === T.ACK || f.type === T.NAK) {
      const p = pendingAcks.get(f.ackId);
      if (!p) { log(`<- ${TYPE_NAME[f.type]} for unknown ackId ${f.ackId} (agent logs a warning and ignores it)`); continue; }
      clearTimeout(p.timer); pendingAcks.delete(f.ackId);
      if (f.type === T.ACK) p.resolve(); else p.reject(new Error('NAK'));
      continue;
    }
    const encrypted = f.type === T.ENC_ACK || f.type === T.ENC_NO_ACK;
    if (f.type === T.MSG_ACK || f.type === T.ENC_ACK) socket.write(encode(T.ACK, f.ackId)); // sendAck before processing
    let body = f.body;
    if (encrypted) {
      if (!key) { check('R8', false, 'encrypted frame received but no key configured: the agent cannot read it'); continue; }
      try { body = decrypt(body); } catch (e) { check('R8', false, `encrypted frame could not be decrypted (${e.message})`); continue; }
    } else if (key && body.length) {
      check('R8', false, 'plaintext message frame on an encrypted connection: the agent refuses it'); continue;
    }
    if (!body.length) { log(`<- empty ${TYPE_NAME[f.type]} (keep-alive), ACKed`); continue; }
    log(`<- ${TYPE_NAME[f.type]} ackId ${f.ackId}, ${body.length} bytes`);
    inspectResult(body.toString('utf8'), sentIds, results, statuses);
  }
});
socket.on('error', (e) => { check('R1', false, `socket error: ${e.code || e.message}`); finish(); });
socket.on('close', () => finish());

socket.on('connect', async () => {
  log(`connected to ${host}:${portArg}${key ? ' (encrypted)' : ''}; sending ${queries} ${entity} quer${queries === 1 ? 'y' : 'ies'}`);
  for (let i = 0; i < queries; i++) {
    const id = queryId(); // tenants on the configuration-driven FS handlers send the bare query id (no _ENTITY suffix)
    sentIds.add(id);
    const ackId = nextAckId();
    const xml = Buffer.from(buildRequest(id), 'utf8');
    socket.write(encode(key ? T.ENC_ACK : T.MSG_ACK, ackId, key ? encrypt(xml) : xml));
    log(`-> query ${id} ackId ${ackId}`);
    try { await waitAck(ackId, 'query'); check('R2', true); check('R10', true); log(`<- ACK ${ackId}`); } catch (e) {
      if (e.message === 'NAK') check('R10', false, `query ${i + 1} was NAKed: the agent reports "CommsYS rejected the frame (NAK)"`);
      else check('R2', false, `query ${i + 1}: ${e.message}: the agent reports "CommsYS did not acknowledge the query"`);
    }
  }
  await new Promise((r) => setTimeout(r, waitMs + idleMs));
  finish();
});

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  clearInterval(silenceTimer); clearInterval(heartbeat);
  for (const p of pendingAcks.values()) clearTimeout(p.timer);
  socket.destroy();
  for (const id of sentIds) {
    const n = results.get(id) || 0;
    if (expect === null) check('R7', n >= 1, n >= 1 ? null : `no result arrived for ${id} within the wait (use --wait, or expect 0 with --expect 0)`);
    else check('R7', n === expect, n === expect ? null : `${n} result(s) for ${id}, expected ${expect}`);
  }
  if (heartbeatAcked === true) check('R3', true);
  if (!checks.has('R4')) check('R4', true, longestSilence ? `longest silence ${Math.round(longestSilence / 1000)}s` : null);
  if (!checks.has('R8')) check('R8', true);
  if (!checks.has('R1')) check('R1', true);
  const order = Object.keys(DESCRIPTIONS);
  const rows = order.filter((id) => checks.has(id)).map((id) => ({ id, result: !checks.get(id).ok ? 'FAIL' : checks.get(id).warn ? 'WARN' : 'PASS', requirement: DESCRIPTIONS[id], detail: checks.get(id).detail }));
  const failed = rows.some((r) => r.result === 'FAIL');
  if (flag('--json')) console.log(JSON.stringify({ host, port: Number(portArg), entity, queries, results: Object.fromEntries(results), statuses, checks: rows, ok: !failed }, null, 2));
  else {
    console.log('\nResult                                   Requirement');
    for (const r of rows) {
      console.log(`${r.result.padEnd(5)} ${r.id.padEnd(4)} ${r.requirement}`);
      for (const d of r.detail) console.log(`           - ${d}`);
    }
    if (statuses.length) console.log(`\nstatus frames seen: ${statuses.length} (${[...new Set(statuses)].join(' | ')})`);
    if (heartbeatAcked === null) console.log(`(R3 not exercised: run longer than --heartbeat ${heartbeatMs / 1000}s, e.g. --idle 35)`);
    console.log(failed ? '\nNOT CONFORMANT: a real agent would fail or drop something above.' : '\nCONFORMANT for everything exercised.');
  }
  process.exit(failed ? 1 : 0);
}
