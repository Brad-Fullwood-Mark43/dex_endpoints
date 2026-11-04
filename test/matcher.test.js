import test from 'node:test';
import assert from 'node:assert/strict';
import { recordMatches } from '../src/matcher.js';

const record = { entityType: 'PERSON', match: { Name: 'DOE, JANE', OperatorLicenseNumber: 'D0000001' } };
const matches = (fields) => recordMatches(record, 'PERSON', fields);

test('name: "LAST, FIRST", "LAST FIRST" and "FIRST LAST" all match the record', () => {
  assert.ok(matches({ Name: 'DOE, JANE A' }));
  assert.ok(matches({ Name: 'DOE JANE' }));
  assert.ok(matches({ Name: 'JANE DOE' }));
});

test('name: a comma fixes the order, so "JANE, DOE" does not match; other names and last-name-only misses stay misses', () => {
  assert.ok(!matches({ Name: 'JANE, DOE' }));
  assert.ok(!matches({ Name: 'ROE JANE' }));
  assert.ok(!matches({ Name: 'JANE ROE' }));
});

test('name: an unrelated BirthDate or SexCode in the request does not stop a name match', () => {
  assert.ok(matches({ Name: 'JANE DOE', BirthDate: '01011950', SexCode: 'M' }));
});

test('license: a contradicting license number still rules the record out', () => {
  assert.ok(!matches({ Name: 'JANE DOE', OperatorLicenseNumber: 'X999' }));
});
