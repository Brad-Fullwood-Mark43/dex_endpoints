export const ENTITY_TYPES = ['PERSON', 'VEHICLE', 'FIREARM', 'BOAT', 'ARTICLE'];

const MESSAGE_TYPE_TO_ENTITY = {
  DriverLicenseQuery: 'PERSON',
  VehicleRegistrationQuery: 'VEHICLE',
  GunQuery: 'FIREARM',
  BoatQuery: 'BOAT',
  ArticleSingleQuery: 'ARTICLE',
};

/** Identifier fields a record can match on, per entity type. */
export const MATCH_KEYS = {
  PERSON: ['Name', 'OperatorLicenseNumber', 'SocialSecurityNumber', 'BirthDate'],
  VEHICLE: ['LicensePlateNumber', 'VehicleIdentificationNumber'],
  FIREARM: ['GunSerialNumber'],
  BOAT: ['BoatHullIdNumber', 'RegistrationNumber'],
  ARTICLE: ['ArticleSerialNumber'],
};

export const norm = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Federated Search sends request ids as `<queryId>_<ENTITY>`; fall back to the message type. */
export function entityTypeOf(requestId, messageType) {
  const suffix = String(requestId ?? '').split('_').pop()?.toUpperCase();
  if (ENTITY_TYPES.includes(suffix)) return suffix;
  return MESSAGE_TYPE_TO_ENTITY[messageType] ?? null;
}

/** "SMITH, JOHN M", "SMITH JOHN M" or "JOHN SMITH" -> { last, first } normalised. */
export function splitName(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return { last: '', first: '' };
  if (value.includes(',')) {
    const [last, rest = ''] = value.split(',');
    return { last: norm(last), first: norm(rest.trim().split(/\s+/)[0]) };
  }
  const parts = value.split(/\s+/);
  return { last: norm(parts[0]), first: norm(parts[1]) };
}

function nameMatches(requestName, recordName) {
  const a = splitName(requestName);
  const b = splitName(recordName);
  if (!a.last || a.last !== b.last) return false;
  return !a.first || !b.first || a.first === b.first || b.first.startsWith(a.first) || a.first.startsWith(b.first);
}

/**
 * A record matches when at least one identifier the request supplied equals the record's value, and
 * no supplied identifier contradicts it. Name compares last name and first name (prefix ok).
 */
export function recordMatches(record, entityType, requestFields) {
  if (record.entityType !== entityType) return false;
  let hit = false;
  for (const key of MATCH_KEYS[entityType] ?? []) {
    const wanted = record.match?.[key];
    const given = requestFields[key];
    if (!wanted || !given) continue;
    const ok = key === 'Name' ? nameMatches(given, wanted) : norm(given) === norm(wanted);
    if (!ok) return false;
    hit = true;
  }
  return hit;
}

export function findRecords(records, entityType, requestFields) {
  return records.filter((r) => r.enabled !== false && recordMatches(r, entityType, requestFields));
}

/** The "nothing found" result Commsys returns when no interface has a record. */
export function noRecordResult(entityType) {
  const messageData = {
    PERSON: 'NO NCIC WANT/RECORD FOUND. NO RECORD ON FILE.',
    VEHICLE: 'NO NCIC WANT. NO RECORD FOUND FOR REGISTRATION.',
    FIREARM: 'NO NCIC RECORD IDENTIFIABLE WITH THE SERIAL NUMBER GIVEN.',
    BOAT: 'NO NCIC RECORD IDENTIFIABLE WITH THE HULL NUMBER GIVEN.',
    ARTICLE: 'NO NCIC RECORD IDENTIFIABLE WITH THE ARTICLE SERIAL NUMBER GIVEN.',
  }[entityType] ?? 'NO RECORD FOUND';
  return {
    hit: false,
    class: 'NoRecord',
    system: 'NCIC',
    responseType: 'NCIC No Record',
    messageType: 'NCIC No Record',
    interfaceName: 'MOCK_INTERFACE',
    systemName: 'NCIC',
    messageData,
    fields: {},
  };
}
