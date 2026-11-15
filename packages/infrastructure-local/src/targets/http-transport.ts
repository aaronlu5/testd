import {
  PlatformError,
  mapTargetFailure,
  type HttpTransport,
  type HttpTransportRequest,
  type HttpTransportResponse,
} from '@test-platform/core';

const readCapped = async (
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> => {
  if (!body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = maxBytes - total;
    if (value.byteLength > room) {
      if (room > 0) chunks.push(value.subarray(0, room));
      total += Math.max(room, 0);
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
};

/** `fetch` carries the cause (for example ECONNRESET) on `error.cause.code`. */
const failureFrom = (error: unknown): unknown => {
  const cause = (error as { cause?: unknown } | null)?.cause;
  return typeof cause === 'object' && cause !== null ? cause : error;
};

/**
 * HTTP transport over Node's `fetch`. Redirects are never followed (a redirect could leave the
 * approved host), the request is bounded by a timeout and the caller's signal, and the response
 * body is read only up to `maxResponseBytes`.
 */
export const createFetchHttpTransport = (fetchImpl: typeof fetch = fetch): HttpTransport => ({
  async send(request: HttpTransportRequest): Promise<HttpTransportResponse> {
    const timeout = AbortSignal.timeout(request.timeoutMs);
    const signal = AbortSignal.any([request.signal, timeout]);
    try {
      const response = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body ? { body: request.body } : {}),
        redirect: 'manual',
        signal,
      });
      const { bytes, truncated } = await readCapped(response.body, request.maxResponseBytes);
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
      return {
        status: response.status,
        statusText: response.statusText,
        headers,
        body: bytes,
        truncated,
      };
    } catch (error) {
      if (request.signal.aborted)
        throw new PlatformError('EXECUTION_CANCELLED', 'The request was cancelled.');
      if (timeout.aborted)
        throw new PlatformError(
          'TARGET_TIMEOUT',
          `The request timed out after ${request.timeoutMs} ms.`,
        );
      throw mapTargetFailure(failureFrom(error), 'HTTP request');
    }
  },
});
