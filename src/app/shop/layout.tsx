import Link from "next/link";
import { requireCustomer } from "@/lib/customer-session";
import { logOutCustomer } from "@/app/actions/auth";

export default async function ShopLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { customer, rep } = await requireCustomer();

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <Link href="/shop" className="brand">
            {rep.businessName}
            <small>Signed in as {customer.name}</small>
          </Link>
          <Link href="/shop" className="navlink">
            New request
          </Link>
          <Link href="/shop/requests" className="navlink">
            My requests
          </Link>
          <Link href="/shop/favourites" className="navlink">
            Favourites
          </Link>
          <form action={logOutCustomer}>
            <button type="submit" className="btn-ghost" style={{ border: 0 }}>
              Not you?
            </button>
          </form>
        </div>
      </header>
      {children}
    </>
  );
}
