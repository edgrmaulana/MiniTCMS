// The one place a client component talks to /api/*. Routes answer errors as
// {"error": "..."} (app/api/helpers.ts), so the message a user sees is the
// message the route chose rather than a bare status code.
export class HttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export async function fetchJson<Payload>(url: string, init?: RequestInit): Promise<Payload> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) {
    // The status rides along: a screen that needs to tell "you may not" from
    // "it broke" must not have to match words in a sentence to do it.
    throw new HttpError(body?.error ?? `Request failed with ${response.status}`, response.status);
  }
  return body as Payload;
}

export function postJson<Payload>(url: string, payload: unknown): Promise<Payload> {
  return fetchJson<Payload>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}
