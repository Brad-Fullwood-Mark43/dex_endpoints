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

export function createTcpServer({ heartbeatMs = 30000, allowIps = [], maxConnections = 10, resultFormat = 'bare', log = () => {} } = {}) {
  const sockets = new Set();

  const server = net.createServer((socket) => {
    const ip = (socket.remoteAddress || '').replace(/^::ffff:/, '');
    if ((allowIps.length && !allowIps.includes(ip)) || sockets.size >= maxConnections) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30000);
    log(`tcp connection opened (${sockets.size} open)`);

    const decoder = new FrameDecoder();
    let ackCounter = 0;
    const nextAckId = () => (ackCounter = (ackCounter + 1) & 0xffff);
    const send = (frame) => {
      if (!socket.destroyed) socket.write(encodeFrame(frame));
    };
    const heartbeat = heartbeatMs > 0 ? setInterval(() => send({ type: FrameType.MESSAGE_ACK, ackId: nextAckId() }), heartbeatMs) : null;

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
        log('tcp encrypted frame rejected (encryption is not supported)');
        send({ type: FrameType.NAK, ackId: frame.ackId });
        return;
      }
      if (!frame.body.length) {
        if (wantsAck) send({ type: FrameType.ACK, ackId: frame.ackId }); // heartbeat
        return;
      }
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
      if (!ack.httpStatus) return; // simulated timeout: never answer
      if (ack.httpStatus !== 200) {
        send({ type: FrameType.NAK, ackId: frame.ackId });
        return;
      }
      if (wantsAck) send({ type: FrameType.ACK, ackId: frame.ackId });
      if (txn.state === 'resolved' && txn.results.length) await deliver(txn);
    }

    socket.on('data', (chunk) => {
      const { frames, errors } = decoder.push(chunk);
      for (const e of errors) log(`tcp frame skipped: ${e}`);
      for (const frame of frames) {
        if (frame.type === FrameType.ACK || frame.type === FrameType.NAK) continue; // replies to our heartbeats and results
        handleMessage(frame).catch((err) => log(`tcp message failed: ${err.message}`));
      }
    });
    socket.on('error', () => {}); // resets and timeouts are routine; 'close' does the cleanup
    socket.on('close', () => {
      if (heartbeat) clearInterval(heartbeat);
      sockets.delete(socket);
      log(`tcp connection closed (${sockets.size} open)`);
    });
  });

  server.closeAll = () => {
    for (const s of sockets) s.destroy();
    server.close();
  };
  return server;
}
