import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dexe-regions-'));
const { createApp } = await import('../src/server.js');
const { processRequest, listTransactions } = await import('../src/engine.js');
const { applyRegion, formatDate, REGIONS, listRegions, DEFAULT_REGION } = await import('../src/regions.js');
const { withDerivedFields } = await import('../src/normalize.js');
const { buildResultXml } = await import('../src/xml.js');
const { noRecordResult } = await import('../src/matcher.js');
const { SEED_RECORDS } = await import('../src/seed.js');
const { buildRequestXml } = await import('../src/requests.js');
const { updateSettings } = await import('../src/store.js');

const resultOf = (recordId, cls) => SEED_RECORDS.find((r) => r.id === recordId).results.find((x) => x.class === cls);
const build = (res, region) => {
  const full = applyRegion(withDerivedFields(res), region);
  return { full, xml: buildResultXml({ deviceId: 'DEV1', transactionId: 'T', requestId: 'T', result: full }) };
};

test('formatDate handles each pattern and leaves non-dates alone', () => {
  assert.equal(formatDate('20260115', 'MM/DD/YY'), '01/15/26');
  assert.equal(formatDate('20260115', 'MM-DD-YYYY'), '01-15-2026');
  assert.equal(formatDate('20260115', 'YYYY-MM-DD'), '2026-01-15');
  assert.equal(formatDate('20260115', 'YYYYMMDD'), '20260115');
  assert.equal(formatDate('not a date', 'MM/DD/YY'), 'not a date');
});

test('GENERIC changes nothing', () => {
  const res = withDerivedFields(resultOf('seed-vehicle-stolen', 'StolenVehicle'));
  assert.equal(applyRegion(res, DEFAULT_REGION), res);
  assert.equal(applyRegion(res, 'NOT_A_REGION'), res);
});

test('FL_FCIC: QueryState, MM/DD/YY dates, space-separated names, FL codes, normalized copies untouched', () => {
  const { full, xml } = build(resultOf('seed-vehicle-registered', 'VehicleRegistration'), 'FL_FCIC');
  assert.equal(full.interfaceName, 'FL_FCIC');
  assert.equal(full.queryState, 'FL');
  assert.equal(full.fields.IssueDate, '01/01/26');
  assert.equal(full.fields.ExpirationDate, '12/31/27');
  assert.equal(full.fields.NormalizedIssueDate, '20260101', 'normalized stays YYYYMMDD, as in the real exemplar');
  assert.equal(full.fields.Name, 'DOE JANE A');
  assert.equal(full.fields.NormalizedName, 'DOE, JANE A');
  assert.equal(full.fields.AddressStateCode, 'FL');
  assert.equal(full.fields.LicensePlateStateCode, 'FL');
  assert.match(xml, /<QueryState>FL<\/QueryState>/);
  assert.match(xml, /<ResponseType>DMV<\/ResponseType>/);
  assert.ok(!/MOCKORI|\bXX\b/.test(xml), 'no placeholder agency ids or state codes left');
});

test('CA_CLETS: date styles and firearms sourced from AFS', () => {
  const dl = build(resultOf('seed-person-doe-dmv', 'DriverLicense'), 'CA_CLETS').full;
  assert.equal(dl.fields.BirthDate, '01-15-1990');
  assert.equal(dl.fields.ExpirationDate, '12-31-29');
  assert.equal(dl.fields.OperatorLicenseStateCode, 'CA');
  const gun = build(resultOf('seed-firearm-stolen', 'StolenGun'), 'CA_CLETS').full;
  assert.deepEqual([gun.system, gun.systemName, gun.responseType, gun.interfaceName], ['AFS', 'AFS_RECORD', 'AFS', 'CA_CLETS']);
  assert.equal(gun.fields.TheftDate, '20260115');
});

test('CA_ESUN uses its own system names', () => {
  const gun = build(resultOf('seed-firearm-stolen', 'StolenGun'), 'CA_ESUN').full;
  assert.deepEqual([gun.systemName, gun.interfaceName], ['AFS_STOLE_GUN', 'CA_eSUN']);
  assert.equal(build(resultOf('seed-boat-stolen', 'StolenBoat'), 'CA_ESUN').full.systemName, 'NCIC_STOLE_BOAT');
});

test('LA_LEMS leaves Hit/Detected blank; LA_LEMS_OFML uses wordy types and DMV_Person', () => {
  const stolen = build(resultOf('seed-firearm-stolen', 'StolenGun'), 'LA_LEMS');
  assert.match(stolen.xml, /<Detected><\/Detected>/);
  assert.equal(stolen.full.fields.TheftDate, '2026-01-15');
  const dl = build(resultOf('seed-person-doe-dmv', 'DriverLicense'), 'LA_LEMS_OFML').full;
  assert.deepEqual([dl.responseType, dl.systemName], ['DMV Person Record', 'DMV_Person']);
  const none = build(noRecordResult('PERSON'), 'LA_LEMS_OFML').full;
  assert.deepEqual([none.responseType, none.systemName], ['NCIC Person No Record', 'NCIC_PERSON_NORECORD']);
});

test('KS_KIBRS names DMV results "DMV" and NCIC results KS_KIBRS; TN_TIES uses TIES and plain system names', () => {
  assert.equal(build(resultOf('seed-vehicle-stolen', 'VehicleRegistration'), 'KS_KIBRS').full.interfaceName, 'DMV');
  assert.equal(build(resultOf('seed-vehicle-stolen', 'StolenVehicle'), 'KS_KIBRS').full.interfaceName, 'KS_KIBRS');
  const tn = build(resultOf('seed-vehicle-stolen', 'StolenVehicle'), 'TN_TIES').full;
  assert.deepEqual([tn.responseType, tn.messageType, tn.systemName, tn.interfaceName], ['TIES', 'TIES', 'NCIC', 'TN_TIES']);
});

test('no region adds or removes a field: it only rewords values', () => {
  for (const id of Object.keys(REGIONS)) {
    for (const record of SEED_RECORDS) {
      for (const res of record.results) {
        const before = withDerivedFields(res);
        const after = applyRegion(before, id);
        assert.deepEqual(Object.keys(after.fields).sort(), Object.keys(before.fields).sort(), `${id} changed the field set of ${res.class}`);
      }
    }
  }
});

test('a region set in Settings (or per call) reaches the results and the call log', async () => {
  const send = (region) => processRequest({ rawBody: buildRequestXml({ entityType: 'VEHICLE', fields: { LicensePlateNumber: 'STL9999' } }), headers: {}, region });
  updateSettings({ region: 'FL_FCIC', callbackUrl: '' });
  await send(null);
  let txn = listTransactions()[0];
  assert.equal(txn.region, 'FL_FCIC');
  assert.ok(txn.results.every((r) => /<IntInterfaceName>FL_FCIC<\/IntInterfaceName>/.test(r.xml)));
  await send('CA_CLETS');
  txn = listTransactions()[0];
  assert.equal(txn.region, 'CA_CLETS', 'per-call override wins');
  await send('NOPE');
  assert.equal(listTransactions()[0].region, 'FL_FCIC', 'an unknown override falls back to the setting');
  updateSettings({ region: 'GENERIC' });
});

test('API: regions are listed, invalid regions are refused, valid ones are saved', async () => {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const put = (body) => fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.regions.length, listRegions().length);
  assert.ok(state.regions.some((r) => r.id === 'TN_TIES' && /least certain/.test(r.note)));
  assert.equal((await put({ region: 'ATLANTIS' })).status, 400);
  assert.equal((await put({ region: 'LA_LEMS' })).status, 200);
  assert.equal((await (await fetch(`${base}/api/state`)).json()).settings.region, 'LA_LEMS');
  await put({ region: 'GENERIC' });
  const sim = await fetch(`${base}/api/simulate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entityType: 'PERSON', fields: { Name: 'DOE, JANE' }, region: 'ATLANTIS' }) });
  assert.equal(sim.status, 400);
  server.close();
});
