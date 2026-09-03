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
2. On a device they've used before, they're straight in. On a new one, if
   they've ordered before, a 6-digit code goes to their email first.
3. Add what they need, three ways:
   - **Paste a link** — the app reads the public product page and fills in the
     name, photo and price.
   - **Photo** — snap the shelf label or the old unit and describe it.
   - **Share** — on Android, share a product page straight into the app from
     any browser.
4. Send it through, then watch the status change as the rep works it.

---

## Stack

| Piece    | Choice                                    |
| -------- | ----------------------------------------- |
| Framework| Next.js 15 (App Router), React 19         |
| Database | Neon Postgres via Drizzle ORM             |
| Photos   | Vercel Blob                               |
| Hosting  | Vercel (free tier)                        |
| Auth     | scrypt + HMAC-signed cookies, no extra deps|
| Isolation| Postgres row-level security, fail-closed  |

No CSS framework and no auth library — the surface is small enough that neither
earns its keep, and both are one more thing to keep current.

---

## Environment variables

Copy `.env.example` to `.env.local` for development, and set the same three in
Vercel under **Settings → Environment Variables**.

| Variable                | Required            | What it's for |
| ----------------------- | ------------------- | ------------- |
| `DATABASE_URL`          | Yes                 | Neon connection string — use the **pooled** one (host contains `-pooler`). Any standard Postgres URL works. The role must not be a superuser and must not have `BYPASSRLS`, or row-level security is bypassed; Neon's default role is correct as-is. |
| `SESSION_SECRET`        | Yes                 | Signs the rep and customer session cookies. Any random 32+ character string: `openssl rand -base64 32`. Changing it logs everyone out. |
| `BLOB_READ_WRITE_TOKEN` | Only for photos     | Vercel Blob store token. Vercel injects it automatically once you connect a Blob store to the project. Without it, photo upload returns a friendly "type it in instead" message and everything else works normally. |
| `RESEND_API_KEY` + `EMAIL_FROM` | Only for self-serve reset | Set both and password-reset links are emailed. Leave them unset and reset still works — the link is shown on screen and `npm run rep:reset` prints one. |
| `ANTHROPIC_API_KEY`     | Only for triage     | From [console.anthropic.com](https://console.anthropic.com). Powers the morning triage button. Without it the button says triage isn't set up; nothing else depends on it. This is the only variable that costs money to use — see [Morning triage](#morning-triage). |

---

## Running locally

```bash
npm install
cp .env.example .env.local        # then fill in DATABASE_URL and SESSION_SECRET
npm run db:migrate                # applies everything in ./drizzle
npm run dev                       # http://localhost:3100
```

Other scripts:

```bash
npm run db:generate               # new migration after editing src/db/schema.ts
npm run typecheck
npm test                          # all tests
npm run test:scrape               # scraper parsing + fallback tests
npm run test:triage               # triage reconciliation (incl. the injection case)
npm run test:session              # session token expiry, tampering, revocation
npm run scrape:try -- "<url>"     # try the scraper against a real page
npm run rep:addon                 # list reps / switch the triage add-on
npm run rep:reset -- <email>      # print a password reset link
```

---

## Deploying to Vercel + Neon

1. **Neon** — create a project in **`ap-southeast-2` (Sydney)**, copy the
   **pooled** connection string (the host contains `-pooler`).
2. **Vercel** — import this repo. Next.js is detected; no build config needed.
3. Add `DATABASE_URL` and `SESSION_SECRET` under Settings → Environment
   Variables.
4. **Set the function region to Sydney (`syd1`)** under Settings → Functions.
   This matters more than it looks: row-level security means every request
   opens a transaction and makes two or three round trips to Postgres. With the
   functions in Washington and the database in Sydney, that is three Pacific
   crossings per page load, and the app feels broken rather than merely far
   away. Keep the functions and the database on the same continent.
5. **Storage → Blob** — create a store and connect it to the project. That sets
   `BLOB_READ_WRITE_TOKEN` for you.
6. Optionally add `RESEND_API_KEY` + `EMAIL_FROM` (self-serve password reset,
   and sign-in codes for customers returning on a new device) and
   `ANTHROPIC_API_KEY` (morning triage).
7. Run the migration once against Neon:
   ```bash
   DATABASE_URL="<your neon url>" npm run db:migrate
   ```
8. Deploy, then sign up at `/signup` and copy your invite link from
   **Invite link** in the nav.

Both free tiers cover a single rep comfortably. Nothing here runs on Railway.

### Putting Cloudflare in front

To use a domain you manage in Cloudflare while the app stays on Vercel:

1. Vercel → Settings → Domains → add `orders.yourdomain.com`.
2. In Cloudflare DNS, add the `CNAME` Vercel gives you.
3. Set that record's proxy status to **DNS only** (grey cloud) until the
   certificate is issued, then turn the orange cloud back on if you want
   Cloudflare in the path.
4. If you do proxy through Cloudflare, set SSL/TLS mode to **Full (strict)**.
   "Flexible" would terminate TLS at Cloudflare and talk to Vercel over plain
   HTTP, which breaks the `secure` flag on the session cookies.

This is DNS only — no code changes. Hosting *on* Cloudflare Workers is a
different job: Vercel Blob would become R2, the database driver would move to
Neon's WebSocket pool (raw TCP is not available there, and row-level security
needs a real transaction), and scrypt password hashing would need replacing
with WebCrypto PBKDF2 to fit the Workers CPU budget. That last one is not a
one-way door — `verifyPassword` dispatches on a scheme prefix, so a future
change hashes new passwords with the new scheme and re-hashes old ones on next
login.

---

## Tenant isolation

This is the part that has to hold if the app is sold to more than one rep.

### Row-level security

Every tenant table has an RLS policy, and they are `FORCE`d so the table owner
is subject to them too. Access is decided from a per-transaction setting that
`src/db/scoped.ts` puts in place:

```ts
await asRep(rep.id, (tx) => tx.select().from(customers));      // that rep's book
await asCustomer(customer.id, (tx) => /* ... */);              // that customer only
```

The property worth having is what happens when someone **forgets**. A query
that runs without a scope doesn't leak another rep's rows — it returns nothing
at all, because the policies compare against a setting that is NULL. Isolation
stops depending on every future author remembering a `where` clause.

`customer_notes` has no customer clause in its policy whatsoever. The rep's
private notes are unreadable in a customer context even if some future query
asks for them directly.

> **The database role must not be a superuser, and must not have `BYPASSRLS`.**
> Superusers ignore row-level security completely — policies become decoration.
> Neon's default role is a non-superuser table owner, which is exactly the shape
> these policies are written for (hence `FORCE`). If you ever move to another
> host, check this first: `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE
> rolname = current_user;` must return `f | f`.

Because RLS needs per-transaction session state, the app connects with a pooled
TCP connection rather than Neon's HTTP driver — the HTTP driver sends each
statement independently, so the setting would be gone by the time the query ran.
Use Neon's **pooled** connection string.

### Sessions

The signed cookie payload carries an expiry and a session version, both inside
the signature:

- The server checks `exp` on every request. `maxAge` on a cookie is only a hint
  to the browser, so without this a copied cookie value would be valid forever.
- `reps.session_version` is compared against the version in the token. Bumping
  it invalidates every outstanding cookie for that account at once — that's what
  **Sign out everywhere** on the invite-link page does, and what completing a
  password reset does automatically.

### Customer identity

A customer identifies with a name and a contact — no password, because
after-hours convenience is the product and a low-frequency user on a phone at
11pm will not remember one.

That alone is not proof of identity, though: an invite link is public and a
tradie's email is on the side of their van. So a **6-digit code** is required
when someone identifies as an *existing* customer on a device we don't
recognise. It goes to the email on the account, expires in 10 minutes, and dies
after five wrong guesses.

The friction lands only where the risk is:

| Situation | What happens |
| --------- | ------------ |
| Brand new customer | Straight in — no history to protect yet |
| Returning, same device | Straight in — the year-long cookie |
| Returning, new device | Code to their email first |

Two cases a code can't reach — a customer whose contact is a mobile number, and
a deployment with no email provider — are covered by a **rep-issued sign-in
link**: a button on the customer's page in the dashboard, good for a day. The
rep is vouching for someone they already know, which is the right authority for
it.

There is an end-to-end test that plays the attack out: given only the public
invite link and a customer's email address, it confirms the intruder never
reaches the shop and never sees the order history, pricing, or job address.

### Password reset

`/forgot` issues a single-use token that expires in an hour. Only the token's
SHA-256 hash is stored, so a database dump contains nothing that can be used to
take over an account.

Delivery is pluggable, because the app has to work on free hosting with nothing
else configured:

- **`RESEND_API_KEY` + `EMAIL_FROM` set** → the link is emailed, and reset is
  self-serve.
- **Neither set** → the link is shown on screen for you to pass on, and
  `npm run rep:reset -- dave@example.com https://your-app-url` prints one from
  the command line.

Either way the page reports the same thing whether or not the email matches an
account, so it cannot be used to find out who has one — and a link is only ever
revealed for an address that does.

Completing a reset bumps `session_version`, so every other session for that
account is signed out. That is the point of a reset when someone else may have
had access.

### Changing a password while logged in

**Account** in the dashboard nav has a change-password form and the
sign-out-everywhere control.

Changing a password requires the **current** one. A session cookie alone must
not be enough to lock the real owner out of their own account — that is exactly
what someone with a borrowed laptop would try.

Like a reset, it bumps `session_version` and signs out every other session. The
difference is that the cookie on *this* device is re-issued at the new version,
so the person making the change stays logged in rather than being bounced to
the login page.

### Rate limiting

A fixed-window limiter counted in Postgres (`rate_limits`), not in memory —
serverless instances share no memory, so a per-instance counter caps nothing.

| Action | Limit | Keyed on |
| ------ | ----- | -------- |
| Scraping a URL | 30 / 5 min | customer |
| Photo upload | 20 / 5 min | customer |
| Morning triage | 6 / hour | rep |
| Rep login | 40 / 15 min | IP |
| Rep login | 8 / 15 min | account |
| Password reset request | 5 / 15 min | IP |
| Change password | 10 / 15 min | rep |
| Customer identify | 15 / hour | IP |
| Sign-in code guesses | 12 / 15 min | customer (plus 5 tries per code) |

Login is capped on two axes on purpose. The per-IP limit is generous because a
whole office behind one NAT shares an address, and locking all of them out
because one person mistypes a password is worse than the attack it prevents;
the tight per-account limit is what actually stops someone grinding at a
specific rep. Reset has its own bucket rather than sharing login's — the person
asking for a reset has usually just failed several logins, and must not be
locked out of the remedy by the symptom.

It **fails open**: if the limiter itself errors the request proceeds. That is
the right trade for abuse protection and the wrong one for authorisation, which
is why nothing about access control depends on it.

### What is covered by tests

Fifty-four end-to-end checks run against a real Postgres with RLS active and
the app on a non-superuser role, plus unit tests for the session tokens and the
triage reconciliation. Among them: a second rep gets a 404 and empty lists; a
private note appears in no customer-facing page or raw response; the triage
add-on switch doesn't cross accounts; the scraper limit blocks a flood and one
customer's limit doesn't affect another.

### Still worth knowing

- Photos in Vercel Blob sit at public (unguessable) URLs — anyone holding a URL
  can open it without authenticating.
- Invite slugs are enumerable by design; they are meant to be shared. They
  expose a rep's business name, nothing more.
- Reset links are only as private as the inbox they land in. That is the normal
  trade for email-based reset; the one-hour single-use window limits it.

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

### Selling it as a paid add-on

Triage is **off for every rep by default**. When a rep asks for it and agrees to
pay, switch it on for that one account:

```bash
npm run rep:addon -- dave@example.com on     # switch on
npm run rep:addon -- dave@example.com off    # switch off
npm run rep:addon                            # list every rep and their state
```

The flag lives on the rep row (`reps.triage_enabled`), so it is per-account like
everything else. A rep without it never sees the button, **and** the route
returns `402` if they call it directly — the UI hiding it is presentation, the
route check is the part that can't be bypassed. Switching one rep on has no
effect on any other; that's covered by an end-to-end test.

There is no self-serve billing here. Payment is a conversation, then a command.
That's the right shape while the customer count is small; wire it to Stripe when
signing reps up is something you want to happen without you.

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
