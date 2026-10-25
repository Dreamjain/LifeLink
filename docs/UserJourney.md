Patient

↓

SOS

↓

Backend

↓

Hospital

↓

Accept

↓

Assign Ambulance

↓

Driver

↓

Patient Pickup

↓

Hospital

↓

Completed

## Patient account decision

A patient registers as `PENDING`, completes profile and emergency-contact onboarding, and waits for
manual review. The patient app may read only the authenticated patient's account status through
`GET /api/v1/auth/patient-status`; `PENDING` remains on the approval screen, `ACTIVE` moves into
the patient emergency app, and `REJECTED` displays a restricted rejection message with no profile,
contact, or emergency routes. A transient status-service failure preserves the pending session
and displays a retryable error. `/api/v1/auth/me` remains active-only, and a correct-password login
for a rejected patient reports rejection without issuing a token.
