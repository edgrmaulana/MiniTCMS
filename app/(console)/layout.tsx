import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import Rail from "./rail";

// Every console screen is behind the session check here, so a page added later
// cannot forget it. /login sits outside this group and stays reachable.
export default async function ConsoleLayout({ children }: LayoutProps<"/">) {
  const user = await currentUser();
  if (!user) redirect("/login");

  return (
    <div className="shell">
      <Rail email={user.email} />
      <main className="min-w-0 rise">{children}</main>
    </div>
  );
}
