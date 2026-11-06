// Every reply the simulator sends to a user's query carries this label as the first line of its MessageData, so nobody
// mistakes a simulated response for a live state switch reply. Universal Search shows MessageData as plain text, so the
// label is text only (no colour or bold is possible through a reply).
export const SIM_LABEL = '*** USx SIMULATION ***';

/** MessageData text with the label on top (once). */
export function labelText(text) {
  const s = String(text ?? '');
  return s.startsWith(SIM_LABEL) ? s : s ? `${SIM_LABEL}\n${s}` : SIM_LABEL;
}

/** Labels every <MessageData> in a reply's XML (a reply can hold several <Response> elements); adds one where a
 * Response has none. The text inside is already XML-escaped and the label has no characters that need escaping. */
export function labelResponseXml(xml) {
  const s = String(xml ?? '').replace(/<MessageData>([\s\S]*?)<\/MessageData>|<MessageData\s*\/>/g, (_m, inner) => `<MessageData>${labelText(inner ?? '')}</MessageData>`);
  return s.replace(/<Response>((?:(?!<\/Response>)[\s\S])*?)<\/Response>/g, (m, inner) => (/<MessageData>/.test(inner) ? m : `<Response>${inner}<MessageData>${SIM_LABEL}</MessageData></Response>`));
}
