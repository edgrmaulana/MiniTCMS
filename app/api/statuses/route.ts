import { getDb, listStatuses } from "@/lib/db";
import { handle, requireUser } from "../helpers";

// The UI reads the status set from here rather than hardcoding the five
// built-ins, so a custom status an import brought in shows up by itself.
export async function GET(): Promise<Response> {
  return handle(async () => {
    await requireUser();
    return Response.json({ rows: listStatuses(getDb()) });
  });
}
