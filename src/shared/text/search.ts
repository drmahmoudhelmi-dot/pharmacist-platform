import { toWesternDigits } from "./digits";

// Arabic-aware normalization for search (database reference, "Arabic
// search"): applied to the stored search column and to every query, so both
// sides compare the same form. Not for display.

const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭ]/g;
const FORMAT = /[؜​-‏‪-‮⁠-⁩﻿]/g;

export function normalizeForSearch(input: string): string {
  return toWesternDigits(input.normalize("NFKC"))
    .replace(DIACRITICS, "")
    .replace(FORMAT, "")
    .replace(/ـ/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
