// Seed records. Everything here is invented: obviously fake names, 999-prefixed SSNs, "TEST" streets
// and ORIs. Field names follow what real Commsys results carry (checked against the interface agent's
// and Federated Search's exemplar responses); normalized copies and split names are derived at send
// time by normalize.js. Add or edit records in the web UI (Records tab) or import a CSV.

// Bump when the seed records change so existing deployments refresh them (custom records are kept).
export const SEED_VERSION = 2;

const AGENCY = 'MOCKORI00';

const person = (over) => ({ entityType: 'PERSON', enabled: true, ...over });
const vehicle = (over) => ({ entityType: 'VEHICLE', enabled: true, ...over });
const result = (over) => ({ interfaceName: 'MOCK_INTERFACE', responseType: over.messageType, ...over });

const license = ({ name, dob, sex, race, height, weight, eyes, hair, oln, ssn, street, city, zip }) =>
  result({
    hit: false,
    class: 'DriverLicense',
    system: 'DMV',
    messageType: 'DMV Person Record',
    interfaceName: 'MOCK_STATE_DMV',
    systemName: 'DMV_DRIVER_LICENSE',
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
      HairColorCode: hair,
      OperatorLicenseNumber: oln,
      OperatorLicenseStateCode: 'XX',
      OperatorLicenseClassCode: 'E',
      OperatorLicenseRestrictions: 'NONE',
      IssueDate: '20240110',
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
      license({ name: 'DOE, JANE A', dob: '19900115', sex: 'F', race: 'W', height: '505', weight: '130', eyes: 'BRN', hair: 'BRO', oln: 'D0000001', ssn: '999-00-0001', street: '100 TEST ST', city: 'SAMPLETOWN', zip: '00001' }),
    ],
  }),
  person({
    id: 'seed-person-sample-wanted',
    name: 'Alex Sample - license plus wanted hit',
    match: { Name: 'SAMPLE, ALEX', OperatorLicenseNumber: 'S0000002' },
    results: [
      license({ name: 'SAMPLE, ALEX B', dob: '19850630', sex: 'M', race: 'B', height: '510', weight: '180', eyes: 'BRO', hair: 'BLK', oln: 'S0000002', ssn: '999-00-0002', street: '200 TEST AVE', city: 'SAMPLETOWN', zip: '00002' }),
      result({
        hit: true,
        class: 'WantedPerson',
        system: 'NCIC',
        messageType: 'NCIC Wanted Person',
        interfaceName: 'MOCK_NCIC',
        systemName: 'NCIC_WANTED_PERSON',
        messageData:
          `MOCKORI01\n*** WARRANT HIT - CONFIRM WITH ENTERING AGENCY ***\nMKE/WANTED PERSON\nORI/${AGENCY} NAM/SAMPLE, ALEX B SEX/M RAC/B\n` +
          `DOB/19850630 HGT/510 WGT/180 EYE/BRO HAI/BLK\nOFF/FAILURE TO APPEAR\nDOW/20260101 OCA/TEST-0001\nNIC/W000000001 DTE/20260102\n` +
          `ENTERING AGENCY: MOCK COUNTY SHERIFF 555-0100\n`,
        fields: {
          Name: 'SAMPLE, ALEX B',
          BirthDate: '19850630',
          BirthPlaceCode: 'XX',
          SexCode: 'M',
          RaceCode: 'B',
          Height: '510',
          Weight: '180',
          EyeColorCode: 'BRO',
          HairColorCode: 'BLK',
          SocialSecurityNumber: '999-00-0002',
          OffenseCode: 'FAILURE TO APPEAR',
          WarrantNumber: 'TEST-WARRANT-0001',
          WarrantDate: '20260101',
          NCICNumber: 'W000000001',
          OriginatingAgencyCaseNumber: 'TEST-0001',
          OriginatingAgencyIdentifier: AGENCY,
          FreeText: 'MOCK COUNTY SHERIFF',
          MessageKey: 'WPTEST0001',
        },
      }),
    ],
  }),
  person({
    id: 'seed-person-missing',
    name: 'Casey Example - missing person',
    match: { Name: 'EXAMPLE, CASEY' },
    results: [
      result({
        hit: true,
        class: 'MissingPerson',
        system: 'NCIC',
        messageType: 'NCIC Missing Person',
        interfaceName: 'MOCK_NCIC',
        systemName: 'NCIC_MISSING_PERSON',
        messageData:
          `MOCKORI01\nMKE/MISSING PERSON - JUVENILE\nORI/${AGENCY} NAM/EXAMPLE, CASEY SEX/F RAC/W\nDOB/20100301 HGT/500 WGT/095 EYE/GRN HAI/BLN\n` +
          `DLC/20260210 OCA/TEST-0002 NIC/M000000002\nCIRCUMSTANCES: LAST SEEN WALKING HOME FROM SCHOOL\n`,
        fields: {
          Name: 'EXAMPLE, CASEY',
          BirthDate: '20100301',
          SexCode: 'F',
          RaceCode: 'W',
          Height: '500',
          Weight: '095',
          EyeColorCode: 'GRN',
          HairColorCode: 'BLN',
          NCICNumber: 'M000000002',
          OriginatingAgencyCaseNumber: 'TEST-0002',
          OriginatingAgencyIdentifier: AGENCY,
          FreeText: 'LAST SEEN WALKING HOME FROM SCHOOL',
          MessageKey: 'MPTEST0002',
        },
      }),
    ],
  }),
  vehicle({
    id: 'seed-vehicle-registered',
    name: 'TST1234 - registered, clean',
    match: { LicensePlateNumber: 'TST1234', VehicleIdentificationNumber: '1TEST00000A000001' },
    results: [
      result({
        hit: false,
        class: 'VehicleRegistration',
        system: 'DMV',
        messageType: 'DMV Vehicle Registration',
        interfaceName: 'MOCK_STATE_DMV',
        systemName: 'DMV_VEHICLE_REGISTRATION',
        messageData:
          `MOCKORI01\nLIC/TST1234 LIS/XX LIY/2027 LIT/PC\nVIN/1TEST00000A000001 VYR/2020 VMA/TOYT VMO/CAM VCO/BLK\n` +
          `OWNER: DOE, JANE A\n100 TEST ST\nSAMPLETOWN XX 00001\nREG EXP 20271231  STATUS ACTIVE\n`,
        fields: {
          LicensePlateNumber: 'TST1234',
          LicensePlateStateCode: 'XX',
          ImpliedLicensePlateStateCode: 'XX',
          LicensePlateTypeCode: 'PC',
          LicensePlateYear: '2027',
          LicensePlateExpirationDate: '20271231',
          VehicleIdentificationNumber: '1TEST00000A000001',
          VehicleYear: '2020',
          VehicleMakeCode: 'TOYT',
          VehicleModelCode: 'CAM',
          VehicleStyleCode: '4D',
          VehicleColorCode: 'BLK',
          Name: 'DOE, JANE A',
          AddressStreet: '100 TEST ST',
          AddressCity: 'SAMPLETOWN',
          AddressStateCode: 'XX',
          AddressZipCode: '00001',
          IssueDate: '20260101',
          ExpirationDate: '20271231',
          RegistrationStatusCode: 'ACTIVE',
          AutoInsurance: 'ACTIVE',
          AutoInsuranceCarrier: 'SAMPLE MUTUAL',
          AutoInsurancePolicyNumber: 'POL-TEST-0001',
        },
      }),
    ],
  }),
  vehicle({
    id: 'seed-vehicle-stolen',
    name: 'STL9999 - registered and stolen',
    match: { LicensePlateNumber: 'STL9999', VehicleIdentificationNumber: '1TEST00000S000009' },
    results: [
      result({
        hit: false,
        class: 'VehicleRegistration',
        system: 'DMV',
        messageType: 'DMV Vehicle Registration',
        interfaceName: 'MOCK_STATE_DMV',
        systemName: 'DMV_VEHICLE_REGISTRATION',
        messageData: `MOCKORI01\nLIC/STL9999 LIS/XX LIY/2026\nVIN/1TEST00000S000009 VYR/2018 VMA/FORD VMO/F15 VCO/RED\nOWNER: SAMPLE, ALEX B\n200 TEST AVE\nSAMPLETOWN XX 00002\n`,
        fields: {
          LicensePlateNumber: 'STL9999',
          LicensePlateStateCode: 'XX',
          ImpliedLicensePlateStateCode: 'XX',
          LicensePlateTypeCode: 'PC',
          LicensePlateYear: '2026',
          LicensePlateExpirationDate: '20261231',
          VehicleIdentificationNumber: '1TEST00000S000009',
          VehicleYear: '2018',
          VehicleMakeCode: 'FORD',
          VehicleModelCode: 'F15',
          VehicleStyleCode: 'PK',
          VehicleColorCode: 'RED',
          Name: 'SAMPLE, ALEX B',
          AddressStreet: '200 TEST AVE',
          AddressCity: 'SAMPLETOWN',
          AddressStateCode: 'XX',
          AddressZipCode: '00002',
          IssueDate: '20250101',
          ExpirationDate: '20261231',
          RegistrationStatusCode: 'ACTIVE',
        },
      }),
      result({
        hit: true,
        class: 'StolenVehicle',
        system: 'NCIC',
        messageType: 'NCIC Stolen Vehicle',
        interfaceName: 'MOCK_NCIC',
        systemName: 'NCIC_VEHICLE_STOLEN',
        messageData: `MOCKORI01\n*** STOLEN VEHICLE HIT - CONFIRM WITH ENTERING AGENCY ***\nMKE/STOLEN VEHICLE\nLIC/STL9999 LIS/XX VIN/1TEST00000S000009 VYR/2018 VMA/FORD VMO/F15 VCO/RED\nDOT/20260301 OCA/TEST-0003 NIC/V000000003\n`,
        fields: {
          LicensePlateNumber: 'STL9999',
          LicensePlateStateCode: 'XX',
          LicensePlateYear: '2026',
          VehicleIdentificationNumber: '1TEST00000S000009',
          VehicleYear: '2018',
          VehicleMakeCode: 'FORD',
          VehicleModelCode: 'F15',
          VehicleStyleCode: 'PK',
          VehicleColorCode: 'RED',
          TheftDate: '20260301',
          NCICNumber: 'V000000003',
          OriginatingAgencyCaseNumber: 'TEST-0003',
          OriginatingAgencyIdentifier: AGENCY,
          FreeText: 'MOCK COUNTY SHERIFF',
          MessageKey: 'VHTEST0003',
        },
      }),
    ],
  }),
  {
    id: 'seed-firearm-stolen',
    entityType: 'FIREARM',
    enabled: true,
    name: 'TESTGUN001 - stolen firearm',
    match: { GunSerialNumber: 'TESTGUN001' },
    results: [
      result({
        hit: true,
        class: 'StolenGun',
        system: 'NCIC',
        messageType: 'NCIC Stolen Gun',
        interfaceName: 'MOCK_NCIC',
        systemName: 'NCIC_STOLEN_GUN',
        messageData: `MOCKORI01\n*** STOLEN GUN HIT ***\nMKE/STOLEN GUN\nSER/TESTGUN001 CAL/9MM MAK/TEST MOD/SAMPLE-9 TYP/PISTOL\nDOT/20260115 OCA/TEST-0004 NIC/G000000004\n`,
        fields: {
          GunSerialNumber: 'TESTGUN001',
          GunMake: 'TEST',
          GunModel: 'SAMPLE-9',
          GunCaliber: '9MM',
          GunTypeCode: 'HG',
          ArticleSerialNumber: 'TESTGUN001',
          ArticleBrand: 'TEST',
          ArticleTypeCode: 'HANDGUN',
          TheftDate: '20260115',
          NCICNumber: 'G000000004',
          OriginatingAgencyCaseNumber: 'TEST-0004',
          OriginatingAgencyIdentifier: AGENCY,
          FreeText: 'BLACK TEST SAMPLE-9 HANDGUN',
          MessageKey: 'GNTEST0004',
        },
      }),
    ],
  },
  {
    id: 'seed-boat-stolen',
    entityType: 'BOAT',
    enabled: true,
    name: 'TEST12345B606 - stolen boat',
    match: { BoatHullIdNumber: 'TEST12345B606' },
    results: [
      result({
        hit: true,
        class: 'StolenBoat',
        system: 'NCIC',
        messageType: 'NCIC Stolen Boat',
        interfaceName: 'MOCK_NCIC',
        systemName: 'NCIC_STOLEN_BOAT',
        messageData: `MOCKORI01\n*** STOLEN BOAT HIT ***\nMKE/STOLEN BOAT\nBHN/TEST12345B606 BNM/SAMPLE WAVE BMA/TEST\nDOT/20260201 OCA/TEST-0005 NIC/B000000005\n`,
        fields: {
          BoatHullIdNumber: 'TEST12345B606',
          BoatSerialNumber: 'TESTSER0005',
          BoatName: 'SAMPLE WAVE',
          BoatBrand: 'TEST',
          BoatMakeCode: 'TEST',
          RegistrationNumber: 'TESTREG0005',
          RegistrationExpirationYear: '2027',
          LicensePlateNumber: 'TSTBT05',
          LicensePlateStateCode: 'XX',
          TheftDate: '20260201',
          NCICNumber: 'B000000005',
          OriginatingAgencyCaseNumber: 'TEST-0005',
          OriginatingAgencyIdentifier: AGENCY,
          FreeText: 'WHITE TEST SAMPLE WAVE',
          MessageKey: 'BTTEST0005',
        },
      }),
    ],
  },
  {
    id: 'seed-article-stolen',
    entityType: 'ARTICLE',
    enabled: true,
    name: 'TESTART777 - stolen article',
    match: { ArticleSerialNumber: 'TESTART777' },
    results: [
      result({
        hit: true,
        class: 'StolenArticle',
        system: 'NCIC',
        messageType: 'NCIC Stolen Article',
        interfaceName: 'MOCK_NCIC',
        systemName: 'NCIC_STOLEN_ARTICLE',
        messageData: `MOCKORI01\n*** STOLEN ARTICLE HIT ***\nMKE/STOLEN ARTICLE\nSER/TESTART777 TYP/LAPTOP BRA/TEST MOD/SAMPLE-1\nDOT/20260215 OCA/TEST-0006 NIC/A000000006\n`,
        fields: {
          ArticleSerialNumber: 'TESTART777',
          ArticleTypeCode: 'LAPTOP',
          ArticleBrand: 'TEST',
          ArticleModel: 'SAMPLE-1',
          TheftDate: '20260215',
          NCICNumber: 'A000000006',
          OriginatingAgencyCaseNumber: 'TEST-0006',
          OriginatingAgencyIdentifier: AGENCY,
          FreeText: 'GREY TEST SAMPLE-1 LAPTOP',
          MessageKey: 'ARTEST0006',
        },
      }),
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
  // Which interface's wording results use (see src/regions.js). GENERIC = no regional quirks.
  region: 'GENERIC',
  // Device ORI (exact, or a 2-letter state prefix) -> USx region, for replays (docs/REPLAY.md). Real ORIs go here only, never in code.
  regionByOri: {},
};
