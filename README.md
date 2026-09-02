# Rep Order App

An order-taking app owned by **one salesperson**, not by their employer.

A rep shares a link with their own customers. After hours those customers put
together a list of what they need — by pasting a product link, snapping a photo,
or just typing it in. Next morning the rep opens the dashboard, sees the
requests, and keys them into the store's own system by hand to raise the real
quote.

The app has **no connection to any store's website or systems**. No API, no
integration, no login to anybody's platform. The rep is the bridge between the
two worlds, on purpose. That's what makes the customer list portable: it belongs
to the rep account, and it travels with them.

---

## How it works

**For the rep**

1. Sign up. You get an invite link like `/r/dave-at-trade-supplies`.
2. Send that link to your customers however you already talk to them.
3. Requests land on your dashboard marked **Received**.
4. Work each one: mark it **Quoted**, then **Ordered**, and write a reply the
   customer sees. Keep private notes on customers that they never see.
5. Export the lot — customers, notes, every request and line item — as CSV
   whenever you want.

**For the customer**

1. Tap the rep's link, put in a name and an email or mobile. No password, no
   account. The device remembers them for a year.
2. Add what they need, three ways:
   - **Paste a link** — the app reads the public product page and fills in the
     name, photo and price.
   - **Photo** — snap the shelf label or the old unit and describe it.
   - **Share** — on Android, share a product page straight into the app from
     any browser.
3. Send it through, then watch the status change as the rep works it.

---

## Stack

| Piece    | Choice                                    |
| -------- | ----------------------------------------- |
| Framework| Next.js 15 (App Router), React 19         |
| Database | Neon Postgres via Drizzle ORM             |
| Photos   | Vercel Blob                               |
| Hosting  | Vercel (free tier)                        |
| Auth     | scrypt + HMAC-signed cookies, no extra deps|

No CSS framework and no auth library — the surface is small enough that neither
earns its keep, and both are one more thing to keep current.

---

## Environment variables

Copy `.env.example` to `.env.local` for development, and set the same three in
Vercel under **Settings → Environment Variables**.

| Variable                | Required            | What it's for |
| ----------------------- | ------------------- | ------------- |
| `DATABASE_URL`          | Yes                 | Neon connection string. Use the **pooled** one from the Neon dashboard. Any standard Postgres URL works too — the app picks Neon's HTTP driver or a normal TCP pool based on the host. |
| `SESSION_SECRET`        | Yes                 | Signs the rep and customer session cookies. Any random 32+ character string: `openssl rand -base64 32`. Changing it logs everyone out. |
| `BLOB_READ_WRITE_TOKEN` | Only for photos     | Vercel Blob store token. Vercel injects it automatically once you connect a Blob store to the project. Without it, photo upload returns a friendly "type it in instead" message and everything else works normally. |
| `ANTHROPIC_API_KEY`     | Only for triage     | From [console.anthropic.com](https://console.anthropic.com). Powers the morning triage button. Without it the button says triage isn't set up; nothing else depends on it. This is the only variable that costs money to use — see [Morning triage](#morning-triage). |

---

## Running locally

```bash
npm install
cp .env.example .env.local        # then fill in DATABASE_URL and SESSION_SECRET
npm run db:migrate                # applies everything in ./drizzle
npm run dev                       # http://localhost:3000
```

Other scripts:

```bash
npm run db:generate               # new migration after editing src/db/schema.ts
npm run typecheck
npm test                          # all tests
npm run test:scrape               # scraper parsing + fallback tests
npm run test:triage               # triage reconciliation (incl. the injection case)
npm run scrape:try -- "<url>"     # try the scraper against a real page
```

---

## Deploying to Vercel + Neon

1. **Neon** — create a project, copy the pooled connection string.
2. **Vercel** — import this repo. Next.js is detected; no build config needed.
3. Add `DATABASE_URL` and `SESSION_SECRET` as environment variables.
4. **Storage → Blob** — create a store and connect it to the project. That sets
   `BLOB_READ_WRITE_TOKEN` for you.
5. Run the migration once against the Neon database:
   ```bash
   DATABASE_URL="<your neon url>" npm run db:migrate
   ```
6. Deploy, then sign up at `/signup` and grab your invite link from
   **Invite link** in the nav.

Both free tiers cover a single rep comfortably. Nothing here runs on Railway.

---

## Data model

Everything hangs off `rep_id`. That's the portability guarantee — a rep's entire
world is one predicate away, which is exactly what the CSV export does.

```
reps ──┬── customers ──┬── customer_notes   (rep-only, never customer-visible)
       │               ├── favourites
       │               └── requests ── request_items
       └── requests
```

A request's status runs `draft → received → quoted → ordered`, with `declined`
available at any point. `draft` is the customer's live basket: it is never shown
to the rep, and submitting is what flips it to `received`. **Reorder** clones a
past request's items into a fresh draft.

Prices are stored as **text**, not numeric. Scraped prices are messy — `From
$899`, `$1,299.00 inc GST` — and rounding them into a decimal column would
invent precision the source never had.

---

## The URL scraper

`src/lib/scrape.ts` fetches the public HTML of a pasted page and reads, in
order of preference:

1. **JSON-LD** `Product` schema — including inside `@graph` and nested arrays.
2. **Open Graph** and Twitter card tags, plus `product:price:*`.
3. The plain `<title>` as a last resort.

It reads the same public page a customer sees when they open the link
themselves. It never touches an API, never logs in anywhere, and never goes
behind an authentication wall.

**It degrades rather than fails.** `scrapeProduct()` never throws and never
returns null. Blocked by the site, timed out, not HTML, no usable tags — every
path still returns the original URL with `degraded: true` and a plain-English
reason, and the customer types a title and carries on with the link attached. A
scrape that doesn't work is a slightly worse item card, never a dead end.

It also refuses to fetch loopback and private-range addresses, since customers
supply the URL.

---

## Morning triage

The rep dashboard has a **Run morning triage** button. It takes every request
still sitting in **Received** that hasn't been triaged, sends them to Claude in
one batch, and writes back a one-line summary and a priority for each. The
inbox then sorts highest-priority first, so the ones needing a judgment call —
an open "Milwaukee or Makita?", a stated deadline, an item described only by a
photo — surface above the straightforward lists.

It is deliberately manual. A rep taps it when they sit down with a coffee.
Putting it on a schedule is a small change once the flow has earned its keep.

**Triage never changes a request's status.** Status is what the *customer*
sees, and "Triaged" would mean nothing to them while hiding the fact that their
request is still Received. Triage writes to its own columns
(`triage_summary`, `triage_priority`, `triaged_at`) and the customer never sees
any of it.

**What gets sent to the API.** Only what's needed to write a useful summary:
the customer's *name*, the request message, and the line items. Not their email
or phone, and **never the rep's private notes** — those don't leave the
database. Worth knowing this is customer data going to a third-party API, and
worth telling a rep that plainly before they switch it on.

**What it costs.** A batch of 10 overnight requests is roughly 3K input and 600
output tokens — about **2-3 cents a morning**, call it **$1 a month** for one
rep. Even a heavy night of 40 requests (the per-run cap) lands under 15 cents.
It runs only when the button is pressed, and only over requests not already
triaged, so re-tapping it is free. This is the one part of the app that isn't
on a free tier.

**Model output is never trusted as a database key.** The prompt contains
customer-written text, and the model echoes request ids back. Those ids are
checked against the exact set of rows fetched for that rep before anything is
written, and the update is scoped by `rep_id` at the database as well. Without
that, text a customer typed into an item note could steer a write onto someone
else's request. `npm run test:triage` covers this case directly.

If triage fails for any reason — no API key, API error, a refusal — the inbox
is left exactly as it was and the rep is told so. Nothing is half-written.

---

## Known limitations

These are real. Don't let anyone promise otherwise.

- **Share target is Android-only.** `share_target` is implemented by Chrome on
  Android, not by iOS Safari — Apple doesn't support the Web Share Target API.
  iPhone customers use paste or photo instead, and the UI never offers them a
  share option that won't work.
- **Scraping depends on the target site.** It works when a site publishes OG or
  JSON-LD tags and doesn't block unfamiliar clients. Expect some retailer pages
  to fill in perfectly and others to fall back to a bare link. Check any
  specific site with `npm run scrape:try -- "<url>"` before relying on it.
- **Photos need Vercel Blob.** Without `BLOB_READ_WRITE_TOKEN` the photo method
  tells the customer to type it in instead. It doesn't break anything else.
- **No store connection, by design.** The rep re-keys quotes into the store's
  system themselves. That's the point of the app, not a missing feature.
- **Triage quality is unverified against real requests.** The plumbing is
  tested, but no summary has been generated from a live API call yet — that
  needs a key and a few real overnight requests. Expect to tune the prompt in
  `src/lib/triage.ts` once a rep has read a week of its summaries and can say
  what it over- and under-flags.
- **The scraper attributes prices to a moment in time.** A scraped price is what
  the page said when it was pasted. It is not a quote, and the app never shows
  it as one.

---

## A note on data portability

Technically, everything here belongs to the rep account and exports in one
click. Whether a rep is *contractually* allowed to keep customer details after
changing employers is a separate question, and it depends on their employment
agreement. Worth checking before leaning on the portability angle.
