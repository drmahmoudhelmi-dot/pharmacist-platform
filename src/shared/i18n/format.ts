// Number formatting shared by all modules. Arabic uses ar-EG so digits are
// Arabic-Indic, as in the rest of the Arabic UI (plain "ar" prints Western
// digits).

export const intlLocale = (locale: string) =>
  locale === "ar" ? "ar-EG" : "en-GB";

export function formatCount(value: number, locale: string): string {
  return new Intl.NumberFormat(intlLocale(locale)).format(value);
}
