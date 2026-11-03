#!/usr/bin/env node
// Compares this service's result XML with the real thing, using a local checkout of the
// federated-search repository as the source of truth. Run after changing seed records, regions or
// normalize.js:
//
//   node scripts/check-fidelity.mjs <path to federated-search checkout> [--region CA_CLETS | --all-regions]
//
// Reports, per result class: (1) fields we emit that Federated Search's Response model does not declare,
// (2) how many source fields the provider result mappings read that we supply (compared with the
// real exemplars), and (3) fields the exemplars carry that we do not. It never writes anything.
import fs from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { SEED_RECORDS } from '../src/seed.js';
import { withDerivedFields } from '../src/normalize.js';
import { applyRegion, REGIONS, isRegion } from '../src/regions.js';
import { buildResultXml } from '../src/xml.js';

const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith('--'));
if (!root || args.includes('--help')) {
  console.log('usage: node scripts/check-fidelity.mjs <path to federated-search checkout> [--region ID | --all-regions]');
  process.exit(root ? 0 : 1);
}
const regionArg = args.includes('--region') ? args[args.indexOf('--region') + 1] : 'GENERIC';
const regions = args.includes('--all-regions') ? Object.keys(REGIONS) : [regionArg];
for (const r of regions) if (!isRegion(r)) { console.error(`unknown region ${r}`); process.exit(1); }

const find = (dir, test, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && e.name !== 'node_modules' && e.name !== 'target') find(p, test, out);
    else if (test(p)) out.push(p);
  }
  return out;
};

const responseJava = find(path.join(root, 'api/src/main/java'), (p) => p.endsWith('commsys/transactions/Response.java'))[0];
const exemplarDir = path.join(root, 'simulation-exemplars/src/main/resources/simulated-responses');
const mappingFiles = find(path.join(root, 'api/src/main/resources'), (p) => /RESULTS_[A-Za-z0-9]+_[A-Za-z0-9]+_?[A-Z]*\.json$/.test(path.basename(p)));
const missing = [!responseJava && 'Response.java (api/src/main/java/**/commsys/transactions)', !fs.existsSync(exemplarDir) && 'simulation-exemplars/.../simulated-responses', !mappingFiles.length && 'api/src/main/resources/RESULTS_*.json'].filter(Boolean);
if (missing.length) { console.error('Not found under that path:\n  ' + missing.join('\n  ')); process.exit(1); }

const declared = new Set([...fs.readFileSync(responseJava, 'utf8').matchAll(/@XmlElement\(name\s*=\s*"([^"]+)"/g)].map((m) => m[1]));
const parser = new XMLParser({ removeNSPrefix: true, parseTagValue: false });
const responseOf = (xml) => {
  const find2 = (o) => (o && typeof o === 'object' ? (o.Response ?? Object.values(o).map(find2).find(Boolean)) : undefined);
  return find2(parser.parse(xml));
};
const leafNames = (resp) => Object.entries(resp).filter(([, v]) => typeof v === 'string' || v === '').map(([k]) => k);

const exemplarsByClass = {};
for (const f of fs.readdirSync(exemplarDir).filter((n) => n.endsWith('.xml'))) {
  try {
    const resp = responseOf(fs.readFileSync(path.join(exemplarDir, f), 'utf8'));
    if (!resp) continue;
    (exemplarsByClass[resp.Class || ''] ??= []).push(new Set(leafNames(resp)));
  } catch { /* skip unparsable exemplar */ }
}

const sourceFields = (file) => {
  const out = new Set();
  const walk = (o) => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (k === 'sourceField') [].concat(v).forEach((x) => typeof x === 'string' && out.add(x.toLowerCase())); walk(v); }
  };
  walk(JSON.parse(fs.readFileSync(file, 'utf8')));
  return out;
};
const mappingsByEntity = {};
for (const f of mappingFiles) {
  const m = /RESULTS_([A-Za-z0-9]+)_([A-Z]+)/.exec(path.basename(f));
  (mappingsByEntity[m[2]] ??= {})[m[1]] = sourceFields(f);
}
const ENTITY_OF = { DriverLicense: 'PERSON', WantedPerson: 'PERSON', MissingPerson: 'PERSON', ViolentPerson: 'PERSON', VehicleRegistration: 'VEHICLE', StolenVehicle: 'VEHICLE', StolenGun: 'FIREARM', StolenBoat: 'BOAT', StolenArticle: 'ARTICLE', LostArticle: 'ARTICLE' };

console.log(`Response.java declares ${declared.size} elements; ${Object.values(exemplarsByClass).flat().length} exemplars; mappings: ${mappingFiles.map((f) => path.basename(f)).join(', ')}`);
let problems = 0;
for (const region of regions) {
  console.log(`\n######## region ${region}`);
  const seen = new Set();
  for (const record of SEED_RECORDS) {
    for (const stored of record.results) {
      if (seen.has(stored.class)) continue;
      seen.add(stored.class);
      const result = applyRegion(withDerivedFields(stored), region);
      const resp = responseOf(buildResultXml({ deviceId: 'DEV1', transactionId: 'T', requestId: 'T', result }));
      const mine = new Set(leafNames(resp));
      const undeclaredAll = [...mine].filter((n) => !declared.has(n) && !['Request', 'Hit', 'Image', 'SecondaryRequests'].includes(n));
      const exList = exemplarsByClass[stored.class] ?? [];
      const exUnion = new Set(exList.flatMap((s) => [...s]));
      // Undeclared in the model but present in real exemplars is tolerated by Federated Search; flag only the rest.
      const undeclared = undeclaredAll.filter((n) => !exUnion.has(n));
      const tolerated = undeclaredAll.filter((n) => exUnion.has(n));
      console.log(`\n${stored.class}  (${mine.size} fields)`);
      console.log(`  not declared in Response.java : ${undeclared.length ? undeclared.join(', ') : 'none'}${tolerated.length ? `   (also in real exemplars, so tolerated: ${tolerated.join(', ')})` : ''}`);
      const entity = ENTITY_OF[stored.class];
      for (const [provider, src] of Object.entries(mappingsByEntity[entity] ?? {})) {
        const lower = new Set([...mine].map((n) => n.toLowerCase()));
        const lowerEx = new Set([...exUnion].map((n) => n.toLowerCase()));
        const ours = [...src].filter((s) => lower.has(s)).length;
        const theirs = [...src].filter((s) => lowerEx.has(s)).length;
        console.log(`  ${provider} mapping reads ${src.size} fields: we supply ${ours}, exemplars supply ${theirs}`);
      }
      // Fields that at least a quarter of this class's exemplars carry and we do not (one-off fields are noise).
      const count = (n) => exList.filter((s) => s.has(n)).length;
      const gap = [...exUnion].filter((n) => !mine.has(n) && count(n) >= Math.max(2, Math.ceil(exList.length / 4))).sort((a, b) => count(b) - count(a));
      console.log(`  common in exemplars, not ours : ${gap.length ? gap.slice(0, 15).map((n) => `${n}(${count(n)}/${exList.length})`).join(', ') + (gap.length > 15 ? `, +${gap.length - 15} more` : '') : 'none'}`);
      problems += undeclared.length;
    }
  }
}
console.log(problems ? `\n${problems} undeclared field name(s) found: fix these first.` : '\nNo undeclared field names.');
process.exit(problems ? 2 : 0);
