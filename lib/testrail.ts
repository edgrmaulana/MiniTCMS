/*
  The TestRail API v2 client. One module, one fetch, one auth path, one
  pagination helper - nothing else in the repo talks to TestRail
  (AGENTS.md rule 6).

  Credentials come from the environment only. They are never logged, never
  put in an error message and never written to the import report.
*/

export class TestRailError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export type TestRailConfig = {
  host: string;
  user: string;
  apiKey: string;
  /* A full import of a large instance is tens of thousands of calls, and
     the usual way it dies is the account hitting TestRail's rate limit
     halfway through. */
  requestsPerSecond: number;
  maxAttempts: number;
  /* Injected so the retry tests do not spend real seconds asleep. */
  wait: (millis: number) => Promise<void>;
  fetchImpl: typeof fetch;
};

export const DEFAULT_REQUESTS_PER_SECOND = 5;
export const DEFAULT_MAX_ATTEMPTS = 5;

/*
  A page bound rather than a `while (true)`. TestRail's `_links.next` is
  built from the offset it was given, and an instance that echoes the same
  offset back would otherwise spin forever on one collection.
*/
const MAX_PAGES = 10_000;

export function testRailConfigFromEnv(
  environment: Record<string, string | undefined> = process.env,
): TestRailConfig {
  const host = environment.TESTRAIL_HOST?.trim();
  const user = environment.TESTRAIL_USER?.trim();
  const apiKey = environment.TESTRAIL_API_KEY?.trim();

  const missing = [
    host ? null : "TESTRAIL_HOST",
    user ? null : "TESTRAIL_USER",
    apiKey ? null : "TESTRAIL_API_KEY",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new TestRailError(`Missing environment variables: ${missing.join(", ")}`, 0);
  }
  if (!/^https?:\/\//.test(host as string)) {
    throw new TestRailError(`TESTRAIL_HOST must start with http:// or https://`, 0);
  }

  const rps = Number(environment.TESTRAIL_RPS ?? DEFAULT_REQUESTS_PER_SECOND);
  return {
    host: (host as string).replace(/\/+$/, ""),
    user: user as string,
    apiKey: apiKey as string,
    requestsPerSecond: Number.isFinite(rps) && rps > 0 ? rps : DEFAULT_REQUESTS_PER_SECOND,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    wait: (millis) => new Promise((resolve) => setTimeout(resolve, millis)),
    fetchImpl: fetch,
  };
}

export type TestRailClient = {
  get<Response>(method: string, params?: Record<string, string | number>): Promise<Response>;
  /* The only list helper. `collection` is the key the rows live under in a
     6.7+ response; older versions answer with a bare array. */
  getAll<Row>(
    method: string,
    collection: string,
    params?: Record<string, string | number>,
  ): Promise<Row[]>;
};

export function testRailClientFromEnv(
  overrides: Partial<TestRailConfig> = {},
): TestRailClient {
  return createTestRailClient({ ...testRailConfigFromEnv(), ...overrides });
}

export function createTestRailClient(config: TestRailConfig): TestRailClient {
  const authorisation = `Basic ${Buffer.from(`${config.user}:${config.apiKey}`).toString("base64")}`;
  const minimumGap = 1000 / config.requestsPerSecond;
  let nextSlot = 0;

  /*
    TestRail's URL shape is not a typo: the method sits in the query string
    after `?/`, so every extra parameter appends with `&`, never `?`.
  */
  const urlFor = (method: string, params: Record<string, string | number> = {}): string => {
    const query = Object.entries(params)
      .map(([name, value]) => `&${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`)
      .join("");
    return `${config.host}/index.php?/api/v2/${method}${query}`;
  };

  const throttle = async (): Promise<void> => {
    const now = Date.now();
    const waitFor = Math.max(0, nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + minimumGap;
    if (waitFor > 0) await config.wait(waitFor);
  };

  const requestUrl = async <Response>(url: string, describe: string): Promise<Response> => {
    let lastComplaint = "";
    for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
      await throttle();
      const response = await config.fetchImpl(url, {
        headers: { Authorization: authorisation, "Content-Type": "application/json" },
      });

      if (response.ok) return (await response.json()) as Response;

      // The server said when to come back; believe it over our own backoff.
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after"));
        lastComplaint = "rate limited (429)";
        await config.wait(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
        continue;
      }
      if (response.status >= 500) {
        lastComplaint = `server error (${response.status})`;
        await config.wait(backoff(attempt));
        continue;
      }
      // 4xx other than 429 will not get better by being asked again.
      throw new TestRailError(
        `${describe} failed: ${response.status} ${await safeBody(response)}`,
        response.status,
      );
    }
    throw new TestRailError(
      `${describe} gave up after ${config.maxAttempts} attempts: ${lastComplaint}`,
      0,
    );
  };

  return {
    get: (method, params) => requestUrl(urlFor(method, params), `${method}`),

    async getAll<Row>(
      method: string,
      collection: string,
      params: Record<string, string | number> = {},
    ): Promise<Row[]> {
      const rows: Row[] = [];
      let url: string | null = urlFor(method, params);

      for (let page = 0; url !== null && page < MAX_PAGES; page += 1) {
        const body = await requestUrl<unknown>(url, `${method} page ${page + 1}`);

        // TestRail before 6.7 answers a list call with a bare array.
        if (Array.isArray(body)) return body as Row[];

        const envelope = body as Record<string, unknown> & {
          _links?: { next?: string | null };
        };
        const chunk = envelope[collection];
        if (!Array.isArray(chunk)) {
          throw new TestRailError(
            `${method} answered without a "${collection}" array; got ${Object.keys(envelope).join(", ")}`,
            0,
          );
        }
        rows.push(...(chunk as Row[]));

        const next = envelope._links?.next;
        // `next` is relative and already starts with /api/v2/, so it slots
        // in after the `?` the same way the method does.
        url = next ? `${config.host}/index.php?${next.replace(/^\/+/, "/")}` : null;
      }
      return rows;
    },
  };
}

function backoff(attempt: number): number {
  return Math.min(30_000, 500 * 2 ** (attempt - 1));
}

/* An error body is for the log, so a non-JSON one must not throw over the
   real failure. */
async function safeBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return "<unreadable body>";
  }
}
