# ADR-003: Profiles (milestone 1, step 3)

- Status: Accepted
- Date: 2026-10-20
- Deciders: principal engineer (delegated authority; product owner informed)

## Context

Pharmacists, students and graduates need a profile that employers can find and read, plus private details used later for applications. The skill requires separate storage for public profile and private professional data, data minimization with a purpose per field, reference tables for locations, and owner-only edits. Verification (national ID, syndicate card) is step 4; organizations (pharmacy owners) are step 5; CV upload needs file storage and comes with step 4's storage work.

## Decision

### Data model (module `profiles`, owns these tables)

| Table | Fields (purpose) | Visibility |
|---|---|---|
| `profile` | `id` uuid (public identifier, not the auth user id), `user_id` unique FK → user ON DELETE CASCADE, `display_name` (how others see you), `headline` (short professional title), `bio` (≤ 1,000 chars), `career_stage` CHECK in `student`, `graduate`, `pharmacist` (matching to jobs), `years_experience` 0–60 (matching), `governorate_id` FK (area search), `specialties` text[] limited to a fixed list (community, hospital, clinical, industry, medical rep, regulatory, other), `open_to_work` boolean, `visibility` CHECK in `members`, `hidden` (default `members`), timestamps | Signed-in members when `visibility = members`; owner always |
| `professional_details` | `user_id` PK FK → user ON DELETE CASCADE, `phone_e164` (contact by employers after an application, step 6), `university`, `graduation_year` (eligibility for roles), timestamps | Owner only in step 3 |
| `experience` | `id`, `user_id` FK ON DELETE CASCADE, `title`, `employer_name`, `start_month`, `end_month` nullable (null = current), CHECK end ≥ start, max 30 entries per user enforced in the service, timestamps | Same as the profile |
| `governorate` | `id` smallint, `code`, `name_ar`, `name_en` | Reference data, seeded by migration with Egypt's 27 governorates |

Not collected: date of birth, gender, photo, home address. The national ID, syndicate number and documents belong to verification (step 4). Cities and districts come later from a verified source; governorate alone covers year-one search.

### Rules

- A profile row is created on first save, not at sign-up. Pages show an empty state until then.
- Only the owner reads or edits their professional details and edits their profile and experience. `user_id` always comes from the session, never from input.
- Public reads go through one service function that applies visibility: a `hidden` profile is visible only to its owner; there is no anonymous (internet-public) profile at launch.
- Profiles show the verification badge from step 4 once it exists; nothing in step 3 claims a user is verified.
- Inputs: names trimmed and normalized (tatweel removed, Arabic and Latin both allowed), phone through the Egyptian mobile normalizer, Arabic and Persian digits accepted in every numeric field, server-side Zod validation with localized error codes.
- Data rights: the owner can download their account and profile data as JSON from the account page. Account deletion waits for counsel's retention answer (data-protection status, question 6).

### Policy actions

`profile.read` (visibility rule), `profile.update` and `professionalDetails.read` / `.update` (owner only), via a `can()` in the profiles module that reuses the identity Actor.

## Alternatives considered

- One wide profile table with private columns: rejected; the skill requires public and private data apart, and it makes accidental exposure in a public query likely.
- Internet-public profiles for search engines: rejected for launch; exposes pharmacists' data to scraping before counsel has reviewed it. Job posts, not people, are the search-engine surface.
- Free-text location: rejected; breaks area filters.

## Consequences

- Employers in step 6 search on governorate, career stage, specialties and experience without touching private data.
- Adding photos later needs the file pipeline (re-encode, strip metadata, scan).
- Reversibility: high; new tables only.

## Revisit when

- Counsel answers retention and deletion questions (add account deletion).
- City-level search is requested (add cities from a verified dataset).
- Employers ask for internet-public profiles (privacy review first).
