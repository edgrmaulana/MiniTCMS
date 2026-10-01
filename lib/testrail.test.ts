import { describe, expect, it } from "vitest";
import { TestRailError, createTestRailClient, testRailConfigFromEnv } from "./testrail";

const ENVIRONMENT = {
  TESTRAIL_HOST: "https://example.testrail.io/",
  TESTRAIL_USER: "importer@example.com",
  TESTRAIL_API_KEY: "fixture-value-not-a-secret",
};

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };

/* A fetch that answers from a script and records what it was asked for. */
function scriptedFetch(replies: Reply[]) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(String(url));
    const reply = replies.shift() ?? { status: 500 };
    return {
      ok: (reply.status ?? 200) < 400,
      status: reply.status ?? 200,
      headers: { get: (name: string) => reply.headers?.[name.toLowerCase()] ?? null },
      json: async () => reply.body,
      text: async () => JSON.stringify(reply.body ?? ""),
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function clientWith(replies: Reply[], extra: Record<string, unknown> = {}) {
  const { impl, calls } = scriptedFetch(replies);
  const client = createTestRailClient({
    ...testRailConfigFromEnv(ENVIRONMENT),
    fetchImpl: impl,
    wait: async () => {},
    ...extra,
  });
  return { client, calls };
}

describe("config", () => {
  it("names every missing variable at once", () => {
    expect(() => testRailConfigFromEnv({})).toThrow(
      /TESTRAIL_HOST, TESTRAIL_USER, TESTRAIL_API_KEY/,
    );
  });

  it("refuses a host with no scheme", () => {
    expect(() =>
      testRailConfigFromEnv({ ...ENVIRONMENT, TESTRAIL_HOST: "example.testrail.io" }),
    ).toThrow(TestRailError);
  });

  it("trims the trailing slash off the host", () => {
    expect(testRailConfigFromEnv(ENVIRONMENT).host).toBe("https://example.testrail.io");
  });
});

describe("request shape", () => {
  it("puts the method after ?/ and appends params with &", async () => {
    const { client, calls } = clientWith([{ body: { id: 1 } }]);
    await client.get("get_case/7", { with_data: "1" });
    expect(calls[0]).toBe(
      "https://example.testrail.io/index.php?/api/v2/get_case/7&with_data=1",
    );
  });
});

describe("pagination", () => {
  it("follows _links.next to the end", async () => {
    const page = (ids: number[], next: string | null) => ({
      body: { offset: 0, limit: 2, size: ids.length, _links: { next }, cases: ids.map((id) => ({ id })) },
    });
    const { client, calls } = clientWith([
      page([1, 2], "/api/v2/get_cases/1&limit=2&offset=2"),
      page([3, 4], "/api/v2/get_cases/1&limit=2&offset=4"),
      page([5], null),
    ]);
    const cases = await client.getAll<{ id: number }>("get_cases/1", "cases", { limit: 2 });
    expect(cases.map((row) => row.id)).toEqual([1, 2, 3, 4, 5]);
    expect(calls[1]).toBe("https://example.testrail.io/index.php?/api/v2/get_cases/1&limit=2&offset=2");
  });

  it("accepts a bare array from a pre-6.7 instance", async () => {
    const { client, calls } = clientWith([{ body: [{ id: 9 }, { id: 10 }] }]);
    const rows = await client.getAll<{ id: number }>("get_suites/1", "suites");
    expect(rows.map((row) => row.id)).toEqual([9, 10]);
    expect(calls).toHaveLength(1);
  });

  it("fails loud when the collection key is not there", async () => {
    const { client } = clientWith([{ body: { offset: 0, something_else: [] } }]);
    await expect(client.getAll("get_cases/1", "cases")).rejects.toThrow(/"cases" array/);
  });
});

describe("retry", () => {
  it("honours Retry-After on a 429 and then succeeds", async () => {
    const slept: number[] = [];
    const { client, calls } = clientWith(
      [
        { status: 429, headers: { "retry-after": "2" } },
        { body: { id: 1 } },
      ],
      { wait: async (millis: number) => void slept.push(millis) },
    );
    await client.get("get_case/1");
    expect(calls).toHaveLength(2);
    expect(slept).toContain(2000);
  });

  it("backs off on a 5xx and gives up with the method in the message", async () => {
    const { client, calls } = clientWith([
      { status: 503 },
      { status: 503 },
      { status: 503 },
      { status: 503 },
      { status: 503 },
    ]);
    await expect(client.get("get_cases/1")).rejects.toThrow(/get_cases\/1 gave up after 5 attempts/);
    expect(calls).toHaveLength(5);
  });

  it("does not retry a 400", async () => {
    const { client, calls } = clientWith([{ status: 400, body: { error: "Field :suite_id is not valid" } }]);
    await expect(client.get("get_cases/1")).rejects.toThrow(/400/);
    expect(calls).toHaveLength(1);
  });

  it("keeps the api key out of the error text", async () => {
    const { client } = clientWith([{ status: 403, body: { error: "no" } }]);
    await expect(client.get("get_cases/1")).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("fixture-value-not-a-secret") }),
    );
  });
});
