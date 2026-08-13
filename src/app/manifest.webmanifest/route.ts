export const dynamic = "force-static";

/**
 * Served from a route handler rather than a static file so `share_target`
 * survives — Next.js's typed MetadataRoute.Manifest has no field for it.
 *
 * share_target is Android-only (Chrome/Edge on Android, plus desktop Chrome OS).
 * iOS Safari does not implement it; iPhone customers use paste or photo, and
 * the UI never promises otherwise.
 */
export function GET() {
  const manifest = {
    name: "Rep Order App",
    short_name: "Rep Orders",
    description:
      "Send your rep a product request any time — paste a link, snap a photo, or share straight from another app.",
    start_url: "/shop",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f6f7f9",
    theme_color: "#b8410e",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any maskable",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any maskable",
      },
    ],
    share_target: {
      action: "/share",
      method: "GET",
      params: {
        title: "title",
        text: "text",
        url: "url",
      },
    },
  };

  return new Response(JSON.stringify(manifest, null, 2), {
    headers: { "content-type": "application/manifest+json" },
  });
}
