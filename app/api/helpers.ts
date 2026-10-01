import { currentUser } from "@/lib/session";
import { CaseFieldError, type SessionUser } from "@/lib/format";
import { ConflictError, MAX_BULK_IDS, NotFoundError } from "@/lib/db";

/*
  Thin routes (AGENTS.md rule 6): everything the handlers share lives here. Validate, delegate to lib/db.ts, return. No SQL above this
  line, and no business rule either - a rule that lives in a route is a rule
  the CLI and the importer do not get.
*/

export class BadRequestError extends Error {}
export class UnauthorisedError extends Error {}

export function problem(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) throw new UnauthorisedError();
  return user;
}

/*
  One place that turns a thrown domain error into a status code, so a handler
  never has to remember which of these maps to 404 and which to 409, and an
  unexpected error never leaks its message to the caller.
*/
export async function handle(work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof UnauthorisedError) return problem(401, "Sign in first");
    if (error instanceof NotFoundError) return problem(404, error.message);
    if (error instanceof ConflictError) return problem(409, error.message);
    if (error instanceof BadRequestError) return problem(400, error.message);
    if (error instanceof CaseFieldError) return problem(400, error.message);
    console.error(error);
    return problem(500, "Something went wrong");
  }
}

export function routeId(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new BadRequestError(`"${value}" is not an id`);
  return id;
}

export function queryId(url: URL, name: string): number {
  const raw = url.searchParams.get(name);
  if (raw === null) throw new BadRequestError(`${name} is required`);
  return routeId(raw);
}

export function optionalQueryId(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  return raw === null ? undefined : routeId(raw);
}

/*
  Unknown keys are rejected rather than ignored. Ignoring one turns a typo in
  a field name into a silent no-op, which is the kind of bug that gets found a
  week later by someone wondering why their edit never saved.
*/
export async function readBody<Key extends string>(
  request: Request,
  allowed: readonly Key[],
): Promise<Partial<Record<Key, unknown>>> {
  /*
    Defence in depth against a cross-site write. The session cookie is
    sameSite=lax, so a browser will not attach it to a cross-site POST in the
    first place; requiring a JSON content type also keeps these routes out of
    reach of the form-and-image tricks that count as "simple requests" and so
    skip the CORS preflight entirely.
  */
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new BadRequestError("Content-Type must be application/json");
  }
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new BadRequestError("Body must be JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BadRequestError("Body must be a JSON object");
  }
  const body = parsed as Record<string, unknown>;
  const unknown = Object.keys(body).filter((key) => !(allowed as readonly string[]).includes(key));
  if (unknown.length > 0) throw new BadRequestError(`Unknown field: ${unknown.join(", ")}`);
  return body as Partial<Record<Key, unknown>>;
}

export function requireText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BadRequestError(`${name} is required`);
  }
  return value.trim();
}

export function optionalText(value: unknown, name: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new BadRequestError(`${name} must be text`);
  return value;
}

export function optionalInteger(value: unknown, name: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Number.isInteger(value)) throw new BadRequestError(`${name} must be a whole number`);
  return value as number;
}

export function requireIdList(value: unknown, name: string): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BadRequestError(`${name} must be a non-empty array of ids`);
  }
  if (value.length > MAX_BULK_IDS) {
    throw new BadRequestError(`${name} holds at most ${MAX_BULK_IDS} ids`);
  }
  for (const entry of value) {
    if (!Number.isInteger(entry) || (entry as number) < 1) {
      throw new BadRequestError(`${name} must contain ids`);
    }
  }
  return value as number[];
}

export function customFrom(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestError("custom must be an object");
  }
  return value as Record<string, unknown>;
}

export function listOptionsFrom(url: URL) {
  return {
    search: url.searchParams.get("search"),
    page: url.searchParams.get("page") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  };
}
