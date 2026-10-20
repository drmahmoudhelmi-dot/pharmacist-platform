# Frontend, Arabic and RTL quality

Arabic is the primary language; English is supported where needed.

## RTL

- Set `lang` and `dir` on the `<html>` element per locale. `text-align: right` is not RTL support.
- Use logical CSS properties throughout (`margin-inline-start`, `padding-inline-end`, `inset-inline-start`, `text-align: start`) or the framework's RTL variants. No hard-coded left/right.
- Mirror directional icons (arrows, chevrons, back buttons); do not mirror logos, media controls or checkmarks.
- Mixed content: wrap embedded Latin text, numbers, emails, URLs and drug or product names with `dir="auto"` or `<bdi>` so punctuation does not jump.
- Phone numbers, emails and IDs are always displayed LTR (`dir="ltr"`) inside Arabic text.

## Arabic input

- Accept Eastern Arabic digits (٠١٢٣٤٥٦٧٨٩) and Persian digits in every numeric field and normalize to Western digits before validation and storage.
- Egyptian mobile numbers: accept `01XXXXXXXXX`, `+201XXXXXXXXX` and `00201XXXXXXXXX`; valid prefixes 010, 011, 012, 015; store in E.164 (`+201…`).
- Trim and normalize whitespace and tatweel in names; never reject a name for containing Arabic and Latin characters.

## Localization

- All user-facing strings in translation files; no hard-coded Arabic or English in components.
- Localized validation and error messages from the server (error codes mapped to messages), not raw exception text.
- Dates and times formatted in `Africa/Cairo` with the user's locale; relative times ("منذ ٣ ساعات") where helpful.
- Currency shown as EGP with correct grouping.
- Use a font with full Arabic coverage and good weights (e.g. Cairo, IBM Plex Sans Arabic, Noto Sans Arabic); subset and self-host.

## States and feedback

Every screen handles loading, empty, error, success, expired and unauthorized states. Success messages appear only after the server confirms. Destructive actions ask for confirmation. Verification and listing statuses are always visible and clearly worded.

## Accessibility

- WCAG 2.2 AA as the target.
- Labels on every input, associated error messages, `aria-live` for async results.
- Full keyboard operation, visible focus, logical focus order in RTL.
- Contrast at least 4.5:1 for text.
- Touch targets at least 44×44 px.

## Mobile

Most users will be on phones, often on mobile data. Critical journeys (register, verify, search, apply, book a shift, create a listing) must work at 360 px width. Optimize images (responsive sizes, WebP/AVIF), keep JavaScript bundles small, and avoid blocking on third-party scripts.

## Test data

Use realistic but clearly fake test data in development and seed files (marked as such). Never fabricate real-looking credentials, verified users or listings in any environment that real users can see.

Test whole journeys in Arabic RTL on a mobile viewport, not only isolated components.
