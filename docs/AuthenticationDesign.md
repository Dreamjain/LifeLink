# LifeLink Authentication & Authorization Design

## 1. Authentication objectives

LifeLink must identify four authenticated roles—`PATIENT`, `DRIVER`, `HOSPITAL_STAFF`, and `ADMIN`—while protecting emergency and medical information. The MVP uses phone number plus password, bcrypt password hashing, short-lived JWT access tokens, role-based checks, and resource-level policies.

The design prioritises a small, understandable implementation for a student project. Authentication establishes **who** the caller is; authorization establishes **whether** that caller may perform an action on a particular resource. An emergency contact is never an authenticated user in the MVP; it is only a notification recipient.

## 2. Authentication architecture

```text
Client -> Auth boundary -> User lookup -> bcrypt verification
                              |             |
                              v             v
                       account status   issue minimal JWT
                                              |
                                              v
API request -> token validation -> role gate -> resource policy -> use case
```

The future auth mechanism is isolated behind an authentication service interface. Authorization consumes a stable authenticated principal (`userId`, role, token ID, issued/expiry times) rather than relying on a particular login mechanism. This permits a later SMS/WhatsApp OTP or external identity provider without rewriting authorization policies.

## 3. Roles and identity model

| Role | Identity and operational boundary |
|---|---|
| `PATIENT` | Own `PatientProfile`, reports, contacts, requests, tracking, and notifications. |
| `DRIVER` | Own `DriverProfile`, availability, and only current/historical assignments permitted by policy. |
| `HOSPITAL_STAFF` | Hospital-scoped activity through an active `HospitalStaffMembership`. |
| `ADMIN` | System-wide administrative oversight; sensitive operations remain attributable. |

`User` holds `phone`, optional `email`, optional future `passwordHash`, `role`, `status`, and `displayName`. Patient data remains in `PatientProfile`; driver-specific data remains in `DriverProfile`; hospital association remains in `HospitalStaffMembership`. Do not duplicate those attributes in `User`.

## 4. Registration and onboarding strategy

| Role | MVP entry path | Activation condition |
|---|---|---|
| Patient | Self-registration with phone, password, and display name; account starts as `PENDING`. | Required profile and at least one emergency contact are completed, then an administrator performs simulated/manual MVP verification and sets the account to `ACTIVE`. |
| Driver | Registration/application creates a `PENDING` account and a `DriverProfile` with simulated licence details. | Admin verifies driver and changes status to `ACTIVE`; profile verification is `VERIFIED`. |
| Hospital staff | Controlled hospital invitation or hospital-admin-created account; a staff membership is created as `ACTIVE` only after approval. | `User.role = HOSPITAL_STAFF`, user is `ACTIVE`, and an active membership exists. |
| Admin | Controlled creation only by an existing authorised admin or a secure development bootstrap process. | Explicit administrative approval; no public registration. |

Patient self-registration must not allow a caller to choose another role. Patient activation is a manual/simulated administrative workflow: the application checks required profile/contact completeness and basic consistency, then an administrator verifies the submission before setting `User.status` to `ACTIVE`. No Aadhaar, PAN, voter-ID API, SMS OTP provider, or external identity-verification service is used. The MVP must not claim official government-system verification; actual government identity verification is a future integration. Driver registration must not grant dispatch access before approval. Hospital staff membership must be associated with a hospital through controlled onboarding. Admin role assignment is never client-controlled.

## 5. Login strategy

Login accepts normalised phone number and password. The server:

1. validates the request shape and rate-limits the attempt;
2. finds the user by phone without disclosing whether it exists;
3. verifies the password with bcrypt;
4. verifies `User.status = ACTIVE` and role-specific eligibility where required;
5. issues a short-lived access token; and
6. records only safe operational log data (correlation ID, user ID after success, outcome), never a password or token.

For drivers, login may succeed only when the user account is active; dispatch operations additionally require a verified `DriverProfile`. For hospital staff, operational requests additionally require an active membership. This avoids treating login itself as an authorization grant.

## 6. Password security

- Hash passwords with bcrypt using **12 rounds** for the MVP; revisit after measuring the development deployment’s latency.
- Require at least 12 characters and reject commonly compromised or trivially weak passwords where practical. A passphrase is encouraged; do not impose arbitrary composition rules that reduce usability.
- Use bcrypt comparison only; never decrypt or log passwords.
- Accept password fields only in explicit auth/password DTOs. Exclude `passwordHash` from response mappers, logs, events, JWTs, notifications, and error objects.
- On password change, verify the current password (unless a valid reset flow is being used), rehash the new password, and invalidate current authorization where supported.

**MVP reset strategy:** do not claim secure self-service reset until a verified out-of-band channel exists. An authorised administrator may perform a controlled reset after identity verification, requiring the user to change it at next login. A future OTP adapter enables self-service reset without changing authorization policy.

## 7. JWT access-token design

Use a symmetric **HS256** JWT in the MVP with a high-entropy `JWT_SECRET` stored only in environment configuration. HS256 keeps local deployment simple. Move to asymmetric `RS256`/`EdDSA` only when separate signing and verification services or external consumers justify key separation.

| Claim/configuration | Recommendation |
|---|---|
| Algorithm | HS256, explicitly allow-list it during verification. |
| `sub` | Required immutable `User.id` UUID. |
| `role` | Required `UserRole`; a convenience claim, not the only authorization input. |
| `jti` | Required random UUID for traceability and future revocation. |
| `iss` | Required configured issuer, e.g. `lifelink-api`. |
| `aud` | Required configured audience, e.g. `lifelink-clients`. |
| `iat`, `exp` | Issued/expiry timestamps; access token lifetime: **15 minutes**. |
| Header | `Authorization: Bearer <token>` over HTTPS in deployed environments. |

Never place passwords, password hashes, refresh secrets, medical reports, allergy/medical data, government IDs, emergency details, hospital membership, complete permissions, or contact details in a JWT. Current membership, account state, assignment, and ownership are checked at the request/use-case boundary because they can change before token expiry.

## 8. Token lifecycle

### MVP: access token only

The MVP issues a 15-minute access token and does **not** implement refresh tokens. This fits the approved 17-entity schema, which intentionally has no `AuthSession`/refresh-token model, and avoids a false or incomplete revocation design. The client reauthenticates when the token expires.

Logout is client-side token disposal. Server-side immediate revocation is not guaranteed for an already-issued access token; its short expiry bounds exposure. On suspension, deactivation, or password change, future requests must additionally consult current `User.status`; an active account/token mismatch is rejected. Password change also requires the user to log in again.

### Future upgrade path

Add an explicitly approved `AuthSession`/refresh-token persistence model before implementing refresh tokens. Store only a hashed rotating refresh token plus session/device metadata, expiry, revocation time, and user ID. Rotate on refresh, revoke on logout/password change/suspension, and use HttpOnly secure SameSite cookies for web refresh tokens where appropriate. Do not add this model during the current MVP design task.

## 9. Authorization architecture

Authorization is layered:

```text
valid JWT
  -> active account check
  -> role gate
  -> scope/relationship lookup
  -> resource and state policy
  -> permitted use case
```

Route-level guards establish an authenticated principal and broad role eligibility. Use-case policies then inspect ownership, active membership, verified driver profile, active assignment, emergency state, and hospital scope. Never trust a client-supplied `userId`, `hospitalId`, role, or assignment ID as proof of permission.

## 10. Resource-level authorization

| Resource/action | Required policy |
|---|---|
| Patient profile, reports, contacts, requests, notifications | `PatientProfile.userId = principal.sub`; ownership is checked in the query/policy. |
| Emergency tracking | Patient owns the emergency, driver has a permitted assignment, or hospital staff belongs to the applicable hospital; admin has system scope. |
| Driver profile/availability | `DriverProfile.userId = principal.sub`. |
| Driver assignment/emergency pickup data | Assignment `driverId` resolves to principal’s `DriverProfile`, and assignment/state policy permits access. |
| Hospital operations | Principal is `HOSPITAL_STAFF` with active membership for the hospital owning the affected resource or response. |
| Admin operations | `ADMIN` role plus explicit operation policy; destructive changes require confirmation/audit intent. |

This prevents IDOR: fetching `/emergencies/{id}` must evaluate the caller’s relationship to that exact emergency, not merely validate that the caller is logged in.

## 11. Hospital-scoped authorization

```text
Hospital staff user
  -> User.role = HOSPITAL_STAFF and User.status = ACTIVE
  -> active HospitalStaffMembership for hospitalId
  -> target resource belongs to hospitalId
  -> staffRole permits the operation
```

`HospitalStaffMembership.status` must be `ACTIVE`. Hospital-scoped queries must join/filter through membership rather than accepting a hospital ID supplied by the browser. `staffRole` narrows actions: dispatcher coordinates responses/assignments, receptionist handles permitted intake, clinical coordinator handles clinical coordination, and hospital admin performs hospital administration. A staff member cannot read another hospital’s emergency or patient data merely because both users have `HOSPITAL_STAFF` role.

## 12. Driver assignment authorization

Drivers are never permanently associated with ambulances. A driver may view/use an emergency only when `AmbulanceAssignment.driverId` matches their `DriverProfile.id` and the assignment is current or historical access is explicitly permitted. The assignment connects the driver, hospital response, ambulance, and emergency; it is the authoritative scope boundary for pickup and journey data.

Availability changes affect only the caller’s own driver profile. A driver cannot claim, alter, or view another driver’s assignment by changing an assignment ID.

## 13. Patient ownership authorization

All patient-scoped queries begin from the authenticated user’s `PatientProfile`, then constrain the target relation. Examples:

```text
principal.sub -> PatientProfile.userId
  -> EmergencyRequest.patientId
  -> MedicalReport.patientId / EmergencyContact.patientId
```

No endpoint should use an arbitrary patient ID as the sole lookup key. Reports and emergency details require the same ownership check; a predictable UUID is never considered authorization.

## 14. Admin authorization

Admins have system-wide resource scope but still require an authorised operation. Privileged operations—account role/status changes, verification decisions, hospital suspension, and data exports—should require a deliberate confirmation field/action, fresh token validation, safe audit logging in a future audit mechanism, and no self-demotion/deactivation loopholes. Admins do not impersonate patients, staff, or drivers; their actions retain their own identity.

## 15. Authentication and account flows

### Patient registration and login

```text
Patient -> submit phone/password/display name
        -> validate and normalise -> create PATIENT/PENDING
        -> complete required PatientProfile + at least one EmergencyContact
        -> application completeness/consistency checks
        -> simulated/manual administrator verification
        -> successful verification -> User status ACTIVE
        -> no government-ID, SMS OTP, or external identity-provider verification

Client -> login(phone, password) -> validate credentials
       -> find User -> bcrypt compare -> active-status check
       -> issue 15-minute JWT -> authenticated requests
```

### Driver, staff, and admin onboarding

```text
Driver application -> DRIVER/PENDING + DriverProfile/PENDING
                   -> admin verification -> profile VERIFIED, user ACTIVE

Hospital invitation/controlled creation -> HOSPITAL_STAFF user
                                      -> active HospitalStaffMembership -> operational access

Existing authorised admin / secure bootstrap -> ADMIN user -> ACTIVE
```

### Authenticated request, logout, password lifecycle

```text
Client -> Bearer token -> signature/issuer/audience/expiry checks
       -> active account -> role check -> resource policy -> use case

Logout -> client disposes JWT -> no future request can present it
Password change -> verify current password -> bcrypt rehash -> re-login required
Suspension/deactivation -> User.status changes -> next request is denied
```

For password reset, the MVP uses controlled admin reset; future verified OTP enables self-service reset.

## 16. Authorization examples

- A patient reads an emergency only if it joins to that patient’s profile.
- A driver accepts an assignment only if its `driverId` is the caller’s profile and the assignment is in an allowed state.
- A dispatcher acts on a hospital response only if the response’s hospital has an active membership for the caller.
- An admin may verify a driver, but must not use a client-supplied role field to grant themselves elevated access.
- No role alone grants broad patient-record visibility: hospital staff and drivers require active emergency/hospital/assignment context.

## 17. Error handling

Use the existing safe error envelope with a correlation ID. Authentication responses must not reveal whether a phone number exists.

| Code | HTTP status | Meaning |
|---|---:|---|
| `INVALID_CREDENTIALS` | 401 | Incorrect phone/password or non-disclosing login failure. |
| `MISSING_TOKEN` | 401 | Bearer token absent. |
| `MALFORMED_TOKEN` / `INVALID_TOKEN` | 401 | Token cannot be accepted. |
| `TOKEN_EXPIRED` | 401 | Token is validly formed but expired. |
| `INACTIVE_ACCOUNT` | 403 | Suspended, deactivated, rejected, or pending account. |
| `INSUFFICIENT_ROLE` | 403 | Broad role is not permitted. |
| `RESOURCE_ACCESS_DENIED` | 403 | Ownership or scope policy failed. |
| `HOSPITAL_SCOPE_DENIED` | 403 | No active membership for target hospital. |
| `DRIVER_ASSIGNMENT_DENIED` | 403 | Caller lacks the required assignment. |

For sensitive resource lookups, a generic 404 may be used where revealing existence would be harmful; apply it consistently per resource.

## 18. Security considerations

- Rate-limit login/reset attempts by IP and normalised phone; use bounded exponential delay after repeated failures.
- Use bcrypt and never log credentials, tokens, or password hashes.
- Enforce HTTPS in deployment; do not store tokens in logs, URL parameters, or browser local storage where avoidable. Native clients use secure device storage.
- Validate JWT algorithm, signature, issuer, audience, expiry, and subject; do not accept `none` or algorithm confusion.
- Keep access tokens short-lived; the future session model enables robust refresh revocation.
- Re-check current account status and resource relationships to prevent privilege persistence and replay after operational changes.
- Allow-list writable fields in DTOs to prevent role/status/ownership mass assignment.
- Use ownership and hospital/assignment filters in every data access path to prevent IDOR and unauthorised medical access.
- Limit returned medical data by purpose and log sensitive access safely when an audit capability is introduced.

## 19. Future environment configuration

Do not add these variables yet. Future implementation requires at least:

```env
JWT_SECRET=<high-entropy-secret>
JWT_ISSUER=lifelink-api
JWT_AUDIENCE=lifelink-clients
JWT_EXPIRES_IN=15m
BCRYPT_ROUNDS=12
AUTH_LOGIN_RATE_LIMIT_WINDOW_MS=900000
AUTH_LOGIN_RATE_LIMIT_MAX=5
```

Future refresh/session, OTP, and external identity providers add their own secrets and configuration rather than overloading `JWT_SECRET`.

## 20. MVP versus future authentication

| MVP | Future |
|---|---|
| Phone/password, bcrypt-12, 15-minute HS256 access tokens, role plus resource policies, controlled administrative reset, simulated verification | SMS/WhatsApp OTP, self-service reset, rotating refresh tokens and session/device management, secure web refresh cookies, MFA, OAuth, external identity providers, asymmetric signing, token revocation/session dashboards. |

## 21. Recommended API boundary (documentation only)

Future endpoints may be grouped under `/api/v1/auth`: registration/intake, login, logout, password change, reset initiation/completion, and current-session identity. Authentication endpoints issue/validate identity only; domain endpoints invoke authorization policies and must not contain credential logic. Exact API contracts are deliberately deferred.

## 22. Security checklist

- [ ] Secrets are environment-only and never committed.
- [ ] Passwords use bcrypt-12 and are absent from logs/responses/tokens.
- [ ] JWT signature, algorithm, issuer, audience, expiry, and subject are validated.
- [ ] Active account status is rechecked after JWT validation.
- [ ] Every patient/hospital/driver resource is ownership- or scope-filtered.
- [ ] Hospital actions require active membership and appropriate staff role.
- [ ] Driver emergency access requires the caller’s assignment.
- [ ] Admin mutations require explicit authorised operation and safe audit intent.
- [ ] Login/reset responses do not enumerate accounts.
- [ ] Authentication requests are rate-limited and DTOs allow-list fields.

## 23. Open questions

1. Who is authorised to create the first admin in each development/demo environment, and how is that bootstrap credential protected?
2. Which hospital staff roles may access which minimum medical fields during active care?
3. What retention period is appropriate for authentication/security logs in the academic deployment?
4. When refresh tokens are approved, should mobile and web clients have different storage/session policies?
