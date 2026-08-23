# URL shortener

Build a small HTTP service that shortens URLs.

## Requirements

- `POST /links` accepts `{ "url": "https://..." }` and returns `{ "slug": "abc123", "short_url": "..." }`.
- `GET /:slug` redirects (302) to the original URL, or returns 404 if the slug is unknown.
- `GET /health` returns `{ "ok": true }`.
- Slugs are 6 characters, URL-safe, and collision-checked before use.
- Reject anything that is not an absolute http/https URL with a 400 and a useful message.

## Constraints

- Node 20+, TypeScript, no web framework beyond the standard library or Express.
- Persistence through Postgres if a `DATABASE_URL` is present, otherwise an in-memory map.
- Tests must run with `npm test` and cover slug generation, validation and the redirect path.
- No secrets in the repository.
