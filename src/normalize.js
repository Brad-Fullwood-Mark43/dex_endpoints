// Real Commsys results carry the raw field plus "Normalized" copies and split name parts
// (NormalizedName, NormalizedBirthDateYear, NameFirst, ...). Federated Search's attribute mappings
// read them, so every result gets them derived from the plain fields, without overriding any value a
// record sets explicitly. This applies to seed records, CSV imports and records edited in the UI.

const two = (n) => String(n).padStart(2, '0');

function splitName(raw) {
  const v = String(raw).trim();
  if (!v) return null;
  if (v.includes(',')) {
    const [last, rest = ''] = v.split(',');
    const [first = '', ...middle] = rest.trim().split(/\s+/).filter(Boolean);
    return { last: last.trim(), first, middle: middle.join(' ') };
  }
  const parts = v.split(/\s+/);
  if (parts.length === 1) return { last: parts[0], first: '', middle: '' };
  return { last: parts[0], first: parts[1], middle: parts.slice(2).join(' ') };
}

const eightDigits = (v) => /^\d{8}$/.test(String(v ?? ''));

export function enrichFields(fields = {}) {
  const out = { ...fields };
  const set = (key, value) => {
    if (value !== undefined && value !== null && value !== '' && out[key] === undefined) out[key] = value;
  };
  const datePart = (source, prefix, withParts) => {
    const v = fields[source];
    if (!eightDigits(v)) return;
    set(`Normalized${prefix}`, v);
    if (withParts) {
      set(`Normalized${prefix}Year`, v.slice(0, 4));
      set(`Normalized${prefix}Month`, v.slice(4, 6));
      set(`Normalized${prefix}Day`, v.slice(6, 8));
    }
  };

  const name = fields.Name ? splitName(fields.Name) : null;
  if (name) {
    set('NameLast', name.last);
    set('NameFirst', name.first);
    set('NameMiddle', name.middle);
    set('NormalizedName', `${name.last}, ${[name.first, name.middle].filter(Boolean).join(' ')}`.replace(/, $/, ''));
    set('NormalizedNameLast', name.last);
    set('NormalizedNameFirst', name.first);
    set('NormalizedNameMiddle', name.middle);
  }

  datePart('BirthDate', 'BirthDate', true);
  datePart('IssueDate', 'IssueDate', false);
  datePart('ExpirationDate', 'ExpirationDate', false);
  datePart('LicensePlateExpirationDate', 'LicensePlateExpirationDate', false);
  datePart('TheftDate', 'TheftDate', true);
  if (fields.VehicleYear) set('NormalizedVehicleYear', fields.VehicleYear);
  if (fields.LicensePlateYear) set('NormalizedLicensePlateYear', fields.LicensePlateYear);

  const { AddressStreet: street, AddressCity: city, AddressStateCode: state, AddressZipCode: zip } = fields;
  if (street || city) {
    set('NormalizedAddressStreet', street);
    set('NormalizedAddressCity', city);
    set('NormalizedAddressStateCode', state);
    set('NormalizedAddressZipCode', zip);
    set('NormalizedAddress', [street, city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', '));
  }
  return out;
}

export const withDerivedFields = (result) => ({ ...result, fields: enrichFields(result.fields ?? {}) });
