import { apiKeyUser, currentUser } from "@/lib/session";
import { CaseFieldError, roleAtLeast, type SessionUser, type UserRole } from "@/lib/format";
import { takeApiToken } from "@/lib/rate-limit";
import { AttachmentTooLargeError } from "@/lib/attachments";
import { ConflictError, MAX_BULK_IDS, NotFoundError, nowSeconds } from "@/lib/db";
import { MappingError } from "@/lib/migrate/map";

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

export class ForbiddenError extends Error {}

export class RateLimitedError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super("Too many requests on this API key");
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/*
  Every API route starts here, and nothing in app/api reads a cookie or a
  header for itself. Cookie first because that is the common case and costs no
  header read; a bearer key second, which is how CI authenticates.

  The rate limit lives on the key path only: a browser session is a person, and
  a person cannot loop fast enough to matter. A CI job can, and SQLite
  serialises writes, so one runaway reporter is an outage for everybody.
*/
export async function requireUser(): Promise<SessionUser> {
  const session = await currentUser();
  if (session) return session;

  const keyUser = await apiKeyUser();
  if (!keyUser?.apiKeyId) throw new UnauthorisedError();

  const decision = takeApiToken(String(keyUser.apiKeyId), nowSeconds());
  if (!decision.allowed) {
    throw new RateLimitedError(Math.max(1, decision.resetAt - nowSeconds()));
  }
  return keyUser;
}

/*
  The permission model, in one sentence: the roles are a ladder and a route
  names the rung it needs. Three rungs, from AGENTS.md and phase 6:

  - tester  reads everything, records results, uploads attachments.
  - lead    everything tester can, plus editing the case repository, creating
            and closing runs, and running an import.
  - admin   everything lead can, plus the paths that destroy history.

  An API key is checked here exactly like a session, so a key never reaches a
  route its owner cannot.
*/
export async function requireRole(minimum: UserRole): Promise<SessionUser> {
  const user = await requireUser();
  if (!roleAtLeast(user.role, minimum)) {
    throw new ForbiddenError(`This needs the ${minimum} role or better`);
  }
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
    if (error instanceof UnauthorisedError) return problem(401, "Sign in, or send an API key");
    if (error instanceof ForbiddenError) return problem(403, error.message);
    if (error instanceof RateLimitedError) {
      return Response.json(
        { error: error.message },
        { status: 429, headers: { "retry-after": String(error.retryAfterSeconds) } },
      );
    }
    if (error instanceof AttachmentTooLargeError) return problem(413, error.message);
    if (error instanceof NotFoundError) return problem(404, error.message);
    if (error instanceof ConflictError) return problem(409, error.message);
    if (error instanceof BadRequestError) return problem(400, error.message);
    if (error instanceof CaseFieldError) return problem(400, error.message);
    // A mapping failure names the source row, which is exactly what the
    // operator needs to see; it is a bad input, not a server fault.
    if (error instanceof MappingError) return problem(400, error.message);
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

/*
  A comma-separated id list in the query string, so "everything not passed"
  is one request rather than one per status. Bounded like every other list
  the caller controls the length of: this one ends up as an IN clause, and
  SQLite stops binding parameters at 32766.
*/
const MAX_QUERY_IDS = 100;

export function idListParam(url: URL, name: string): number[] | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length > MAX_QUERY_IDS) {
    throw new BadRequestError(`${name} takes at most ${MAX_QUERY_IDS} ids`);
  }
  return entries.map((entry) => routeId(entry));
}

/*
  A boolean in a query string, strictly. "true" and "false" only: anything else
  is a typo, and reading a typo as false is how a caller ends up looking at the
  opposite of what they asked for.
*/
export function optionalFlag(url: URL, name: string): boolean | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new BadRequestError(`${name} must be true or false`);
}

export function listOptionsFrom(url: URL) {
  return {
    search: url.searchParams.get("search"),
    page: url.searchParams.get("page") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  };
}
