/**
 * Turn what staff type into the digits-only international format WhatsApp wants
 * (no "+", e.g. "96171123456"). Defaults to Lebanon (961).
 *
 *   "03 123 456"       -> "9613123456"
 *   "71 123 456"       -> "96171123456"
 *   "+961 71 123 456"  -> "96171123456"
 *   "00961 71 123456"  -> "96171123456"
 *   "+44 7700 900123"  -> "447700900123"
 */
export function normalizePhone(input: string, defaultCountryCode = "961"): string {
  const raw = input.trim();
  let digits = raw.replace(/\D/g, "");
  if (raw.startsWith("+")) {
    // already international
  } else if (digits.startsWith("00")) {
    digits = digits.slice(2);
  } else if (digits.startsWith("0")) {
    digits = defaultCountryCode + digits.slice(1);
  } else if (!digits.startsWith(defaultCountryCode)) {
    digits = defaultCountryCode + digits;
  }
  if (!/^\d{10,15}$/.test(digits)) {
    throw new RangeError(`"${input}" is not a valid phone number`);
  }
  return digits;
}
