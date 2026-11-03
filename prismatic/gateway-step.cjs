// Prismatic "Code" step, flow 1, placed right after the synchronous webhook trigger.
//
// What it does, in order, failing closed at every step:
//   1. Checks the caller's x-api-key against the "Gateway Key" config variable.
//   2. Pulls the query out of the request (REST or SOAP) and rejects anything that is not a
//      plain query: only known field names, only identifying values that are on the mock's allowlist.
//   3. Rebuilds a minimal request (no session, no authentication, no ORI, no user names) and sends
//      only that to the mock service's /resolve endpoint.
//   4. Returns the acknowledgement for the caller and, as a string, the results for flow 2 to deliver.
//
// Config variables (rename here if yours differ): "Gateway Key", "Mock Service URL", "Mock Service Key".
// The name of the webhook trigger step, camelCased, goes in TRIGGER_STEP below.
module.exports = async ({ logger, configVars }, stepResults) => {
  const TRIGGER_STEP = 'commsysWebhook';
  const crypto = require('crypto');

  // A connection field or a plain string, whichever the config variable turns out to be.
  const secret = (v) => (typeof v === 'string' ? v : (v?.fields?.apiKey ?? v?.fields?.value ?? v?.fields?.password ?? v?.fields?.key ?? ''));
  const gatewayKey = secret(configVars['Gateway Key']);
  const mockUrl = String(configVars['Mock Service URL'] ?? '').replace(/\/+$/, '');
  const mockKey = secret(configVars['Mock Service Key']);

  const IDENTIFYING = ['Name', 'BirthDate', 'SocialSecurityNumber', 'OperatorLicenseNumber', 'LicensePlateNumber', 'VehicleIdentificationNumber', 'GunSerialNumber', 'BoatHullIdNumber', 'RegistrationNumber', 'ArticleSerialNumber'];
  const BENIGN = ['InquiryTypeIndicator', 'ImageIndicator', 'State', 'RaceCode', 'SexCode', 'ArticleTypeCode', 'LicensePlateTypeCode', 'LicensePlateYear', 'VehicleMakeCode', 'VehicleYear', 'GunCaliber', 'GunMake'];
  const MAX_REQUESTS = 5;

  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const decode = (s) => String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const norm = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const nameKey = (raw) => {
    const v = String(raw ?? '').trim();
    let last;
    let first;
    if (v.includes(',')) {
      const [l, rest = ''] = v.split(',');
      last = norm(l);
      first = norm(rest.trim().split(/\s+/)[0]);
    } else {
      const p = v.split(/\s+/);
      last = norm(p[0]);
      first = norm(p[1]);
    }
    return `${last}|${first}`;
  };
  const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
  const keysMatch = (a, b) => !!a && !!b && crypto.timingSafeEqual(sha(a), sha(b));

  const NS = 'http://schema.commsys.com/xml/ConnectCic/Api';
  const NS_SOAP = 'http://schema.commsys.com/xml/ConnectCic/Api/Soap';
  const failXml = (status, reason) =>
    `<api:ConnectCicApi xmlns:api="${NS}"><api:Route><api:Source>ConnectWsi</api:Source><api:Destinations><api:Destination>UNKNOWN</api:Destination></api:Destinations></api:Route>` +
    `<api:Transactions><api:TransactionResult id="UNKNOWN"><api:Status>Failed</api:Status><api:Reason>${esc(reason)}</api:Reason>` +
    `<api:Errors><api:Error code="${status}" category="HTTP">${esc(reason)}</api:Error></api:Errors></api:TransactionResult></api:Transactions></api:ConnectCicApi>`;
  const respond = (status, body, contentType = 'application/xml') => ({ data: { status, contentType, body, deliveries: '' } });
  const rejected = (status, reason) => {
    logger.warn(`gateway rejected a request: ${reason}`); // reasons never contain request values
    return respond(status, failXml(status, reason));
  };
  const soapWrap = (inner, element) =>
    `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><wsi:${element} xmlns:wsi="${NS_SOAP}"><wsi:Message><![CDATA[${inner.replace(/]]>/g, ']]]]><![CDATA[>')}]]></wsi:Message></wsi:${element}></s:Body></s:Envelope>`;

  const toText = (raw) => {
    if (raw && typeof raw === 'object' && raw.data !== undefined && !Buffer.isBuffer(raw)) raw = raw.data;
    if (raw && typeof raw === 'object' && raw.type === 'Buffer' && Array.isArray(raw.data)) raw = Buffer.from(raw.data);
    if (Buffer.isBuffer(raw)) return raw.toString('utf8');
    return typeof raw === 'string' ? raw : '';
  };

  // ---- 1. caller authentication
  if (!gatewayKey || !mockUrl || !mockKey) return rejected(503, 'Gateway is not configured');
  const trigger = stepResults[TRIGGER_STEP].results;
  const headers = Object.fromEntries(Object.entries(trigger.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const provided = headers['x-api-key'] || String(headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (!keysMatch(provided, gatewayKey)) return rejected(401, 'Unauthorized');

  // ---- 2. extract and validate the query
  let raw = toText(trigger.rawBody) || toText(trigger.body?.data);
  if (!raw) return rejected(400, 'Empty request');
  const soap = /<(\w+:)?Envelope[\s>]/.test(raw.slice(0, 2000));
  if (soap) {
    const m = raw.match(/<(?:\w+:)?Message>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))\s*<\/(?:\w+:)?Message>/);
    if (!m) return rejected(400, 'SOAP body has no Message');
    raw = m[1] !== undefined ? m[1] : decode(m[2]);
  }
  const blocks = [...raw.matchAll(/<Request>([\s\S]*?)<\/Request>/g)].map((m) => m[1]);
  if (!blocks.length || blocks.length > MAX_REQUESTS) return rejected(400, 'Expected between 1 and 5 Request elements');

  let allowlist;
  try {
    const res = await fetch(`${mockUrl}/allowlist`, { headers: { 'x-api-key': mockKey }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`allowlist ${res.status}`);
    allowlist = await res.json();
  } catch (err) {
    logger.error(`could not load the allowlist: ${err.message}`);
    return rejected(502, 'Allowlist unavailable');
  }

  const requests = [];
  for (const block of blocks) {
    const fields = {};
    for (const m of block.matchAll(/<([A-Za-z0-9]+)>\s*([^<]*?)\s*<\/\1>/g)) if (m[2] !== '') fields[m[1]] = decode(m[2]);
    const { Id: id, MessageType: messageType, ...rest } = fields;
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id ?? '')) return rejected(400, 'Request Id is missing or malformed');
    if (!/^[A-Za-z]{1,40}$/.test(messageType ?? '')) return rejected(400, 'MessageType is missing or malformed');
    for (const [key, value] of Object.entries(rest)) {
      if (IDENTIFYING.includes(key)) {
        const wanted = key === 'Name' ? nameKey(value) : norm(value);
        if (!(allowlist[key] ?? []).includes(wanted)) return rejected(403, `Value for ${key} is not on the test allowlist`);
      } else if (BENIGN.includes(key)) {
        if (value.length > 40) return rejected(400, `${key} is too long`);
      } else {
        return rejected(403, `Field ${key} is not permitted`);
      }
    }
    requests.push({ id, messageType, rest });
  }

  // ---- 3. rebuild a minimal request: no session, authentication, ORI or user details
  const deviceMatch = raw.match(/<DeviceId>\s*([A-Za-z0-9_-]{1,64})\s*<\/DeviceId>/) ?? raw.match(/<Session>\s*<Id>\s*([A-Za-z0-9_-]{1,64})\s*<\/Id>/);
  const device = deviceMatch ? deviceMatch[1] : 'DEVICE';
  const transactions = requests
    .map((r) => {
      const fieldXml = Object.entries(r.rest).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('');
      return (
        `<api:Transaction id="${esc(r.id)}"><LawEnforcementTransaction version="1.0"><Session><Id>${esc(device)}</Id><Authentication><DeviceId>${esc(device)}</DeviceId></Authentication></Session>` +
        `<Transaction><Request><Id>${esc(r.id)}</Id><MessageType>${esc(r.messageType)}</MessageType>${fieldXml}</Request></Transaction></LawEnforcementTransaction></api:Transaction>`
      );
    })
    .join('');
  const forward =
    `<?xml version="1.0" encoding="UTF-8"?><api:ConnectCicApi xmlns:api="${NS}"><api:Route><api:Source>${esc(device)}</api:Source>` +
    `<api:Destinations><api:Destination>ConnectCIC</api:Destination></api:Destinations></api:Route><api:Transactions>${transactions}</api:Transactions></api:ConnectCicApi>`;

  let resolved;
  try {
    const res = await fetch(`${mockUrl}/resolve`, {
      method: 'POST',
      headers: { 'x-api-key': mockKey, 'content-type': 'application/xml' },
      body: forward,
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`resolve ${res.status}`);
    resolved = await res.json();
  } catch (err) {
    logger.error(`mock service call failed: ${err.message}`);
    return rejected(502, 'Mock service unavailable');
  }

  // ---- 4. acknowledgement for the caller, results for flow 2
  const ack = resolved.ack ?? {};
  const ackBody = soap && ack.httpStatus === 200 ? soapWrap(ack.body, 'SendMessageResult') : ack.body ?? '';
  const results = (resolved.results ?? []).map((r) => r.xml);
  logger.info(`gateway handled ${requests.length} request(s): ack ${ack.httpStatus}, ${results.length} result(s)`);
  return {
    data: {
      status: ack.httpStatus || 504,
      contentType: soap ? 'text/xml' : ack.contentType || 'application/xml',
      body: ackBody,
      deliveries: results.length ? JSON.stringify({ protocol: soap ? 'SOAP' : 'REST', delays: resolved.delays ?? {}, results }) : '',
    },
  };
};
