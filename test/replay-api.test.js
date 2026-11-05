// Replay records over the admin API: upload, open one, edit (id and region fixed, marked edited), reject bad edits, delete.
// Synthetic data only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dexe-replay-api-'));
const { createApp } = await import('../src/server.js');
const server = createApp().listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const call = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
const pack = {
  region: 'XX_TEST',
  records: [{ id: 'replay-xx-1', type: 'replay', region: 'XX_TEST', certified: true, entityType: 'PERSON',
    match: { kind: 'OLN', OperatorLicenseNumber: 'T1234567', State: null },
    replies: [{ offsetMs: 1000, dataSource: 'OSW', fullEnvelope: false, response: '<Response><MessageData>TEST</MessageData></Response>', attachedImage: '/9j/AAAA' }] }],
};

test('a replay record can be listed, opened, edited and deleted; id and region never change', async () => {
  assert.equal((await call('POST', '/api/replays', pack)).status, 200);
  const [summary] = (await call('GET', '/api/replays')).json;
  assert.deepEqual([summary.id, summary.replies, summary.photos, summary.edited, summary.certified, summary.hit], ['replay-xx-1', 1, 1, false, true, false]);
  assert.deepEqual(summary.sources, ['OSW']);

  const rec = (await call('GET', '/api/replay-records/replay-xx-1')).json;
  rec.replies[0].response = '<Response><MessageData>EDITED TEXT</MessageData></Response>';
  const put = await call('PUT', '/api/replay-records/replay-xx-1', { ...rec, region: 'ZZ_OTHER', id: 'other' });
  assert.equal(put.status, 200);
  assert.equal(put.json.id, 'replay-xx-1');
  assert.equal(put.json.region, 'XX_TEST');
  assert.equal(put.json.edited, true);
  // the HIT flag follows the replies: an edit that adds <Detected>1</Detected> turns it on
  const hitRec = { ...rec, replies: [{ ...rec.replies[0], response: '<Response><Hit><Details>NCIC</Details><Detected>1</Detected></Hit><MessageData>TEST</MessageData></Response>' }] };
  assert.equal((await call('PUT', '/api/replay-records/replay-xx-1', hitRec)).status, 200);
  assert.equal((await call('GET', '/api/replays')).json[0].hit, true);
  assert.equal((await call('PUT', '/api/replay-records/replay-xx-1', rec)).status, 200);
  assert.equal(put.json.replies[0].attachedImage, '/9j/AAAA');
  assert.equal((await call('GET', '/api/replays')).json[0].edited, true);

  const bad = await call('PUT', '/api/replay-records/replay-xx-1', { ...rec, match: { kind: 'NOPE' }, replies: [] });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.problems.length >= 2);
  assert.equal((await call('GET', '/api/replay-records/replay-xx-1')).json.replies[0].response, '<Response><MessageData>EDITED TEXT</MessageData></Response>');

  assert.equal((await call('PUT', '/api/replay-records/nope', rec)).status, 404);
  assert.equal((await call('DELETE', '/api/replay-records/replay-xx-1')).status, 200);
  assert.equal((await call('GET', '/api/replays')).json.length, 0);
  assert.equal((await call('DELETE', '/api/replay-records/replay-xx-1')).status, 404);
});

test('import (mode=merge) adds to the region, replaces the same query, keeps the rest, maps the test ORI once', async () => {
  const rec = (id, oln, text = 'TEST') => ({ id, type: 'replay', region: 'YY_TEST', certified: true, entityType: 'PERSON',
    match: { kind: 'OLN', OperatorLicenseNumber: oln, State: null },
    replies: [{ offsetMs: 1000, dataSource: 'OSW', fullEnvelope: false, response: `<Response><MessageData>${text}</MessageData></Response>` }] });
  assert.equal((await call('POST', '/api/replays', { region: 'YY_TEST', records: [rec('a', 'T1000001'), rec('b', 'T1000002')] })).status, 200);

  const m = await call('POST', '/api/replays?mode=merge', { region: 'YY_TEST', testOri: 'YY1000001', records: [rec('c', 'T1000002', 'NEWER'), rec('d', 'T1000003')] });
  assert.equal(m.status, 200);
  assert.deepEqual([m.json.added, m.json.replaced, m.json.total, m.json.oriMapped], [1, 1, 3, 'YY1000001']);
  const held = (await call('GET', '/api/replays')).json.filter((r) => r.region === 'YY_TEST').map((r) => r.id).sort();
  assert.deepEqual(held, ['a', 'c', 'd']);
  assert.equal((await call('GET', '/api/replay-records/c')).json.replies[0].response, '<Response><MessageData>NEWER</MessageData></Response>');

  // an ORI already mapped elsewhere is left alone
  await call('PUT', '/api/settings', { regionByOri: { YY1000001: 'ZZ_OTHER' } });
  const again = await call('POST', '/api/replays?mode=merge', { region: 'YY_TEST', testOri: 'YY1000001', records: [rec('e', 'T1000004')] });
  assert.match(again.json.oriConflict, /mapped to ZZ_OTHER/);
  assert.equal((await call('GET', '/api/state')).json.settings.regionByOri.YY1000001, 'ZZ_OTHER');

  // packs with photos can pass the 2 MB /api limit
  const big = rec('f', 'T1000005'); big.replies[0].attachedImage = 'A'.repeat(3 * 1024 * 1024);
  assert.equal((await call('POST', '/api/replays?mode=merge', { region: 'YY_TEST', records: [big] })).status, 200);
  assert.equal((await call('POST', '/api/replays?mode=merge', { region: 'YY_TEST', records: [{ type: 'nope' }] })).status, 400);
});
