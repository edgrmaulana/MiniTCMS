import { getDb, listUsers } from "@/lib/db";
import { handle, listOptionsFrom, requireUser } from "../helpers";

// Who a test can be assigned to. The query selects its columns by name, so
// there is no path from here to a password hash.
export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    await requireUser();
    return Response.json(listUsers(getDb(), listOptionsFrom(new URL(request.url))));
  });
}
