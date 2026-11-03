import { esc, NS_API } from './xml.js';
import { randomUUID } from 'node:crypto';

const MESSAGE_TYPE = {
  PERSON: 'DriverLicenseQuery',
  VEHICLE: 'VehicleRegistrationQuery',
  FIREARM: 'GunQuery',
  BOAT: 'BoatQuery',
  ARTICLE: 'ArticleSingleQuery',
};

/**
 * Builds a request the way Federated Search does: the transaction id and Request/Id are
 * `<queryId>_<ENTITY>`, and the session id is the device id.
 */
export function buildRequestXml({ entityType, fields = {}, queryId = randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase(), auth = {} }) {
  const deviceId = auth.deviceId || 'MOCKDEVICE01';
  const requestId = `${queryId}_${entityType}`;
  const requestFields = { MessageType: MESSAGE_TYPE[entityType], ...fields };
  const fieldXml = Object.entries(requestFields)
    .filter(([, v]) => v !== undefined && v !== null && String(v) !== '')
    .map(([k, v]) => `<${k}>${esc(v)}</${k}>`)
    .join('');
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<api:ConnectCicApi xmlns:api="${NS_API}"><api:Route><api:Source>${esc(deviceId)}</api:Source><api:Destinations><api:Destination>ConnectCIC</api:Destination></api:Destinations></api:Route>` +
    `<api:Transactions><api:Transaction id="${esc(requestId)}"><LawEnforcementTransaction version="1.0"><Session><Id>${esc(deviceId)}</Id><Authentication>` +
    `<UserName>${esc(auth.userName || 'TESTUSER')}</UserName><ORI>${esc(auth.ori || 'MOCKORI01')}</ORI><Mnemonic>${esc(auth.mnemonic || 'MOCK')}</Mnemonic>` +
    `<DeviceId>${esc(deviceId)}</DeviceId><DeviceAlias>${esc(auth.deviceAlias || 'MOCKDEVICE')}</DeviceAlias></Authentication></Session>` +
    `<Transaction><Request><Id>${esc(requestId)}</Id>${fieldXml}</Request></Transaction></LawEnforcementTransaction></api:Transaction></api:Transactions></api:ConnectCicApi>`
  );
}
