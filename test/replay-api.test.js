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
  assert.deepEqual([summary.id, summary.replies, summary.photos, summary.edited, summary.certified], ['replay-xx-1', 1, 1, false, true]);
  assert.deepEqual(summary.sources, ['OSW']);

  const rec = (await call('GET', '/api/replay-records/replay-xx-1')).json;
  rec.replies[0].response = '<Response><MessageData>EDITED TEXT</MessageData></Response>';
  const put = await call('PUT', '/api/replay-records/replay-xx-1', { ...rec, region: 'ZZ_OTHER', id: 'other' });
  assert.equal(put.status, 200);
  assert.equal(put.json.id, 'replay-xx-1');
  assert.equal(put.json.region, 'XX_TEST');
  assert.equal(put.json.edited, true);
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
