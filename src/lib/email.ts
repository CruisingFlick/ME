import "server-only";

/**
 * Email delivery, optional by design.
 *
 * The app has to work on free hosting with nothing else configured, so email is
 * pluggable rather than required:
 *
 *  - `RESEND_API_KEY` + `EMAIL_FROM` set → the message is sent, and password
 *    reset is self-serve.
 *  - neither set → nothing is sent and the caller is told so, so it can fall
 *    back to handing the link over by another route (see `npm run rep:reset`).
 *
 * Called over plain fetch rather than an SDK — it's one endpoint, and it keeps
 * the dependency list short.
 */

export type DeliveryResult =
  | { delivered: true }
  | { delivered: false; reason: "not-configured" | "failed" };

export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  text: string;
}): Promise<DeliveryResult> {
  if (!emailConfigured()) return { delivered: false, reason: "not-configured" };

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM,
        to: [opts.to],
        subject: opts.subject,
        text: opts.text,
      }),
    });

    return res.ok ? { delivered: true } : { delivered: false, reason: "failed" };
  } catch {
    return { delivered: false, reason: "failed" };
  }
}

export function resetEmailBody(name: string, link: string): string {
  return [
    `Hi ${name},`,
    "",
    "Someone asked to reset the password on your Rep Order App account.",
    "Open this link to choose a new one:",
    "",
    link,
    "",
    "The link works once and expires in an hour.",
    "",
    "If this wasn't you, ignore this email — nothing has changed, and your",
    "current password still works.",
  ].join("\n");
}
