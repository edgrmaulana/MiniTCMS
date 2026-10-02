import { getDb, listImportRuns } from "@/lib/db";
import { handle, requireRole } from "../helpers";

/*
  Every import, newest first. The report is the deliverable of a migration,
  so it stays readable long after the import finished - this is what the
  import screen lists.

  Starting an API import is not here on purpose: it is minutes to hours of
  work against a live instance, which is a CLI job (npm run migrate), not a
  request a browser holds open. The CSV path is fast enough to be a request
  and has its own route.
*/
export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    await requireRole("admin");
    const url = new URL(request.url);
    return Response.json(
      listImportRuns(getDb(), {
        limit: url.searchParams.get("limit"),
        page: url.searchParams.get("page"),
      }),
    );
  });
}
