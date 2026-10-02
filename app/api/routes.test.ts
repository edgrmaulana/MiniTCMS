/*
  Authorisation, route by route. The 401 sweep walks every route file on disk
  rather than a hand-written list, so a route added later is covered the day it
  lands - which is the guarantee a middleware.ts would have given, without a
  second place for the rule to live.
*/
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "minitcms-routes-"));
process.env.SQLITE_FILE = join(directory, "routes.db");

// The request context the routes read, swapped per test. Hoisted so the mock
// factory below can close over it.
const context = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  authorization: undefined as string | undefined,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      context.cookie === undefined ? undefined : { name, value: context.cookie },
  }),
  headers: async () =>
    new Headers(context.authorization ? { authorization: context.authorization } : {}),
}));

const { createApiKey, createSessionToken, hashPassword } = await import("@/lib/auth");
const database = await import("@/lib/db");
const { API_RATE_LIMIT } = await import("@/lib/rate-limit");

type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;

/*
  Every route module under app/api, found at build time rather than listed by
  hand: a route added next month is swept without anybody remembering to add it
  here. import.meta.glob and not readdirSync because the import path has to be
  statically analysable.
*/
const ROUTE_MODULES = import.meta.glob("./**/route.ts") as Record<
  string,
  () => Promise<Record<string, Handler>>
>;

const routeFiles = (): string[] => Object.keys(ROUTE_MODULES).sort();

// Query parameters every list route might want, and a body with one of every
// required field shape. Neither should matter: the session check comes first,
// and a route that validates before it authenticates fails this test.
function requestFor(method: string): Request {
  const url = "http://localhost/api/thing?projectId=1&suiteId=1&runId=1&limit=5";
  return new Request(url, {
    method,
    headers: method === "GET" ? undefined : { "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify({}),
  });
}

async function callAll(file: string): Promise<{ method: string; status: number }[]> {
  const loaded = await ROUTE_MODULES[file]();
  const answers: { method: string; status: number }[] = [];
  for (const method of METHODS) {
    if (typeof loaded[method] !== "function") continue;
    const response = await loaded[method](requestFor(method), {
      params: Promise.resolve({ id: "1" }),
    });
    answers.push({ method, status: response.status });
  }
  return answers;
}

let testerCookie = "";
let leadCookie = "";
let adminCookie = "";
let testerKey = "";
let adminKey = "";
let revokedKey = "";
let deactivatedKey = "";
let burstKey = "";
let caseId = 0;
let runId = 0;
let testId = 0;

beforeAll(async () => {
  const db = database.getDb();

  const signIn = (userId: number): string => {
    const { token, tokenHash } = createSessionToken();
    database.insertSession(db, {
      tokenHash,
      userId,
      expiresOn: database.nowSeconds() + 600,
      userAgent: null,
    });
    return token;
  };
  const passwordHash = await hashPassword("a long enough password");
  const tester = database.createUser(db, { email: "tester@example.com", role: "tester", passwordHash });
  const lead = database.createUser(db, { email: "lead@example.com", role: "lead", passwordHash });
  const admin = database.createUser(db, { email: "admin@example.com", role: "admin", passwordHash });
  const retired = database.createUser(db, { email: "retired@example.com", role: "admin", passwordHash });
  db.prepare("UPDATE users SET is_active = 0 WHERE id = ?").run(retired);

  testerCookie = signIn(tester);
  leadCookie = signIn(lead);
  adminCookie = signIn(admin);

  const mint = (userId: number, name: string): string => {
    const { key, keyHash } = createApiKey();
    database.insertApiKey(db, { userId, name, keyHash });
    return key;
  };
  testerKey = mint(tester, "tester ci");
  adminKey = mint(admin, "admin ci");
  deactivatedKey = mint(retired, "retired ci");
  burstKey = mint(admin, "burst ci");
  const { key, keyHash } = createApiKey();
  const revokedId = database.insertApiKey(db, { userId: admin, name: "old ci", keyHash });
  database.revokeApiKey(db, revokedId);
  revokedKey = key;

  const projectId = database.createProject(db, { name: "Checkout", suiteMode: 1 });
  const suiteId = database.createSuite(db, { projectId, name: "Suite" });
  const sectionId = database.createSection(db, { suiteId, name: "Section" });
  caseId = database.createCase(db, { suiteId, sectionId, title: "Card declines" });
  runId = database.createRun(db, { projectId, suiteId, name: "Nightly", includeAll: true });
  testId = database.listTests(db, runId).rows[0].id;
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("every route needs a credential", () => {
  it("finds the route files to sweep", () => {
    expect(routeFiles().length).toBeGreaterThan(20);
  });

  for (const file of routeFiles()) {
    it(`${file} answers 401 with no session and no key`, async () => {
      context.cookie = undefined;
      context.authorization = undefined;
      const answers = await callAll(file);
      expect(answers.length).toBeGreaterThan(0);
      for (const answer of answers) {
        expect({ file, ...answer }).toEqual({ file, method: answer.method, status: 401 });
      }
    });
  }

  it("refuses a session token that is not in the database", async () => {
    context.cookie = createSessionToken().token;
    context.authorization = undefined;
    const statuses = await import("@/app/api/statuses/route");
    expect((await statuses.GET()).status).toBe(401);
  });
});

describe("roles", () => {
  it("lets a tester read", async () => {
    context.cookie = testerCookie;
    const cases = await import("@/app/api/cases/route");
    const response = await cases.GET(new Request("http://localhost/api/cases?suiteId=1"));
    expect(response.status).toBe(200);
  });

  it("refuses a tester editing a case", async () => {
    context.cookie = testerCookie;
    const route = await import("@/app/api/cases/[id]/route");
    const response = await route.PATCH(
      new Request(`http://localhost/api/cases/${caseId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Renamed by a tester" }),
      }),
      { params: Promise.resolve({ id: String(caseId) }) },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "This needs the lead role or better" });
  });

  it("refuses a tester creating a run and lets a lead", async () => {
    const body = JSON.stringify({ projectId: 1, suiteId: 1, name: "From the API", includeAll: true });
    const route = await import("@/app/api/runs/route");
    const post = () =>
      route.POST(
        new Request("http://localhost/api/runs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
      );
    context.cookie = testerCookie;
    expect((await post()).status).toBe(403);
    context.cookie = leadCookie;
    expect((await post()).status).toBe(201);
  });

  it("keeps an import admin-only", async () => {
    const route = await import("@/app/api/migrate/route");
    context.cookie = leadCookie;
    expect((await route.GET(new Request("http://localhost/api/migrate"))).status).toBe(403);
    context.cookie = adminCookie;
    expect((await route.GET(new Request("http://localhost/api/migrate"))).status).toBe(200);
  });

  it("keeps deleting a run admin-only", async () => {
    const route = await import("@/app/api/runs/[id]/route");
    context.cookie = leadCookie;
    const response = await route.DELETE(new Request("http://localhost/api/runs/1", { method: "DELETE" }), {
      params: Promise.resolve({ id: String(runId) }),
    });
    expect(response.status).toBe(403);
  });

  it("lets a tester record a result, which is the job", async () => {
    context.cookie = testerCookie;
    const route = await import("@/app/api/results/route");
    const response = await route.POST(
      new Request("http://localhost/api/results", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ results: [{ testId, statusId: 1 }] }),
      }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ recorded: 1 });
  });
});

describe("API keys", () => {
  const statusesRequest = async () => {
    const route = await import("@/app/api/statuses/route");
    return route.GET();
  };

  it("authenticates a bearer key", async () => {
    context.cookie = undefined;
    context.authorization = `Bearer ${adminKey}`;
    expect((await statusesRequest()).status).toBe(200);
  });

  it("refuses a revoked key, a deactivated owner, and a made-up key", async () => {
    context.cookie = undefined;
    for (const key of [revokedKey, deactivatedKey, createApiKey().key]) {
      context.authorization = `Bearer ${key}`;
      expect((await statusesRequest()).status).toBe(401);
    }
  });

  it("gives a key exactly its owner's role", async () => {
    context.cookie = undefined;
    const route = await import("@/app/api/runs/route");
    const create = () =>
      route.POST(
        new Request("http://localhost/api/runs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: 1, suiteId: 1, name: "By key", includeAll: true }),
        }),
      );
    context.authorization = `Bearer ${testerKey}`;
    expect((await create()).status).toBe(403);
    context.authorization = `Bearer ${adminKey}`;
    expect((await create()).status).toBe(201);
  });

  it("records the key as used", async () => {
    context.cookie = undefined;
    context.authorization = `Bearer ${adminKey}`;
    await statusesRequest();
    const rows = database.listApiKeys(database.getDb(), {}).rows;
    const used = rows.find((row) => row.name === "admin ci");
    expect(used?.last_used_on).toBeGreaterThan(0);
  });

  it("never puts a key hash in a listing", () => {
    const rows = database.listApiKeys(database.getDb(), {}).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain("key_hash");
      expect(JSON.stringify(row)).not.toContain("mtk_");
    }
  });

  it("prefers a session cookie over a key, and never rate limits it", async () => {
    context.cookie = adminCookie;
    context.authorization = `Bearer ${revokedKey}`;
    expect((await statusesRequest()).status).toBe(200);
  });
});

describe("rate limiting", () => {
  it("answers 429 with a retry-after once a key burns its allowance", async () => {
    const route = await import("@/app/api/statuses/route");
    context.cookie = undefined;
    // A key of its own, so the spent allowance cannot leak into another test:
    // the window lives in the process, not the database.
    context.authorization = `Bearer ${burstKey}`;
    for (let request = 0; request < API_RATE_LIMIT; request += 1) {
      expect((await route.GET()).status).toBe(200);
    }
    const refused = await route.GET();
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await refused.json()).toEqual({ error: "Too many requests on this API key" });
  });
});

describe("results by case id", () => {
  const post = async (payload: unknown) => {
    const route = await import("@/app/api/results/route");
    return route.POST(
      new Request("http://localhost/api/results", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );
  };

  it("resolves a case id in a run to its test", async () => {
    context.cookie = testerCookie;
    context.authorization = undefined;
    const response = await post({ runId, results: [{ caseId, statusId: 1 }] });
    expect(response.status).toBe(201);
    const latest = database.listResults(database.getDb(), testId, { limit: 1 }).rows[0];
    expect(latest.status_id).toBe(1);
  });

  it("refuses a case that is not in the run", async () => {
    context.cookie = testerCookie;
    const response = await post({ runId, results: [{ caseId: caseId + 9999, statusId: 1 }] });
    expect(response.status).toBe(404);
  });

  it("refuses a case id with no run", async () => {
    context.cookie = testerCookie;
    const response = await post({ results: [{ caseId, statusId: 1 }] });
    expect(response.status).toBe(400);
  });

  it("refuses an entry naming both a test and a case", async () => {
    context.cookie = testerCookie;
    const response = await post({ runId, results: [{ testId, caseId, statusId: 1 }] });
    expect(response.status).toBe(400);
  });
});
