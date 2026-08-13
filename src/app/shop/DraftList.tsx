import type { RequestItem } from "@/db/schema";
import { ItemCard } from "@/components/ItemCard";
import { removeItem, saveFavourite, updateItemQuantity } from "@/app/actions/basket";

export function DraftList({ items }: { items: RequestItem[] }) {
  if (items.length === 0) {
    return (
      <div className="empty">
        Nothing in this request yet. Add your first item above.
      </div>
    );
  }

  return (
    <section className="card">
      <h2>This request ({items.length})</h2>
      <ul className="list-reset">
        {items.map((item) => (
          <ItemCard key={item.id} item={item}>
            <div className="row" style={{ marginTop: "0.4rem", gap: "0.5rem" }}>
              <form action={updateItemQuantity} className="row" style={{ gap: "0.35rem" }}>
                <input type="hidden" name="itemId" value={item.id} />
                <input
                  className="qty"
                  type="number"
                  name="quantity"
                  min={1}
                  max={999}
                  defaultValue={item.quantity}
                  aria-label={`Quantity for ${item.title}`}
                />
                <button type="submit" className="btn-ghost">
                  Update
                </button>
              </form>

              <form action={saveFavourite}>
                <input type="hidden" name="title" value={item.title} />
                <input type="hidden" name="sourceUrl" value={item.sourceUrl ?? ""} />
                <input type="hidden" name="imageUrl" value={item.imageUrl ?? ""} />
                <input type="hidden" name="price" value={item.price ?? ""} />
                <button type="submit" className="btn-ghost">
                  ☆ Save
                </button>
              </form>

              <form action={removeItem}>
                <input type="hidden" name="itemId" value={item.id} />
                <button type="submit" className="btn-danger">
                  Remove
                </button>
              </form>
            </div>
          </ItemCard>
        ))}
      </ul>
    </section>
  );
}
