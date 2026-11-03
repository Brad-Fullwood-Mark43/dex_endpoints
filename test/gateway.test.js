import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.API_KEY = 'mock-only-secret';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dexe-'));
const { createApp } = await import('../src/server.js');
const { listTransactions } = await import('../src/engine.js');
const { recordsFromCsv, parseCsv } = await import('../src/csv-import.js');
const { allowlist } = await import('../src/matcher.js');
const { SEED_RECORDS } = await import('../src/seed.js');

const require = createRequire(import.meta.url);
const gateway = require('../prismatic/gateway-step.cjs');
const deliver = require('../prismatic/deliver-step.cjs');

let server;
let mockUrl;
const logger = { info() {}, warn() {}, error() {} };
const configVars = () => ({ 'Gateway Key': 'real-fs-key', 'Mock Service URL': mockUrl, 'Mock Service Key': 'mock-only-secret' });

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  mockUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const request = (fields, { id = 'Q1_PERSON', auth = true } = {}) =>
  `<?xml version="1.0"?><api:ConnectCicApi xmlns:api="http://schema.commsys.com/xml/ConnectCic/Api"><api:Route><api:Source>DEV1</api:Source><api:Destinations><api:Destination>ConnectCIC</api:Destination></api:Destinations></api:Route>` +
  `<api:Transactions><api:Transaction id="${id}"><LawEnforcementTransaction version="1.0"><Session><Id>DEV1</Id>` +
  (auth ? `<Authentication><UserName>REALUSER</UserName><Password>SECRETPW</Password><ORI>REALORI01</ORI><DeviceId>DEV1</DeviceId></Authentication>` : '') +
  `</Session><Transaction><Request><Id>${id}</Id><MessageType>DriverLicenseQuery</MessageType>${fields}</Request></Transaction></LawEnforcementTransaction></api:Transaction></api:Transactions></api:ConnectCicApi>`;

const run = (xml, { key = 'real-fs-key', headerName = 'X-Api-Key' } = {}) =>
  gateway({ logger, configVars: configVars() }, { commsysWebhook: { results: { headers: { [headerName]: key }, rawBody: Buffer.from(xml) } } });

test('allowlisted query passes: sanitized request reaches the mock, ack and results come back', async () => {
  const before = listTransactions().length;
  const { data } = await run(request('<Name>DOE, JANE A</Name><OperatorLicenseNumber>D0000001</OperatorLicenseNumber><State>XX</State>'));
  assert.equal(data.status, 200);
  assert.match(data.body, /<api:Status>Succeeded<\/api:Status>/);
  const job = JSON.parse(data.deliveries);
  assert.equal(job.protocol, 'REST');
  assert.equal(job.results.length, 1);
  assert.match(job.results[0], /<Class>DriverLicense<\/Class>/);
  assert.match(job.results[0], /<Id>Q1_PERSON<\/Id>/);

  const txn = listTransactions()[0];
  assert.equal(listTransactions().length, before + 1);
  assert.equal(txn.origin, 'gateway');
  assert.equal(txn.state, 'resolved');
  for (const leaked of ['REALUSER', 'SECRETPW', 'REALORI01', 'real-fs-key']) {
    assert.ok(!txn.sent.includes(leaked) && !JSON.stringify(txn.headers).includes(leaked), `${leaked} must not reach the mock`);
  }
});

test('a name or plate that is not on the allowlist is rejected before anything is sent', async () => {
  const before = listTransactions().length;
  const bad = await run(request('<Name>REALPERSON, ACTUAL</Name>'));
  assert.equal(bad.data.status, 403);
  assert.match(bad.data.body, /not on the test allowlist/);
  assert.ok(!bad.data.body.includes('REALPERSON'), 'rejection must not echo the value');
  const dob = await run(request('<Name>DOE, JANE</Name><BirthDate>19010101</BirthDate>'));
  assert.equal(dob.data.status, 403);
  assert.equal(listTransactions().length, before, 'nothing reached the mock');
});

test('unknown field names, wrong key and missing key are rejected', async () => {
  assert.equal((await run(request('<Name>DOE, JANE</Name><HomePhone>5550100</HomePhone>'))).data.status, 403);
  assert.equal((await run(request('<Name>DOE, JANE</Name>'), { key: 'wrong' })).data.status, 401);
  assert.equal((await run(request('<Name>DOE, JANE</Name>'), { key: '' })).data.status, 401);
});

test('header names are matched case-insensitively and SOAP requests get SOAP acks', async () => {
  const inner = request('<Name>DOE, JANE</Name>');
  const soap = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><wsi:SendMessage xmlns:wsi="http://schema.commsys.com/xml/ConnectCic/Api/Soap"><wsi:Message><![CDATA[${inner}]]></wsi:Message></wsi:SendMessage></s:Body></s:Envelope>`;
  const { data } = await run(soap, { headerName: 'x-api-key' });
  assert.equal(data.status, 200);
  assert.match(data.body, /SendMessageResult/);
  assert.equal(JSON.parse(data.deliveries).protocol, 'SOAP');
});

test('/resolve and /allowlist refuse callers without the key', async () => {
  assert.equal((await fetch(`${mockUrl}/allowlist`)).status, 401);
  assert.equal((await fetch(`${mockUrl}/resolve`, { method: 'POST', body: '<x/>' })).status, 401);
  const list = await (await fetch(`${mockUrl}/allowlist`, { headers: { 'x-api-key': 'mock-only-secret' } })).json();
  assert.ok(list.Name.includes('DOE|JANE'));
  assert.ok(list.LicensePlateNumber.includes('TST1234'));
});

test('delivery step posts each result in order and fails loudly on a bad callback', async () => {
  const got = [];
  const cb = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { got.push({ type: req.headers['content-type'], body }); res.statusCode = got.length === 2 ? 500 : 200; res.end('<ok/>'); });
  });
  await new Promise((r) => cb.listen(0, r));
  const url = `http://127.0.0.1:${cb.address().port}/interface-agent/v2/query-result`;
  const job = JSON.stringify({ protocol: 'REST', delays: { resultDelayMs: 0, betweenResultsMs: 0 }, results: ['<a/>', '<b/>'] });
  const stepResults = { crossFlowTrigger: { results: { body: { data: job } } } };

  await assert.rejects(deliver({ logger, configVars: { 'Callback URL': url } }, stepResults), /callbacks failed: 200, 500/);
  assert.deepEqual(got.map((g) => g.body), ['<a/>', '<b/>']);
  assert.equal(got[0].type, 'application/xml');
  assert.deepEqual((await deliver({ logger, configVars: {} }, { crossFlowTrigger: { results: { body: { data: '' } } } })).data, { delivered: 0, statuses: [] });
  cb.close();
});

test('CSV import groups rows into records, reports bad rows, and feeds the allowlist', () => {
  const csv = fs.readFileSync(new URL('../public/records-template.csv', import.meta.url), 'utf8') + 'PERSON,,,,,,,,,,,,,,,,,,,,,,,,,,,,\nBOGUS,x\n';
  const { records, errors } = recordsFromCsv(csv);
  const jordan = records.find((r) => r.name === 'Jordan Example - license');
  const widths = new Set(parseCsv(fs.readFileSync(new URL('../public/records-template.csv', import.meta.url), 'utf8')).map((r) => r.length));
  assert.equal(widths.size, 1, 'every template row has the same number of columns as the header');
  assert.equal(jordan.results.length, 2);
  assert.deepEqual(jordan.results.map((r) => [r.class, r.hit, r.system]), [['DriverLicense', false, 'DMV'], ['WantedPerson', true, 'NCIC']]);
  assert.equal(jordan.match.OperatorLicenseNumber, 'E0000100');
  assert.equal(errors.length, 2);
  assert.match(errors[0], /needs at least one of/);
  const list = allowlist([...SEED_RECORDS, ...records]);
  assert.ok(list.Name.includes('EXAMPLE|JORDAN'));
  assert.ok(list.VehicleIdentificationNumber.includes('1TEST00000S000100'));
});
