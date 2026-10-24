// Minimal JSON client for the app's API, authenticated with a bot session cookie.
// Does not throw on HTTP error statuses (some are expected); network errors do throw.

export async function apiRequest(baseUrl, cookie, method, path, body) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      cookie,
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const isJson = response.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await response.json() : null;
  return { status: response.status, ok: response.ok, data };
}

export function apiError(what, { status, data }) {
  return new Error(`${what} failed: HTTP ${status}${data?.error ? ` (${data.error})` : ''}`);
}

// fetch() reports only "fetch failed"; the reason is in err.cause.
export function describeError(err) {
  return `${err.message}${err.cause ? ` (${err.cause.code ?? err.cause.message})` : ''}`;
}
