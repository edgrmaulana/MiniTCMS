import { Suspense } from "react";
import CaseDetail from "./case-detail";

export default async function CasePage({ params }: PageProps<"/cases/[id]">) {
  const { id } = await params;
  return (
    <Suspense fallback={<p className="px-8 py-16 text-sm text-muted">Loading case</p>}>
      <CaseDetail caseId={Number(id)} />
    </Suspense>
  );
}
