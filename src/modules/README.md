# Modules

Each module owns its tables and exposes services; other modules call those services, never its tables (ADR-001 section 2). Directories are created when a module gets its first real code.

- `identity`: users, sessions, roles, MFA. Milestone 1 (step 2, ADR-002). `auth-config.ts` (Better Auth setup), `auth.ts` (server instance), `schema.ts` (tables), `policy.ts` (`getActor`, `can`, `requireActor`, `requireStaff`), `roles-service.ts` and `cli/role-admin.ts` (staff roles), `rate-limit.ts` (per-email limits), `export.ts` (identity part of the data export), `ui/` (auth forms).
- `profiles`: public profile, private professional details, experience, governorate reference data. Milestone 1 (step 3, ADR-003). `schema.ts` (tables), `constants.ts` (allowed values, limits), `policy.ts` (`can` for `profile.read`, `profile.update`, `professionalDetails.read`, `professionalDetails.update`, reusing identity's Actor), `validation.ts` (Zod parsing shared by forms and services, error codes), `service.ts` (all database access; owner ids only from the Actor; `getProfileForViewer` applies visibility; `exportOwnData`), `actions.ts` (server actions), `ui/` (owner forms, member view).
- `verification`: submissions, review queue, decisions, document access log. Milestone 1.
- `organizations`: pharmacies and chains, membership. Milestone 1.
- `jobs`: jobs and applications, including manager recruitment. Milestone 1.
- `shifts`: shift coverage and booking. Milestone 2.
- `listings`: pharmacy sale and rental listings. Milestone 3.
- `billing`: subscriptions and payments. Milestone 3.
- `notifications`: channels, preferences, outbox. Milestone 1 (email), extended later.
- `admin`: moderation queues and audit log. Milestone 1.
