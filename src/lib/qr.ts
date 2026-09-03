import QRCode from "qrcode";

/**
 * QR codes for a rep's invite link.
 *
 * Error correction "M" (~15%) rather than the maximum. Nothing covers the
 * symbol, so the extra redundancy would only buy density — more, smaller
 * modules — and this is usually scanned off one phone screen by another, often
 * at an angle or with glare. Fewer, chunkier modules read more easily.
 *
 * If anything is ever laid over the middle again, this has to go back to "H"
 * or it will scan on the phone you tested with and fail on someone else's.
 */
export async function inviteQrSvg(url: string): Promise<string> {
  return QRCode.toString(url, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 1,
    // Rendered at whatever size the page asks for; the SVG scales.
    width: 512,
    color: { dark: "#16191d", light: "#ffffff" },
  });
}

