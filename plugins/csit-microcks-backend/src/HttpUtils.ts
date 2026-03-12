export type FetchWithTimeout = (
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
) => Promise<Response>;

function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }

  return String(e);
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (controller.signal.aborted) {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }

    const msg = errorMessage(e);
    throw new Error(`${label} failed: ${msg}`);
  } finally {
    clearTimeout(t);
  }
}