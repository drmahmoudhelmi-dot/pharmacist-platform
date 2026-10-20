# Modules

Each module owns its tables and exposes services; other modules call those services, never its tables (ADR-001 section 2). Directories are created when a module gets its first real code.

- `identity`: users, sessions, roles, MFA. Milestone 1.
- `profiles`: public and professional profiles. Milestone 1.
- `verification`: submissions, review queue, decisions, document access log. Milestone 1.
- `organizations`: pharmacies and chains, membership. Milestone 1.
- `jobs`: jobs and applications, including manager recruitment. Milestone 1.
- `shifts`: shift coverage and booking. Milestone 2.
- `listings`: pharmacy sale and rental listings. Milestone 3.
- `billing`: subscriptions and payments. Milestone 3.
- `notifications`: channels, preferences, outbox. Milestone 1 (email), extended later.
- `admin`: moderation queues and audit log. Milestone 1.
