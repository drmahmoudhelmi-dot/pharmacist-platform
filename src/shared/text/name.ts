const TATWEEL = /ـ/g;

/**
 * Normalizes a person's name: removes tatweel (kashida), collapses runs of
 * whitespace to one space and trims. Arabic and Latin characters are kept as-is.
 */
export function normalizeName(input: string): string {
  return input.replace(TATWEEL, "").replace(/\s+/g, " ").trim();
}
