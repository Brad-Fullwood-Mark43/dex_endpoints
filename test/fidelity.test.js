import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SEED_RECORDS, SEED_VERSION } from '../src/seed.js';
import { buildResultXml } from '../src/xml.js';
import { enrichFields, withDerivedFields } from '../src/normalize.js';

// Fields that real Commsys exemplars carry for each class and that Federated Search's result
// mappings read. A seed result missing one of these would map to a blank attribute.
const REQUIRED = {
  DriverLicense: ['Name', 'NameFirst', 'NameLast', 'NormalizedName', 'BirthDate', 'NormalizedBirthDateYear', 'HairColorCode', 'EyeColorCode', 'OperatorLicenseNumber', 'OperatorLicenseStateCode', 'AddressStateCode', 'NormalizedAddress', 'ExpirationDate'],
  WantedPerson: ['NameFirst', 'NameLast', 'NCICNumber', 'OffenseCode', 'WarrantNumber', 'OriginatingAgencyIdentifier', 'OriginatingAgencyCaseNumber', 'FreeText', 'MessageKey', 'BirthPlaceCode', 'HairColorCode', 'SocialSecurityNumber'],
  MissingPerson: ['NameFirst', 'NameLast', 'NCICNumber', 'OriginatingAgencyIdentifier', 'OriginatingAgencyCaseNumber', 'HairColorCode', 'MessageKey', 'NormalizedBirthDateYear'],
  VehicleRegistration: ['VehicleMakeCode', 'VehicleModelCode', 'VehicleStyleCode', 'VehicleColorCode', 'ImpliedLicensePlateStateCode', 'LicensePlateExpirationDate', 'ExpirationDate', 'NormalizedName', 'NormalizedAddress'],
  StolenVehicle: ['VehicleMakeCode', 'VehicleModelCode', 'VehicleStyleCode', 'VehicleColorCode', 'LicensePlateStateCode', 'LicensePlateYear', 'TheftDate', 'NormalizedTheftDateYear', 'FreeText', 'OriginatingAgencyIdentifier', 'MessageKey', 'NCICNumber'],
  StolenGun: ['GunModel', 'GunTypeCode', 'GunCaliber', 'GunMake', 'FreeText', 'OriginatingAgencyIdentifier', 'OriginatingAgencyCaseNumber', 'TheftDate', 'NCICNumber', 'MessageKey'],
  StolenBoat: ['BoatMakeCode', 'BoatSerialNumber', 'RegistrationNumber', 'LicensePlateNumber', 'LicensePlateStateCode', 'OriginatingAgencyIdentifier', 'FreeText', 'TheftDate', 'NCICNumber', 'RegistrationExpirationYear'],
  StolenArticle: ['ArticleBrand', 'ArticleModel', 'ArticleTypeCode', 'FreeText', 'OriginatingAgencyIdentifier', 'OriginatingAgencyCaseNumber', 'TheftDate', 'NCICNumber', 'MessageKey'],
};

test('every seed result carries the fields real Commsys exemplars and the result mappings use', () => {
  const seen = new Set();
  for (const record of SEED_RECORDS) {
    for (const res of record.results) {
      const xml = buildResultXml({ deviceId: 'DEV1', transactionId: 'T', requestId: 'T', result: withDerivedFields(res) });
      const required = REQUIRED[res.class];
      assert.ok(required, `no field list for class ${res.class}`);
      for (const field of required) assert.match(xml, new RegExp(`<${field}>[^<]+</${field}>`), `${res.class} (${record.id}) is missing ${field}`);
      seen.add(res.class);
    }
  }
  assert.deepEqual([...seen].sort(), Object.keys(REQUIRED).sort(), 'every class has at least one seed record');
});

test('derived fields: name parts, normalized dates and address, without overriding explicit values', () => {
  const out = enrichFields({ Name: 'EXAMPLE, JORDAN A', BirthDate: '19920214', TheftDate: '20260301', AddressStreet: '1 TEST ST', AddressCity: 'TESTVILLE', AddressStateCode: 'XX', AddressZipCode: '00001', VehicleYear: '2021', NormalizedBirthDateYear: 'KEEP' });
  assert.equal(out.NameLast, 'EXAMPLE');
  assert.equal(out.NameFirst, 'JORDAN');
  assert.equal(out.NameMiddle, 'A');
  assert.equal(out.NormalizedName, 'EXAMPLE, JORDAN A');
  assert.deepEqual([out.NormalizedBirthDate, out.NormalizedBirthDateMonth, out.NormalizedBirthDateDay], ['19920214', '02', '14']);
  assert.equal(out.NormalizedBirthDateYear, 'KEEP', 'explicit values win');
  assert.equal(out.NormalizedTheftDateYear, '2026');
  assert.equal(out.NormalizedAddress, '1 TEST ST, TESTVILLE, XX 00001');
  assert.equal(out.NormalizedVehicleYear, '2021');
  const parts = enrichFields({ IssueDate: '20240110', ExpirationDate: '20301021', Name: 'DOE, JANE' });
  assert.deepEqual([parts.NormalizedIssueDateYear, parts.NormalizedExpirationDateMonth, parts.NormalizedExpirationDateDay], ['2024', '10', '21']);
  assert.deepEqual([parts.NormalizedNameMiddle, parts.NormalizedNameSuffix], ['', ''], 'empty middle and suffix are still emitted, as in the exemplars');
  assert.deepEqual(enrichFields({ Name: 'MADONNA' }).NormalizedName, 'MADONNA');
  assert.deepEqual(enrichFields({}), {});
});

test('seed upgrade: refreshes seed records, keeps custom ones, only when the version changes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexe-seed-'));
  const old = { id: 'seed-person-doe-dmv', entityType: 'PERSON', name: 'OLD SEED', match: { Name: 'DOE, JANE' }, results: [] };
  const custom = { id: 'my-own-record', entityType: 'VEHICLE', name: 'Mine', match: { LicensePlateNumber: 'MINE001' }, results: [] };
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ records: [old, custom], settings: { resultDelayMs: 77 }, seedVersion: SEED_VERSION - 1 }));
  process.env.DATA_DIR = dir;
  const store = await import('../src/store.js?upgrade-test');
  const ids = store.records().map((r) => r.id);
  assert.ok(ids.includes('my-own-record'), 'custom record kept');
  assert.equal(store.records().find((r) => r.id === 'seed-person-doe-dmv').name, 'Jane Doe - license only', 'seed record refreshed');
  assert.equal(store.settings().resultDelayMs, 77, 'settings untouched');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'store.json'), 'utf8')).seedVersion, SEED_VERSION, 'new version persisted');
});
