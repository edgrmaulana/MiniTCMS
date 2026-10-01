import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { logout } from "./auth-actions";

export default async function HomePage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center gap-8 px-6">
      <p className="wordmark">minitcms / test console</p>
      <h1 className="display text-4xl">Signed in as {user.email}</h1>
      <p className="text-sm text-muted">
        Role: {user.role}. The console itself lands with phases 2 and 3 — see plan/.
      </p>
      <form action={logout}>
        <button type="submit" className="signin w-40">
          Sign out
        </button>
      </form>
    </main>
  );
}
