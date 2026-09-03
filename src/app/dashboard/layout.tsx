import Link from "next/link";
import { requireRep } from "@/lib/rep-session";
import { logOutRep } from "@/app/actions/auth";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const rep = await requireRep();

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <Link href="/dashboard" className="brand">
            {rep.businessName}
            <small>Rep dashboard</small>
          </Link>
          <Link href="/dashboard" className="navlink">
            Requests
          </Link>
          <Link href="/dashboard/customers" className="navlink">
            Customers
          </Link>
          <Link href="/dashboard/share" className="navlink">
            Invite link
          </Link>
          <Link href="/dashboard/account" className="navlink">
            Account
          </Link>
          <form action={logOutRep}>
            <button type="submit" className="btn-ghost" style={{ border: 0 }}>
              Log out
            </button>
          </form>
        </div>
      </header>
      {children}
    </>
  );
}
