/**
 * Issue a password reset link for a rep from the command line.
 *
 *   npm run rep:reset -- dave@example.com
 *
 * For when no email provider is configured, or a rep can't get into the inbox
 * on the account. Hand the printed link over however you already talk to them;
 * it works once and expires in an hour.
 */
import "dotenv/config";
import { createResetToken } from "../lib/password-reset";

async function main() {
  const email = process.argv[2];
  const base = process.argv[3] ?? process.env.APP_URL ?? "http://localhost:3000";

  if (!email) {
    console.error("Usage: npm run rep:reset -- <email> [https://your-app-url]");
    process.exit(1);
  }

  const issued = await createResetToken(email);
  if (!issued) {
    console.error(`No rep with the email ${email}.`);
    process.exit(1);
  }

  console.log(`\nReset link for ${issued.name} — works once, expires in 1 hour:\n`);
  console.log(`  ${base}/reset/${issued.token}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
