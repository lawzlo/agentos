import fs from "node:fs/promises";
import path from "node:path";

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

export function json(res: any, statusCode: number, payload: unknown) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

export async function readJsonBody(req: any) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function serveStatic(publicDir: string, req: any, res: any) {
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
