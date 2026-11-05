// Replay matching and frame building (src/replay.js). Synthetic fixtures only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRequest, regionForOri, matches, findReplay, replayFrames, validatePack } from '../src/replay.js';

const req = (fields, { id = '01ABCDEFGHJKMNPQRSTVWXYZ00', ori = 'XX1000001', type = 'DriverLicenseQuery' } = {}) =>
  `<LawEnforcementTransaction version="1.0"><Session><Id>DEV01</Id><Authentication><UserName>TESTUSER</UserName><ORI>${ori}</ORI></Authentication></Session>` +
  `<Transaction><Request><MessageType>${type}</MessageType><Id>${id}</Id>${Object.entries(fields).map(([k, v]) => `<${k}>${v}</${k}>`).join('')}</Request></Transaction></LawEnforcementTransaction>`;

const rec = (match, replies = [{ offsetMs: 1000, fullEnvelope: false, response: '<Response><MessageData>TEST</MessageData></Response>' }], region = 'XX_TEST') =>
  ({ id: `replay-${match.kind}`, type: 'replay', region, certified: true, match, replies });

test('readRequest pulls id, ORI and the match fields from a bare request and from a ConnectCicApi envelope', () => {
  const r = readRequest(req({ OperatorLicenseNumber: '012345678', State: 'FL' }, { ori: 'XX1000001' }));
  assert.equal(r.id, '01ABCDEFGHJKMNPQRSTVWXYZ00');
  assert.equal(r.ori, 'XX1000001');
  assert.equal(r.fields.OperatorLicenseNumber, '012345678');
  assert.equal(r.fields.State, 'FL');
  const env = `<api:ConnectCicApi xmlns:api="x"><api:Transactions><api:Transaction id="T1">${req({ LicensePlateNumber: 'TST123' })}</api:Transaction></api:Transactions></api:ConnectCicApi>`;
  assert.equal(readRequest(env).fields.LicensePlateNumber, 'TST123');
  assert.equal(readRequest('<x/>'), null);
});

test('regionForOri: exact ORI first, then the two-letter prefix, else null', () => {
  const map = { XX1000001: 'XX_TEST', XX: 'XX_OTHER', ZZ2000001: 'ZZ_TWO' };
  assert.equal(regionForOri('XX1000001', map), 'XX_TEST');
  assert.equal(regionForOri('xx9999999', map), 'XX_OTHER');
  assert.equal(regionForOri('ZZ2000001', map), 'ZZ_TWO');
  assert.equal(regionForOri('ZZ1000001', map), null);
  assert.equal(regionForOri('', map), null);
});

test('OLN: case and leading zeros ignored; in-state means no State or the home state', () => {
  const r = rec({ kind: 'OLN', OperatorLicenseNumber: '012345678', State: null });
  assert.ok(matches(r, readRequest(req({ OperatorLicenseNumber: '12345678' })), 'XX'));
  assert.ok(matches(r, readRequest(req({ OperatorLicenseNumber: '012345678', State: 'XX' })), 'XX'));
  assert.ok(!matches(r, readRequest(req({ OperatorLicenseNumber: '012345678', State: 'FL' })), 'XX'));
  assert.ok(!matches(r, readRequest(req({ OperatorLicenseNumber: '112345678' })), 'XX'));
  const oos = rec({ kind: 'OLN', OperatorLicenseNumber: 'A1234567', State: 'CA' });
  assert.ok(matches(oos, readRequest(req({ OperatorLicenseNumber: 'a1234567', State: 'CA' })), 'XX'));
  assert.ok(!matches(oos, readRequest(req({ OperatorLicenseNumber: 'A1234567' })), 'XX'));
});

test('NAME_DOB: "LAST, FIRST M" or split name parts; middle by initial; DOB and sex must agree', () => {
  const r = rec({ kind: 'NAME_DOB', NameLast: 'SAMPLE', NameFirst: 'ALEX', NameMiddle: 'B', BirthDate: '19850630', SexCode: 'M', State: null });
  assert.ok(matches(r, readRequest(req({ Name: 'SAMPLE, ALEX', BirthDate: '19850630', SexCode: 'M' })), 'XX'));
  assert.ok(matches(r, readRequest(req({ Name: 'sample, alex bryan', BirthDate: '19850630' })), 'XX'));
  assert.ok(matches(r, readRequest(req({ NameLast: 'Sample', NameFirst: 'Alex', BirthDate: '1985-06-30' })), 'XX'));
  assert.ok(!matches(r, readRequest(req({ Name: 'SAMPLE, ALEX C', BirthDate: '19850630' })), 'XX'));
  assert.ok(!matches(r, readRequest(req({ Name: 'SAMPLE, ALEX', BirthDate: '19850701' })), 'XX'));
  assert.ok(!matches(r, readRequest(req({ Name: 'SAMPLE, ALEX', BirthDate: '19850630', SexCode: 'F' })), 'XX'));
});

test('PLATE and VIN', () => {
  const p = rec({ kind: 'PLATE', LicensePlateNumber: 'TST123', State: 'XX' });
  assert.ok(matches(p, readRequest(req({ LicensePlateNumber: 'tst123', State: 'XX' }, { type: 'VehicleRegistrationQuery' })), 'XX'));
  assert.ok(matches(p, readRequest(req({ LicensePlateNumber: 'TST123' }, { type: 'VehicleRegistrationQuery' })), 'XX'));
  assert.ok(!matches(p, readRequest(req({ LicensePlateNumber: 'TST123', State: 'NY' }, { type: 'VehicleRegistrationQuery' })), 'XX'));
  const v = rec({ kind: 'VIN', VehicleIdentificationNumber: '1TEST00000A000001', State: 'XX' });
  assert.ok(matches(v, readRequest(req({ VehicleIdentificationNumber: '1test00000a000001' }, { type: 'VehicleRegistrationQuery' })), 'XX'));
});

test('findReplay: only the request region, certified records, the most complete set wins', () => {
  const short = rec({ kind: 'OLN', OperatorLicenseNumber: '1234567', State: null }, [{ offsetMs: 1000, response: '<Response><MessageData>A</MessageData></Response>' }]);
  const long = { ...rec({ kind: 'OLN', OperatorLicenseNumber: '01234567', State: null }), id: 'long', replies: [1, 2, 3].map((n) => ({ offsetMs: n * 1000, response: `<Response><MessageData>${n}</MessageData></Response>` })) };
  const other = { ...long, id: 'other-region', region: 'ZZ_OTHER' };
  const off = { ...long, id: 'uncertified', certified: false, replies: [...long.replies, ...long.replies] };
  const r = readRequest(req({ OperatorLicenseNumber: '1234567' }));
  assert.equal(findReplay([short, long, other, off], 'XX_TEST', r).id, 'long');
  assert.equal(findReplay([short, long], 'ZZ_OTHER', r), null);
  assert.equal(findReplay([short, long], null, r), null);
});

test('replayFrames: request id swapped or inserted, spacing kept, photo put back, bare LawEnforcementTransaction', () => {
  const r = rec({ kind: 'OLN', OperatorLicenseNumber: '1', State: null }, [
    { offsetMs: 1000, fullEnvelope: true, response: '<Response><Class>Accept</Class><Request><Id>OLDID</Id></Request><System>OSW</System></Response>' },
    { offsetMs: 2500, fullEnvelope: false, response: '<Response><MessageData>DP.XX1000001</MessageData></Response>', attachedImage: '/9j/AAAA' },
  ]);
  const f = replayFrames(r, 'NEWID');
  assert.equal(f.length, 2);
  assert.deepEqual(f.map((x) => x.delayMs), [1000, 1500]);
  assert.match(f[0].xml, /^<\?xml version="1.0"\?>\n<LawEnforcementTransaction version="1.0"><Transaction><Response>/);
  assert.match(f[0].xml, /<Request><Id>NEWID<\/Id><\/Request>/);
  assert.doesNotMatch(f[0].xml, /OLDID/);
  assert.match(f[1].xml, /^[\s\S]*<Response><Request><Id>NEWID<\/Id><\/Request><MessageData>/);
  assert.match(f[1].xml, /<Image><ImageData>\/9j\/AAAA<\/ImageData><\/Image><\/Response>/);
});

test('replayFrames: a full CommSys envelope (ConnectCICRequestId before Id) keeps one Request, with the new id', () => {
  const r = rec({ kind: 'OLN', OperatorLicenseNumber: '1', State: null }, [
    { offsetMs: 1000, fullEnvelope: true, response: '<Response><Class>Accept</Class><MessageData>X</MessageData><Request><ConnectCICRequestId>1234</ConnectCICRequestId><Id>OLDID</Id></Request><System>OSW</System></Response>' },
  ]);
  const [f] = replayFrames(r, 'NEWID');
  assert.equal((f.xml.match(/<Request>/g) || []).length, 1);
  assert.match(f.xml, /<Request><ConnectCICRequestId>1234<\/ConnectCICRequestId><Id>NEWID<\/Id><\/Request>/);
  assert.doesNotMatch(f.xml, /OLDID/);
  const two = replayFrames(rec({ kind: 'OLN', OperatorLicenseNumber: '1', State: null }, [{ offsetMs: 0, fullEnvelope: true,
    response: '<Response><Image/><Request><Id>OLDA</Id></Request></Response><Response><Class>DMV</Class><Request><ConnectCICRequestId>9</ConnectCICRequestId><Id>OLDB</Id></Request></Response>' }]), 'NEWID')[0];
  assert.equal((two.xml.match(/<Request>/g) || []).length, 2);
  assert.equal((two.xml.match(/<Id>NEWID<\/Id>/g) || []).length, 2);
  assert.doesNotMatch(two.xml, /OLDA|OLDB/);
});

test('validatePack rejects malformed packs', () => {
  assert.deepEqual(validatePack({ records: [rec({ kind: 'OLN', OperatorLicenseNumber: '1' })] }), []);
  assert.ok(validatePack({}).length);
  assert.ok(validatePack({ records: [{ type: 'replay', region: 'x', match: { kind: 'NOPE' }, replies: [] }] }).length >= 3);
});
