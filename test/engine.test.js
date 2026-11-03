import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildRequestXml } from '../src/requests.js';
import { parseRequest, soapEnvelope, unwrapSoap, buildResultXml } from '../src/xml.js';
import { findRecords, entityTypeOf, splitName } from '../src/matcher.js';
import { SEED_RECORDS } from '../src/seed.js';
import { processRequest, listTransactions } from '../src/engine.js';
import { updateSettings } from '../src/store.js';

test('request builder output parses back with ids and fields intact', () => {
  const xml = buildRequestXml({ entityType: 'VEHICLE', queryId: 'Q1', fields: { LicensePlateNumber: 'TST1234', State: 'XX' } });
  const parsed = parseRequest(xml);
  const q = parsed.transactions[0];
  assert.equal(q.requestId, 'Q1_VEHICLE');
  assert.equal(q.transactionId, 'Q1_VEHICLE');
  assert.equal(q.fields.LicensePlateNumber, 'TST1234');
  assert.equal(entityTypeOf(q.requestId, q.messageType), 'VEHICLE');
});

test('SOAP envelope round-trips the inner document and response url', () => {
  const inner = buildRequestXml({ entityType: 'PERSON', fields: { Name: 'DOE, JANE' } });
  const un = unwrapSoap(soapEnvelope(inner, 'SendMessage', 'http://example.test/cb'));
  assert.equal(un.responseUrl, 'http://example.test/cb');
  assert.equal(parseRequest(un.xml).transactions[0].fields.Name, 'DOE, JANE');
});

test('name matching handles comma and space forms, prefix first names, and rejects other surnames', () => {
  assert.deepEqual(splitName('Doe, Jane A'), { last: 'DOE', first: 'JANE' });
  const hit = (name) => findRecords(SEED_RECORDS, 'PERSON', { Name: name }).map((r) => r.id);
  assert.deepEqual(hit('DOE, JANE'), ['seed-person-doe-dmv']);
  assert.deepEqual(hit('DOE JANE'), ['seed-person-doe-dmv']);
  assert.deepEqual(hit('DOE'), ['seed-person-doe-dmv']);
  assert.deepEqual(hit('DOE, JOHN'), []);
  assert.deepEqual(findRecords(SEED_RECORDS, 'PERSON', { OperatorLicenseNumber: 's-000 0002' }).map((r) => r.id), ['seed-person-sample-wanted']);
});

test('result XML is itself parseable as a Response with the echoed request id', () => {
  const xml = buildResultXml({ deviceId: 'DEV1', transactionId: 'T1_PERSON', requestId: 'T1_PERSON', result: SEED_RECORDS[0].results[0] });
  assert.match(xml, /<Request>\s*<Id>T1_PERSON<\/Id>\s*<\/Request>/);
  assert.match(xml, /<Class>DriverLicense<\/Class>/);
  assert.match(xml, /<Detected>0<\/Detected>/);
});

test('end to end: request -> ack -> one callback per result, wanted person yields two', async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ type: req.headers['content-type'], body });
      res.setHeader('content-type', 'application/xml');
      res.end('<ok/>');
    });
  });
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}/interface-agent/v2/query-result`;
  updateSettings({ callbackUrl: url, resultDelayMs: 0, betweenResultsMs: 0, ackMode: 'success', resultMode: 'normal' });

  const rawBody = buildRequestXml({ entityType: 'PERSON', queryId: 'E2E', fields: { Name: 'SAMPLE, ALEX', OperatorLicenseNumber: 'S0000002' } });
  const ack = await processRequest({ rawBody, headers: { 'x-api-key': 'secretvalue' } });
  assert.equal(ack.httpStatus, 200);
  assert.match(ack.body, /<api:Status>Succeeded<\/api:Status>/);

  const txn = listTransactions()[0];
  assert.equal(txn.headers['x-api-key'], '(redacted)');
  assert.equal(txn.results.length, 2);
  for (let i = 0; i < 50 && txn.state !== 'delivered'; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(txn.state, 'delivered');
  assert.equal(received.length, 2);
  assert.match(received[0].body, /<Id>E2E_PERSON<\/Id>/);
  assert.ok(received.some((r) => /<Class>WantedPerson<\/Class>/.test(r.body)));
  server.close();
});

test('unmatched query returns a NoRecord result; malformed body is rejected with 400', async () => {
  updateSettings({ callbackUrl: '', ackMode: 'success', resultMode: 'normal' });
  const rawBody = buildRequestXml({ entityType: 'VEHICLE', queryId: 'MISS', fields: { LicensePlateNumber: 'NOPE000' } });
  await processRequest({ rawBody, headers: {} });
  const txn = listTransactions()[0];
  assert.equal(txn.results[0].class, 'NoRecord');
  assert.equal(txn.state, 'held');

  const bad = await processRequest({ rawBody: '<not-connectcic/>', headers: {} });
  assert.equal(bad.httpStatus, 400);
  assert.match(bad.body, /Failed/);
});

test('ack failure modes: http503 and SOAP fault', async () => {
  updateSettings({ ackMode: 'http503' });
  const rawBody = buildRequestXml({ entityType: 'VEHICLE', fields: { LicensePlateNumber: 'TST1234' } });
  assert.equal((await processRequest({ rawBody, headers: {} })).httpStatus, 503);
  updateSettings({ ackMode: 'soapFault' });
  const fault = await processRequest({ rawBody, headers: {} });
  assert.equal(fault.httpStatus, 500);
  assert.match(fault.body, /Fault/);
  updateSettings({ ackMode: 'success' });
});
