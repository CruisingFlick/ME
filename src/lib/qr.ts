import QRCode from "qrcode";

/**
 * QR codes for a rep's invite link.
 *
 * Error correction is set to "H" (recovers ~30% of the symbol) specifically so
 * the middle can be covered by the rep's badge and still scan. With the default
 * level, punching a hole in the centre would break it on some readers and work
 * on others — the worst kind of bug, because it looks fine on the phone you
 * tested with.
 */
export async function inviteQrSvg(url: string): Promise<string> {
  return QRCode.toString(url, {
    type: "svg",
    errorCorrectionLevel: "H",
    margin: 1,
    // Rendered at whatever size the page asks for; the SVG scales.
    width: 512,
    color: { dark: "#16191d", light: "#ffffff" },
  });
}

/**
 * Initials for the centre badge. Two characters is the most that stays legible
 * at the size the badge can safely be.
 */
export function initialsFor(businessName: string): string {
  const words = businessName
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) return "??";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
