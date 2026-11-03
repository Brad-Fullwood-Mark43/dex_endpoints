# Response reference

What this service sends and receives, how each part is produced, and where the regional differences come from.
For how to change things, see `CLAUDE.md`.

## 1. The three messages

**Request** (agent to Commsys). Built by Federated Search, forwarded by the agent. One `ConnectCicApi` document, one
`Transaction` per query. The transaction `id` and `Request/Id` are `<queryId>_<ENTITY>` (for example
`01ABC..._PERSON`); that id is how a result is tied back to its query.

```xml
<api:ConnectCicApi xmlns:api="http://schema.commsys.com/xml/ConnectCic/Api">
  <api:Route><api:Source>DEVICE1</api:Source><api:Destinations><api:Destination>ConnectCIC</api:Destination></api:Destinations></api:Route>
  <api:Transactions>
    <api:Transaction id="Q1_PERSON">
      <LawEnforcementTransaction version="1.0">
        <Session><Id>DEVICE1</Id><Authentication><!-- user, ORI, mnemonic, device alias: the gateway strips all of this --></Authentication></Session>
        <Transaction><Request><Id>Q1_PERSON</Id><MessageType>DriverLicenseQuery</MessageType><Name>DOE, JANE</Name></Request></Transaction>
      </LawEnforcementTransaction>
    </api:Transaction>
  </api:Transactions>
</api:ConnectCicApi>
```

Query types: `DriverLicenseQuery` (PERSON), `VehicleRegistrationQuery` (VEHICLE), `GunQuery` (FIREARM),
`BoatQuery` (BOAT), `ArticleSingleQuery` (ARTICLE).

**Acknowledgement** (Commsys to agent, immediately). The agent only reads the status:

```xml
<api:ConnectCicApi xmlns:api="..."><api:Route>...</api:Route><api:Transactions>
  <api:TransactionResult id="Q1_PERSON"><api:Status>Succeeded</api:Status><api:Reason>Processed</api:Reason></api:TransactionResult>
</api:Transactions></api:ConnectCicApi>
```

Anything other than `Succeeded` (or an HTTP error) makes the agent mark the query as errored.

**Result** (Commsys to the agent's `/interface-agent/v2/query-result`, one POST per result, after a delay). Same
envelope as the request, with a `Response` instead of a `Request`:

```xml
<LawEnforcementTransaction version="1.0">
  <Session>...<IntTransId/>...<TotalSegments>1</TotalSegments><CurrentSegment>1</CurrentSegment></Session>
  <Transaction><Response>
    <Request><Id>Q1_PERSON</Id></Request>           <!-- must echo the request id -->
    <Hit><Details/><Detected>0</Detected></Hit>
    <Image/><SecondaryRequests/>
    <Class>DriverLicense</Class> <System>DMV</System> <ResponseType>DMV</ResponseType> ...
    <Name>DOE, JANE A</Name> <NameFirst>JANE</NameFirst> <NormalizedName>DOE, JANE A</NormalizedName> ...
    <MessageData>free text the interface returned</MessageData>
  </Response></Transaction>
</LawEnforcementTransaction>
```

Response children are emitted alphabetically (`buildResultXml`), like the real exemplars. The agent finds the query
with `Response/Request/Id`, stores the whole document, and Federated Search maps the elements to display attributes.

## 2. Result classes

`Class` is what Federated Search and the agent switch on. These are the classes the seed data covers (the full
list the agent knows is in its `Constants.java`):

| Class | Entity | Source system | Hit? | Seed record |
| --- | --- | --- | --- | --- |
| `DriverLicense` | PERSON | DMV | no | Jane Doe, Alex Sample |
| `WantedPerson` | PERSON | NCIC | yes | Alex Sample |
| `MissingPerson` | PERSON | NCIC | yes | Casey Example |
| `VehicleRegistration` | VEHICLE | DMV | no | plates TST1234, STL9999 |
| `StolenVehicle` | VEHICLE | NCIC | yes | plate STL9999 |
| `StolenGun` | FIREARM | NCIC (AFS in CA) | yes | TESTGUN001 |
| `StolenBoat` | BOAT | NCIC | yes | TEST12345B606 |
| `StolenArticle` | ARTICLE | NCIC | yes | TESTART777 |
| `NoRecord` | any | NCIC | no | returned when nothing matches |

Not yet seeded but known to the agent: `ViolentPerson`, `LostArticle`, `Image`, `Unknown`, `LogonAccept`, `LogonFailed`.

## 3. Fields

- **Field names** must be elements declared in Federated Search's `Response.java` (316 of them). `check-fidelity` enforces this.
- **Raw fields** are what a record sets: `Name`, `BirthDate` (YYYYMMDD), `AddressStreet`, `VehicleMakeCode`...
- **Derived fields** are added by `src/normalize.js` and never override a value a record sets: `NameFirst`, `NameLast`,
  `NameMiddle`, `NormalizedName*` (middle and suffix are emitted even when empty), `Normalized<Date>` plus
  `Year/Month/Day` for birth, issue, expiry, plate expiry and theft dates, `NormalizedAddress*`, `NormalizedVehicleYear`,
  `NormalizedLicensePlateYear`.
- **Regions** reword raw fields afterwards (`src/regions.js`). `Normalized*` copies deliberately stay YYYYMMDD, as in the real
  Florida exemplar (`IssueDate=01/15/26`, `NormalizedIssueDate=20260115`).
- **Codes** (`VehicleMakeCode`, `VehicleColorCode`, `HairColorCode`, `GunTypeCode`) use NCIC-style codes. The
  seeds use common ones (`TOYT`, `FORD`, `BLK`, `BRO`).
- The fields a class should carry are listed in `REQUIRED` in `test/fidelity.test.js`. They are the fields real
  exemplars carry that Federated Search's result mapping reads.

## 4. Regions

A region changes wording only. It never adds or removes a field (a test enforces that). Choose it in the web UI
under Settings, or per call on the Send test query tab.

| Region | Evidence | What it changes |
| --- | --- | --- |
| GENERIC | n/a | Nothing: placeholder state `XX`, `MOCK_*` interface names, YYYYMMDD dates. The default. |
| CA_CLETS | 13 exemplars | Birth `MM-DD-YYYY`, issue/expiry `MM-DD-YY`; firearms from AFS (`AFS_RECORD`); `ResponseType` = source system |
| CA_ESUN | 14 exemplars | Issue/expiry `MM-DD-YY`; firearms from AFS (`AFS_STOLE_GUN`); NCIC names like `NCIC_STOLE_BOAT` |
| LA_LEMS | 3 exemplars | `Hit/Detected` left blank; issue and theft dates `YYYY-MM-DD` (the exemplars mix formats; this picks one) |
| LA_LEMS_OFML | 6 exemplars | Wordy types (`DMV Person Record`, `NCIC Person No Record`), `DMV_Person` system name |
| FL_FCIC | 2 exemplars | `QueryState` FL; issue/expiry `MM/DD/YY`; names `LAST FIRST` without a comma |
| SD_DMV | 1 exemplar | `QueryState` SD |
| KS_KIBRS | 1 exemplar | `QueryState` KS; DMV results use interface name `DMV`, NCIC results `KS_KIBRS` |
| HI_CJIS | 1 exemplar | `QueryState` HI |
| TN_TIES | request sample and mapping only, **no response exemplars** | `ResponseType` TIES, plain system names. The least certain profile. |

All regions also set the state code (replacing `XX`) and swap the `MOCKORI..` agency ids for `<ST>0000000` and
`<ST>0000100`. Regions the repos have no sample for (AZ and most other states) are not modelled: adding one
needs exemplar responses for that interface.

## 5. Records and CSV

A record is `{ id, name, entityType, enabled, match: { <identifier>: value }, results: [ { hit, class, system,
messageType, interfaceName, systemName, messageData, fields } ] }`. A query matches a record when an identifier it
supplies equals the record's, and none contradicts it. Each entry in `results` is delivered as its own callback.

CSV columns (see `public/records-template.csv`): `entity_type` (required), `record_name`, `result_class`, `hit`, `system`,
`message_data`, then any Commsys field names. Rows sharing a `record_name` become one record with several results.

Identifiers per entity (`MATCH_KEYS`): PERSON `Name`, `OperatorLicenseNumber`, `SocialSecurityNumber`, `BirthDate`;
VEHICLE `LicensePlateNumber`, `VehicleIdentificationNumber`; FIREARM `GunSerialNumber`; BOAT `BoatHullIdNumber`,
`RegistrationNumber`; ARTICLE `ArticleSerialNumber`.

## 6. Settings that change responses

| Setting | Effect |
| --- | --- |
| Region | See section 4 |
| Acknowledgement | `success`, `http503`, `soapFault`, `timeout` (the gateway returns 504 instead of hanging) |
| Results | `normal`, `none` (never call back), `status` (send a Commsys interface status "Down" message instead) |
| Delay before results / between results | Used by the delivery step |
| No matching record | Return a `NoRecord` result (default) or nothing |

## 7. Known gaps

- Results have not been run through Federated Search's Java parser (only Java 8 was available when this was built).
  `check-fidelity` is the closest substitute: declared element names plus mapping coverage.
- MessageData text is invented in a Commsys-like shape; real text differs by state.
- Tenant-specific result mappings (a remote configuration) may read fields the TN_TIES mapping does not.
- `NormalizedExpirationDate` is emitted although Federated Search's model does not declare it; real exemplars carry it.
- No `ViolentPerson`, `LostArticle` or `Image` seed records, no multi-candidate (candidate list) results.
