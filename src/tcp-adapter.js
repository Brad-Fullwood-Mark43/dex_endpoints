// Over TCP the agent and legacy DEx speak a bare <LawEnforcementTransaction> document, while the REST/SOAP
// path wraps the same element in a <ConnectCicApi> envelope. The rest of this service (parseRequest,
// buildResultXml) works on the envelope, so these two functions convert at the edge.
// The request side accepts either form because the exact bytes the agent sends over TCP are still to be
// confirmed from a packet capture.

const LET = /<LawEnforcementTransaction[\s\S]*<\/LawEnforcementTransaction>/;

export function toEnvelope(xml) {
  if (/ConnectCicApi/.test(xml.slice(0, 2000))) return xml;
  const doc = xml.match(LET)?.[0];
  if (!doc) throw new Error('No LawEnforcementTransaction element found');
  const id = doc.match(/<Request[\s>][\s\S]*?<Id>([^<"]*)<\/Id>/)?.[1] ?? '';
  const device = doc.match(/<Session[\s>][\s\S]*?<Id>([^<"]*)<\/Id>/)?.[1] ?? 'UNKNOWN';
  return (
    '<api:ConnectCicApi xmlns:api="http://schema.commsys.com/xml/ConnectCic/Api">' +
    `<api:Route><api:Source>${device}</api:Source><api:Destinations><api:Destination>ConnectCIC</api:Destination></api:Destinations></api:Route>` +
    `<api:Transactions><api:Transaction id="${id}">${doc}</api:Transaction></api:Transactions></api:ConnectCicApi>`
  );
}

/** The result as the agent's TCP reader expects it: the bare LawEnforcementTransaction element. */
export function toBareResult(envelopeXml) {
  const doc = envelopeXml.match(LET)?.[0];
  return doc ? `<?xml version="1.0"?>\n${doc}\n` : envelopeXml;
}
