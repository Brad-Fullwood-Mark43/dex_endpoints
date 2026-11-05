// Replay: answer a CommSys request with a reply set captured from a real CommSys server and state switch (scrubbed of
// CJI/PII, photos blurred). This is how a USx region is represented exactly: nothing is generated, every reply is a
// captured <Response> sent back as it was, in order and with its captured spacing, with only the request id swapped.
// See docs/REPLAY.md. Pure functions, no I/O, so they are easy to test (test/replay.test.js).

const up = (v) => String(v ?? '').trim().toUpperCase();
const noLeadingZeros = (v) => (/^\d+$/.test(v) ? v.replace(/^0+(?=\d)/, '') : v);
const leaf = (xml, tag) => { const m = new RegExp(`<(?:\\w+:)?${tag}>([^<]*)</(?:\\w+:)?${tag}>`).exec(xml); return m ? m[1].trim() : null; };

/**
 * The parts of a request a replay matches on, from a bare <LawEnforcementTransaction> (TCP) or a ConnectCicApi envelope.
 * Returns null if there is no Request element.
 */
export function readRequest(xml) {
  const s = String(xml || '');
  const req = /<Request>([\s\S]*?)<\/Request>/.exec(s);
  if (!req) return null;
  const r = req[1];
  const auth = (/<Authentication>([\s\S]*?)<\/Authentication>/.exec(s) || [])[1] || '';
  return {
    id: leaf(r, 'Id'),
    messageType: leaf(r, 'MessageType'),
    ori: leaf(auth, 'ORI'),
    fields: {
      OperatorLicenseNumber: leaf(r, 'OperatorLicenseNumber'),
      Name: leaf(r, 'Name'), NameLast: leaf(r, 'NameLast'), NameFirst: leaf(r, 'NameFirst'), NameMiddle: leaf(r, 'NameMiddle'),
      BirthDate: leaf(r, 'BirthDate'), SexCode: leaf(r, 'SexCode'), State: leaf(r, 'State'),
      LicensePlateNumber: leaf(r, 'LicensePlateNumber'), VehicleIdentificationNumber: leaf(r, 'VehicleIdentificationNumber'),
    },
  };
}

/** The region for a device ORI: exact ORI, then its two-letter state prefix, then null. */
/**
 * The USx regions a replay pack can be made for (id = USx provider name), each with its test ORI. The ORIs are invented
 * test values, never a real agency's; a pack's testOri is mapped to its region on first import. The USx Railway Capture
 * extension uses the same list. CA and TX have several providers, so their test ORIs are matched exactly.
 */
export const USX_REGIONS = [
  ['AZ_AZDPS', 'AZ1000001'], ['CA_CLETS', 'CA1000001'], ['CA_CLETS_OCATS', 'CA2000001'], ['CA_CONTRA_COSTA', 'CA3000001'],
  ['CA_eSUN', 'CA4000001'], ['CA_SAN_LUIS_OBISPO', 'CA5000001'], ['CA_VENTURA_COUNTY', 'CA6000001'], ['FL_FCIC', 'FL1000001'],
  ['HI_HCJDC_OFML', 'HI1000001'], ['IL_LEADS_OFML', 'IL1000001'], ['LA_LEMS', 'LA1000001'], ['MD_METERS', 'MD1000001'],
  ['NJ_NJCJIS', 'NJ1000001'], ['NM_NMLETS_OFML', 'NM1000001'], ['NY_NYSPIN_EJUSTICE', 'NY1000001'], ['OH_LEADS', 'OH1000001'],
  ['OR_LEDS', 'OR1000001'], ['SC_SLED', 'SC1000001'], ['TN_TIES', 'TN1000001'], ['TX_TLETS', 'TX1000001'], ['TX_TLETS_CCH', 'TX2000001'],
].map(([id, testOri]) => ({ id, testOri }));

/** A region's replay records as a pack that POST /api/replays accepts again (the Records tab's Export pack). */
export function regionPack(records, region, regionByOri = {}) {
  const list = records.filter((r) => r.region === region);
  const testOri = Object.entries(regionByOri).find(([k, v]) => v === region && k.length === 9)?.[0]
    || USX_REGIONS.find((r) => r.id === region)?.testOri || null;
  return { format: 'dex_endpoints replay pack v1', region, testOri, built: new Date().toISOString(),
    source: 'exported from the Records tab (records as stored, edits included)', records: list };
}

export function regionForOri(ori, regionByOri = {}) {
  const o = up(ori).replace(/[^A-Z0-9]/g, '');
  if (!o) return null;
  return regionByOri[o] || regionByOri[o.slice(0, 2)] || null;
}

/** "DOE, JOHN Q" or NameLast/NameFirst/NameMiddle -> { last, first, middle } (upper case). */
function nameParts(f) {
  if (f.NameLast || f.NameFirst) return { last: up(f.NameLast), first: up(f.NameFirst), middle: up(f.NameMiddle) };
  const n = up(f.Name);
  if (!n) return null;
  if (n.includes(',')) { const [last, rest = ''] = n.split(','); const [first = '', ...mid] = rest.trim().split(/\s+/); return { last: last.trim(), first, middle: mid.join(' ') }; }
  const p = n.split(/\s+/); return { last: p[0], first: p[1] || '', middle: p.slice(2).join(' ') };
}
// BirthDate to YYYYMMDD. Accepts YYYYMMDD / YYYY-MM-DD, and MMDDYYYY / MM-DD-YYYY / M/D/YYYY (TX_TLETS requests send
// MMDDYYYY). Eight digits are never ambiguous: a YYYY lead is 1800 or more, an MMDD lead is 1231 or less.
const ymd = (v) => {
  const s = String(v || '').trim(); let m;
  if ((m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(s)) && Number(m[1]) >= 1800) return `${m[1]}${m[2]}${m[3]}`;
  if ((m = /^(\d{2})-?(\d{2})-?(\d{4})$/.exec(s))) return `${m[3]}${m[1]}${m[2]}`;
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) return `${m[3]}${m[1].padStart(2, '0')}${m[2].padStart(2, '0')}`;
  return s;
};

/**
 * Does a replay record answer this request? Match rules (docs/REPLAY.md):
 *   OLN       OperatorLicenseNumber equal, ignoring case and leading zeros; State equal (in-state = no State, or the home state)
 *   NAME_DOB  last and first name equal (case-insensitive); middle checked by its first letter only when both sides have one;
 *             BirthDate the same date (YYYYMMDD or MMDDYYYY on either side); a record with SexCode needs the request to send
 *             the same sex (first letter: M / MALE); a record without SexCode matches with or without one; State as above
 *   PLATE     LicensePlateNumber equal (case-insensitive); State equal, or absent / home on either side for an in-state record
 *   VIN       VehicleIdentificationNumber equal (case-insensitive)
 */
export function matches(record, request, home) {
  const m = record.match || {}; const f = request.fields || {};
  const st = (v) => { const s = up(v); return !s || s === home ? null : s; };
  switch (m.kind) {
    case 'OLN':
      return !!f.OperatorLicenseNumber && noLeadingZeros(up(f.OperatorLicenseNumber)) === noLeadingZeros(up(m.OperatorLicenseNumber)) && st(f.State) === st(m.State);
    case 'NAME_DOB': {
      const n = nameParts(f); if (!n) return false;
      if (n.last !== up(m.NameLast) || n.first !== up(m.NameFirst)) return false;
      if (n.middle && m.NameMiddle && n.middle[0] !== up(m.NameMiddle)[0]) return false;
      if (ymd(f.BirthDate) !== ymd(m.BirthDate)) return false;
      if (up(m.SexCode) && (!up(f.SexCode) || up(f.SexCode)[0] !== up(m.SexCode)[0])) return false;
      return st(f.State) === st(m.State);
    }
    case 'PLATE':
      return !!f.LicensePlateNumber && up(f.LicensePlateNumber) === up(m.LicensePlateNumber) && st(f.State) === st(m.State);
    case 'VIN':
      return !!f.VehicleIdentificationNumber && up(f.VehicleIdentificationNumber) === up(m.VehicleIdentificationNumber);
    default:
      return false;
  }
}

/** The best replay for a request in a region: matching records, most replies first, then most full envelopes. */
export function findReplay(replays, region, request) {
  if (!region || !request) return null;
  const home = region.slice(0, 2);
  const hits = replays.filter((r) => r.region === region && r.certified !== false && matches(r, request, home));
  hits.sort((a, b) => b.replies.length - a.replies.length || b.replies.filter((x) => x.fullEnvelope).length - a.replies.filter((x) => x.fullEnvelope).length);
  return hits[0] || null;
}

/**
 * The frames to send, in order: [{ delayMs, xml }]. Each captured <Response> is sent as a bare <LawEnforcementTransaction>
 * (what the agent's TCP reader expects), with its Request/Id set to the incoming request's id (inserted when the captured
 * reply kept only its message text). A photo Federated Search had moved out of a text-only reply goes back in as
 * <Image><ImageData> (inferred placement: that envelope wasn't captured).
 */
export function replayFrames(record, requestId) {
  const id = String(requestId ?? '').replace(/[<&>]/g, '');
  let prev = 0;
  return record.replies.map((r) => {
    let resp = String(r.response || '').trim();
    // A full CommSys envelope writes <Request><ConnectCICRequestId>..</ConnectCICRequestId><Id>..</Id></Request>, so the Id
    // is not always first, and one reply can hold several <Response> elements (a photo response, then the record), each
    // with its own Request. Set the Id inside every existing Request block; never add a second Request to a Response (the
    // agent would read the captured query's id and drop the reply).
    if (/<Request>[\s\S]*?<\/Request>/.test(resp)) {
      resp = resp.replace(/<Request>([\s\S]*?)<\/Request>/g, (_m, inner) =>
        `<Request>${/<Id>[^<]*<\/Id>/.test(inner) ? inner.replace(/<Id>[^<]*<\/Id>/, `<Id>${id}</Id>`) : `${inner}<Id>${id}</Id>`}</Request>`);
    } else resp = resp.replace(/^<Response>/, `<Response><Request><Id>${id}</Id></Request>`);
    if (r.attachedImage && !/<ImageData>/.test(resp)) resp = resp.replace(/<\/Response>\s*$/, `<Image><ImageData>${r.attachedImage}</ImageData></Image></Response>`);
    const delayMs = Math.max(0, (r.offsetMs ?? 0) - prev);
    prev = r.offsetMs ?? prev;
    return { delayMs, xml: `<?xml version="1.0"?>\n<LawEnforcementTransaction version="1.0"><Transaction>${resp}</Transaction></LawEnforcementTransaction>\n` };
  });
}

/**
 * Does a replay record report a hit? True when any of its captured replies has <Hit><Detected>1</Detected></Hit> (the
 * CommSys envelope's hit flag). Text-only replies have no envelope, so they never count.
 */
export function replayHasHit(record) {
  return (record.replies || []).some((x) => /<Detected>\s*1\s*<\/Detected>/i.test(x.response || ''));
}

/** Checks an uploaded replay pack before it is stored. Returns a list of problems (empty = valid). */
export function validatePack(pack) {
  const problems = [];
  if (!pack || !Array.isArray(pack.records)) return ['pack has no records array'];
  const kinds = new Set(['OLN', 'NAME_DOB', 'PLATE', 'VIN']);
  pack.records.forEach((r, i) => {
    if (r.type !== 'replay') problems.push(`record ${i}: type must be "replay"`);
    if (!/^[A-Z]{2}_[A-Za-z0-9_]+$/.test(r.region || '')) problems.push(`record ${i}: region must be a USx provider name`);
    if (!kinds.has(r.match?.kind)) problems.push(`record ${i}: match.kind must be one of ${[...kinds].join(', ')}`);
    if (!Array.isArray(r.replies) || !r.replies.length) problems.push(`record ${i}: no replies`);
    (r.replies || []).forEach((x, j) => { if (!/^\s*<Response[\s>]/.test(x.response || '')) problems.push(`record ${i} reply ${j}: response must be a <Response> element`); });
  });
  return problems;
}

/**
 * Query catalog (docs/REPLAY.md "Query catalog"): a plate query for X1X1, any state, from a device whose ORI maps to a
 * region gets one reply listing every query that region can answer from its replay records. Testers search X1X1 to find
 * out what to search for.
 */
export const CATALOG_PLATE = 'X1X1';
/** The catalog reply's System, which Universal Search shows as the result's source label. */
export const CATALOG_SYSTEM = 'Mark43 TEST DATA Response';
export function isCatalogRequest(request) {
  return up(request?.fields?.LicensePlateNumber).replace(/[^A-Z0-9]/g, '') === CATALOG_PLATE;
}

const xmlText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const mdy = (v) => { const d = ymd(v); return /^\d{8}$/.test(d) ? `${d.slice(4, 6)}/${d.slice(6)}/${d.slice(0, 4)}` : String(v ?? ''); };

/** The catalog text: one section per query kind, one line per distinct query, in the order a tester would type them. */
export function catalogText(replays, region, { noMatch = false } = {}) {
  const home = region.slice(0, 2);
  const recs = replays.filter((r) => r.region === region && r.certified !== false);
  const where = (s) => (!up(s) || up(s) === home ? `State ${home} or blank` : `State ${up(s)}`);
  const extra = (r) => `${r.replies.length} repl${r.replies.length === 1 ? 'y' : 'ies'}${replayHasHit(r) ? '  HIT' : ''}`;
  const kinds = [
    ['OLN', 'PERSON BY DRIVER LICENSE', (m) => `OLN ${up(m.OperatorLicenseNumber)}  ${where(m.State)}`],
    ['NAME_DOB', 'PERSON BY NAME / DOB', (m) => `${up(m.NameLast)}, ${up(m.NameFirst)}${m.NameMiddle ? ' ' + up(m.NameMiddle) : ''}  DOB ${mdy(m.BirthDate)}  Sex ${up(m.SexCode) || 'any or blank'}  ${where(m.State)}`],
    ['PLATE', 'VEHICLE BY PLATE', (m) => `Plate ${up(m.LicensePlateNumber)}  ${where(m.State)}`],
    ['VIN', 'VEHICLE BY VIN', (m) => `VIN ${up(m.VehicleIdentificationNumber)}`],
  ];
  const out = [...(noMatch ? ['NO TEST RECORD MATCHES THIS QUERY.', 'Search one of the queries below instead (check spelling, DOB, sex and state).', ''] : []), `MARK43 TEST DATA QUERIES - ${region}`, `${recs.length} captured quer${recs.length === 1 ? 'y' : 'ies'}. Search one of these from a device whose ORI maps to ${region}.`];
  if (!recs.length) out.push('', 'No replay records are loaded for this region yet.');
  for (const [kind, title, line] of kinds) {
    const lines = new Map();
    for (const r of recs.filter((x) => x.match?.kind === kind)) {
      const l = line(r.match);
      if (!lines.has(l) || lines.get(l).replies.length < r.replies.length) lines.set(l, r);
    }
    if (!lines.size) continue;
    out.push('', `${title} (${lines.size})`);
    for (const [l, r] of [...lines].sort((a, b) => a[0].localeCompare(b[0]))) out.push(`  ${l}  (${extra(r)})`);
  }
  return out.join('\n');
}

/**
 * The catalog as a replay record, so it is sent and logged like any replay. The envelope is one of the region's own
 * captured full-envelope replies (its Class, System and interface names, so Universal Search parses it the way it
 * parses that region), with the catalog as MessageData, no hit and no image. A region with no captured envelope gets
 * the plain envelope the captures share.
 */
/** PERSON for an OLN or name query, VEHICLE for a plate or VIN query (the call log's entity column). */
export function requestEntityType(request) {
  const f = request?.fields || {};
  return f.OperatorLicenseNumber || f.Name || f.NameLast || f.NameFirst ? 'PERSON' : 'VEHICLE';
}

/**
 * `noMatch`: the request matched no record, so the catalog is sent with a "no test record matches" line on top (instead
 * of an ACK alone), logged as entity `entityType` and replay id `catalog-<region>-no-match`.
 */
export function catalogRecord(replays, region, { noMatch = false, entityType = 'VEHICLE' } = {}) {
  const plain = (r) => r.fullEnvelope && /<MessageData>/.test(r.response || '') && !/<(LicensePlateNumber|Name|OperatorLicenseNumber|VehicleIdentificationNumber)>/.test(r.response);
  const all = replays.filter((r) => r.region === region).flatMap((r) => r.replies || []);
  // Prefer a neutral message class (TX_TLETS Nlets "Response", LA_LEMS OSW "Accept"); NoRecord or Unknown could make
  // Universal Search show the list as "no record" or unparsed.
  const cls = (r) => (/<Class>([^<]*)<\/Class>/.exec(r.response) || [])[1];
  const template = all.find((r) => plain(r) && /^(Response|Accept)$/.test(cls(r)))
    || all.find((r) => plain(r) && !/^(NoRecord|Unknown)$/.test(cls(r))) || all.find(plain)
    || all.find((r) => r.fullEnvelope && /<MessageData>/.test(r.response || ''));
  const text = xmlText(catalogText(replays, region, { noMatch }));
  const response = template
    ? template.response
      .replace(/<MessageData>[\s\S]*?<\/MessageData>/, `<MessageData>${text}</MessageData>`)
      .replace(/<Detected>[^<]*<\/Detected>/, '<Detected>0</Detected>')
      .replace(/<Image>[\s\S]*?<\/Image>/, '<Image/>')
      .replace(/<System>[^<]*<\/System>/, `<System>${CATALOG_SYSTEM}</System>`)
    : `<Response><Class>Accept</Class><CurrentDataBlock>1</CurrentDataBlock><Hit><Details></Details><Detected>0</Detected></Hit><Image/><MessageData>${text}</MessageData><Request><Id></Id></Request><System>${CATALOG_SYSTEM}</System></Response>`;
  return { id: `catalog-${region.toLowerCase()}${noMatch ? '-no-match' : ''}`, type: 'replay', region, certified: true, entityType, noMatch,
    match: noMatch ? { kind: 'CATALOG (no match)' } : { kind: 'CATALOG', LicensePlateNumber: CATALOG_PLATE }, replies: [{ offsetMs: 500, dataSource: CATALOG_SYSTEM, fullEnvelope: true, response }] };
}
