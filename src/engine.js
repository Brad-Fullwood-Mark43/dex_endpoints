import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { isSoap, unwrapSoap, parseRequest, parseResultDoc, buildAckXml, buildResultXml, buildStatusXml, soapEnvelope, soapFault } from './xml.js';
import { entityTypeOf, findRecords, noRecordResult } from './matcher.js';
import { withDerivedFields } from './normalize.js';
import { applyRegion, isRegion, DEFAULT_REGION } from './regions.js';
import { records, settings } from './store.js';
import { maskCredentials } from './mask.js';

const MAX_TXNS = 300;
const MAX_BODY_LOG = 20000;

export const bus = new EventEmitter();
const txns = [];

export const listTransactions = () => txns;
export function restoreTransactions(list) {
  txns.splice(0, txns.length, ...list);
}
export const getTransaction = (id) => txns.find((t) => t.id === id);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s) => (typeof s === 'string' && s.length > MAX_BODY_LOG ? `${s.slice(0, MAX_BODY_LOG)}\n...[truncated]` : s);

function publish(txn) {
  bus.emit('txn', txn);
}

/** Mask credentials before they land in the on-screen log. */
function redactHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (['host', 'content-length', 'connection', 'accept-encoding'].includes(k)) continue;
    out[k] = /key|auth|token|cookie/i.test(k) ? '(redacted)' : v;
  }
  return out;
}

/**
 * The whole mock-Commsys request lifecycle. Returns the HTTP response to send back immediately
 * (after any configured ack delay); result callbacks are delivered in the background.
 */
export async function processRequest({ rawBody, headers = {}, path = '/connectcic', origin = 'tenant', deliver = true, onTxn = null, region = null, loggedBody = null, protocol = null, maskAuth = false }) {
  const cfg = settings();
  const soap = isSoap(rawBody);
  const regionId = region && isRegion(region) ? region : isRegion(cfg.region) ? cfg.region : DEFAULT_REGION;
  const txn = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    origin,
    region: regionId,
    protocol: protocol ?? (soap ? 'SOAP' : 'REST'),
    path,
    headers: redactHeaders(headers),
    // What the caller sent (loggedBody when rawBody was converted at the edge), with credentials masked.
    sent: clip(maskCredentials(loggedBody ?? rawBody)),
    requestXml: null,
    queries: [],
    ack: null,
    results: [],
    deliveries: [],
    state: 'received',
  };
  txns.unshift(txn);
  if (txns.length > MAX_TXNS) txns.pop();
  if (onTxn) onTxn(txn);
  publish(txn);

  let parsed;
  let responseUrl = null;
  try {
    let xml = rawBody;
    if (soap) {
      const un = unwrapSoap(rawBody);
      xml = un.xml;
      responseUrl = un.responseUrl;
    }
    txn.requestXml = maskCredentials(loggedBody ?? xml);
    parsed = parseRequest(xml);
    // Direct (TCP) callers: do not echo or keep the caller's identity in results or in the call log.
    if (maskAuth) for (const t of parsed.transactions) t.auth = { ...t.auth, mnemonic: null, ori: null, userName: null };
  } catch (err) {
    return finishAck(txn, soap, {
      httpStatus: 400,
      status: 'Failed',
      reason: 'Invalid request',
      errors: [{ code: 400, category: 'HTTP', message: err.message }],
      state: 'rejected',
    });
  }

  txn.queries = parsed.transactions.map((t) => ({
    transactionId: t.transactionId,
    requestId: t.requestId,
    entityType: entityTypeOf(t.requestId, t.messageType),
    messageType: t.messageType,
    auth: t.auth,
    fields: t.fields,
  }));

  // Build every result up front so the UI can show the formatted response even if delivery fails.
  for (const q of txn.queries) {
    const t = parsed.transactions.find((x) => x.requestId === q.requestId);
    const found = q.entityType ? findRecords(records(), q.entityType, q.fields) : [];
    let list = found.flatMap((rec) => rec.results.map((res) => ({ rec, res })));
    if (!list.length && cfg.noRecordOnMiss && q.entityType) list = [{ rec: null, res: noRecordResult(q.entityType) }];
    list.forEach(({ rec, res: stored }, i) => {
      const res = applyRegion(withDerivedFields(stored), regionId);
      const deviceId = t.auth.deviceId || 'UNKNOWN_DEVICE';
      const xml = buildResultXml({ deviceId, transactionId: q.transactionId, requestId: q.requestId, auth: t.auth, result: res, segment: i + 1, total: list.length });
      txn.results.push({
        requestId: q.requestId,
        recordId: rec?.id ?? null,
        recordName: rec?.name ?? '(no matching record)',
        class: res.class,
        hit: !!res.hit,
        system: res.system,
        messageType: res.messageType,
        messageData: res.messageData,
        fields: res.fields,
        xml,
      });
    });
    if (cfg.resultMode === 'status') {
      txn.results.push({
        requestId: q.requestId, recordId: null, recordName: '(status message)', class: 'Status', hit: false, system: '', messageType: 'Status',
        messageData: 'Interface status message', fields: { Status: 'Down' },
        xml: buildStatusXml({ deviceId: t.auth.deviceId || 'UNKNOWN_DEVICE', transactionId: q.transactionId, requestId: q.requestId, status: 'Down' }),
        isStatus: true,
      });
    }
  }
  if (cfg.resultMode === 'status') txn.results = txn.results.filter((r) => r.isStatus);

  const first = parsed.transactions[0];
  const deviceId = first.auth.deviceId || 'UNKNOWN_DEVICE';

  if (cfg.ackMode === 'http503') {
    return finishAck(txn, soap, {
      httpStatus: 503, status: 'Failed', reason: 'SERVICE UNAVAILABLE', deviceId, transactionId: first.transactionId,
      errors: [{ code: 503, category: 'HTTP', message: 'SERVICE UNAVAILABLE' }], state: 'ack-failed',
    });
  }
  if (cfg.ackMode === 'soapFault') {
    const detail = buildAckXml({ deviceId, transactionId: first.transactionId, status: 'Failed', reason: 'Processing Failure', errors: [{ code: 500, category: 'SOAP', message: 'Simulated SOAP fault' }] });
    const body = soapFault(detail);
    txn.ack = { httpStatus: 500, contentType: 'text/xml', body };
    txn.state = 'ack-failed';
    publish(txn);
    return txn.ack;
  }
  if (cfg.ackMode === 'timeout') {
    txn.state = 'ack-timeout';
    txn.ack = { httpStatus: 0, contentType: 'text/xml', body: '(no response sent: simulating a timeout, connection held for 60s)' };
    publish(txn);
    // A gateway (deliver: false) is told to simulate the timeout itself rather than hold this request open.
    if (!deliver) return txn.ack;
    await sleep(60000);
    return { httpStatus: 504, contentType: 'text/xml', body: '' };
  }

  if (cfg.ackDelayMs && deliver) await sleep(cfg.ackDelayMs);
  const ack = finishAck(txn, soap, { httpStatus: 200, status: 'Succeeded', reason: 'Processed', deviceId, transactionId: first.transactionId, state: 'acked' });
  if (cfg.resultMode === 'none') {
    txn.state = 'no-callback';
    publish(txn);
  } else if (!deliver) {
    // The caller (the gateway) takes the results from the response and delivers them itself.
    txn.state = 'resolved';
    publish(txn);
  } else {
    deliverResults(txn, responseUrl).catch((err) => console.error('delivery failed', err.message));
  }
  return ack;
}

function finishAck(txn, soap, { httpStatus, status, reason, errors = [], deviceId = 'UNKNOWN_DEVICE', transactionId = 'UNKNOWN', state }) {
  const inner = buildAckXml({ deviceId, transactionId, status, reason, errors });
  const body = soap ? (httpStatus === 200 ? soapEnvelope(inner, 'SendMessageResult') : soapFault(inner)) : inner;
  txn.ack = { httpStatus, contentType: soap ? 'text/xml' : 'application/xml', body };
  txn.state = state;
  publish(txn);
  return txn.ack;
}

function resolveCallbackUrl(requestUrl) {
  if (requestUrl && process.env.ALLOW_REQUEST_RESPONSE_URL === 'true') return requestUrl;
  return settings().callbackUrl || '';
}

/** POSTs each result to the callback URL, in order, with the configured delays. */
export async function deliverResults(txn, requestUrl = null) {
  const cfg = settings();
  const url = resolveCallbackUrl(requestUrl);
  if (!url) {
    txn.state = 'held';
    txn.deliveries.push({ ts: new Date().toISOString(), url: null, note: 'No callback URL configured. Results are shown above but were not sent.' });
    publish(txn);
    return;
  }
  txn.state = 'delivering';
  publish(txn);
  await sleep(cfg.resultDelayMs);
  let failed = false;
  for (let i = 0; i < txn.results.length; i++) {
    const result = txn.results[i];
    const body = txn.protocol === 'SOAP' ? soapEnvelope(result.xml, 'SendMessage') : result.xml;
    const delivery = { ts: new Date().toISOString(), url, resultIndex: i, sent: clip(body), status: null, response: null, error: null, ms: null };
    txn.deliveries.push(delivery);
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': txn.protocol === 'SOAP' ? 'text/xml; charset=utf-8' : 'application/xml' },
        body,
        signal: AbortSignal.timeout(15000),
      });
      delivery.status = res.status;
      delivery.response = clip(await res.text());
      if (!res.ok) failed = true;
    } catch (err) {
      delivery.error = err.cause?.code ?? err.message;
      failed = true;
    }
    delivery.ms = Date.now() - started;
    publish(txn);
    if (i < txn.results.length - 1) await sleep(cfg.betweenResultsMs);
  }
  txn.state = failed ? 'delivery-failed' : 'delivered';
  publish(txn);
}

/**
 * Stand-in for the interface agent's /v2/query-result endpoint. Records the result the gateway
 * delivers, answers the way the agent does, and marks the matching result on the original call
 * as delivered so the call log shows the whole loop.
 */
export function recordCallback({ rawBody, headers = {}, path = '/interface-agent/v2/query-result' }) {
  const soap = isSoap(rawBody);
  const txn = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    origin: 'receiver',
    protocol: soap ? 'SOAP' : 'REST',
    path,
    headers: redactHeaders(headers),
    sent: clip(rawBody),
    requestXml: null,
    queries: [],
    ack: null,
    results: [],
    deliveries: [],
    state: 'callback-received',
  };
  txns.unshift(txn);
  if (txns.length > MAX_TXNS) txns.pop();

  let parsed;
  try {
    const xml = soap ? unwrapSoap(rawBody).xml : rawBody;
    txn.requestXml = xml;
    parsed = parseResultDoc(xml);
  } catch (err) {
    return finishAck(txn, soap, { httpStatus: 400, status: 'Failed', reason: 'Invalid request', errors: [{ code: 400, category: 'HTTP', message: err.message }], state: 'rejected' });
  }

  txn.results = parsed.map((p) => ({
    requestId: p.requestId, recordId: null, recordName: '(callback from the gateway)', class: p.class, hit: p.hit,
    system: p.system, messageType: p.messageType, messageData: p.messageData, fields: p.fields, xml: txn.requestXml,
  }));

  for (const p of parsed) {
    const original = txns.find((t) => t.origin === 'gateway' && t.results.some((r) => r.requestId === p.requestId));
    if (!original) continue;
    const i = original.results.findIndex((r, idx) => r.requestId === p.requestId && r.class === p.class && !original.deliveries.some((d) => d.resultIndex === idx));
    if (i < 0) continue;
    original.deliveries.push({ ts: new Date().toISOString(), url: '(callback receiver)', resultIndex: i, sent: null, status: 200, response: null, error: null, ms: null });
    if (original.results.every((_, idx) => original.deliveries.some((d) => d.resultIndex === idx))) original.state = 'delivered';
    txn.linkedTo = original.id;
    publish(original);
  }

  return finishAck(txn, soap, { httpStatus: 200, status: 'Succeeded', reason: 'Processed', deviceId: 'RECEIVER', transactionId: parsed[0]?.transactionId ?? 'UNKNOWN', state: 'callback-received' });
}

export async function redeliver(id) {
  const txn = getTransaction(id);
  if (!txn) return null;
  txn.deliveries = [];
  await deliverResults(txn);
  return txn;
}

/**
 * Call-log entry for a replayed request (docs/REPLAY.md). `regionReason` says how the region was chosen ("ori" or
 * "state"); the ORI itself stays masked like every other credential. `replay` is the matched record, or null when the
 * region is certified but no captured reply set matches (the TCP path now sends the query catalog instead, `noMatch`; a certified region never falls back to
 * generated results).
 */
export function recordReplay({ loggedBody, request, region, regionReason, replay }) {
  const txn = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    origin: 'tcp',
    region,
    regionReason,
    protocol: 'TCP',
    path: 'tcp',
    headers: {},
    sent: clip(maskCredentials(loggedBody)),
    requestXml: clip(maskCredentials(loggedBody)),
    queries: [{ transactionId: request.id, requestId: request.id, entityType: replay?.entityType ?? null, messageType: request.messageType, auth: request.auth ?? {}, fields: request.params ?? {} }],
    ack: { httpStatus: 200, contentType: 'application/xml', body: '(ACK frame)' },
    results: (replay?.replies ?? []).map((r) => {
      const tag = (t) => (new RegExp(`<${t}>([^<]*)</${t}>`).exec(r.response) || [])[1] ?? '';
      return {
        requestId: request.id, recordId: replay.id, recordName: `${replay.match.kind} replay (${r.fullEnvelope ? 'full envelope' : 'message text only'})`,
        class: tag('Class') || r.dataSource || '', hit: tag('Detected') === '1', system: tag('System') || r.dataSource || '',
        messageType: tag('MessageType'), messageData: tag('MessageData'), fields: {}, xml: r.response,
      };
    }),
    deliveries: [],
    state: replay ? 'replaying' : 'no-capture',
    replayId: replay?.id ?? null,
    noMatch: !!replay?.noMatch,
  };
  txns.unshift(txn);
  if (txns.length > MAX_TXNS) txns.pop();
  publish(txn);
  return txn;
}

/** Marks one replayed frame as written to the socket (or failed). */
export function recordReplayDelivery(txn, resultIndex, error = null) {
  txn.deliveries.push({ ts: new Date().toISOString(), url: 'tcp', resultIndex, sent: null, status: error ? null : 200, response: error ? null : 'sent over TCP', error, ms: 0 });
  if (error) txn.state = 'delivery-failed';
  else if (txn.deliveries.length === txn.results.length) txn.state = 'delivered';
  publish(txn);
}
