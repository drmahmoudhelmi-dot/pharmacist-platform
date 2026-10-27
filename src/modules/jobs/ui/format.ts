// Display helpers shared by the job pages (pure, usable in server and client
// components). Dates in Africa/Cairo; numbers and currency in the user's
// locale (Arabic-Indic digits in Arabic).

import { formatCount, intlLocale } from "@/shared/i18n/format";

export function dateTimeFormat(locale: string) {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    dateStyle: "medium",
    timeZone: "Africa/Cairo",
  });
}

/** A `YYYY-MM-DD` calendar date (no time zone shift). */
export function formatCalendarDate(value: string, locale: string): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

export function formatPounds(pounds: number, locale: string): string {
  return new Intl.NumberFormat(intlLocale(locale), {
    style: "currency",
    currency: "EGP",
    maximumFractionDigits: 0,
  }).format(pounds);
}

export { formatCount };
