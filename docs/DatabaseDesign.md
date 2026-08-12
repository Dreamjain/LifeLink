# LifeLink Database Design

## 1. Design objectives

This is the relational design for the LifeLink academic MVP, to be implemented later in PostgreSQL through Prisma. It supports a traceable SOS-to-admission workflow without treating an emergency as a single mutable hospital/ambulance record. One `EmergencyRequest` may retain many hospital offers, ambulance/driver attempts, reservations, notifications, and state changes.

Design goals:

- preserve operational history and retries;
- keep master data (hospital, fleet, people, beds) separate from emergency decisions;
- use UUID primary keys, UTC `timestamptz` timestamps, and explicit enum-like values;
- expose only the minimum patient data needed by each role; and
- remain understandable and implementable by one developer.

This document is a design only. It creates no schema, models, migrations, tables, or SQL.

## 2. Entity review and final recommendation

| Starting entity | Decision | Rationale |
|---|---|---|
| User | Keep | Common authenticated identity and account state. |
| PatientProfile | Keep separate | Optional one-to-one, patient-specific demographic and medical-summary data. |
| EmergencyContact | Keep separate | One patient has many contacts; contacts are not MVP users. |
| MedicalReport | Keep separate | A patient may own many protected report metadata records. |
| Hospital | Keep | Operational organisation and capability boundary. |
| HospitalStaff | Keep, rename `HospitalStaffMembership` | It is the user-to-hospital association, not a second person record. |
| Doctor | Keep separate | Hospital clinical resource; not assumed to be an authenticated user in MVP. |
| Bed | Keep | Hospital capacity unit. |
| Ambulance | Keep | Hospital fleet resource independent of a driver or emergency. |
| DriverProfile | Keep separate | Optional one-to-one driver-specific profile for a user. |
| EmergencyRequest | Keep | The central emergency case, owned by one patient. |
| HospitalResponse | Keep | Preserves every hospital contact/accept/reject attempt. |
| AmbulanceAssignment | Keep | Preserves each dispatch attempt and driver outcome. |
| BedReservation | Keep | Preserves capacity/reservation history; one active reservation is a constraint, not a one-row design. |
| DoctorAssignment | Keep | Preserves optional clinical assignment history. |
| EmergencyStatusHistory | Keep | Immutable transition history, distinct from the current status. |
| Notification | Keep | Records in-app and simulated-contact delivery independently of the emergency state. |

**Final MVP entity count: 17.** No additional MVP entity is required. `MedicalReport` stores its own protected-file metadata initially; introduce a shared `FileAsset` only when multiple upload purposes genuinely need it. Persistent GPS history and a general `AuditLog` are future additions; Socket.IO remains the MVP source for live tracking.

## 3. Conventions

- Every entity has `id UUID` (required, unique, default `gen_random_uuid()` at database level later) unless noted otherwise.
- Every mutable entity has `createdAt timestamptz` (required, default `now()`); selected records also have `updatedAt timestamptz` (required, default `now()`).
- Timestamps are UTC; user-entered dates use `date` where a time is not meaningful.
- `JSONB` is limited to extensible, non-query-critical safe metadata. No password, token, or raw report content is stored in it.
- Status changes are append-only in `EmergencyStatusHistory`; `EmergencyRequest.currentStatus` is a read-efficient current snapshot.

## 4. Final entity attributes

`R` = required, `O` = optional. Unique is `Y` or `N` unless a scoped/conditional rule is stated.

### 4.1 User

| Attribute | Type | R/O | Unique | Default | Purpose |
|---|---|---:|---:|---|---|
| id | UUID | R | Y | generated | Primary key. |
| phone | varchar(20) | R | Y | — | Normalised login/contact number. |
| email | varchar(254) | O | Y when present | — | Optional normalised email. |
| passwordHash | varchar(255) | O | N | — | Reserved for a future authentication design; never returned when present. |
| role | UserRole | R | N | — | PATIENT, DRIVER, HOSPITAL_STAFF, ADMIN. |
| status | UserStatus | R | N | PENDING | Account and verification state. |
| displayName | varchar(120) | R | N | — | Safe operational display name. |
| createdAt, updatedAt | timestamptz | R | N | now() | Record lifecycle. |

### 4.2 PatientProfile

| Attribute | Type | R/O | Unique | Default | Purpose |
|---|---|---:|---:|---|---|
| id | UUID | R | Y | generated | Primary key. |
| userId | UUID FK User | R | Y | — | One profile per patient user. |
| dateOfBirth | date | O | N | — | Age-related care context. |
| gender | varchar(32) | O | N | — | Optional self-described value. |
| bloodGroup | BloodGroup | O | N | — | Optional emergency summary. |
| allergies, medicalSummary | text | O | N | — | Minimum clinical context; access controlled. |
| addressLine, city, state, postalCode | varchar | O | N | — | Optional saved address. |
| createdAt, updatedAt | timestamptz | R | N | now() | Record lifecycle. |

### 4.3 EmergencyContact

| Attribute | Type | R/O | Unique | Default | Purpose |
|---|---|---:|---:|---|---|
| id | UUID | R | Y | generated | Primary key. |
| patientId | UUID FK PatientProfile | R | N | — | Contact owner. |
| name | varchar(120) | R | N | — | Recipient name. |
| relationship | varchar(60) | R | N | — | e.g. parent or spouse. |
| phone | varchar(20) | R | N | — | Simulated delivery destination. |
| isPrimary | boolean | R | N | false | Preferred contact; at most one per patient. |
| createdAt, updatedAt | timestamptz | R | N | now() | Record lifecycle. |

### 4.4 MedicalReport

| Attribute | Type | R/O | Unique | Default | Purpose |
|---|---|---:|---:|---|---|
| id | UUID | R | Y | generated | Primary key. |
| patientId | UUID FK PatientProfile | R | N | — | Report owner. |
| reportType | MedicalReportType | R | N | OTHER | Category for display/access. |
| displayName | varchar(255) | R | N | — | Sanitised display name. |
| storageKey | varchar(512) | R | Y | — | Protected server-side storage reference. |
| mimeType | varchar(100) | R | N | — | Allowlisted content type. |
| sizeBytes | integer | R | N | — | Validated upload size. |
| checksum | varchar(128) | O | N | — | Integrity/deduplication aid. |
| consentStatus | ConsentStatus | R | N | ACTIVE | Whether it may be used for care. |
| createdAt, updatedAt | timestamptz | R | N | now() | Record lifecycle. |

### 4.5 Hospital

| Attribute | Type | R/O | Unique | Default | Purpose |
|---|---|---:|---:|---|---|
| id | UUID | R | Y | generated | Primary key. |
| name | varchar(180) | R | N | — | Organisation name. |
| registrationNumber | varchar(100) | R | Y | — | Simulated verification identifier. |
| phone, email | varchar | R/O | phone N, email Y when present | — | Operational contact data. |
| addressLine, city, state, postalCode | varchar | R | N | — | Service location. |
| latitude, longitude | decimal(9,6) | O | N | — | Matching/map coordinates. |
| capabilities | JSONB | R | N | [] | MVP service/capability list. |
| status | HospitalStatus | R | N | PENDING_VERIFICATION | Verification and availability. |
| createdAt, updatedAt | timestamptz | R | N | now() | Record lifecycle. |

### 4.6 HospitalStaffMembership

| Attribute | Type | R/O | Unique | Default | Purpose |
|---|---|---:|---:|---|---|
| id | UUID | R | Y | generated | Primary key. |
| hospitalId | UUID FK Hospital | R | N | — | Staff organisation. |
| userId | UUID FK User | R | N | — | Staff account. |
| staffRole | HospitalStaffRole | R | N | — | Operational scope. |
| status | MembershipStatus | R | N | ACTIVE | Membership state. |
| createdAt, updatedAt | timestamptz | R | N | now() | Record lifecycle. |

Unique: `(hospitalId, userId)`.

### 4.7 Doctor

| Attribute | Type | R/O | Unique | Default | Purpose |
|---|---|---:|---:|---|---|
| id | UUID | R | Y | generated | Primary key. |
| hospitalId | UUID FK Hospital | R | N | — | Affiliated hospital. |
| name | varchar(120) | R | N | — | Doctor name. |
| registrationNumber | varchar(100) | R | Y | — | Simulated professional identifier. |
| specialty | varchar(100) | O | N | — | Matching/preparation context. |
| status | DoctorStatus | R | N | AVAILABLE | Operational availability. |
| createdAt, updatedAt | timestamptz | R | N | now() | Record lifecycle. |

### 4.8 Bed

| Attribute | Type | R/O | Unique | Default | Purpose |
|---|---|---:|---:|---|---|
| id | UUID | R | Y | generated | Primary key. |
| hospitalId | UUID FK Hospital | R | N | — | Owning hospital. |
| bedCode | varchar(50) | R | N | — | Hospital-local identifier. |
| bedType | BedType | R | N | GENERAL | Care capability. |
| status | BedStatus | R | N | AVAILABLE | Current operational availability. |
| createdAt, updatedAt | timestamptz | R | N | now() | Record lifecycle. |

Unique: `(hospitalId, bedCode)`.

### 4.9 Ambulance

| Attribute | Type | R/O | Unique | Default | Purpose |
|---|---|---:|---:|---|---|
| id | UUID | R | Y | generated | Primary key. |
| hospitalId | UUID FK Hospital | R | N | — | Operating hospital. |
| vehicleNumber | varchar(30) | R | Y | — | Vehicle registration. |
| ambulanceType | AmbulanceType | R | N | BASIC_LIFE_SUPPORT | Capability category. |
| capabilities | JSONB | R | N | [] | MVP equipment/capability list. |
| status | AmbulanceStatus | R | N | AVAILABLE | Current fleet state. |
| createdAt, updatedAt | timestamptz | R | N | now() | Record lifecycle. |

### 4.10 DriverProfile

| Attribute | Type | R/O | Unique | Default | Purpose |
|---|---|---:|---:|---|---|
| id | UUID | R | Y | generated | Primary key. |
| userId | UUID FK User | R | Y | — | One profile per driver user. |
| licenceNumber | varchar(80) | R | Y | — | Simulated licence identifier. |
| verificationStatus | VerificationStatus | R | N | PENDING | Admin review state. |
| availabilityStatus | DriverAvailability | R | N | OFFLINE | Driver work state. |
| createdAt, updatedAt | timestamptz | R | N | now() | Record lifecycle. |

### 4.11 EmergencyRequest

| Attribute | Type | R/O | Unique | Default | Purpose |
|---|---|---:|---:|---|---|
| id | UUID | R | Y | generated | Primary emergency case key. |
| patientId | UUID FK PatientProfile | R | N | — | Requesting patient. |
| requestType | EmergencyType | R | N | SOS | SOS or non-critical request. |
| severity | Severity | R | N | UNKNOWN | Patient/triage severity. |
| currentStatus | EmergencyStatus | R | N | CREATED | Current authoritative lifecycle state. |
| description | text | O | N | — | Patient-provided context. |
| pickupAddress | varchar(500) | O | N | — | Human-readable origin. |
| pickupLatitude, pickupLongitude | decimal(9,6) | O | N | — | Validated coordinates. |
| idempotencyKey | varchar(128) | O | Y | — | Safe SOS retry key. |
| cancelledAt, completedAt, expiresAt | timestamptz | O | N | — | Terminal/expiry timing. |
| createdAt, updatedAt | timestamptz | R | N | now() | Record lifecycle. |

### 4.12 HospitalResponse

| Attribute | Type | R/O | Unique | Default | Purpose |
|---|---|---:|---:|---|---|
| id | UUID | R | Y | generated | Primary key. |
| emergencyId | UUID FK EmergencyRequest | R | N | — | Emergency being offered. |
| hospitalId | UUID FK Hospital | R | N | — | Hospital contacted. |
| attemptNumber | smallint | R | N | 1 | Per-emergency offer sequence. |
| status | HospitalResponseStatus | R | N | PENDING | Offer outcome. |
| rank, estimatedDistanceKm | integer, decimal(8,2) | O | N | — | Matching result captured when this offer is created; immutable historical values, not dynamically recalculated. |
| responseByUserId | UUID FK User | O | N | — | Staff actor, if human response. |
| rejectionReason | text | O | N | — | Required for rejection where applicable. |
| offeredAt, respondedAt, expiresAt | timestamptz | R/O | N | now()/— | Offer and decision timing. |
| createdAt, updatedAt | timestamptz | R | N | now() | Record lifecycle. |

Unique: `(emergencyId, hospitalId, attemptNumber)`.

### 4.13 AmbulanceAssignment

| Attribute | Type | R/O | Unique | Default | Purpose |
|---|---|---:|---:|---|---|
| id | UUID | R | Y | generated | Primary key. |
| emergencyId | UUID FK EmergencyRequest | R | N | — | Emergency served. |
| hospitalResponseId | UUID FK HospitalResponse | R | N | — | Accepting hospital context. |
| ambulanceId | UUID FK Ambulance | R | N | — | Offered vehicle. |
| driverId | UUID FK DriverProfile | R | N | — | Offered driver. |
| attemptNumber | smallint | R | N | 1 | Dispatch sequence per emergency. |
| status | AmbulanceAssignmentStatus | R | N | OFFERED | Offer/driver/journey state. |
| rejectionReason | text | O | N | — | Driver/operational rejection reason. |
| assignedAt, respondedAt, startedAt, endedAt | timestamptz | R/O | N | now()/— | Dispatch timeline. |
| createdAt, updatedAt | timestamptz | R | N | now() | Record lifecycle. |

Unique: `(emergencyId, attemptNumber)`.

### 4.14 BedReservation

| Attribute | Type | R/O | Unique | Default | Purpose |
|---|---|---:|---:|---|---|
| id | UUID | R | Y | generated | Primary key. |
| emergencyId | UUID FK EmergencyRequest | R | N | — | Emergency requiring capacity. |
| hospitalResponseId | UUID FK HospitalResponse | R | N | — | Accepted hospital context. |
| bedId | UUID FK Bed | R | N | — | Reserved bed. |
| status | BedReservationStatus | R | N | RESERVED | Reservation outcome. |
| reservedByUserId | UUID FK User | O | N | — | Staff actor if applicable. |
| reservedAt, expiresAt, releasedAt | timestamptz | R/O | N | now()/— | Capacity timeline. |
| releaseReason | text | O | N | — | Audit reason for expiry/release. |
| createdAt, updatedAt | timestamptz | R | N | now() | Record lifecycle. |

### 4.15 DoctorAssignment

| Attribute | Type | R/O | Unique | Default | Purpose |
|---|---|---:|---:|---|---|
| id | UUID | R | Y | generated | Primary key. |
| emergencyId | UUID FK EmergencyRequest | R | N | — | Emergency receiving care. |
| doctorId | UUID FK Doctor | R | N | — | Assigned doctor. |
| status | DoctorAssignmentStatus | R | N | ASSIGNED | Assignment outcome. |
| assignedByUserId | UUID FK User | O | N | — | Staff actor. |
| assignedAt, releasedAt | timestamptz | R/O | N | now()/— | Assignment history. |
| releaseReason | text | O | N | — | Reassignment/release explanation. |
| createdAt, updatedAt | timestamptz | R | N | now() | Record lifecycle. |

### 4.16 EmergencyStatusHistory

| Attribute | Type | R/O | Unique | Default | Purpose |
|---|---|---:|---:|---|---|
| id | UUID | R | Y | generated | Primary key. |
| emergencyId | UUID FK EmergencyRequest | R | N | — | Emergency changed. |
| fromStatus, toStatus | EmergencyStatus | O, R | N | — | Explicit allowed transition. |
| actorUserId | UUID FK User | O | N | — | Human actor; null for system. |
| actorType | TransitionActorType | R | N | SYSTEM | System/patient/staff/driver/admin. |
| reason | text | O | N | — | Safe business reason. |
| metadata | JSONB | R | N | {} | Minimal safe context/correlation data. |
| occurredAt | timestamptz | R | N | now() | Immutable event time. |

### 4.17 Notification

| Attribute | Type | R/O | Unique | Default | Purpose |
|---|---|---:|---:|---|---|
| id | UUID | R | Y | generated | Primary key. |
| emergencyId | UUID FK EmergencyRequest | R | N | — | Relevant emergency. |
| recipientUserId | UUID FK User | O | N | — | Authenticated in-app recipient. |
| emergencyContactId | UUID FK EmergencyContact | O | N | — | Unauthenticated contact recipient. |
| channel | NotificationChannel | R | N | IN_APP | MVP in-app/simulated delivery channel. |
| type | NotificationType | R | N | — | Operational/status category. |
| status | NotificationStatus | R | N | PENDING | Delivery lifecycle. |
| title | varchar(160) | R | N | — | Safe display title. |
| payload | JSONB | R | N | {} | Minimal authorised data reference. |
| scheduledAt, sentAt, readAt, failedAt | timestamptz | O | N | — | Delivery/read timing. |
| failureReason | text | O | N | — | Safe diagnostic reason. |
| createdAt, updatedAt | timestamptz | R | N | now() | Record lifecycle. |

Constraint: exactly one of `recipientUserId` and `emergencyContactId` is present.

## 5. Keys and relationships

Every `id` above is the primary key. Foreign keys are the attributes labelled `FK`; deletion should generally be restricted for historical emergency data rather than cascaded. The exception is a not-yet-used draft profile/contact where lifecycle rules may later allow a controlled soft deletion.

| Entity A | Entity B | Cardinality | Relationship |
|---|---|---|---|
| User | PatientProfile | 1 — 0..1 | A patient user has one profile. |
| User | DriverProfile | 1 — 0..1 | A driver user has one driver profile. |
| PatientProfile | EmergencyContact | 1 — N | Patient owns contacts. |
| PatientProfile | MedicalReport | 1 — N | Patient owns reports. |
| PatientProfile | EmergencyRequest | 1 — N | Patient creates cases. |
| Hospital | HospitalStaffMembership / Doctor / Bed / Ambulance | 1 — N | Hospital owns operational resources. |
| User | HospitalStaffMembership | 1 — N | Supports future transfers/multiple memberships; MVP permits one active membership. |
| EmergencyRequest | HospitalResponse | 1 — N | Every hospital offer/response is preserved. |
| HospitalResponse | BedReservation | 1 — N | Accepted context can have reservation history. |
| EmergencyRequest | AmbulanceAssignment / DoctorAssignment / BedReservation | 1 — N | Attempts/history are never overwritten. |
| Ambulance / DriverProfile | AmbulanceAssignment | 1 — N | Resources participate in many assignments over time; this is the only driver-to-ambulance association, so drivers are not permanently bound to vehicles. |
| Doctor | DoctorAssignment | 1 — N | Doctor participates in many assignments over time. |
| EmergencyRequest | EmergencyStatusHistory / Notification | 1 — N | Lifecycle and notifications are append-only history. |
| User / EmergencyContact | Notification | 1 — N | Notification has exactly one recipient kind. |

## 6. Recommended enums and constraints

| Area | Recommended values / rules |
|---|---|
| UserRole | `PATIENT`, `DRIVER`, `HOSPITAL_STAFF`, `ADMIN`. |
| UserStatus | `PENDING`, `ACTIVE`, `SUSPENDED`, `DEACTIVATED`, `REJECTED`. |
| HospitalStatus | `PENDING_VERIFICATION`, `VERIFIED`, `TEMPORARILY_UNAVAILABLE`, `SUSPENDED`, `REJECTED`. |
| AmbulanceStatus | `AVAILABLE`, `OFFERED`, `ASSIGNED`, `EN_ROUTE`, `OUT_OF_SERVICE`, `INACTIVE`. |
| BedStatus | `AVAILABLE`, `RESERVED`, `OCCUPIED`, `OUT_OF_SERVICE`. |
| EmergencyStatus | `CREATED`, `SEARCHING_HOSPITAL`, `PENDING_HOSPITAL_RESPONSE`, `HOSPITAL_REJECTED`, `HOSPITAL_ACCEPTED`, `BED_RESERVED`, `AMBULANCE_ASSIGNED`, `PENDING_DRIVER_ACCEPTANCE`, `DRIVER_EN_ROUTE`, `AT_PICKUP`, `TRANSPORTING`, `AT_HOSPITAL`, `ADMITTED`, `COMPLETED`, `CANCELLED`, `ESCALATED`, `EXPIRED`. |
| HospitalResponseStatus | `PENDING`, `ACCEPTED`, `REJECTED`, `EXPIRED`, `WITHDRAWN`. |
| AmbulanceAssignmentStatus | `OFFERED`, `ACCEPTED`, `REJECTED`, `CANCELLED`, `EN_ROUTE`, `AT_PICKUP`, `TRANSPORTING`, `COMPLETED`, `FAILED`. |
| BedReservationStatus | `RESERVED`, `RELEASED`, `EXPIRED`, `CONSUMED`, `FAILED`. |
| DoctorAssignmentStatus | `ASSIGNED`, `RELEASED`, `COMPLETED`, `CANCELLED`. |
| NotificationChannel / Status | Channels: `IN_APP`, `SIMULATED_CONTACT`, future `SMS`, `WHATSAPP`, `PUSH`, `EMAIL`. Status: `PENDING`, `SENT`, `DELIVERED`, `READ`, `FAILED`, `CANCELLED`. |
| BloodGroup | `A_POSITIVE`, `A_NEGATIVE`, `B_POSITIVE`, `B_NEGATIVE`, `AB_POSITIVE`, `AB_NEGATIVE`, `O_POSITIVE`, `O_NEGATIVE`, `UNKNOWN`. |
| MedicalReportType | `PRESCRIPTION`, `LAB_REPORT`, `SCAN`, `DISCHARGE_SUMMARY`, `MEDICAL_HISTORY`, `OTHER`. |
| ConsentStatus | `ACTIVE`, `REVOKED`, `EXPIRED`. |
| HospitalStaffRole | `ADMIN`, `DISPATCHER`, `RECEPTIONIST`, `CLINICAL_COORDINATOR`. |
| MembershipStatus | `ACTIVE`, `SUSPENDED`, `REMOVED`. |
| DoctorStatus | `AVAILABLE`, `BUSY`, `ON_LEAVE`, `INACTIVE`. |
| BedType | `GENERAL`, `ICU`, `EMERGENCY`, `ISOLATION`. |
| AmbulanceType | `BASIC_LIFE_SUPPORT`, `ADVANCED_LIFE_SUPPORT`, `PATIENT_TRANSPORT`. |
| EmergencyType | `SOS`, `AMBULANCE_REQUEST`. |
| Severity | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`, `UNKNOWN`. |
| VerificationStatus | `PENDING`, `VERIFIED`, `REJECTED`. |
| DriverAvailability | `OFFLINE`, `AVAILABLE`, `BUSY`, `ON_BREAK`, `SUSPENDED`. |
| NotificationType | `EMERGENCY_CREATED`, `HOSPITAL_REQUEST`, `HOSPITAL_ACCEPTED`, `HOSPITAL_REJECTED`, `AMBULANCE_ASSIGNED`, `DRIVER_ASSIGNED`, `DRIVER_EN_ROUTE`, `PATIENT_PICKED_UP`, `HOSPITAL_ARRIVAL`, `PATIENT_ADMITTED`, `EMERGENCY_COMPLETED`, `EMERGENCY_CANCELLED`, `GENERAL`. |
| TransitionActorType | `SYSTEM`, `PATIENT`, `HOSPITAL_STAFF`, `DRIVER`, `ADMIN`. |

`EmergencyType` distinguishes an immediate `SOS` from an `AMBULANCE_REQUEST`.
`Severity` independently determines emergency priority; it is not inferred from
`EmergencyType`. `UNKNOWN` is intentionally valid for both `BloodGroup` and
`Severity` when information is unavailable.

Also enforce: unique normalised phone; unique non-null email; valid coordinate ranges; non-negative distances and file sizes; role/profile compatibility; immutable status-history rows; one primary contact per patient; only one active bed reservation per emergency and per bed; only one active assignment per ambulance/driver; and one active hospital acceptance per emergency. These active-only rules should be implemented later with conditional unique indexes and transaction/locking logic.

## 7. Emergency lifecycle representation

```text
SOS -> EmergencyRequest(CREATED)
    -> EmergencyStatusHistory(CREATED -> SEARCHING_HOSPITAL)
    -> HospitalResponse[1..N](PENDING, ranked/offered)
    -> HospitalResponse(ACCEPTED) + history(HOSPITAL_ACCEPTED)
    -> BedReservation(RESERVED) + history(BED_RESERVED)
    -> AmbulanceAssignment[1..N](OFFERED -> ACCEPTED) + history
    -> driver journey: EN_ROUTE -> AT_PICKUP -> TRANSPORTING
    -> history(AT_HOSPITAL -> ADMITTED -> COMPLETED)
```

`EmergencyRequest.currentStatus` is updated in the same transaction as one immutable `EmergencyStatusHistory` row. Hospital, reservation, ambulance, and doctor records explain *why* a transition happened and retain abandoned/rejected attempts.

## 8. Failure scenarios

| Scenario | Representation and response |
|---|---|
| All hospitals reject | Keep all `HospitalResponse(REJECTED)` rows; append `ESCALATED` or `EXPIRED` history, never erase attempts. |
| Accepted hospital has no ambulance | Keep acceptance/reservation; create no assignment or mark a failed attempt, append escalation history, then offer another eligible resource/hospital by policy. |
| Driver rejects | Mark that `AmbulanceAssignment(REJECTED)` with reason; create a later attempt number. |
| Ambulance becomes unavailable | Mark vehicle `OUT_OF_SERVICE`; cancel/fail its active offer atomically and create another assignment attempt. |
| Patient cancels | Set current status `CANCELLED`, append history, release active reservations/assignments with reasons, retain records. |
| Emergency expires | Set `EXPIRED`, expire pending responses/reservations, append system history. |
| Hospital becomes unavailable after accepting | Set hospital status, withdraw/cancel its active response/reservations, record reason, and escalate/re-match. |
| Reserved bed becomes unavailable | Release/fail the reservation with reason; protect consistency by locking the bed/reservation transaction and seek another eligible bed/hospital. |

## 9. Integrity, privacy, and normalization

**Integrity.** Use transactions for hospital acceptance plus bed reservation, ambulance offers, and lifecycle changes. Foreign keys retain referential history. Use optimistic versioning or row locks for bed and ambulance availability. Validate every transition against an allowed state machine; a client never writes a status directly. Index active emergency status, `HospitalResponse(emergencyId, status)`, assignment/resource status, reservation status, and history `(emergencyId, occurredAt)`.

**Privacy.** Treat patient profiles, report metadata/storage keys, contact phones, and emergency coordinates as sensitive. Limit report retrieval to authorised active-care contexts; never store public file URLs, passwords, JWTs, or raw government IDs. Log only safe operational metadata, minimise notification payloads, and retain access/audit design for a later phase. Simulated ID verification stores only review state/evidence reference, not Aadhaar/PAN integration data.

**Normalization.** Users, profiles, contacts, resources, offers, reservations, assignments, and notifications are separate to avoid repeating data or overwriting history. JSONB is limited to evolving capability lists and safe event/payload metadata. Do not copy hospital, ambulance, driver, or doctor details onto `EmergencyRequest`; resolve them through historical child records.

## 10. MVP versus future scope

| MVP | Future version |
|---|---|
| All 17 final entities, protected report metadata, simulated verification, in-app/simulated-contact notifications, live Socket.IO location, and historical operational attempts | `FileAsset` shared upload abstraction, `AuditLog`, durable `LocationPing`/GPS history, push/SMS/WhatsApp delivery adapters, external hospital/bed integrations, verification-provider records, advanced analytics/retention partitions, and AI/insurance/government integrations. |

## 11. ER relationship summary

```text
User 1--0..1 PatientProfile 1--N EmergencyContact
 |                         `--N MedicalReport
 |                         `--N EmergencyRequest 1--N HospitalResponse N--1 Hospital
 |                                              |       `--N BedReservation N--1 Bed N--1 Hospital
 |                                              |       `--N AmbulanceAssignment N--1 Ambulance N--1 Hospital
 |                                              |       |                      `--1 DriverProfile 1--1 User
 |                                              |       `--N DoctorAssignment N--1 Doctor N--1 Hospital
 |                                              |       `--N EmergencyStatusHistory
 |                                              `--N Notification --1 User OR EmergencyContact
 `--N HospitalStaffMembership N--1 Hospital

DriverProfile and Ambulance have no direct relationship. They meet only through
`AmbulanceAssignment`, allowing a verified available driver to operate different
hospital-owned ambulances over time under assignment and availability rules.
```

## 12. Architectural questions and conflicts

1. The architecture names `HospitalStaffMembership`, while the starting list says `HospitalStaff`; this design adopts the membership name because it accurately models the relationship.
2. The architecture mentions `FileAsset`, `AuditLog`, and `LocationPing`. They are sound future seams but are postponed to avoid premature tables; `MedicalReport` and Socket.IO cover the MVP need.
3. Drivers are not permanently bound to ambulances. Ambulances remain hospital-owned; a verified available driver may operate different ambulances over time only through `AmbulanceAssignment` and the applicable availability rules.
