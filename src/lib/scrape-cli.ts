/**
 * Try the scraper against a real URL from the command line:
 *
 *   npm run scrape:try -- "https://sydneytools.com.au/product/..."
 *
 * Useful for checking how a given retailer's pages behave before promising a
 * customer the paste box will fill itself in. A `degraded` result is a normal,
 * supported outcome — not a failure.
 */
import { scrapeProduct } from "./scrape";

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: npm run scrape:try -- "https://example.com/product/123"');
    process.exit(1);
  }

  const result = await scrapeProduct(url);

  console.log("");
  console.log(`  source   ${result.sourceUrl}`);
  console.log(`  title    ${result.title ?? "—"}`);
  console.log(`  price    ${result.price ?? "—"}`);
  console.log(`  image    ${result.imageUrl ?? "—"}`);
  console.log(`  degraded ${result.degraded}`);
  if (result.reason) console.log(`  reason   ${result.reason}`);
  console.log("");
}

void main();
