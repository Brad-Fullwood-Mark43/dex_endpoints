// Replay matching and frame building (src/replay.js). Synthetic fixtures only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRequest, regionForOri, matches, findReplay, replayFrames, validatePack, replayHasHit, isCatalogRequest, catalogText, catalogRecord, requestEntityType } from '../src/replay.js';

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
  assert.ok(matches(r, readRequest(req({ Name: 'sample, alex bryan', BirthDate: '19850630', SexCode: 'MALE' })), 'XX'));
  // a record with a sex needs the request to send it; a record without one matches with or without
  assert.ok(!matches(r, readRequest(req({ Name: 'SAMPLE, ALEX', BirthDate: '19850630' })), 'XX'));
  assert.ok(matches(rec({ ...r.match, SexCode: null }), readRequest(req({ Name: 'SAMPLE, ALEX', BirthDate: '19850630', SexCode: 'M' })), 'XX'));
  assert.ok(matches(rec({ ...r.match, SexCode: null }), readRequest(req({ Name: 'SAMPLE, ALEX', BirthDate: '19850630' })), 'XX'));
  assert.ok(matches(r, readRequest(req({ NameLast: 'Sample', NameFirst: 'Alex', BirthDate: '1985-06-30', SexCode: 'M' })), 'XX'));
  assert.ok(!matches(r, readRequest(req({ Name: 'SAMPLE, ALEX C', BirthDate: '19850630', SexCode: 'M' })), 'XX'));
  assert.ok(!matches(r, readRequest(req({ Name: 'SAMPLE, ALEX', BirthDate: '19850701', SexCode: 'M' })), 'XX'));
  // MMDDYYYY (TX_TLETS request order) is the same date as the record's YYYYMMDD, and the other way round
  assert.ok(matches(r, readRequest(req({ Name: 'SAMPLE, ALEX', BirthDate: '06301985', SexCode: 'M' })), 'XX'));
  assert.ok(matches(r, readRequest(req({ Name: 'SAMPLE, ALEX', BirthDate: '06-30-1985', SexCode: 'M' })), 'XX'));
  assert.ok(matches(rec({ ...r.match, BirthDate: '06301985' }), readRequest(req({ Name: 'SAMPLE, ALEX', BirthDate: '19850630', SexCode: 'M' })), 'XX'));
  assert.ok(!matches(r, readRequest(req({ Name: 'SAMPLE, ALEX', BirthDate: '07011985', SexCode: 'M' })), 'XX'));
  assert.ok(!matches(r, readRequest(req({ Name: 'SAMPLE, ALEX', BirthDate: '30061985', SexCode: 'M' })), 'XX'));
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

test('replayHasHit: any reply with <Detected>1</Detected>; 0 or no envelope is not a hit', () => {
  const r = (...responses) => rec({ kind: 'OLN', OperatorLicenseNumber: '1' }, responses.map((response) => ({ offsetMs: 0, response })));
  assert.equal(replayHasHit(r('<Response><Hit><Details>NCIC</Details><Detected>0</Detected></Hit></Response>', '<Response><Hit><Detected>1</Detected></Hit></Response>')), true);
  assert.equal(replayHasHit(r('<Response><Hit><Details/><Detected> 1 </Detected></Hit></Response>')), true);
  assert.equal(replayHasHit(r('<Response><Hit><Detected>0</Detected></Hit></Response>')), false);
  assert.equal(replayHasHit(r('<Response><MessageData>WANTED DETECTED 1</MessageData></Response>')), false);
  assert.equal(replayHasHit(r('<Response><Hit><Detected>10</Detected></Hit></Response>')), false);
});

test('validatePack rejects malformed packs', () => {
  assert.deepEqual(validatePack({ records: [rec({ kind: 'OLN', OperatorLicenseNumber: '1' })] }), []);
  assert.ok(validatePack({}).length);
  assert.ok(validatePack({ records: [{ type: 'replay', region: 'x', match: { kind: 'NOPE' }, replies: [] }] }).length >= 3);
});

test('query catalog: X1X1 (any state, any spacing) asks for it; the list covers the region only, one line per query', () => {
  assert.ok(isCatalogRequest(readRequest(req({ LicensePlateNumber: 'x1x1', State: 'ZZ' }))));
  assert.ok(isCatalogRequest(readRequest(req({ LicensePlateNumber: 'X1 X1' }))));
  assert.ok(!isCatalogRequest(readRequest(req({ LicensePlateNumber: 'X1X12' }))));
  assert.ok(!isCatalogRequest(readRequest(req({ OperatorLicenseNumber: 'X1X1' }))));

  const env = (cls, text, extra = '') => `<Response><Class>${cls}</Class><Hit><Details></Details><Detected>1</Detected></Hit><Image><ImageData>/9j/AAAA</ImageData></Image>${extra}<MessageData>${text}</MessageData><Request><Id>OLD</Id></Request><System>SYS</System></Response>`;
  const full = (cls, text, extra) => [{ offsetMs: 1000, fullEnvelope: true, response: env(cls, text, extra) }];
  const recs = [
    rec({ kind: 'OLN', OperatorLicenseNumber: 'T1234567', State: null }, full('NoRecord', 'NO RECORD')),
    rec({ kind: 'NAME_DOB', NameLast: 'SAMPLE', NameFirst: 'ALEX', NameMiddle: 'B', BirthDate: '19850630', SexCode: 'M', State: 'ZZ' }, full('Response', 'TEST')),
    rec({ kind: 'PLATE', LicensePlateNumber: 'TEST01', State: null }, full('VehicleRegistration', 'TEST', '<LicensePlateNumber>TEST01</LicensePlateNumber>')),
    rec({ kind: 'PLATE', LicensePlateNumber: 'TEST01', State: null }),
    rec({ kind: 'VIN', VehicleIdentificationNumber: 'OTHERREGION0001' }, undefined, 'YY_TEST'),
  ];
  const text = catalogText(recs, 'XX_TEST');
  assert.match(text, /RAILWAY TEST QUERIES - XX_TEST/);
  assert.match(text, /PERSON BY DRIVER LICENSE \(1\)\n  OLN T1234567  State XX or blank/);
  assert.match(text, /SAMPLE, ALEX B  DOB 06\/30\/1985  Sex M  State ZZ  \(1 reply  HIT\)/);
  assert.match(text, /VEHICLE BY PLATE \(1\)\n  Plate TEST01/);
  assert.doesNotMatch(text, /OTHERREGION|VEHICLE BY VIN/);
  assert.match(catalogText([], 'XX_TEST'), /No replay records are loaded/);

  const c = catalogRecord(recs, 'XX_TEST');
  assert.equal(c.entityType, 'VEHICLE');
  const resp = c.replies[0].response;
  assert.match(resp, /<Class>Response<\/Class>/); // the neutral captured envelope, not NoRecord or a data class
  assert.match(resp, /<Detected>0<\/Detected>/);
  assert.match(resp, /<Image\/>/);
  assert.doesNotMatch(resp, /ImageData/);
  const [frame] = replayFrames(c, 'NEWID_VEHICLE');
  assert.match(frame.xml, /<Request><Id>NEWID_VEHICLE<\/Id><\/Request>/);
  assert.match(catalogRecord([], 'XX_TEST').replies[0].response, /No replay records are loaded/);
});

test('a NAME_DOB record without SexCode is accepted and listed as any sex; the catalog reply is labelled Mark43 TEST DATA Response', () => {
  const bad = rec({ kind: 'NAME_DOB', NameLast: 'SAMPLE', NameFirst: 'ALEX', BirthDate: '19850630', SexCode: null, State: null });
  assert.deepEqual(validatePack({ records: [bad] }), []);
  assert.match(catalogText([bad], 'XX_TEST'), /Sex any or blank/);
  const env = [{ offsetMs: 1, fullEnvelope: true, response: '<Response><Class>Response</Class><MessageData>T</MessageData><Request><Id>A</Id></Request><System>Nlets</System></Response>' }];
  assert.match(catalogRecord([rec({ kind: 'OLN', OperatorLicenseNumber: 'T1', State: null }, env)], 'XX_TEST').replies[0].response, /<System>Mark43 TEST DATA Response<\/System>/);
  assert.match(catalogRecord([], 'XX_TEST').replies[0].response, /<System>Mark43 TEST DATA Response<\/System>/);
});

test('no match: the catalog goes out headed "no test record matches", logged with the request entity', () => {
  const recs = [rec({ kind: 'OLN', OperatorLicenseNumber: 'T1234567', State: null })];
  assert.match(catalogText(recs, 'XX_TEST', { noMatch: true }), /^NO TEST RECORD MATCHES THIS QUERY\.\n[\s\S]*RAILWAY TEST QUERIES - XX_TEST[\s\S]*OLN T1234567/);
  assert.doesNotMatch(catalogText(recs, 'XX_TEST'), /NO TEST RECORD/);
  assert.equal(requestEntityType(readRequest(req({ Name: 'SAMPLE, ALEX' }))), 'PERSON');
  assert.equal(requestEntityType(readRequest(req({ OperatorLicenseNumber: 'T1' }))), 'PERSON');
  assert.equal(requestEntityType(readRequest(req({ LicensePlateNumber: 'TEST01' }))), 'VEHICLE');
  const c = catalogRecord(recs, 'XX_TEST', { noMatch: true, entityType: 'PERSON' });
  assert.deepEqual([c.id, c.entityType, c.noMatch, c.match.kind], ['catalog-xx_test-no-match', 'PERSON', true, 'CATALOG (no match)']);
  assert.match(c.replies[0].response, /NO TEST RECORD MATCHES THIS QUERY/);
});
