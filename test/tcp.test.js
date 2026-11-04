import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dexe-tcp-'));
const { FrameDecoder, FrameType, encodeFrame } = await import('../src/tcp-frame.js');
const { maskCredentials } = await import('../src/mask.js');
const { toEnvelope, toBareResult } = await import('../src/tcp-adapter.js');
const { createTcpServer } = await import('../src/tcp-server.js');
const { listTransactions } = await import('../src/engine.js');
const { updateSettings } = await import('../src/store.js');

const bare = (id, fields) =>
  `<?xml version="1.0"?><LawEnforcementTransaction version="1.0"><Session><Authentication><UserName>REALUSER</UserName><Password>SECRETPW</Password><ORI>REALORI01</ORI><DeviceId>DEV1</DeviceId></Authentication><Id>DEV1</Id></Session>` +
  `<Transaction><Request><Id>${id}</Id><MessageType>DriverLicenseQuery</MessageType>${fields}</Request></Transaction></LawEnforcementTransaction>`;

// ---- frame codec ---------------------------------------------------------------------------------

test('frame: layout matches the DEx encoder (length counts the whole frame)', () => {
  const f = encodeFrame({ type: FrameType.MESSAGE_ACK, ackId: 0x0102, body: Buffer.from('<a/>') });
  assert.deepEqual([...f.subarray(0, 4)], [0x5a, 0xf0, 0xc3, 0x0f]);
  assert.equal(f.readUInt32BE(4), f.length);
  assert.equal(f.length, 20 + 4);
  assert.equal(f.readUInt16BE(8), 8);
  assert.deepEqual([f[10], f[11], f[12]], [0x01, 0x02, 0x01]);
  assert.deepEqual([...f.subarray(f.length - 4)], [0xc3, 0x0f, 0x5a, 0xf0]);
  assert.equal(encodeFrame({ type: FrameType.ACK, ackId: 7 }).length, 20);
});

test('frame: round trip, split across chunks, and several frames in one chunk', () => {
  const a = encodeFrame({ type: FrameType.MESSAGE_ACK, ackId: 1, body: Buffer.from('one') });
  const b = encodeFrame({ type: FrameType.ACK, ackId: 2 });
  const d = new FrameDecoder();
  const all = Buffer.concat([a, b]);
  const frames = [];
  for (let i = 0; i < all.length; i += 3) frames.push(...d.push(all.subarray(i, i + 3)).frames);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].body.toString(), 'one');
  assert.equal(frames[1].type, FrameType.ACK);
  assert.equal(new FrameDecoder().push(all).frames.length, 2);
});

test('frame: noise, bad lengths and bad end markers are skipped and decoding resumes', () => {
  const good = encodeFrame({ type: FrameType.MESSAGE_NO_ACK, ackId: 3, body: Buffer.from('ok') });
  const badEnd = Buffer.from(good);
  badEnd[badEnd.length - 1] = 0;
  const huge = Buffer.from(good);
  huge.writeUInt32BE(0x7fffffff, 4);
  const { frames, errors } = new FrameDecoder().push(Buffer.concat([Buffer.from('junk'), badEnd, huge, good]));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].body.toString(), 'ok');
  assert.ok(errors.length >= 2);
});

test('frame: bytes that contain no frame start are reported, and a frame split after a partial marker still decodes', () => {
  const d = new FrameDecoder();
  const first = d.push(Buffer.from('hello not a frame'));
  assert.equal(first.frames.length, 0);
  assert.match(first.errors[0], /discarded \d+ bytes with no frame start/);
  const f = encodeFrame({ type: FrameType.ACK, ackId: 4 });
  assert.equal(d.push(f.subarray(0, 2)).frames.length, 0);
  assert.equal(d.push(f.subarray(2)).frames.length, 1);
});

test('frame: the decoder does not buffer without bound when no frame ever completes', () => {
  const d = new FrameDecoder();
  for (let i = 0; i < 50; i++) d.push(Buffer.alloc(100000, 1));
  assert.ok(d.buf.length < 4);
});

// ---- masking and adapter -------------------------------------------------------------------------

test('mask: credentials are masked in plain and SOAP-escaped XML, other values are kept', () => {
  const out = maskCredentials('<Password>SECRETPW</Password><api:ORI>REALORI01</api:ORI><Name>DOE, JANE</Name>&lt;UserName&gt;REALUSER&lt;/UserName&gt;');
  assert.doesNotMatch(out, /SECRETPW|REALORI01|REALUSER/);
  assert.match(out, /<Name>DOE, JANE<\/Name>/);
});

test('adapter: a bare request becomes an envelope the parser accepts; envelopes pass through; results go back to bare', () => {
  const env = toEnvelope(bare('Q9_PERSON', '<Name>DOE, JANE A</Name>'));
  assert.match(env, /<api:Transaction id="Q9_PERSON">/);
  assert.equal(toEnvelope(env), env);
  assert.throws(() => toEnvelope('<nothing/>'));
  assert.match(toBareResult('<api:ConnectCicApi><x><LawEnforcementTransaction a="1"><y/></LawEnforcementTransaction></x></api:ConnectCicApi>'), /^<\?xml version="1.0"\?>\n<LawEnforcementTransaction a="1"><y\/><\/LawEnforcementTransaction>/);
});

// ---- the listener --------------------------------------------------------------------------------

let server;
let port;
before(async () => {
  updateSettings({ resultDelayMs: 0, betweenResultsMs: 0, ackMode: 'success', resultMode: 'normal', noRecordOnMiss: true });
  server = createTcpServer({ heartbeatMs: 80 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => server.closeAll());

function connect() {
  const socket = net.connect(port, '127.0.0.1');
  const decoder = new FrameDecoder();
  const frames = [];
  const waiters = [];
  socket.on('data', (c) => {
    frames.push(...decoder.push(c).frames);
    for (const w of [...waiters]) w();
  });
  const waitFor = (pred, ms = 3000) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out waiting for frame')), ms);
      const check = () => {
        const hit = frames.find(pred);
        if (hit) {
          clearTimeout(t);
          waiters.splice(waiters.indexOf(check), 1);
          resolve(hit);
        }
      };
      waiters.push(check);
      check();
    });
  return { socket, frames, waitFor };
}

test('tcp: a bare request is ACKed, then the result comes back as a bare frame with the request id', async () => {
  const c = connect();
  c.socket.write(encodeFrame({ type: FrameType.MESSAGE_ACK, ackId: 41, body: Buffer.from(bare('Q1_PERSON', '<Name>DOE, JANE A</Name><OperatorLicenseNumber>D0000001</OperatorLicenseNumber>')) }));
  const ack = await c.waitFor((f) => f.type === FrameType.ACK);
  assert.equal(ack.ackId, 41);
  const result = await c.waitFor((f) => f.type === FrameType.MESSAGE_ACK && f.body.length > 0);
  const xml = result.body.toString();
  assert.match(xml, /^<\?xml version="1\.0"\?>\n<LawEnforcementTransaction/);
  assert.doesNotMatch(xml, /ConnectCicApi/);
  assert.match(xml, /<Request>\s*<Id>Q1_PERSON<\/Id>/);
  assert.match(xml, /<Class>DriverLicense<\/Class>/);
  assert.doesNotMatch(xml, /REALUSER|REALORI01|SECRETPW/);
  // The agent ACKs results; make sure that ACK is accepted silently.
  c.socket.write(encodeFrame({ type: FrameType.ACK, ackId: result.ackId }));
  c.socket.destroy();

  const txn = listTransactions().find((t) => t.origin === 'tcp' && t.queries[0]?.requestId === 'Q1_PERSON');
  assert.equal(txn.protocol, 'TCP');
  assert.doesNotMatch(JSON.stringify(txn), /REALUSER|REALORI01|SECRETPW/);
  assert.match(txn.sent, /<Password>\*\*\*<\/Password>/);
  assert.equal(txn.state, 'delivered');
});

test('tcp: an unknown value gets a NoRecord result; the ConnectCicApi envelope form is accepted too', async () => {
  const c = connect();
  const env = toEnvelope(bare('Q2_PERSON', '<Name>NOBODY, NONE</Name>'));
  c.socket.write(encodeFrame({ type: FrameType.MESSAGE_ACK, ackId: 5, body: Buffer.from(env) }));
  await c.waitFor((f) => f.type === FrameType.ACK && f.ackId === 5);
  const result = await c.waitFor((f) => f.body.length > 0);
  assert.match(result.body.toString(), /<Class>NoRecord<\/Class>/);
  c.socket.destroy();
});

test('tcp: the server sends heartbeats and ACKs the agent\'s own empty frames', async () => {
  const c = connect();
  const hb = await c.waitFor((f) => f.type === FrameType.MESSAGE_ACK && f.body.length === 0);
  assert.ok(hb.ackId > 0);
  c.socket.write(encodeFrame({ type: FrameType.MESSAGE_ACK, ackId: 99 }));
  const ack = await c.waitFor((f) => f.type === FrameType.ACK && f.ackId === 99);
  assert.equal(ack.body.length, 0);
  c.socket.destroy();
});

test('tcp: garbage that parses as nothing is NAKed, an encrypted frame is NAKed, and the connection survives', async () => {
  const c = connect();
  c.socket.write(encodeFrame({ type: FrameType.MESSAGE_ACK, ackId: 8, body: Buffer.from('not xml at all') }));
  const nak = await c.waitFor((f) => f.type === FrameType.NAK && f.ackId === 8);
  assert.equal(nak.body.length, 0);
  c.socket.write(encodeFrame({ type: FrameType.ENCRYPTED_ACK, ackId: 9, body: Buffer.from('xx') }));
  await c.waitFor((f) => f.type === FrameType.NAK && f.ackId === 9);
  c.socket.write(encodeFrame({ type: FrameType.MESSAGE_ACK, ackId: 10 }));
  await c.waitFor((f) => f.type === FrameType.ACK && f.ackId === 10);
  c.socket.destroy();
});

test('tcp: ack mode http503 NAKs and sends no results; timeout mode never answers', async () => {
  updateSettings({ ackMode: 'http503' });
  let c = connect();
  c.socket.write(encodeFrame({ type: FrameType.MESSAGE_ACK, ackId: 21, body: Buffer.from(bare('Q3_PERSON', '<Name>DOE, JANE A</Name>')) }));
  await c.waitFor((f) => f.type === FrameType.NAK && f.ackId === 21);
  c.socket.destroy();

  updateSettings({ ackMode: 'timeout' });
  c = connect();
  c.socket.write(encodeFrame({ type: FrameType.MESSAGE_ACK, ackId: 22, body: Buffer.from(bare('Q4_PERSON', '<Name>DOE, JANE A</Name>')) }));
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!c.frames.some((f) => f.ackId === 22 && (f.type === FrameType.ACK || f.type === FrameType.NAK)));
  c.socket.destroy();
  updateSettings({ ackMode: 'success' });
});

test('tcp: connections beyond the limit and from non-allowed addresses are refused', async () => {
  const limited = createTcpServer({ heartbeatMs: 0, maxConnections: 1 });
  await new Promise((r) => limited.listen(0, '127.0.0.1', r));
  const p = limited.address().port;
  const first = net.connect(p, '127.0.0.1');
  await new Promise((r) => first.once('connect', r));
  const second = net.connect(p, '127.0.0.1');
  await new Promise((r) => second.once('close', r));
  assert.ok(second.destroyed);

  const denied = createTcpServer({ heartbeatMs: 0, allowIps: ['10.9.9.9'] });
  await new Promise((r) => denied.listen(0, '127.0.0.1', r));
  const third = net.connect(denied.address().port, '127.0.0.1');
  await new Promise((r) => third.once('close', r));
  assert.ok(third.destroyed);
  first.destroy();
  limited.closeAll();
  denied.closeAll();
});
