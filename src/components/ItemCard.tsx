import type { RequestItem } from "@/db/schema";

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function ItemThumb({
  imageUrl,
  alt,
}: {
  imageUrl: string | null;
  alt: string;
}) {
  if (!imageUrl) {
    return (
      <div className="thumb thumb-placeholder" aria-hidden="true">
        📦
      </div>
    );
  }
  // Plain <img>: sources are arbitrary third-party product pages and user
  // uploads, so there is nothing to gain from the image optimiser here.
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="thumb" src={imageUrl} alt={alt} loading="lazy" />;
}

export function ItemCard({
  item,
  children,
}: {
  item: RequestItem;
  children?: React.ReactNode;
}) {
  return (
    <li className="item">
      <ItemThumb imageUrl={item.imageUrl} alt="" />
      <div className="grow">
        <div className="item-title">{item.title}</div>
        <div className="row" style={{ gap: "0.5rem", marginTop: "0.15rem" }}>
          {item.price && <span className="price">{item.price}</span>}
          <span className="muted">Qty {item.quantity}</span>
        </div>
        {item.sourceUrl && (
          <a
            className="src"
            href={item.sourceUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            {hostOf(item.sourceUrl)} ↗
          </a>
        )}
        {item.customerNote && (
          <p className="tiny" style={{ margin: "0.25rem 0 0" }}>
            “{item.customerNote}”
          </p>
        )}
        {children}
      </div>
    </li>
  );
}
