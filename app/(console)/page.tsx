import { Suspense } from "react";
import Dashboard from "./dashboard";

export default function DashboardPage() {
  return (
    <Suspense fallback={<p className="px-8 py-16 text-sm text-muted">Loading dashboard</p>}>
      <Dashboard />
    </Suspense>
  );
}
