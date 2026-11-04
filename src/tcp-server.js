// TCP listener: the mock Commsys end of the interface agent's TCP mode (agent = client, this = server).
//
//   agent --frame(0x01, LawEnforcementTransaction request)--> here --frame(0x10 ACK)--> agent
//   here --frame(0x01, LawEnforcementTransaction result), one per result--> agent --ACK--> here
//   here --empty frame(0x01) every TCP_HEARTBEAT_MS--> agent --ACK--> here
//
// Requests go through the same processRequest pipeline as /connectcic, so records, regions, settings
// (ack mode, result mode, delays) and the call log behave the same. Encryption is not supported (the
// test tenant runs without a key); an encrypted frame is NAKed. There is no authentication on this port,
// so it only ever serves the synthetic records, and TCP_ALLOWED_IPS can restrict who may connect.
import net from 'node:net';
import { processRequest, bus } from './engine.js';
import { settings } from './store.js';
import { FrameDecoder, FrameType, encodeFrame, isAckRequired, isEncrypted } from './tcp-frame.js';
import { toEnvelope, toBareResult } from './tcp-adapter.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPE_NAMES = Object.fromEntries(Object.entries(FrameType).map(([name, value]) => [value, name]));
const typeName = (t) => TYPE_NAMES[t] ?? `0x${t.toString(16)}`;

let connectionCount = 0;

export function createTcpServer({ heartbeatMs = 30000, allowIps = [], maxConnections = 10, resultFormat = 'bare', log = () => {} } = {}) {
  const sockets = new Set();

  const server = net.createServer((socket) => {
    const ip = (socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (allowIps.length && !allowIps.includes(ip)) {
      log(`tcp connection refused: ${ip} is not in TCP_ALLOWED_IPS`);
      socket.destroy();
      return;
    }
    if (sockets.size >= maxConnections) {
      log(`tcp connection refused from ${ip}: ${maxConnections} connections already open`);
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30000);
    const conn = `#${++connectionCount} ${ip}`;
    const openedAt = Date.now();
    const counts = { frames: 0, queries: 0, acksSent: 0, nakSent: 0, resultsSent: 0, heartbeatsSent: 0, bytesIn: 0 };
    const clog = (m) => log(`tcp ${conn}: ${m}`);
    clog(`opened (${sockets.size} open)`);

    const decoder = new FrameDecoder();
    let ackCounter = 0;
    const nextAckId = () => (ackCounter = (ackCounter + 1) & 0xffff);
    const send = (frame) => {
      if (socket.destroyed) return;
      socket.write(encodeFrame(frame));
      if (frame.type === FrameType.ACK) counts.acksSent++;
      else if (frame.type === FrameType.NAK) counts.nakSent++;
    };
    const heartbeat = heartbeatMs > 0
      ? setInterval(() => {
          counts.heartbeatsSent++;
          send({ type: FrameType.MESSAGE_ACK, ackId: nextAckId() });
          if (counts.heartbeatsSent === 1 || counts.heartbeatsSent % 20 === 0) clog(`heartbeat ${counts.heartbeatsSent} sent`);
        }, heartbeatMs)
      : null;

    async function deliver(txn) {
      txn.state = 'delivering';
      bus.emit('txn', txn);
      const cfg = settings();
      await sleep(cfg.resultDelayMs);
      let failed = false;
      for (let i = 0; i < txn.results.length; i++) {
        const xml = resultFormat === 'envelope' ? txn.results[i].xml : toBareResult(txn.results[i].xml);
        const delivery = { ts: new Date().toISOString(), url: 'tcp', resultIndex: i, sent: xml, status: null, response: null, error: null, ms: 0 };
        txn.deliveries.push(delivery);
        if (socket.destroyed) {
          delivery.error = 'connection closed';
          failed = true;
        } else {
          send({ type: FrameType.MESSAGE_ACK, ackId: nextAckId(), body: Buffer.from(xml, 'utf8') });
          counts.resultsSent++;
          delivery.status = 200;
          delivery.response = 'sent over TCP';
        }
        bus.emit('txn', txn);
        if (i < txn.results.length - 1) await sleep(cfg.betweenResultsMs);
      }
      txn.state = failed ? 'delivery-failed' : 'delivered';
      bus.emit('txn', txn);
    }

    async function handleMessage(frame) {
      const wantsAck = isAckRequired(frame.type);
      if (isEncrypted(frame.type)) {
        clog('encrypted frame rejected (encryption is not supported), sent NAK');
        send({ type: FrameType.NAK, ackId: frame.ackId });
        return;
      }
      if (!frame.body.length) {
        if (wantsAck) send({ type: FrameType.ACK, ackId: frame.ackId }); // heartbeat
        clog(`empty frame (heartbeat) from peer, ackId=${frame.ackId}${wantsAck ? ', ACKed' : ''}`);
        return;
      }
      counts.queries++;
      const loggedBody = frame.body.toString('utf8');
      let rawBody = loggedBody;
      try {
        rawBody = toEnvelope(loggedBody);
      } catch {
        // Not parseable: processRequest records the rejection in the call log.
      }
      let txn = null;
      const ack = await processRequest({
        rawBody, loggedBody, path: 'tcp', origin: 'tcp', protocol: 'TCP', deliver: false, maskAuth: true, onTxn: (t) => { txn = t; },
      });
      // Opaque ids, entity types and counts only: never request or result contents.
      const summary = `request bytes=${frame.body.length} ids=[${(txn?.queries ?? []).map((q) => q.requestId).join(',')}] entity=[${(txn?.queries ?? []).map((q) => q.entityType).join(',')}] results=${txn?.results.length ?? 0}`;
      if (!ack.httpStatus) {
        clog(`query received (${summary}); simulating a timeout, no reply`);
        return;
      }
      if (ack.httpStatus !== 200) {
        send({ type: FrameType.NAK, ackId: frame.ackId });
        clog(`query received (${summary}); sent NAK (${txn?.state ?? 'rejected'})`);
        return;
      }
      if (wantsAck) send({ type: FrameType.ACK, ackId: frame.ackId });
      clog(`query received (${summary}); ACK sent for ackId=${frame.ackId}`);
      if (txn.state === 'resolved' && txn.results.length) {
        await deliver(txn);
        clog(`${txn.results.length} result frame(s) sent, state=${txn.state}`);
      }
    }

    socket.on('data', (chunk) => {
      counts.bytesIn += chunk.length;
      const { frames, errors } = decoder.push(chunk);
      // First bytes only when nothing decodes: shows whether the peer speaks this protocol at all, without logging a payload.
      if (!frames.length && errors.length && counts.frames === 0 && counts.bytesIn <= 64) clog(`first ${chunk.length} bytes were not a frame (starts ${chunk.subarray(0, 4).toString('hex')})`);
      for (const e of errors) clog(`frame skipped: ${e}`);
      for (const frame of frames) {
        counts.frames++;
        if (frame.type === FrameType.ACK || frame.type === FrameType.NAK) {
          if (frame.type === FrameType.NAK) clog(`peer sent NAK for ackId=${frame.ackId}`);
          continue; // replies to our heartbeats and results
        }
        if (frame.body.length) clog(`frame received: ${typeName(frame.type)} ackId=${frame.ackId} body=${frame.body.length} bytes`);
        handleMessage(frame).catch((err) => clog(`message failed: ${err.message}`));
      }
    });
    socket.on('error', (err) => clog(`socket error: ${err.code ?? err.message}`)); // resets and timeouts are routine; 'close' does the cleanup
    socket.on('close', () => {
      if (heartbeat) clearInterval(heartbeat);
      sockets.delete(socket);
      clog(`closed after ${Math.round((Date.now() - openedAt) / 1000)}s (${sockets.size} open): ${counts.frames} frames in, ${counts.bytesIn} bytes in, ${counts.queries} queries, ${counts.acksSent} ACK/${counts.nakSent} NAK sent, ${counts.resultsSent} results sent, ${counts.heartbeatsSent} heartbeats sent`);
    });
  });

  server.closeAll = () => {
    for (const s of sockets) s.destroy();
    server.close();
  };
  return server;
}
