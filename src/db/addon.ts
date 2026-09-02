/**
 * Switch a paid add-on on or off for one rep.
 *
 *   npm run rep:addon -- dave@example.com on
 *   npm run rep:addon -- dave@example.com off
 *   npm run rep:addon                          (lists every rep and their state)
 *
 * This is the "push a button" for selling morning triage as an add-on. It is
 * deliberately a CLI rather than a self-serve toggle in the app: turning it on
 * starts costing money per run, so a human decides, and the decision is
 * recorded against exactly one rep.
 */
import "dotenv/config";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import { reps } from "./schema";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");

  const pool = new Pool({
    connectionString: url,
    ssl: url.includes("sslmode=require") ? { rejectUnauthorized: true } : undefined,
  });
  const db = drizzle(pool, { schema: { reps } });

  // Row-level security is FORCEd, so even the table owner is subject to it.
  // This CLI is an administrative tool with no user identity, so it runs each
  // statement in an admin-context transaction.
  const admin = <T,>(fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.admin', 'on', true)`);
      return fn(tx);
    });

  const [email, state] = process.argv.slice(2);

  if (!email) {
    const all = await admin((tx) =>
      tx
      .select({
        email: reps.email,
        business: reps.businessName,
        triage: reps.triageEnabled,
      })
      .from(reps)
      .orderBy(reps.createdAt),
    );

    if (all.length === 0) {
      console.log("\nNo reps yet.\n");
    } else {
      console.log("\n  triage  rep");
      console.log("  ------  ---------------------------------------------");
      for (const r of all) {
        console.log(
          `  ${r.triage ? "ON  " : "off "}    ${r.email}  (${r.business})`,
        );
      }
      console.log("");
    }
    await pool.end();
    return;
  }

  if (state !== "on" && state !== "off") {
    console.error(`Usage: npm run rep:addon -- <email> <on|off>`);
    process.exit(1);
  }

  const [updated] = await admin((tx) =>
    tx
      .update(reps)
      .set({ triageEnabled: state === "on" })
      .where(eq(reps.email, email.toLowerCase()))
      .returning({ email: reps.email, triage: reps.triageEnabled }),
  );

  if (!updated) {
    console.error(`No rep with the email ${email}.`);
    process.exit(1);
  }

  console.log(
    `\nMorning triage is now ${updated.triage ? "ON" : "OFF"} for ${updated.email}.\n`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
