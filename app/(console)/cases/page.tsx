import { Suspense } from "react";
import CasesScreen from "./cases-screen";

// useSearchParams needs a Suspense boundary to prerender the shell around it.
export default function CasesPage() {
  return (
    <Suspense fallback={<p className="px-8 py-16 text-sm text-muted">Loading cases</p>}>
      <CasesScreen />
    </Suspense>
  );
}
