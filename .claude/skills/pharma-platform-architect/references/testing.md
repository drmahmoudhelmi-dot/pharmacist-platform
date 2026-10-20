# Testing strategy

Choose tests by business and security risk. Test behavior, not implementation details likely to change.

## Unit tests

Isolated business rules: state transitions, eligibility rules, price and entitlement calculations, national ID and phone validation, Arabic normalization, date handling across DST.

## Integration tests

Against a real PostgreSQL (container or test database), not mocks: data access, constraints, transactions, migrations, API contracts, authorization, webhook handling, and third-party boundaries with recorded or sandbox responses.

## End-to-end tests

Critical journeys in Arabic RTL on a mobile viewport:

- Registration, login, MFA for admins
- Profile completion
- Verification submission and reviewer decision
- Job search and application
- Shift booking and cancellation
- Listing creation, moderation and publication
- Subscription activation from a sandbox payment

## Regression tests

For every reproducible bug, add a test that fails before the fix and passes after, where practical.

## Security tests

For every protected endpoint:

- Unauthenticated request is rejected.
- Another user's or organization's resource is rejected (IDOR / broken object-level authorization).
- A user cannot escalate role, verification status or subscription state through the API.
- Forbidden state transitions are rejected.
- Private files are not reachable without a fresh signed URL and an authorized user; expired URLs fail.
- Uploads with wrong content type, oversized files or disguised executables are rejected.
- Rate limits trigger on login, OTP, messaging and listing creation.
- Webhooks with missing or invalid signatures are rejected; replayed events do not double-process.
- Responses and logs contain no national IDs, document URLs, tokens or stack traces.

Run dependency and secret scanning in CI. Before launch and after major changes, run an external penetration test or at least an OWASP ZAP baseline scan against staging.

## Concurrency tests

Simultaneous booking of the same shift, simultaneous duplicate applications and duplicate webhook delivery each produce exactly one result.

## Performance tests

Load-test search, listing pages and application submission against the targets in SKILL.md section 5 before launch and before marketing pushes, using production-like data volume.

## Rules

- Tests run in CI on every pull request; the main branch stays green.
- Never mark a test skipped or delete it to get green; fix it or report it.
- Never claim a test passed that was not run. Report the exact command and result.
