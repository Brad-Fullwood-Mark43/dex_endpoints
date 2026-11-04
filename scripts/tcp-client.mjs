// Stand-in for the interface agent's TCP mode: connects, sends one query, prints the frames that come back.
//   node scripts/tcp-client.mjs <host> <port> [--name "DOE, JANE A"] [--license D0000001] [--wait 5]
// Prints frame types and the result XML (synthetic data only). Use it to check the Railway TCP proxy
// before pointing a real agent at it.
import net from 'node:net';
import { FrameDecoder, FrameType, encodeFrame } from '../src/tcp-frame.js';

const [host, port, ...rest] = process.argv.slice(2);
if (!host || !port) {
  console.error('usage: node scripts/tcp-client.mjs <host> <port> [--name NAME] [--license NUMBER] [--wait SECONDS]');
  process.exit(2);
}
const opt = (flag, fallback) => (rest.includes(flag) ? rest[rest.indexOf(flag) + 1] : fallback);
const name = opt('--name', 'DOE, JANE A');
const license = opt('--license', 'D0000001');
const waitMs = Number(opt('--wait', '5')) * 1000;
const id = `TCPCHECK${Date.now()}_PERSON`;

const xml =
  `<?xml version="1.0"?><LawEnforcementTransaction version="1.0"><Session><Authentication><UserName>TESTUSER</UserName><ORI>MOCKORI01</ORI><DeviceId>MOCKDEVICE01</DeviceId></Authentication><Id>MOCKDEVICE01</Id></Session>` +
  `<Transaction><Request><Id>${id}</Id><MessageType>DriverLicenseQuery</MessageType><Name>${name}</Name><OperatorLicenseNumber>${license}</OperatorLicenseNumber></Request></Transaction></LawEnforcementTransaction>`;

const typeName = (t) => Object.entries(FrameType).find(([, v]) => v === t)?.[0] ?? `0x${t.toString(16)}`;
const decoder = new FrameDecoder();
const socket = net.connect(Number(port), host, () => {
  console.log(`connected to ${host}:${port}, sending request ${id}`);
  socket.write(encodeFrame({ type: FrameType.MESSAGE_ACK, ackId: 1, body: Buffer.from(xml) }));
});
socket.on('data', (chunk) => {
  const { frames, errors } = decoder.push(chunk);
  for (const e of errors) console.log(`  (skipped: ${e})`);
  for (const f of frames) {
    console.log(`<- ${typeName(f.type)} ackId=${f.ackId} body=${f.body.length} bytes`);
    if (f.body.length) console.log(f.body.toString('utf8'));
    if (f.type === FrameType.MESSAGE_ACK) socket.write(encodeFrame({ type: FrameType.ACK, ackId: f.ackId }));
  }
});
socket.on('error', (err) => console.error('socket error:', err.code ?? err.message));
setTimeout(() => {
  socket.destroy();
  process.exit(0);
}, waitMs);
