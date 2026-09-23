/** Pure — a standalone 6-digit run, as every OTP email in this repo's corpus uses. */
const OTP_PATTERN = /\b\d{6}\b/;

export function extractCode(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = OTP_PATTERN.exec(text);
  return match ? match[0] : null;
}
