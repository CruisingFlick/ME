import { requireCustomer } from "@/lib/customer-session";
import { asCustomer } from "@/db/scoped";
import { getRequestItems, getOrCreateDraft } from "@/lib/requests";
import { AddItemPanel } from "./AddItemPanel";
import { DraftList } from "./DraftList";
import { SubmitPanel } from "./SubmitPanel";

export default async function ShopPage({
  searchParams,
}: {
  searchParams: Promise<{
    reordered?: string;
    added?: string;
    // Populated by the Android share target (Block 4).
    shareUrl?: string;
    shareText?: string;
    shareTitle?: string;
  }>;
}) {
  const { customer, rep } = await requireCustomer();
  const sp = await searchParams;

  const items = await asCustomer(customer.id, async (tx) => {
    const draft = await getOrCreateDraft(tx, rep.id, customer.id);
    return getRequestItems(tx, draft.id);
  });

  return (
    <main className="shell shell-narrow">
      <div style={{ padding: "1.25rem 0 0.5rem" }}>
        <h1>What do you need?</h1>
        <p className="muted">
          Add as many items as you like, then send the lot to {rep.name} in one
          go. Any time of night is fine.
        </p>
      </div>

      {sp.reordered && (
        <div className="notice notice-ok">
          Copied that order into your new request — adjust anything below.
        </div>
      )}
      {sp.added && (
        <div className="notice notice-ok">
          Added {sp.added} favourite{sp.added === "1" ? "" : "s"} to this
          request.
        </div>
      )}

      <AddItemPanel
        sharedUrl={sp.shareUrl ?? sp.shareText}
        sharedTitle={sp.shareTitle}
      />

      <DraftList items={items} />

      {items.length > 0 && <SubmitPanel count={items.length} />}
    </main>
  );
}
