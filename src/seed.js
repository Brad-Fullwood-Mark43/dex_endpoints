// Seed records. Everything here is invented: obviously fake names, 999-prefixed SSNs, 555 phone
// numbers, "TEST ST" addresses. Add or edit records in the web UI (Records tab).

const person = (over) => ({ entityType: 'PERSON', enabled: true, ...over });
const vehicle = (over) => ({ entityType: 'VEHICLE', enabled: true, ...over });

const dmvPerson = ({ name, dob, sex, race, height, weight, eyes, oln, ssn, street, city, zip }) => ({
  hit: false,
  class: 'DriverLicense',
  system: 'DMV',
  responseType: 'DMV Person Record',
  messageType: 'DMV Person Record',
  interfaceName: 'MOCK_STATE_DMV',
  systemName: 'DMV_Person',
  messageData:
    `MOCKORI01\nCTL/MOCK01\nATN/TEST QUERY\n\nB6 .MOCKORI01.          .MOCK0001.TEST QUERY                     D.\n` +
    `CLS/E OLN/  ${oln}  DISC/00\n${name.replace(',', '')}\n${street}\n${city}        ${zip}\n` +
    `DOB ${dob} RAC/${race} SEX/${sex} EYE/${eyes} WGT/${weight} HGT/${height}\nEXP 20291231 SSN ${ssn}\n\n..VALID..\n`,
  fields: {
    Name: name,
    BirthDate: dob,
    SexCode: sex,
    RaceCode: race,
    Height: height,
    Weight: weight,
    EyeColorCode: eyes,
    OperatorLicenseNumber: oln,
    OperatorLicenseStateCode: 'XX',
    OperatorLicenseClassCode: 'E',
    ExpirationDate: '20291231',
    SocialSecurityNumber: ssn,
    AddressStreet: street,
    AddressCity: city,
    AddressStateCode: 'XX',
    AddressZipCode: zip,
  },
});

export const SEED_RECORDS = [
  person({
    id: 'seed-person-doe-dmv',
    name: 'Jane Doe - license only',
    match: { Name: 'DOE, JANE', OperatorLicenseNumber: 'D0000001' },
    results: [
      dmvPerson({ name: 'DOE, JANE A', dob: '19900115', sex: 'F', race: 'W', height: '505', weight: '130', eyes: 'BRN', oln: 'D0000001', ssn: '999-00-0001', street: '100 TEST ST', city: 'SAMPLETOWN', zip: '00001' }),
    ],
  }),
  person({
    id: 'seed-person-sample-wanted',
    name: 'Alex Sample - license plus wanted hit',
    match: { Name: 'SAMPLE, ALEX', OperatorLicenseNumber: 'S0000002' },
    results: [
      dmvPerson({ name: 'SAMPLE, ALEX B', dob: '19850630', sex: 'M', race: 'B', height: '510', weight: '180', eyes: 'BRO', oln: 'S0000002', ssn: '999-00-0002', street: '200 TEST AVE', city: 'SAMPLETOWN', zip: '00002' }),
      {
        hit: true,
        class: 'WantedPerson',
        system: 'NCIC',
        responseType: 'NCIC Wanted Person',
        messageType: 'NCIC Wanted Person',
        interfaceName: 'MOCK_NCIC',
        systemName: 'NCIC',
        messageData:
          `MOCKORI01\n*** WARRANT HIT - CONFIRM WITH ENTERING AGENCY ***\nMKE/WANTED PERSON\nORI/MOCKORI00 NAM/SAMPLE, ALEX B SEX/M RAC/B\n` +
          `DOB/19850630 HGT/510 WGT/180 EYE/BRO\nOFF/FAILURE TO APPEAR\nDOW/20260101 OCA/TEST-0001\nNIC/W000000001 DTE/20260102\n` +
          `ENTERING AGENCY: MOCK COUNTY SHERIFF 555-0100\n`,
        fields: {
          Name: 'SAMPLE, ALEX B',
          BirthDate: '19850630',
          SexCode: 'M',
          RaceCode: 'B',
          Height: '510',
          Weight: '180',
          EyeColorCode: 'BRO',
          OffenseCode: 'FAILURE TO APPEAR',
          OriginatingAgencyCaseNumber: 'TEST-0001',
          NCICNumber: 'W000000001',
          WarrantDate: '20260101',
        },
      },
    ],
  }),
  person({
    id: 'seed-person-missing',
    name: 'Casey Example - missing person',
    match: { Name: 'EXAMPLE, CASEY' },
    results: [
      {
        hit: true,
        class: 'MissingPerson',
        system: 'NCIC',
        responseType: 'NCIC Missing Person',
        messageType: 'NCIC Missing Person',
        interfaceName: 'MOCK_NCIC',
        systemName: 'NCIC',
        messageData:
          `MOCKORI01\nMKE/MISSING PERSON - JUVENILE\nORI/MOCKORI00 NAM/EXAMPLE, CASEY SEX/F RAC/W\nDOB/20100301 HGT/500 WGT/095 EYE/GRN HAI/BLN\n` +
          `DLC/20260210 OCA/TEST-0002 NIC/M000000002\nCIRCUMSTANCES: LAST SEEN WALKING HOME FROM SCHOOL\n`,
        fields: { Name: 'EXAMPLE, CASEY', BirthDate: '20100301', SexCode: 'F', RaceCode: 'W', Height: '500', Weight: '095', EyeColorCode: 'GRN', NCICNumber: 'M000000002' },
      },
    ],
  }),
  vehicle({
    id: 'seed-vehicle-registered',
    name: 'TST1234 - registered, clean',
    match: { LicensePlateNumber: 'TST1234', VehicleIdentificationNumber: '1TEST00000A000001' },
    results: [
      {
        hit: false,
        class: 'VehicleRegistration',
        system: 'DMV',
        responseType: 'DMV Vehicle Registration',
        messageType: 'DMV Vehicle Registration',
        interfaceName: 'MOCK_STATE_DMV',
        systemName: 'DMV_Vehicle',
        messageData:
          `MOCKORI01\nLIC/TST1234 LIS/XX LIY/2027 LIT/PC\nVIN/1TEST00000A000001 VYR/2020 VMA/TEST VMO/SEDAN VCO/BLK\n` +
          `OWNER: DOE, JANE A\n100 TEST ST\nSAMPLETOWN XX 00001\nREG EXP 20271231  STATUS ACTIVE\n`,
        fields: {
          LicensePlateNumber: 'TST1234',
          LicensePlateStateCode: 'XX',
          LicensePlateTypeCode: 'PC',
          LicensePlateYear: '2027',
          VehicleIdentificationNumber: '1TEST00000A000001',
          VehicleYear: '2020',
          VehicleMake: 'TEST',
          VehicleModel: 'SEDAN',
          VehicleColor: 'BLACK',
          VehicleColorCode: 'BLK',
          Name: 'DOE, JANE A',
          AddressStreet: '100 TEST ST',
          AddressCity: 'SAMPLETOWN',
          AddressStateCode: 'XX',
          AddressZipCode: '00001',
          RegistrationExpirationYear: '2027',
        },
      },
    ],
  }),
  vehicle({
    id: 'seed-vehicle-stolen',
    name: 'STL9999 - registered and stolen',
    match: { LicensePlateNumber: 'STL9999', VehicleIdentificationNumber: '1TEST00000S000009' },
    results: [
      {
        hit: false,
        class: 'VehicleRegistration',
        system: 'DMV',
        responseType: 'DMV Vehicle Registration',
        messageType: 'DMV Vehicle Registration',
        interfaceName: 'MOCK_STATE_DMV',
        systemName: 'DMV_Vehicle',
        messageData: `MOCKORI01\nLIC/STL9999 LIS/XX LIY/2026\nVIN/1TEST00000S000009 VYR/2018 VMA/TEST VMO/PICKUP VCO/RED\nOWNER: SAMPLE, ALEX B\n200 TEST AVE\nSAMPLETOWN XX 00002\n`,
        fields: { LicensePlateNumber: 'STL9999', LicensePlateStateCode: 'XX', VehicleIdentificationNumber: '1TEST00000S000009', VehicleYear: '2018', VehicleMake: 'TEST', VehicleModel: 'PICKUP', VehicleColor: 'RED', Name: 'SAMPLE, ALEX B' },
      },
      {
        hit: true,
        class: 'StolenVehicle',
        system: 'NCIC',
        responseType: 'NCIC Stolen Vehicle',
        messageType: 'NCIC Stolen Vehicle',
        interfaceName: 'MOCK_NCIC',
        systemName: 'NCIC',
        messageData: `MOCKORI01\n*** STOLEN VEHICLE HIT - CONFIRM WITH ENTERING AGENCY ***\nMKE/STOLEN VEHICLE\nLIC/STL9999 LIS/XX VIN/1TEST00000S000009 VYR/2018 VMA/TEST VCO/RED\nDOT/20260301 OCA/TEST-0003 NIC/V000000003\n`,
        fields: { LicensePlateNumber: 'STL9999', VehicleIdentificationNumber: '1TEST00000S000009', VehicleYear: '2018', VehicleMake: 'TEST', TheftDate: '20260301', OriginatingAgencyCaseNumber: 'TEST-0003', NCICNumber: 'V000000003' },
      },
    ],
  }),
  {
    id: 'seed-firearm-stolen',
    entityType: 'FIREARM',
    enabled: true,
    name: 'TESTGUN001 - stolen firearm',
    match: { GunSerialNumber: 'TESTGUN001' },
    results: [
      {
        hit: true,
        class: 'StolenGun',
        system: 'NCIC',
        responseType: 'NCIC Stolen Gun',
        messageType: 'NCIC Stolen Gun',
        interfaceName: 'MOCK_NCIC',
        systemName: 'NCIC',
        messageData: `MOCKORI01\n*** STOLEN GUN HIT ***\nMKE/STOLEN GUN\nSER/TESTGUN001 CAL/9MM MAK/TEST TYP/PISTOL\nDOT/20260115 OCA/TEST-0004 NIC/G000000004\n`,
        fields: { GunSerialNumber: 'TESTGUN001', GunCaliber: '9MM', GunMake: 'TEST', GunTypeCode: 'PISTOL', TheftDate: '20260115', NCICNumber: 'G000000004' },
      },
    ],
  },
  {
    id: 'seed-boat-stolen',
    entityType: 'BOAT',
    enabled: true,
    name: 'TEST12345B606 - stolen boat',
    match: { BoatHullIdNumber: 'TEST12345B606' },
    results: [
      {
        hit: true,
        class: 'StolenBoat',
        system: 'NCIC',
        responseType: 'NCIC Stolen Boat',
        messageType: 'NCIC Stolen Boat',
        interfaceName: 'MOCK_NCIC',
        systemName: 'NCIC',
        messageData: `MOCKORI01\n*** STOLEN BOAT HIT ***\nMKE/STOLEN BOAT\nBHN/TEST12345B606 BNM/SAMPLE WAVE BMA/TEST\nDOT/20260201 OCA/TEST-0005 NIC/B000000005\n`,
        fields: { BoatHullIdNumber: 'TEST12345B606', BoatName: 'SAMPLE WAVE', BoatBrand: 'TEST', TheftDate: '20260201', NCICNumber: 'B000000005' },
      },
    ],
  },
  {
    id: 'seed-article-stolen',
    entityType: 'ARTICLE',
    enabled: true,
    name: 'TESTART777 - stolen article',
    match: { ArticleSerialNumber: 'TESTART777' },
    results: [
      {
        hit: true,
        class: 'StolenArticle',
        system: 'NCIC',
        responseType: 'NCIC Stolen Article',
        messageType: 'NCIC Stolen Article',
        interfaceName: 'MOCK_NCIC',
        systemName: 'NCIC',
        messageData: `MOCKORI01\n*** STOLEN ARTICLE HIT ***\nMKE/STOLEN ARTICLE\nSER/TESTART777 TYP/LAPTOP BRA/TEST MOD/SAMPLE-1\nDOT/20260215 OCA/TEST-0006 NIC/A000000006\n`,
        fields: { ArticleSerialNumber: 'TESTART777', ArticleTypeCode: 'LAPTOP', ArticleBrand: 'TEST', ArticleModel: 'SAMPLE-1', TheftDate: '20260215', NCICNumber: 'A000000006' },
      },
    ],
  },
];

export const DEFAULT_SETTINGS = {
  // Where results are POSTed back (the interface agent's /interface-agent/v2/query-result).
  callbackUrl: '',
  // Delay before the ack and before each result callback.
  ackDelayMs: 0,
  resultDelayMs: 1500,
  betweenResultsMs: 500,
  // success | http503 | soapFault | timeout
  ackMode: 'success',
  // normal | none (never call back) | status (send a Status message instead of results)
  resultMode: 'normal',
  // Return a NoRecord result when nothing matches (otherwise: no callback).
  noRecordOnMiss: true,
};
