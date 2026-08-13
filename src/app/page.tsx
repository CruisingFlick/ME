import Link from "next/link";
import { redirect } from "next/navigation";
import { getRep } from "@/lib/rep-session";
import { getCustomerContext } from "@/lib/customer-session";

export default async function Home() {
  // Whichever session you already hold decides where you land.
  const rep = await getRep();
  if (rep) redirect("/dashboard");

  const customer = await getCustomerContext();
  if (customer) redirect("/shop");

  return (
    <main className="shell shell-narrow">
      <div style={{ padding: "2.5rem 0 1.5rem" }}>
        <h1>Rep Order App</h1>
        <p className="muted">
          Your customers send you product requests after hours. You pick them up
          in the morning and key them into the store system yourself.
        </p>
      </div>

      <div className="card stack">
        <h2>For reps</h2>
        <p className="muted">
          Create an account, then share your invite link with your customers.
          Your customer list, their requests and your notes belong to your
          account — export them as CSV whenever you like.
        </p>
        <div className="row">
          <Link href="/signup" className="btn">
            Create an account
          </Link>
          <Link href="/login" className="btn btn-secondary">
            Log in
          </Link>
        </div>
      </div>

      <div className="card">
        <h2>For customers</h2>
        <p className="muted" style={{ marginBottom: 0 }}>
          Use the link your rep sent you — it looks like{" "}
          <code>{"/r/your-reps-name"}</code>. There is no account to create.
        </p>
      </div>
    </main>
  );
}
