// Every reply to a user's query is labelled "*** USx SIMULATION ***" on top of its MessageData. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIM_LABEL, labelText, labelResponseXml } from '../src/label.js';
import { replayFrames, catalogRecord } from '../src/replay.js';
import { buildResultXml } from '../src/xml.js';

test('labelText puts the label on the first line, once', () => {
  assert.equal(labelText('LINE ONE\nLINE TWO'), `${SIM_LABEL}\nLINE ONE\nLINE TWO`);
  assert.equal(labelText(labelText('X')), `${SIM_LABEL}\nX`);
  assert.equal(labelText(''), SIM_LABEL);
});

test('labelResponseXml labels every Response, adding MessageData where there is none', () => {
  const xml = '<Response><Class>Image</Class><Image><ImageData>/9j/AAAA</ImageData></Image></Response><Response><Class>Accept</Class><MessageData>TEST &amp; MORE</MessageData></Response><Response><MessageData/></Response>';
  const out = labelResponseXml(xml);
  assert.equal(out.split(SIM_LABEL).length - 1, 3);
  assert.match(out, /<MessageData>\*\*\* USx SIMULATION \*\*\*\nTEST &amp; MORE<\/MessageData>/);
  assert.match(out, /<ImageData>\/9j\/AAAA<\/ImageData><\/Image><MessageData>\*\*\* USx SIMULATION \*\*\*<\/MessageData><\/Response>/);
});

test('replayed frames, the query catalog and generated results all carry the label', () => {
  const rec = { region: 'XX_TEST', replies: [{ offsetMs: 0, fullEnvelope: true, response: '<Response><Class>Accept</Class><MessageData>CAPTURED TEXT</MessageData><Request><Id>OLD</Id></Request></Response>' }] };
  const [f] = replayFrames(rec, 'NEW');
  assert.match(f.xml, /<MessageData>\*\*\* USx SIMULATION \*\*\*\nCAPTURED TEXT<\/MessageData>/);
  const [c] = replayFrames(catalogRecord([], 'XX_TEST'), 'NEW');
  assert.match(c.xml, /<MessageData>\*\*\* USx SIMULATION \*\*\*\nMARK43 TEST DATA QUERIES/);
  const g = buildResultXml({ deviceId: 'D', transactionId: 'T', requestId: 'R', result: { class: 'NoRecord', system: 'NCIC', messageData: 'NO RECORD' } });
  assert.match(g, /\*\*\* USx SIMULATION \*\*\*\s*NO RECORD/);
});
