import { Suspense } from "react";
import { currentUser } from "@/lib/session";
import CasesScreen from "./cases-screen";

// useSearchParams needs a Suspense boundary to prerender the shell around it.
// The role is read here, on the server: it decides whether the bulk edit
// controls are rendered at all. The API checks it again on every write.
export default async function CasesPage() {
  const user = await currentUser();
  return (
    <Suspense fallback={<p className="px-8 py-16 text-sm text-muted">Loading cases</p>}>
      <CasesScreen role={user?.role ?? "tester"} />
    </Suspense>
  );
}
