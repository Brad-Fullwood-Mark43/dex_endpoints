// Region profiles: how a Commsys interface for a given state words its results.
//
// Every profile here is built from what real exemplar responses show (the interface agent's and
// Federated Search's simulated-responses, plus the TN_TIES request sample). Only differences the
// exemplars actually show are modelled; anything not listed behaves like GENERIC. To add or change
// a region, edit PROFILES below and see docs/RESPONSES.md.
//
// A profile can set:
//   state              two-letter code that replaces the placeholder "XX" in fields and message text,
//                      and the "MOCKORI.." agency ids become <state>0000000 / <state>0000100
//   interface          IntInterfaceName; interfaceBySystem overrides it for one source system
//   queryState         the QueryState element (some interfaces fill it, most leave it blank)
//   responseStyle      'keep'        leave ResponseType / MessageType as the record defines them
//                      'system'      ResponseType = MessageType = the source system (DMV, NCIC, AFS...)
//                      'descriptive' wordy types such as "DMV Person Record" (the record's own wording)
//                      'fixed:<X>'   ResponseType = MessageType = X
//   plainSystemName    IntSystemName is just the system (NCIC) instead of NCIC_VEHICLE_STOLEN
//   systemByClass      { Class: { system, systemName } } when a region sources a class elsewhere
//   dates              display format for the raw date fields (Normalized* copies stay YYYYMMDD):
//                      birth, issue (IssueDate / ExpirationDate / plate expiry), theft (TheftDate / WarrantDate)
//   nameFormat         'comma' ("LAST, FIRST M") or 'space' ("LAST FIRST M")
//   hitDetected        'actual' or 'blank' (Hit/Detected left empty)

export const DEFAULT_REGION = 'GENERIC';

const PROFILES = {
  GENERIC: {
    id: 'GENERIC',
    label: 'Generic (no regional quirks)',
    note: 'Placeholder state XX, MOCK interface names, dates as YYYYMMDD. The default.',
  },
  CA_CLETS: {
    id: 'CA_CLETS',
    label: 'California - CLETS',
    state: 'CA',
    interface: 'CA_CLETS',
    responseStyle: 'system',
    systemByClass: {
      DriverLicense: { system: 'DMV', systemName: 'DMV_DRIVER_LICENSE' },
      VehicleRegistration: { system: 'DMV', systemName: 'DMV_VEHICLE_REGISTRATION' },
      WantedPerson: { system: 'NCIC', systemName: 'NCIC_PERSON_HIT' },
      StolenGun: { system: 'AFS', systemName: 'AFS_RECORD' },
      NoRecord: { system: 'NCIC', systemName: 'NCIC' },
    },
    dates: { birth: 'MM-DD-YYYY', issue: 'MM-DD-YY', theft: 'YYYYMMDD' },
    note: 'Birth dates MM-DD-YYYY, issue and expiry MM-DD-YY. Firearms come from AFS. ResponseType is the source system.',
  },
  CA_ESUN: {
    id: 'CA_ESUN',
    label: 'California - eSUN',
    state: 'CA',
    interface: 'CA_eSUN',
    responseStyle: 'system',
    systemByClass: {
      DriverLicense: { system: 'DMV', systemName: 'DMV_DRIVER_LICENSE' },
      WantedPerson: { system: 'NCIC', systemName: 'NCIC_WANTED_PERSON' },
      MissingPerson: { system: 'NCIC', systemName: 'NCIC_MISSING_PERSON' },
      StolenArticle: { system: 'NCIC', systemName: 'NCIC_STOLE_ARTICLE' },
      StolenBoat: { system: 'NCIC', systemName: 'NCIC_STOLE_BOAT' },
      StolenGun: { system: 'AFS', systemName: 'AFS_STOLE_GUN' },
      NoRecord: { system: 'NCIC', systemName: 'NCIC_NO_RECORD' },
    },
    dates: { birth: 'YYYYMMDD', issue: 'MM-DD-YY', theft: 'YYYYMMDD' },
    note: 'Issue and expiry dates MM-DD-YY, birth dates YYYYMMDD. Firearms come from AFS. ResponseType is the source system.',
  },
  LA_LEMS: {
    id: 'LA_LEMS',
    label: 'Louisiana - LEMS',
    state: 'LA',
    interface: 'LA_LEMS',
    responseStyle: 'system',
    dates: { birth: 'YYYYMMDD', issue: 'YYYY-MM-DD', theft: 'YYYY-MM-DD' },
    hitDetected: 'blank',
    note: 'Hit/Detected is left blank. Issue and theft dates YYYY-MM-DD.',
  },
  LA_LEMS_OFML: {
    id: 'LA_LEMS_OFML',
    label: 'Louisiana - LEMS (OFML)',
    state: 'LA',
    interface: 'LA_LEMS_OFML',
    responseStyle: 'descriptive',
    systemByClass: {
      DriverLicense: { system: 'DMV', systemName: 'DMV_Person' },
      NoRecord: { system: 'NCIC', systemName: 'NCIC_PERSON_NORECORD' },
    },
    note: 'Wordy response types ("DMV Person Record", "NCIC Person No Record") and DMV_Person system names.',
  },
  FL_FCIC: {
    id: 'FL_FCIC',
    label: 'Florida - FCIC',
    state: 'FL',
    interface: 'FL_FCIC',
    queryState: 'FL',
    responseStyle: 'system',
    dates: { birth: 'YYYYMMDD', issue: 'MM/DD/YY', theft: 'YYYYMMDD' },
    nameFormat: 'space',
    note: 'QueryState FL. Issue and expiry dates MM/DD/YY. Names are "LAST FIRST" with no comma.',
  },
  SD_DMV: {
    id: 'SD_DMV',
    label: 'South Dakota - DMV',
    state: 'SD',
    interface: 'SD_DMV',
    queryState: 'SD',
    responseStyle: 'system',
    note: 'QueryState SD. Dates YYYYMMDD.',
  },
  KS_KIBRS: {
    id: 'KS_KIBRS',
    label: 'Kansas - KIBRS',
    state: 'KS',
    interface: 'KS_KIBRS',
    interfaceBySystem: { DMV: 'DMV' },
    queryState: 'KS',
    responseStyle: 'system',
    note: 'QueryState KS. DMV results use the interface name DMV, NCIC results KS_KIBRS. Dates YYYYMMDD.',
  },
  HI_CJIS: {
    id: 'HI_CJIS',
    label: 'Hawaii - CJIS',
    state: 'HI',
    interface: 'HI_CJIS',
    queryState: 'HI',
    responseStyle: 'system',
    note: 'QueryState HI. Dates YYYYMMDD.',
  },
  TN_TIES: {
    id: 'TN_TIES',
    label: 'Tennessee - TIES',
    state: 'TN',
    interface: 'TN_TIES',
    responseStyle: 'fixed:TIES',
    plainSystemName: true,
    note: 'ResponseType TIES and plain system names (NCIC). Based on a request sample and the TN_TIES mapping only: there are no TN response exemplars, so this is the least certain profile.',
  },
};

export const REGIONS = PROFILES;
export const listRegions = () => Object.values(PROFILES).map(({ id, label, note }) => ({ id, label, note }));
export const isRegion = (id) => Object.prototype.hasOwnProperty.call(PROFILES, id);

const DATE_FIELDS = {
  birth: ['BirthDate'],
  issue: ['IssueDate', 'ExpirationDate', 'LicensePlateExpirationDate'],
  theft: ['TheftDate', 'WarrantDate'],
};

export function formatDate(value, pattern) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(value ?? ''));
  if (!m || !pattern || pattern === 'YYYYMMDD') return value;
  const [, y, mo, d] = m;
  return pattern
    .replace('YYYY', y)
    .replace('YY', y.slice(2))
    .replace('MM', mo)
    .replace('DD', d);
}

function reorderName(name) {
  const v = String(name ?? '');
  return v.includes(',') ? v.replace(/\s*,\s*/, ' ') : v;
}

/**
 * Returns a copy of `result` worded the way the region's interface words it. Call this AFTER
 * withDerivedFields: the Normalized* copies are derived from the plain YYYYMMDD values and are
 * deliberately left in that form, as in the real exemplars.
 */
export function applyRegion(result, regionId) {
  const profile = PROFILES[regionId];
  if (!profile || profile.id === DEFAULT_REGION) return result;

  const out = { ...result, fields: { ...(result.fields ?? {}) } };
  const override = profile.systemByClass?.[out.class];
  if (override) {
    out.system = override.system;
    out.systemName = override.systemName;
  }
  if (profile.plainSystemName) out.systemName = out.system;

  out.interfaceName = profile.interfaceBySystem?.[out.system] ?? profile.interface;
  if (profile.queryState !== undefined) out.queryState = profile.queryState;
  if (profile.hitDetected === 'blank') out.hitBlank = true;

  const style = profile.responseStyle ?? 'keep';
  if (style === 'system') {
    out.responseType = out.system;
    out.messageType = out.system;
  } else if (style === 'descriptive') {
    const wordy = out.class === 'NoRecord' ? 'NCIC Person No Record' : out.messageType;
    out.responseType = wordy;
    out.messageType = wordy;
  } else if (style.startsWith('fixed:')) {
    out.responseType = style.slice('fixed:'.length);
    out.messageType = out.responseType;
  }

  if (profile.dates) {
    for (const [kind, pattern] of Object.entries(profile.dates)) {
      for (const key of DATE_FIELDS[kind] ?? []) if (out.fields[key] !== undefined) out.fields[key] = formatDate(out.fields[key], pattern);
    }
  }
  if (profile.nameFormat === 'space' && out.fields.Name) out.fields.Name = reorderName(out.fields.Name);

  if (profile.state) {
    const swap = (s) =>
      String(s)
        .replace(/\bXX\b/g, profile.state)
        .replace(/MOCKORI00/g, `${profile.state}0000000`)
        .replace(/MOCKORI01/g, `${profile.state}0000100`);
    for (const [k, v] of Object.entries(out.fields)) if (typeof v === 'string') out.fields[k] = swap(v);
    if (out.messageData) out.messageData = swap(out.messageData);
  }
  return out;
}
