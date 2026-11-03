import { ENTITY_TYPES, MATCH_KEYS } from './matcher.js';

/** Minimal RFC 4180 parser: quoted fields, escaped quotes, commas and newlines inside quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = String(text ?? '').replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  return rows;
}

const DEFAULT_CLASS = { PERSON: 'DriverLicense', VEHICLE: 'VehicleRegistration', FIREARM: 'StolenGun', BOAT: 'StolenBoat', ARTICLE: 'StolenArticle' };
const HIT_CLASSES = new Set(['WantedPerson', 'ViolentPerson', 'MissingPerson', 'StolenVehicle', 'StolenGun', 'StolenBoat', 'StolenArticle', 'LostArticle']);
const DMV_CLASSES = new Set(['DriverLicense', 'VehicleRegistration']);
const META_COLUMNS = new Set(['entity_type', 'record_name', 'result_class', 'hit', 'system', 'message_data']);

const humanize = (s) => s.replace(/([a-z])([A-Z])/g, '$1 $2');
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const truthy = (v) => /^(true|yes|y|1|hit)$/i.test(String(v).trim());

/**
 * Turns spreadsheet rows into records. One row is one result. Rows that share an entity_type and
 * record_name (or, without a record_name, the same identifiers) become one record with several
 * results, for example a license row plus a wanted-person row for the same person.
 *
 * Columns: entity_type (required), record_name, result_class, hit, system, message_data, then any
 * Commsys field names (Name, OperatorLicenseNumber, LicensePlateNumber, ...). Columns that are
 * match keys for the entity type are used to look the record up.
 */
export function recordsFromCsv(text) {
  const rows = parseCsv(text);
  const errors = [];
  if (rows.length < 2) return { records: [], errors: ['The file needs a header row and at least one data row.'] };
  const headers = rows[0].map((h) => h.trim());
  if (!headers.includes('entity_type')) return { records: [], errors: ['Missing required column: entity_type'] };

  const groups = new Map();
  rows.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const row = Object.fromEntries(headers.map((h, j) => [h, (cells[j] ?? '').trim()]));
    const entityType = row.entity_type.toUpperCase();
    if (!ENTITY_TYPES.includes(entityType)) {
      errors.push(`Row ${line}: entity_type "${row.entity_type}" must be one of ${ENTITY_TYPES.join(', ')}`);
      return;
    }
    const fields = Object.fromEntries(Object.entries(row).filter(([k, v]) => k && !META_COLUMNS.has(k) && v !== ''));
    const identifiers = Object.fromEntries(MATCH_KEYS[entityType].filter((k) => fields[k]).map((k) => [k, fields[k]]));
    const cls = row.result_class || DEFAULT_CLASS[entityType];
    const system = row.system || (DMV_CLASSES.has(cls) ? 'DMV' : 'NCIC');
    const key = `${entityType}|${row.record_name || Object.values(identifiers).join('|')}`;
    // Identifiers are needed to start a record; a later row with the same record_name adds another result to it.
    if (!Object.keys(identifiers).length && !(row.record_name && groups.has(key))) {
      errors.push(`Row ${line}: needs at least one of ${MATCH_KEYS[entityType].join(', ')} (or the record_name of an earlier row)`);
      return;
    }
    if (!groups.has(key)) {
      groups.set(key, {
        id: `csv-${slug(key)}`,
        entityType,
        enabled: true,
        name: row.record_name || `${entityType[0]}${entityType.slice(1).toLowerCase()}: ${Object.values(identifiers)[0]}`,
        match: {},
        results: [],
      });
    }
    const record = groups.get(key);
    Object.assign(record.match, identifiers);
    record.results.push({
      hit: row.hit !== '' ? truthy(row.hit) : HIT_CLASSES.has(cls),
      class: cls,
      system,
      responseType: `${system} ${humanize(cls)}`,
      messageType: `${system} ${humanize(cls)}`,
      interfaceName: 'MOCK_INTERFACE',
      systemName: system,
      messageData: row.message_data || Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n'),
      fields,
    });
  });
  return { records: [...groups.values()], errors };
}
