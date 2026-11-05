import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { processRequest, recordCallback, listTransactions, getTransaction, redeliver, restoreTransactions, bus } from './engine.js';
import { dbEnabled, initDb, loadCalls, saveCall } from './db.js';
import { records, settings, upsertRecord, deleteRecord, resetRecords, importRecords, updateSettings, initStore } from './store.js';
import { buildRequestXml } from './requests.js';
import { ENTITY_TYPES, MATCH_KEYS, allowlist } from './matcher.js';
import { recordsFromCsv } from './csv-import.js';
import { buildAckXml, soapEnvelope } from './xml.js';
import { listRegions, isRegion } from './regions.js';
import { replays, setRegionReplays, mergeRegionReplays, clearRegionReplays, updateReplay, deleteReplay } from './store.js';
import { validatePack } from './replay.js';
import { createTcpServer } from './tcp-server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.API_KEY || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const RECEIVER_TOKEN = process.env.RECEIVER_TOKEN || '';

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // ---- Tenant-facing Commsys endpoint -------------------------------------------------------
  // The interface agent sends `x-api-key` on every outbound request, so that is the primary
  // credential; a raw or Bearer Authorization header is accepted as well.
  const commsysAuth = (req, res, next) => {
    if (!API_KEY) return next();
    const header = req.get('x-api-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (header && safeEqual(header, API_KEY)) return next();
    const body = buildAckXml({ deviceId: 'UNKNOWN', transactionId: 'UNKNOWN', status: 'Failed', reason: 'Unauthorized', errors: [{ code: 401, category: 'HTTP', message: 'Unauthorized' }] });
    res.status(401).type('application/xml').send(body);
  };

  const xmlBody = express.text({ type: () => true, limit: '2mb' });
  const handleCommsys = async (req, res) => {
    const ack = await processRequest({ rawBody: typeof req.body === 'string' ? req.body : '', headers: req.headers, path: req.path });
    if (!ack.httpStatus) return res.destroy();
    res.status(ack.httpStatus).type(ack.contentType).send(ack.body);
  };
  for (const route of ['/connectcic', '/commsys', '/connectcic/soap']) app.post(route, commsysAuth, xmlBody, handleCommsys);

  // ---- Gateway endpoints (called by the Prismatic flow, not by the tenant) -------------------
  // These always require API_KEY to be configured; unlike /connectcic they never fall back to open.
  const gatewayAuth = (req, res, next) => {
    if (!API_KEY) return res.status(503).json({ error: 'API_KEY is not configured on this service' });
    const header = req.get('x-api-key') || '';
    if (header && safeEqual(header, API_KEY)) return next();
    res.status(401).json({ error: 'Unauthorized' });
  };

  // Every identifier the records can match, normalised, so the gateway can refuse anything else.
  app.get('/allowlist', gatewayAuth, (_req, res) => res.json(allowlist(records())));

  // Same pipeline as /connectcic, but nothing is delivered from here. The response carries the
  // acknowledgement and the results so the gateway can return the ack and deliver the results itself.
  app.post('/resolve', gatewayAuth, xmlBody, async (req, res) => {
    let txn = null;
    const ack = await processRequest({
      rawBody: typeof req.body === 'string' ? req.body : '',
      headers: req.headers,
      path: req.path,
      origin: 'gateway',
      deliver: false,
      onTxn: (t) => { txn = t; },
    });
    const deliverable = ack.httpStatus === 200 ? txn.results : [];
    res.json({
      protocol: txn.protocol,
      ack: { httpStatus: ack.httpStatus, contentType: ack.contentType, body: ack.body },
      results: deliverable.map((r) => ({ requestId: r.requestId, class: r.class, hit: r.hit, xml: r.xml })),
      delays: { resultDelayMs: settings().resultDelayMs, betweenResultsMs: settings().betweenResultsMs },
    });
  });

  // ---- Stand-in for the interface agent's result endpoint -----------------------------------
  // The delivery step cannot send headers, so the secret is in the path. Disabled (404) unless
  // RECEIVER_TOKEN is set; a wrong token also gets 404 so the route is not discoverable.
  // The token is never logged or stored with the call.
  app.post('/receiver/:token/interface-agent/v2/query-result', xmlBody, (req, res) => {
    if (!RECEIVER_TOKEN || !safeEqual(req.params.token, RECEIVER_TOKEN)) return res.status(404).end();
    const ack = recordCallback({ rawBody: typeof req.body === 'string' ? req.body : '', headers: req.headers });
    res.status(ack.httpStatus).type(ack.contentType).send(ack.body);
  });

  // ---- Admin UI + API -----------------------------------------------------------------------
  const adminAuth = (req, res, next) => {
    if (!ADMIN_PASSWORD) return next();
    const [scheme, encoded] = (req.get('authorization') || '').split(' ');
    if (scheme === 'Basic' && encoded) {
      const pass = Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':');
      if (safeEqual(pass, ADMIN_PASSWORD)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="dex_endpoints"').status(401).send('Authentication required');
  };

  // replay packs carry blurred photos and can pass 2 MB; their routes parse first, with a larger limit
  app.use(['/api/replays', '/api/replay-records'], adminAuth, express.json({ limit: '25mb' }));
  app.use('/api', adminAuth, express.json({ limit: '2mb' }));
  app.use(adminAuth, express.static(path.join(here, '..', 'public')));

  app.get('/api/state', (_req, res) =>
    res.json({
      settings: settings(),
      records: records(),
      transactions: listTransactions(),
      entityTypes: ENTITY_TYPES,
      matchKeys: MATCH_KEYS,
      regions: listRegions(),
      config: { apiKeySet: !!API_KEY, adminPasswordSet: !!ADMIN_PASSWORD, receiverEnabled: !!RECEIVER_TOKEN, allowRequestResponseUrl: process.env.ALLOW_REQUEST_RESPONSE_URL === 'true' },
    }),
  );

  app.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const onTxn = (t) => send('txn', t);
    bus.on('txn', onTxn);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      bus.off('txn', onTxn);
    });
  });

  app.post('/api/transactions/:id/redeliver', async (req, res) => {
    if (!getTransaction(req.params.id)) return res.status(404).json({ error: 'Not found' });
    redeliver(req.params.id).catch(() => {});
    res.json({ ok: true });
  });

  app.put('/api/settings', (req, res) => {
    const patch = req.body ?? {};
    if (patch.regionByOri !== undefined) {
      const m = patch.regionByOri;
      const bad = !m || typeof m !== 'object' || Array.isArray(m) ? ['regionByOri must be an object'] :
        Object.entries(m).filter(([k, v]) => !/^[A-Z]{2}([A-Z0-9]{7})?$/.test(k) || typeof v !== 'string' || !/^[A-Z]{2}_[A-Za-z0-9_]+$/.test(v)).map(([k]) => `bad entry ${k}`);
      if (bad.length) return res.status(400).json({ error: `regionByOri: keys are a 9-character ORI or a 2-letter state, values a USx region name (${bad.join('; ')})` });
    }
    if (patch.region !== undefined && !isRegion(patch.region)) return res.status(400).json({ error: `region must be one of ${listRegions().map((r) => r.id).join(', ')}` });
    res.json(updateSettings(patch));
  });

  // Replay packs (docs/REPLAY.md): captured, scrubbed reply sets for one USx region. Upload replaces that region only.
  app.get('/api/replays', (_req, res) => res.json(replays().map((r) => ({ id: r.id, region: r.region, entityType: r.entityType, match: r.match, replies: r.replies.length, fullEnvelope: r.replies.filter((x) => x.fullEnvelope).length, sources: r.replies.map((x) => x.dataSource || ''), photos: r.replies.filter((x) => x.attachedImage || /<ImageData>/.test(x.response || '')).length, certified: r.certified !== false, edited: !!r.edited }))));
  // One replay record, for the Records tab editor. Saving re-validates it like an uploaded pack; id and region are fixed.
  app.get('/api/replay-records/:id', (req, res) => { const r = replays().find((x) => x.id === req.params.id); return r ? res.json(r) : res.status(404).json({ error: 'Not found' }); });
  app.put('/api/replay-records/:id', (req, res) => {
    const current = replays().find((x) => x.id === req.params.id);
    if (!current) return res.status(404).json({ error: 'Not found' });
    const rec = { ...(req.body ?? {}), id: current.id, region: current.region, type: 'replay' };
    const problems = validatePack({ records: [rec] });
    if (problems.length) return res.status(400).json({ error: 'invalid replay record', problems });
    res.json(updateReplay(current.id, rec));
  });
  app.delete('/api/replay-records/:id', (req, res) => (deleteReplay(req.params.id) ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found' })));
  // ?mode=merge (the Records tab's Import replay pack): add to the region, replacing the same query; otherwise the
  // region's records are replaced. A pack's testOri is mapped to its region when that ORI isn't mapped yet.
  app.post('/api/replays', (req, res) => {
    const pack = req.body ?? {};
    const problems = validatePack(pack);
    const regions = [...new Set((pack.records || []).map((r) => r.region))];
    if (regions.length !== 1) problems.push('a pack must hold exactly one region');
    if (problems.length) return res.status(400).json({ error: 'invalid replay pack', problems: problems.slice(0, 20) });
    const region = regions[0];
    const out = req.query.mode === 'merge' ? { region, ...mergeRegionReplays(region, pack.records) } : { region, stored: setRegionReplays(region, pack.records) };
    const ori = String(pack.testOri || '').toUpperCase();
    if (/^[A-Z]{2}[A-Z0-9]{7}$/.test(ori)) {
      const map = settings().regionByOri || {};
      if (!map[ori]) { updateSettings({ regionByOri: { ...map, [ori]: region } }); out.oriMapped = ori; }
      else if (map[ori] !== region) out.oriConflict = `${ori} is mapped to ${map[ori]}, not ${region}: left as is`;
    }
    res.json(out);
  });
  app.delete('/api/replays/:region', (req, res) => res.json({ region: req.params.region, removed: clearRegionReplays(req.params.region) }));
  app.post('/api/records', (req, res) => res.json(upsertRecord(req.body ?? {})));
  app.put('/api/records/:id', (req, res) => res.json(upsertRecord({ ...req.body, id: req.params.id })));
  app.delete('/api/records/:id', (req, res) => (deleteRecord(req.params.id) ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found' })));
  // Spreadsheet import. Body: { csv: "<file text>", replace?: boolean }. See samples in public/records-template.csv.
  app.post('/api/import-csv', (req, res) => {
    const { records: parsed, errors } = recordsFromCsv(req.body?.csv);
    if (!parsed.length) return res.status(400).json({ imported: 0, errors });
    const total = importRecords(parsed, { replace: req.body?.replace === true });
    res.json({ imported: parsed.length, total, errors });
  });
  app.post('/api/records-reset', (_req, res) => {
    resetRecords();
    res.json({ ok: true, records: records() });
  });

  // Send a test query through exactly the same pipeline a tenant request takes.
  app.post('/api/simulate', async (req, res) => {
    const { entityType, fields, protocol = 'REST', auth, region } = req.body ?? {};
    if (region !== undefined && region !== '' && !isRegion(region)) return res.status(400).json({ error: 'unknown region' });
    if (!ENTITY_TYPES.includes(entityType)) return res.status(400).json({ error: 'entityType must be one of ' + ENTITY_TYPES.join(', ') });
    let rawBody = buildRequestXml({ entityType, fields, auth });
    if (protocol === 'SOAP') {
      rawBody = soapEnvelope(rawBody, 'SendMessage');
    }
    const ackPromise = processRequest({ rawBody, headers: { 'content-type': protocol === 'SOAP' ? 'text/xml' : 'application/xml' }, path: '/api/simulate', origin: 'ui-test', region: region || null });
    // Respond once the transaction exists; the log updates over SSE.
    const existing = listTransactions()[0];
    res.json({ id: existing?.id });
    ackPromise.catch((err) => console.error('simulate failed', err));
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  await initDb();
  await initStore();
  if (dbEnabled) {
    restoreTransactions(await loadCalls());
    bus.on('txn', saveCall);
  }
  const tcpPort = Number(process.env.TCP_PORT) || 0;
  if (tcpPort) {
    // Counts only; request and result contents are never logged.
    createTcpServer({
      heartbeatMs: process.env.TCP_HEARTBEAT_MS === undefined ? 30000 : Number(process.env.TCP_HEARTBEAT_MS),
      allowIps: (process.env.TCP_ALLOWED_IPS || '').split(',').map((s) => s.trim()).filter(Boolean),
      maxConnections: Number(process.env.TCP_MAX_CONNECTIONS) || 10,
      resultFormat: process.env.TCP_RESULT_FORMAT === 'envelope' ? 'envelope' : 'bare',
      log: (m) => console.log(m),
    }).listen(tcpPort, '0.0.0.0', () => console.log(`  TCP listener     : :${tcpPort}  (ConnectCIC frames, no encryption, no auth${process.env.TCP_ALLOWED_IPS ? ', IP allowlist on (not effective behind the Railway TCP proxy)' : ''})`));
  }
  createApp().listen(port, '0.0.0.0', () => {
    console.log(`dex_endpoints listening on :${port}  (storage: ${dbEnabled ? 'postgres' : 'file'})`);
    console.log(`  Commsys endpoint : POST /connectcic   (${API_KEY ? 'x-api-key required' : 'OPEN: set API_KEY'})`);
    console.log(`  Web UI           : /                  (${ADMIN_PASSWORD ? 'password protected' : 'OPEN: set ADMIN_PASSWORD'})`);
  });
}
