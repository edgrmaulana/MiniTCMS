import { Suspense } from "react";
import ImportScreen from "./import-screen";

export default function MigratePage() {
  return (
    <Suspense fallback={<p className="px-8 py-16 text-sm text-muted">Loading imports</p>}>
      <ImportScreen />
    </Suspense>
  );
}
