import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

export function json(res: ServerResponse<IncomingMessage>, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

export async function readJsonBody<TBody = Record<string, unknown>>(
  req: IncomingMessage
): Promise<TBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (!chunks.length) {
    return {} as TBody;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as TBody;
}

export async function serveStatic(
  publicDir: string,
  req: IncomingMessage,
  res: ServerResponse<IncomingMessage>
): Promise<boolean> {
  const url = new URL(req.url, "http://localhost");
  const target = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.join(publicDir, target);

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      json(res, 404, { error: "Not found" });
      return true;
    }

    const extension = path.extname(filePath);
    res.writeHead(200, {
      "content-type": STATIC_CONTENT_TYPES[extension] ?? "application/octet-stream"
    });
    res.end(await fs.readFile(filePath));
    return true;
  } catch {
    json(res, 404, { error: "Not found" });
    return true;
  }
}
