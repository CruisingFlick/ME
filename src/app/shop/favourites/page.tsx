import { desc, eq } from "drizzle-orm";
import { asCustomer } from "@/db/scoped";
import { favourites } from "@/db/schema";
import { requireCustomer } from "@/lib/customer-session";
import { ItemThumb } from "@/components/ItemCard";
import { addFavouritesToDraft, removeFavourite } from "@/app/actions/basket";

export default async function FavouritesPage() {
  const { customer } = await requireCustomer();

  const saved = await asCustomer(customer.id, (tx) =>
    tx
      .select()
      .from(favourites)
      .where(eq(favourites.customerId, customer.id))
      .orderBy(desc(favourites.createdAt)),
  );

  return (
    <main className="shell shell-narrow">
      <div style={{ padding: "1.25rem 0 0.5rem" }}>
        <h1>Favourites</h1>
        <p className="muted">
          The gear you buy over and over. Tick what you need and drop it
          straight into your next request.
        </p>
      </div>

      {saved.length === 0 ? (
        <div className="empty">
          Nothing saved yet. Hit <strong>☆ Save</strong> on any item in a
          request and it lands here.
        </div>
      ) : (
        <form action={addFavouritesToDraft} className="card">
          <ul className="list-reset">
            {saved.map((f) => (
              <li className="item" key={f.id}>
                <input
                  type="checkbox"
                  name="favouriteId"
                  value={f.id}
                  id={`fav-${f.id}`}
                  style={{ width: "1.15rem", flex: "0 0 auto", marginTop: "0.4rem" }}
                />
                <ItemThumb imageUrl={f.imageUrl} alt="" />
                <div className="grow">
                  <label
                    htmlFor={`fav-${f.id}`}
                    className="item-title"
                    style={{ textTransform: "none", letterSpacing: 0, fontSize: "1rem" }}
                  >
                    {f.title}
                  </label>
                  {f.price && <div className="price">{f.price}</div>}
                  {f.sourceUrl && (
                    <a
                      className="src"
                      href={f.sourceUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      View product ↗
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>

          <div className="row" style={{ marginTop: "0.9rem" }}>
            <button type="submit" className="btn grow">
              Add ticked items to my request
            </button>
          </div>
        </form>
      )}

      {saved.length > 0 && (
        <section className="card">
          <h3>Remove a favourite</h3>
          <ul className="list-reset">
            {saved.map((f) => (
              <li className="row-between" key={`rm-${f.id}`} style={{ padding: "0.3rem 0" }}>
                <span className="muted">{f.title}</span>
                <form action={removeFavourite}>
                  <input type="hidden" name="favouriteId" value={f.id} />
                  <button type="submit" className="btn-danger">
                    Remove
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
