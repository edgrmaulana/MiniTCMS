import { Suspense } from "react";
import { currentUser } from "@/lib/session";
import CaseDetail from "./case-detail";

export default async function CasePage({ params }: PageProps<"/cases/[id]">) {
  const { id } = await params;
  const user = await currentUser();
  return (
    <Suspense fallback={<p className="px-8 py-16 text-sm text-muted">Loading case</p>}>
      <CaseDetail caseId={Number(id)} role={user?.role ?? "tester"} />
    </Suspense>
  );
}
