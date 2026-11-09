// Every reply the simulator sends to a user's query carries this label as the first line of its MessageData, so nobody
// mistakes a simulated response for a live state switch reply. Universal Search shows MessageData as plain text, so the
// label is text only (no colour or bold is possible through a reply).
export const SIM_LABEL = '*** USx SIMULATION ***';

/** MessageData text with the label on top (once). */
export function labelText(text) {
  const s = String(text ?? '');
  return s.startsWith(SIM_LABEL) ? s : s ? `${SIM_LABEL}\n${s}` : SIM_LABEL;
}

/** Labels every <MessageData> in a reply's XML (a reply can hold several <Response> elements). A Response without one
 * is left exactly as captured: the photo response that comes before a record's data response (ResponseType Image,
 * <Image><ImageData>) has no MessageData, and adding one made it look like a text reply (2026-11-09, Railway photo
 * replies). The text inside is already XML-escaped and the label has no characters that need escaping. */
export function labelResponseXml(xml) {
  return String(xml ?? '').replace(/<MessageData>([\s\S]*?)<\/MessageData>|<MessageData\s*\/>/g, (_m, inner) => `<MessageData>${labelText(inner ?? '')}</MessageData>`);
}
