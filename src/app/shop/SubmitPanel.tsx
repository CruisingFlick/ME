import { submitRequest } from "@/app/actions/basket";
import { SubmitButton } from "@/components/SubmitButton";

export function SubmitPanel({ count }: { count: number }) {
  return (
    <form action={submitRequest} className="card">
      <h2>Send it through</h2>
      <div className="field">
        <label htmlFor="customerMessage">Anything else your rep should know?</label>
        <textarea
          id="customerMessage"
          name="customerMessage"
          placeholder="e.g. need it by Thursday, site delivery to Rouse Hill"
        />
      </div>
      <div style={{ marginTop: "0.75rem" }}>
        <SubmitButton className="btn btn-block" pendingLabel="Sending…">
          Send {count} item{count === 1 ? "" : "s"} to my rep
        </SubmitButton>
      </div>
      <p className="tiny" style={{ marginTop: "0.5rem", marginBottom: 0 }}>
        Your rep picks these up next business morning and comes back with a
        quote. Nothing is ordered until you say so.
      </p>
    </form>
  );
}
