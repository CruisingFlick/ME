/**
 * Scraper tests. Run with: npm run test:scrape
 *
 * The fixtures mirror the tag shapes real Australian tool retailers ship —
 * JSON-LD Product blocks, Open Graph pairs, and the messier variants — so the
 * parsing rules can be checked without depending on a live site being up,
 * reachable, or unchanged.
 */
import assert from "node:assert/strict";
import { parseProductHtml, scrapeProduct } from "./scrape";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ok   ${name}`);
    })
    .catch((err) => {
      failed++;
      console.log(`  FAIL ${name}`);
      console.log(`       ${err instanceof Error ? err.message : String(err)}`);
    });
}

const URL_UNDER_TEST =
  "https://sydneytools.com.au/product/makita-dhp484z-18v-brushless-hammer-driver-drill";

/* --------------------------------------------------------------------------
 * 1. A page with a full JSON-LD Product block — the good case.
 * ----------------------------------------------------------------------- */
const JSON_LD_PAGE = `<!doctype html><html><head>
<title>Makita DHP484Z 18V Brushless Hammer Driver Drill | Sydney Tools</title>
<meta property="og:title" content="Makita DHP484Z 18V Hammer Drill">
<meta property="og:image" content="https://cdn.example.com/img/dhp484z.jpg">
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Product",
  "name": "Makita DHP484Z 18V 13mm Brushless Hammer Driver Drill (Tool Only)",
  "image": ["https://cdn.example.com/img/dhp484z-large.jpg"],
  "sku": "DHP484Z",
  "offers": {
    "@type": "Offer",
    "price": "229.00",
    "priceCurrency": "AUD",
    "availability": "https://schema.org/InStock"
  }
}
</script>
</head><body></body></html>`;

/* --------------------------------------------------------------------------
 * 2. Open Graph only, no JSON-LD — very common.
 * ----------------------------------------------------------------------- */
const OG_PAGE = `<!doctype html><html><head>
<title>Some Shop</title>
<meta property="og:title" content="Milwaukee M18 FUEL 125mm Angle Grinder">
<meta content="https://cdn.example.com/grinder.png" property="og:image">
<meta property="product:price:amount" content="399">
<meta property="product:price:currency" content="AUD">
</head><body></body></html>`;

/* --------------------------------------------------------------------------
 * 3. @graph nesting + a malformed JSON-LD block before the good one.
 * ----------------------------------------------------------------------- */
const GRAPH_PAGE = `<!doctype html><html><head>
<script type="application/ld+json">{ this is not valid json ,,, }</script>
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
  {"@type":"BreadcrumbList","itemListElement":[]},
  {"@type":["Product","Thing"],
   "name":"DeWalt DCF887 Impact Driver",
   "image":{"@type":"ImageObject","url":"/media/dcf887.jpg"},
   "offers":[{"@type":"Offer","price":"249.00","priceCurrency":"AUD"}]}
]}
</script>
</head><body></body></html>`;

/* --------------------------------------------------------------------------
 * 4. A page with nothing usable at all — must degrade.
 * ----------------------------------------------------------------------- */
const BARE_PAGE = `<!doctype html><html><head></head><body><p>Access denied</p></body></html>`;

async function main() {
  console.log("\nparseProductHtml");

  await test("reads title, image and price from a JSON-LD Product", () => {
    const r = parseProductHtml(JSON_LD_PAGE, URL_UNDER_TEST);
    assert.equal(r.degraded, false);
    assert.equal(
      r.title,
      "Makita DHP484Z 18V 13mm Brushless Hammer Driver Drill (Tool Only)",
    );
    assert.equal(r.imageUrl, "https://cdn.example.com/img/dhp484z-large.jpg");
    assert.equal(r.price, "$229.00");
    assert.equal(r.sourceUrl, URL_UNDER_TEST);
  });

  await test("falls back to Open Graph when there is no JSON-LD", () => {
    const r = parseProductHtml(OG_PAGE, URL_UNDER_TEST);
    assert.equal(r.degraded, false);
    assert.equal(r.title, "Milwaukee M18 FUEL 125mm Angle Grinder");
    assert.equal(r.imageUrl, "https://cdn.example.com/grinder.png");
    assert.equal(r.price, "$399.00");
  });

  await test("digs a Product out of @graph and skips a malformed block", () => {
    const r = parseProductHtml(GRAPH_PAGE, URL_UNDER_TEST);
    assert.equal(r.degraded, false);
    assert.equal(r.title, "DeWalt DCF887 Impact Driver");
    // Relative image resolved against the page URL.
    assert.equal(r.imageUrl, "https://sydneytools.com.au/media/dcf887.jpg");
    assert.equal(r.price, "$249.00");
  });

  await test("degrades — but keeps the link — on a page with no tags", () => {
    const r = parseProductHtml(BARE_PAGE, URL_UNDER_TEST);
    assert.equal(r.degraded, true);
    assert.equal(r.sourceUrl, URL_UNDER_TEST); // guardrail #4: link survives
    assert.ok(r.reason && r.reason.length > 0);
  });

  await test("decodes HTML entities in titles", () => {
    const r = parseProductHtml(
      `<html><head><meta property="og:title" content="Ryobi 18V ONE+ Drill &amp; Impact Driver Kit"></head></html>`,
      URL_UNDER_TEST,
    );
    assert.equal(r.title, "Ryobi 18V ONE+ Drill & Impact Driver Kit");
  });

  await test("handles reversed meta attribute order", () => {
    const r = parseProductHtml(
      `<html><head><meta content="Bosch GBH 18V-26 Rotary Hammer" property="og:title"></head></html>`,
      URL_UNDER_TEST,
    );
    assert.equal(r.title, "Bosch GBH 18V-26 Rotary Hammer");
  });

  await test("keeps a messy price string rather than dropping it", () => {
    const r = parseProductHtml(
      `<html><head><meta property="og:title" content="Bulk buy pallet">
       <meta property="product:price:amount" content="From $899 inc GST"></head></html>`,
      URL_UNDER_TEST,
    );
    assert.equal(r.title, "Bulk buy pallet");
    assert.equal(r.price, "$899.00");
  });

  console.log("\nscrapeProduct (network paths — never throws)");

  await test("degrades gracefully when the host cannot be reached", async () => {
    const r = await scrapeProduct("https://this-host-does-not-exist.invalid/p/1");
    assert.equal(r.degraded, true);
    assert.equal(r.sourceUrl, "https://this-host-does-not-exist.invalid/p/1");
    assert.ok(r.reason);
  });

  await test("degrades on input that isn't a URL at all", async () => {
    const r = await scrapeProduct("just some words");
    assert.equal(r.degraded, true);
    assert.ok(r.reason);
  });

  await test("refuses to fetch private/loopback addresses", async () => {
    for (const u of [
      "http://localhost:3000/admin",
      "http://127.0.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://192.168.1.1/",
    ]) {
      const r = await scrapeProduct(u);
      assert.equal(r.degraded, true, `${u} should be refused`);
      assert.equal(r.title, null);
    }
  });

  await test("pulls the URL out of shared text like a share sheet sends", async () => {
    const r = await scrapeProduct(
      "Check this out https://this-host-does-not-exist.invalid/p/42 mate",
    );
    assert.equal(r.sourceUrl, "https://this-host-does-not-exist.invalid/p/42");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

void main();
