import type { ReactNode } from "react";
import Link from "next/link";
import { getSession } from "@/lib/session.ts";
import { logout } from "./actions.ts";
import "./globals.css";

export const metadata = { title: "Gym Access" };
export const dynamic = "force-dynamic";

export default async function Layout({ children }: { children: ReactNode }) {
  const s = await getSession();
  return (
    <html lang="en">
      <body>
        <header className="top">
          <strong className="brand">Gym Access</strong>
          <span className="muted">Cedars Fitness (demo data)</span>
          {s && (
            <nav>
              <Link href="/members">Members</Link>
              <Link href="/import">Import</Link>
              <Link href="/report">Payments report</Link>
              {s.role === "owner" && <Link href="/settings">Settings</Link>}
            </nav>
          )}
          <span className="grow" />
          {s && (
            <form action={logout}>
              <span className="muted">Signed in as <strong>{s.label}</strong></span> <button className="link">Sign out</button>
            </form>
          )}
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
