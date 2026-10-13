/** Thin client for the Hirely API. Same-origin; the session lives in an httpOnly cookie. */

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: {
      ...(method !== "GET" ? { "x-hirely": "1" } : {}),
      ...(body !== undefined && !isForm ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const json = (await res.json()) as { error?: string; details?: string[] };
      message = json.details?.length ? `${json.error}: ${json.details.join("; ")}` : (json.error ?? message);
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(url: string) => request<T>("GET", url),
  post: <T = { ok: true }>(url: string, body?: unknown) => request<T>("POST", url, body ?? {}),
  put: <T = { ok: true }>(url: string, body: unknown) => request<T>("PUT", url, body),
  patch: <T = { ok: true }>(url: string, body: unknown) => request<T>("PATCH", url, body),
  del: <T = { ok: true }>(url: string) => request<T>("DELETE", url),
};

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");
