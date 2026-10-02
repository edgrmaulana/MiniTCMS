import { currentUser } from "@/lib/session";
import RunDetail from "./run-detail";

/*
  The role comes from the session here rather than from a request the browser
  makes, because it decides whether the delete control is rendered at all.
  The server checks it again on the route; this only keeps the button away
  from people it would always refuse.
*/
export default async function RunPage({ params }: PageProps<"/runs/[id]">) {
  const { id } = await params;
  const user = await currentUser();
  return <RunDetail runId={Number(id)} role={user?.role ?? "tester"} />;
}
