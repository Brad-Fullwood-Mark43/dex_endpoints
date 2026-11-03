# Prismatic gateway

Two Code steps that sit between the interface agent and the mock service. Prismatic holds the real key;
the mock (on Railway) only ever sees a rebuilt query containing allowlisted, synthetic values.

```
interface agent --x-api-key: <real key>--> Flow 1 (synchronous webhook)
                                             step 2 "Gateway"   gateway-step.cjs
                                             step 3 Invoke Flow (hands results to flow 2, does not wait)
                                             step 4 "Respond"   returns the ack to the agent
Flow 2 (cross flow trigger, asynchronous)
   step 2 "Deliver"  deliver-step.cjs  -> POSTs each result to the agent's callback URL
```

## Config variables

| Name | Value |
| --- | --- |
| `Gateway Key` | The key the agent sends as `x-api-key`. Stored only in Prismatic, as a connection field or secret. |
| `Mock Service URL` | `https://dexendpoints-production.up.railway.app` |
| `Mock Service Key` | A mock-only secret. Must equal the `API_KEY` on Railway and must be a different value from `Gateway Key`. |
| `Callback URL` | The agent's `/interface-agent/v2/query-result`, reachable from Prismatic. |

`gateway-step.cjs` reads a connection field named `apiKey`, `value`, `password` or `key`, or a plain string.
If your secret variable uses another field name, change the `secret` helper at the top.

## Flow 1 (synchronous)

1. **Trigger**: Webhook, Response Type = Synchronous. Name it so its camelCased form matches `TRIGGER_STEP`
   in `gateway-step.cjs` (default `commsysWebhook`, i.e. a step named "Commsys Webhook").
2. **Code step** named "Gateway": paste `gateway-step.cjs`.
3. **Invoke Flow** (Cross Flow component): Flow Name = flow 2, Data = the Gateway step's `deliveries` result.
   Add a Branch to skip it when `deliveries` is empty, or leave it; flow 2 does nothing for an empty string.
4. **Code step** named "Respond":
   ```js
   module.exports = async ({ logger }, stepResults) => {
     const g = stepResults.gateway.results;
     return { data: g.body, statusCode: g.status, contentType: g.contentType };
   };
   ```
   If the caller gets an empty body with this, replace it with a Stop Execution step (Response Body =
   `gateway.results.body`, Content Type = `gateway.results.contentType`, HTTP Status Code =
   `gateway.results.status`). The Prismatic docs disagree on whether a body survives a status code in the
   final step, so test it.

## Flow 2 (asynchronous)

1. **Trigger**: Cross Flow Trigger, Response Type = Asynchronous. Name it to match `CROSS_FLOW_STEP` in
   `deliver-step.cjs` (default `crossFlowTrigger`).
2. **Code step**: paste `deliver-step.cjs`. It fails the execution if any callback is not 2xx, so failures
   show up in Prismatic's execution list.

## Things to confirm on the first run

- Header names in `trigger.headers`: the gateway lowercases them, so any casing works.
- The raw body field: the step reads `results.rawBody` (string, Buffer or `{data}`), then `results.body.data`.
- Whether the cross-flow payload arrives as the string we sent (the delivery step parses a string or an object).
- Execution logs: Prismatic keeps trigger payloads, headers included, so check who can read execution
  logs for this instance. The code never logs request or result contents, only counts and status codes.

## What the gateway refuses (fail closed)

Wrong or missing key; an empty or malformed body; more than 5 Request elements; a missing Request Id or
MessageType; any field name not in the permitted lists; any identifying value (name, DOB, SSN, license,
plate, VIN, serial numbers) that is not on the mock's `/allowlist`; and any failure to load the allowlist
or reach the mock. Rejections never echo the offending value.
