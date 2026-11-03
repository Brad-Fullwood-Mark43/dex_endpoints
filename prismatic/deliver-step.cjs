// Prismatic "Code" step, flow 2, right after the Cross Flow Trigger (set to Asynchronous).
// Flow 1 sends it the `deliveries` string from the gateway step through an "Invoke Flow" step.
// It posts each result to the "Callback URL" config variable (the interface agent's
// /interface-agent/v2/query-result), in order, with the delays the mock service asked for.
//
// Rename CROSS_FLOW_STEP to the camelCased name of this flow's trigger step.
module.exports = async ({ logger, configVars }, stepResults) => {
  const CROSS_FLOW_STEP = 'crossFlowTrigger';
  const MAX_DELAY_MS = 20000;
  const NS_SOAP = 'http://schema.commsys.com/xml/ConnectCic/Api/Soap';

  const payload = stepResults[CROSS_FLOW_STEP].results?.body?.data;
  const job = typeof payload === 'string' ? (payload ? JSON.parse(payload) : null) : payload;
  if (!job || !Array.isArray(job.results) || !job.results.length) return { data: { delivered: 0, statuses: [] } };

  const url = String(configVars['Callback URL'] ?? '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('Callback URL config variable is not set to an http(s) URL');

  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.min(Math.max(Number(ms) || 0, 0), MAX_DELAY_MS)));
  const soapWrap = (inner) =>
    `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><wsi:SendMessage xmlns:wsi="${NS_SOAP}"><wsi:Message><![CDATA[${inner.replace(/]]>/g, ']]]]><![CDATA[>')}]]></wsi:Message></wsi:SendMessage></s:Body></s:Envelope>`;

  await sleep(job.delays?.resultDelayMs);
  const statuses = [];
  for (let i = 0; i < job.results.length; i++) {
    const soap = job.protocol === 'SOAP';
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': soap ? 'text/xml; charset=utf-8' : 'application/xml' },
        body: soap ? soapWrap(job.results[i]) : job.results[i],
        signal: AbortSignal.timeout(15000),
      });
      statuses.push(res.status);
    } catch (err) {
      statuses.push(`error: ${err.cause?.code ?? err.name}`); // never log or return bodies
    }
    if (i < job.results.length - 1) await sleep(job.delays?.betweenResultsMs);
  }
  logger.info(`delivered ${statuses.length} result(s): ${statuses.join(', ')}`);
  const failed = statuses.some((s) => typeof s !== 'number' || s < 200 || s >= 300);
  if (failed) throw new Error(`One or more callbacks failed: ${statuses.join(', ')}`);
  return { data: { delivered: statuses.length, statuses } };
};
