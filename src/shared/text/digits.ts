const EASTERN_ARABIC_ZERO = 0x0660; // ٠
const PERSIAN_ZERO = 0x06f0; // ۰

/** Converts Eastern Arabic (٠-٩) and Persian (۰-۹) digits to Western (0-9). */
export function toWesternDigits(input: string): string {
  return input.replace(/[٠-٩۰-۹]/g, (char) => {
    const code = char.charCodeAt(0);
    const digit =
      code >= PERSIAN_ZERO ? code - PERSIAN_ZERO : code - EASTERN_ARABIC_ZERO;
    return String(digit);
  });
}
