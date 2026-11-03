import { XMLParser } from 'fast-xml-parser';

export const NS_API = 'http://schema.commsys.com/xml/ConnectCic/Api';
export const NS_SOAP = 'http://schema.commsys.com/xml/ConnectCic/Api/Soap';

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  trimValues: true,
});

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const asArray = (x) => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);

export function isSoap(body) {
  return /<(\w+:)?Envelope[\s>]/.test(body.slice(0, 2000));
}

/**
 * Pulls the ConnectCicApi XML out of a SOAP SendMessage envelope. The Message element carries the
 * payload either as CDATA or as escaped text; both end up as the text content after parsing.
 */
export function unwrapSoap(body) {
  const doc = parser.parse(body);
  const sendMessage = doc?.Envelope?.Body?.SendMessage ?? doc?.Envelope?.Body?.SendMessageResult;
  if (!sendMessage) throw new Error('SOAP body has no SendMessage element');
  const message = typeof sendMessage.Message === 'object' ? sendMessage.Message['#text'] : sendMessage.Message;
  if (!message) throw new Error('SOAP SendMessage has no Message element');
  const responseUrl = typeof sendMessage.ResponseURL === 'object' ? sendMessage.ResponseURL['#text'] : sendMessage.ResponseURL;
  return { xml: message, responseUrl: responseUrl || null };
}

/**
 * Parses a ConnectCicApi request and returns the pieces the mock needs.
 * Throws if the document is not a ConnectCicApi with at least one request transaction.
 */
export function parseRequest(xml) {
  const doc = parser.parse(xml);
  const api = doc?.ConnectCicApi;
  if (!api) throw new Error('Root element is not ConnectCicApi');

  const transactions = asArray(api.Transactions?.Transaction);
  if (!transactions.length) throw new Error('No Transaction elements found');

  const parsed = transactions.map((tx) => {
    const let_ = tx.LawEnforcementTransaction;
    const request = let_?.Transaction?.Request;
    if (!request) throw new Error('Transaction has no LawEnforcementTransaction/Transaction/Request');
    const auth = let_.Session?.Authentication ?? {};
    const fields = {};
    for (const [k, v] of Object.entries(request)) {
      if (typeof v === 'string') fields[k] = v;
    }
    return {
      transactionId: tx['@_id'] ?? fields.Id ?? null,
      requestId: fields.Id ?? tx['@_id'] ?? null,
      sessionId: let_.Session?.Id ?? null,
      auth: {
        mnemonic: auth.Mnemonic ?? null,
        deviceId: auth.DeviceId ?? let_.Session?.Id ?? null,
        deviceAlias: auth.DeviceAlias ?? null,
        ori: auth.ORI ?? null,
        userName: auth.UserName ?? null,
      },
      messageType: fields.MessageType ?? null,
      fields,
    };
  });

  return {
    source: api.Route?.Source ?? null,
    destinations: asArray(api.Route?.Destinations?.Destination),
    transactions: parsed,
  };
}

const RESULT_META = ['Class', 'System', 'MessageType', 'MessageData', 'ResponseType', 'IntInterfaceName', 'IntSystemName', 'IntTransId', 'CurrentDataBlock', 'QueryState', 'SendToUser'];

/**
 * Parses a Commsys result document (what the interface agent receives on /v2/query-result).
 * Returns one entry per Response element; a document with only TransactionResult elements
 * yields an empty list. Throws if the root is not ConnectCicApi.
 */
export function parseResultDoc(xml) {
  const api = parser.parse(xml)?.ConnectCicApi;
  if (!api) throw new Error('Root element is not ConnectCicApi');
  const out = [];
  for (const tx of asArray(api.Transactions?.Transaction)) {
    const response = tx.LawEnforcementTransaction?.Transaction?.Response;
    if (!response) continue;
    const all = {};
    for (const [k, v] of Object.entries(response)) if (typeof v === 'string' && v !== '') all[k] = v;
    out.push({
      transactionId: tx['@_id'] ?? null,
      requestId: response.Request?.Id ?? tx['@_id'] ?? null,
      hit: String(response.Hit?.Detected ?? '0') === '1',
      class: all.Class ?? '',
      system: all.System ?? '',
      messageType: all.MessageType ?? '',
      messageData: all.MessageData ?? '',
      fields: Object.fromEntries(Object.entries(all).filter(([k]) => !RESULT_META.includes(k))),
    });
  }
  return out;
}

export function buildAckXml({ deviceId, transactionId, status = 'Succeeded', reason = 'Processed', errors = [] }) {
  const errorXml = errors.length
    ? `<api:Errors>${errors
        .map((e) => `<api:Error code="${esc(e.code)}" category="${esc(e.category)}">${esc(e.message)}</api:Error>`)
        .join('')}</api:Errors>`
    : '';
  return (
    `<api:ConnectCicApi xmlns:api="${NS_API}">` +
    `<api:Route><api:Source>ConnectWsi</api:Source><api:Destinations><api:Destination>${esc(deviceId)}</api:Destination></api:Destinations></api:Route>` +
    `<api:Transactions><api:TransactionResult id="${esc(transactionId)}"><api:Status>${esc(status)}</api:Status>` +
    `<api:Reason>${esc(reason)}</api:Reason>${errorXml}</api:TransactionResult></api:Transactions></api:ConnectCicApi>`
  );
}

/** Wraps a ConnectCicApi document in the SOAP envelope Commsys uses (wsi:SendMessage / SendMessageResult). */
export function soapEnvelope(innerXml, element = 'SendMessageResult', responseUrl = null) {
  const safe = innerXml.replace(/]]>/g, ']]]]><![CDATA[>');
  return (
    `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
    `<wsi:${element} xmlns:wsi="${NS_SOAP}"><wsi:Message><![CDATA[${safe}]]></wsi:Message>` +
    (responseUrl ? `<wsi:ResponseURL>${esc(responseUrl)}</wsi:ResponseURL>` : '') +
    `</wsi:${element}></s:Body></s:Envelope>`
  );
}

export function soapFault(detailXml) {
  return (
    `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>` +
    `<faultcode>SOAP-ENV:Server</faultcode><faultstring>Processing Failure - View Detail</faultstring>` +
    `<detail>${esc(detailXml)}</detail></s:Fault></s:Body></s:Envelope>`
  );
}

const RESPONSE_ORDER_HEAD = ['Request'];

/**
 * Builds a Commsys result document (the thing posted back to the interface agent's /v2/query-result).
 * `result` is a record result spec: { hit, class, system, responseType, messageType, interfaceName,
 * systemName, messageData, fields }.
 */
export function buildResultXml({ deviceId, transactionId, requestId, auth = {}, result, segment = 1, total = 1 }) {
  const intTransId = randomCode(4);
  const fields = { ...(result.fields ?? {}) };
  const simple = {
    Class: result.class,
    CurrentDataBlock: '1',
    IntInterfaceName: result.interfaceName ?? 'MOCK_INTERFACE',
    IntSystemName: result.systemName ?? result.system ?? '',
    IntTransId: randomCode(4),
    MessageData: result.messageData ?? '',
    MessageType: result.messageType ?? result.responseType ?? '',
    QueryState: result.queryState ?? '',
    ResponseType: result.responseType ?? result.messageType ?? '',
    SendToUser: '',
    System: result.system ?? '',
    ...fields,
  };
  const body = Object.keys(simple)
    .sort()
    .filter((k) => !RESPONSE_ORDER_HEAD.includes(k))
    .map((k) => `<${k}>${esc(simple[k])}</${k}>`)
    .join('\n                        ');

  return (
    `<api:ConnectCicApi xmlns:api="${NS_API}">\n` +
    `    <api:Route>\n        <api:Source>ConnectCic</api:Source>\n        <api:Destinations>\n            <api:Destination>${esc(deviceId)}</api:Destination>\n        </api:Destinations>\n    </api:Route>\n` +
    `    <api:Transactions>\n        <api:Transaction id="${esc(transactionId)}">\n            <LawEnforcementTransaction version="1.0">\n` +
    `                <Session>\n                    <Authentication>\n` +
    `                        <Mnemonic>${esc(auth.mnemonic ?? '')}</Mnemonic>\n                        <DeviceId>${esc(deviceId)}</DeviceId>\n` +
    `                        <ORI>${esc(auth.ori ?? '')}</ORI>\n                        <UserName>${esc(auth.userName ?? '')}</UserName>\n` +
    `                        <DestinationAlias></DestinationAlias>\n                        <DeviceAlias>${esc(auth.deviceAlias ?? '')}</DeviceAlias>\n` +
    `                    </Authentication>\n                    <IntTransId>${intTransId}</IntTransId>\n                    <Id>${esc(deviceId)}</Id>\n` +
    `                    <TotalSegments>${total}</TotalSegments>\n                    <SegmentRecombinationId>${randomCode(13)}</SegmentRecombinationId>\n                    <CurrentSegment>${segment}</CurrentSegment>\n` +
    `                </Session>\n                <Transaction>\n                    <Response>\n` +
    `                        <Request>\n                            <Id>${esc(requestId)}</Id>\n                        </Request>\n` +
    `                        <Hit>\n                            <Details></Details>\n                            <Detected>${result.hitBlank ? '' : result.hit ? 1 : 0}</Detected>\n                        </Hit>\n` +
    `                        <Image/>\n                        <SecondaryRequests></SecondaryRequests>\n` +
    `                        ${body}\n` +
    `                    </Response>\n                </Transaction>\n            </LawEnforcementTransaction>\n        </api:Transaction>\n    </api:Transactions>\n</api:ConnectCicApi>\n`
  );
}

/** A Commsys interface status message (what the agent treats as a heartbeat). */
export function buildStatusXml({ deviceId, transactionId, requestId, iface = 'MOCK_INTERFACE', status = 'Up' }) {
  return (
    `<api:ConnectCicApi xmlns:api="${NS_API}"><api:Route><api:Source>ConnectCic</api:Source><api:Destinations><api:Destination>${esc(deviceId)}</api:Destination></api:Destinations></api:Route>` +
    `<api:Transactions><api:Transaction id="${esc(transactionId)}"><LawEnforcementTransaction version="1.0"><Session><Authentication><DeviceId>${esc(deviceId)}</DeviceId></Authentication><Id>${esc(deviceId)}</Id></Session>` +
    `<Transaction><Response><Request><Id>${esc(requestId)}</Id></Request><MessageType>Status</MessageType><Interface>${esc(iface)}</Interface>` +
    `<Status>${esc(status)}</Status><TransManStatus>Connected</TransManStatus></Response></Transaction></LawEnforcementTransaction></api:Transaction></api:Transactions></api:ConnectCicApi>`
  );
}

function randomCode(len) {
  const chars = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
