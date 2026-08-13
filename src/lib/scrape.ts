export type ScrapeResult = {
  /** Always present — the URL is the fallback item on its own. */
  sourceUrl: string;
  title: string | null;
  imageUrl: string | null;
  price: string | null;
  /** True when we got nothing useful and the customer needs to type it in. */
  degraded: boolean;
  /** Plain-English reason, shown to the customer when degraded. */
  reason?: string;
};

const MAX_BYTES = 1_500_000; // product pages are big; don't read a whole CDN blob
const TIMEOUT_MS = 8000;

/**
 * A real browser UA. Not evasion — plenty of sites serve a stripped page or a
 * 403 to an unrecognised agent, and we only ever read the same public HTML a
 * customer sees when they open the link themselves.
 */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function clean(s: string | null | undefined): string | null {
  if (!s) return null;
  const v = decodeEntities(s).replace(/\s+/g, " ").trim();
  return v ? v.slice(0, 400) : null;
}

/** Pull `content` from whichever meta tag matches, attribute order independent. */
function meta(html: string, names: string[]): string | null {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(
        `<meta[^>]+(?:property|name|itemprop)\\s*=\\s*["']${escaped}["'][^>]*?content\\s*=\\s*["']([^"']*)["']`,
        "i",
      ),
      new RegExp(
        `<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*?(?:property|name|itemprop)\\s*=\\s*["']${escaped}["']`,
        "i",
      ),
    ];
    for (const re of patterns) {
      const m = html.match(re);
      const v = clean(m?.[1]);
      if (v) return v;
    }
  }
  return null;
}

function titleTag(html: string): string | null {
  return clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
}

type Jsonish = Record<string, unknown>;

function isProductNode(node: unknown): node is Jsonish {
  if (!node || typeof node !== "object") return false;
  const t = (node as Jsonish)["@type"];
  const types = Array.isArray(t) ? t : [t];
  return types.some((x) => typeof x === "string" && /product/i.test(x));
}

/** Walk arbitrary JSON-LD (arrays, @graph, nesting) looking for a Product. */
function findProduct(node: unknown, depth = 0): Jsonish | null {
  if (depth > 6 || !node || typeof node !== "object") return null;
  if (isProductNode(node)) return node;

  const values = Array.isArray(node) ? node : Object.values(node as Jsonish);
  for (const v of values) {
    const hit = findProduct(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function formatPrice(value: unknown, currency: unknown): string | null {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const n = Number(raw.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return raw.slice(0, 120);

  const symbol =
    typeof currency === "string" && currency.toUpperCase() !== "AUD"
      ? `${currency.toUpperCase()} `
      : "$";
  return `${symbol}${n.toLocaleString("en-AU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fromJsonLd(html: string): Partial<ScrapeResult> {
  const blocks = html.matchAll(
    /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );

  for (const block of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block[1].trim());
    } catch {
      continue; // one malformed block must not stop us looking at the next
    }

    const product = findProduct(parsed);
    if (!product) continue;

    const image = product.image;
    const imageUrl =
      typeof image === "string"
        ? image
        : Array.isArray(image)
          ? typeof image[0] === "string"
            ? image[0]
            : ((image[0] as Jsonish | undefined)?.url as string | undefined)
          : ((image as Jsonish | undefined)?.url as string | undefined);

    const offersRaw = product.offers;
    const offer = (
      Array.isArray(offersRaw) ? offersRaw[0] : offersRaw
    ) as Jsonish | undefined;

    return {
      title: clean(product.name as string),
      imageUrl: clean(imageUrl) ?? null,
      price: offer
        ? formatPrice(
            offer.price ?? offer.lowPrice ?? offer.highPrice,
            offer.priceCurrency,
          )
        : null,
    };
  }

  return {};
}

function absolutise(value: string | null, base: string): string | null {
  if (!value) return null;
  try {
    return new URL(value, base).toString();
  } catch {
    return null;
  }
}

/** Block obvious SSRF targets — we fetch whatever URL a customer hands us. */
function isPubliclyRoutable(u: URL): boolean {
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "[::1]") {
    return false;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const [a, b] = host.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false; // cloud metadata endpoint
  }
  return true;
}

function degrade(sourceUrl: string, reason: string): ScrapeResult {
  return {
    sourceUrl,
    title: null,
    imageUrl: null,
    price: null,
    degraded: true,
    reason,
  };
}

/**
 * Turns a page's HTML into a product card. Pure and network-free, so the
 * parsing rules can be tested against saved pages without hitting a live site.
 *
 * Tries JSON-LD first (richest and most reliable when present), then Open Graph
 * and friends, then the plain <title>.
 */
export function parseProductHtml(html: string, sourceUrl: string): ScrapeResult {
  const ld = fromJsonLd(html);

  const title =
    ld.title ??
    meta(html, ["og:title", "twitter:title", "title", "name"]) ??
    titleTag(html);

  const imageUrl = absolutise(
    ld.imageUrl ??
      meta(html, ["og:image:secure_url", "og:image", "twitter:image", "image"]),
    sourceUrl,
  );

  const price =
    ld.price ??
    formatPrice(
      meta(html, [
        "product:price:amount",
        "og:price:amount",
        "price",
        "twitter:data1",
      ]),
      meta(html, ["product:price:currency", "og:price:currency", "priceCurrency"]) ??
        "AUD",
    );

  // A title is the one thing that makes a card useful. Without it, degrade.
  if (!title) {
    return degrade(
      sourceUrl,
      "We couldn't read a product name off that page. Type what you need and we'll keep the link attached.",
    );
  }

  return { sourceUrl, title, imageUrl, price, degraded: false };
}

/**
 * Reads the public HTML of a pasted product page and pulls out a card.
 *
 * Guardrail #4: this function never throws and never returns null. Every
 * failure path — bad URL, timeout, 403, non-HTML, no tags — still returns a
 * usable result carrying the original URL with `degraded: true`, so the
 * customer can type a title and carry on.
 */
export async function scrapeProduct(input: string): Promise<ScrapeResult> {
  const raw = input.trim();

  // A share sheet often sends "Look at this https://... " rather than a bare URL.
  const found = raw.match(/https?:\/\/[^\s"'<>]+/i)?.[0] ?? raw;

  let url: URL;
  try {
    url = new URL(found);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    return {
      sourceUrl: found,
      title: null,
      imageUrl: null,
      price: null,
      degraded: true,
      reason: "That doesn't look like a web link — type the item in instead.",
    };
  }

  const sourceUrl = url.toString();
  const fail = (reason: string) => degrade(sourceUrl, reason);

  if (!isPubliclyRoutable(url)) {
    return fail("That link points somewhere we can't reach.");
  }

  let html: string;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await fetch(sourceUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": UA,
        accept: "text/html,application/xhtml+xml",
        "accept-language": "en-AU,en;q=0.9",
      },
    }).finally(() => clearTimeout(timer));

    if (!res.ok) {
      return fail(
        `That site didn't let us read the page (error ${res.status}). Add a title yourself and your rep will open the link.`,
      );
    }

    const type = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml/i.test(type)) {
      return fail("That link isn't a product page we can read.");
    }

    // Cap the read so a huge page can't stall a serverless invocation.
    const buf = await res.arrayBuffer();
    html = new TextDecoder("utf-8").decode(buf.slice(0, MAX_BYTES));
  } catch {
    return fail(
      "We couldn't reach that page just now. Add a title yourself and your rep will open the link.",
    );
  }

  return parseProductHtml(html, sourceUrl);
}
