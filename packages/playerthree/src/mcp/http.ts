/** Minimal node:http ⇄ web-standard Request/Response bridging (no framework dependency). */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

export function toWebRequest(req: IncomingMessage, signal: AbortSignal): Request {
  const headers = new Headers();
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
  // The host only shapes the URL handed to the SDK; nothing is routed or authorized on it.
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  return new Request(url, {
    method,
    headers,
    signal,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' } : {}),
  } as RequestInit);
}

export async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  // SSE responses must reach the client frame by frame.
  if (response.headers.get('content-type')?.startsWith('text/event-stream')) res.flushHeaders();
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (res.destroyed) {
        await reader.cancel();
        break;
      }
      if (done) break;
      res.write(value);
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
}
