# Database and data integrity

Inspect the existing schema and migration history before any change.

## Modelling rules

- Explicit primary keys (UUID or bigint, follow the project) and foreign keys with deliberate `ON DELETE` behavior.
- Uniqueness constraints for business rules: one application per user per job, one active subscription per account, one verification record per credential.
- `NOT NULL` and `CHECK` constraints for required fields and allowed values. Status columns use an enum or a check constraint, and transitions are enforced in one service function per entity.
- Frontend validation is a convenience; integrity lives in the database and the server.
- Critical multi-step operations run in a transaction.
- Protect against duplicate processing with idempotency keys on webhooks, payments and notification sends.
- Soft delete only where there is a reason (audit, restore); otherwise delete, and handle personal-data deletion explicitly.
- Every table that holds user data has `created_at` and `updated_at`; tenant- or owner-scoped tables carry the owner column and an index on it.

## Money

- Store amounts as integer minor units (piasters) or `numeric` with a currency column (`EGP`). Never floating point.
- Payments and subscription events are append-only ledgers; current state is derived or updated in the same transaction.

## Time

- Store all timestamps as `timestamptz` in UTC. Display in `Africa/Cairo`.
- Egypt reinstated daylight saving time in 2023, so never hard-code a +02:00 offset. Use the IANA zone for all date arithmetic, shift start and end times, and listing expiry.
- Shifts store a `tstzrange` (or start/end pair) and are protected from overlap with an exclusion constraint (`btree_gist`) where double booking must be impossible.

## Locations

- Use a reference table of governorates, cities and districts (Arabic and English names) rather than free text, so area search and filters work.
- Store coordinates only when needed; add PostGIS when distance search becomes a validated requirement.

## Arabic search

- Search on a normalized column maintained by the application or a generated column: remove diacritics and tatweel, unify alef forms (أ إ آ ٱ → ا), ة → ه, ى → ي, ؤ → و, ئ → ي, and convert Eastern Arabic digits to Western.
- Apply the same normalization to the query string.
- Use `pg_trgm` GIN indexes for fuzzy matching and PostgreSQL full-text search for multi-word queries; combine with structured filters (governorate, role, status, date).
- This scales well past the first-year targets. Consider a dedicated search engine only when measured latency or relevance requires it.

## Queries and pagination

- Index from real query patterns: filters, sort keys and foreign keys. Composite indexes match the filter-then-sort order. Partial indexes for `status = 'published'` style queries.
- Keyset (cursor) pagination for feeds and large lists; offset pagination only for small admin tables.
- Check for N+1 queries in list endpoints. Use `EXPLAIN ANALYZE` on new heavy queries.
- Set statement timeouts on the application role.

## Migration safety

For every meaningful migration:

1. Explain the change.
2. Inspect existing data and dependencies.
3. Assess compatibility with the currently running application version.
4. Define any backfill and run it in batches.
5. Test the migration on a copy of realistic data where possible.
6. Define rollback or forward-recovery.
7. Identify locking, downtime and data-loss risks.

- Prefer additive, staged migrations (expand, migrate, contract): add nullable column, deploy code that writes both, backfill, switch reads, then drop in a later release.
- Create indexes concurrently on large tables. Avoid long-held locks on hot tables.
- Never delete columns, tables or records just to make a migration pass.
- Never run a destructive production migration without explicit authorization and a verified backup.
- Migrations are committed, reviewed and run by the deployment pipeline, not by hand.

## Database roles

- The application connects with a least-privilege role (no superuser, no DDL at runtime).
- Migrations run with a separate role.
- Analytics and reporting read from a read replica or a restricted read-only role, never with the application's write credentials.
