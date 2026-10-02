import { Suspense } from "react";
import RunsScreen from "./runs-screen";

export default function RunsPage() {
  return (
    <Suspense fallback={<p className="px-8 py-16 text-sm text-muted">Loading runs</p>}>
      <RunsScreen />
    </Suspense>
  );
}
