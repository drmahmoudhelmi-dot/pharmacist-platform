// Month formatting for experience dates. Dates are first-of-month strings
// (`YYYY-MM-01`) with no time of day, so they are formatted in UTC to avoid
// any time-zone shift.

function utcDate(year: number, month: number) {
  return new Date(Date.UTC(year, month - 1, 1));
}

/** Localized month names, January first. */
export function monthNames(locale: string): string[] {
  const format = new Intl.DateTimeFormat(locale, {
    month: "long",
    timeZone: "UTC",
  });
  return Array.from({ length: 12 }, (_, i) =>
    format.format(utcDate(2000, i + 1)),
  );
}

/** "March 2020" / "مارس ٢٠٢٠" for `2020-03-01`. */
export function formatMonth(locale: string, value: string): string {
  const [year, month] = value.split("-").map(Number);
  if (!year || !month) return value;
  return new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(utcDate(year, month));
}

/** Year and month numbers from `YYYY-MM-01`, for prefilling the edit form. */
export function splitMonth(value: string | null): {
  year: string;
  month: string;
} {
  if (!value) return { year: "", month: "" };
  const [year = "", month = ""] = value.split("-");
  return { year, month: String(Number(month)) };
}
