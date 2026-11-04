// Credentials that arrive in request bodies. The call log, Postgres and the web UI must never keep them,
// even when the values are dummy ones, so the habit holds if a real value ever slips in.

const TAGS = ['Password', 'UserName', 'UserAlias', 'ORI', 'OriginatingAgencyORI', 'SSN', 'Mnemonic'].join('|');

// <Tag>value</Tag>, and the same thing XML-escaped inside a SOAP message (&lt;Tag&gt;value&lt;/Tag&gt;).
const PLAIN = new RegExp(`(<(?:\\w+:)?(?:${TAGS})(?:\\s[^>]*)?>)([^<]+)(</)`, 'g');
const ESCAPED = new RegExp(`(&lt;(?:\\w+:)?(?:${TAGS})(?:\\s[^&]*)?&gt;)([^&]+)(&lt;/)`, 'g');

export function maskCredentials(xml) {
  if (typeof xml !== 'string') return xml;
  return xml.replace(PLAIN, '$1***$3').replace(ESCAPED, '$1***$3');
}
