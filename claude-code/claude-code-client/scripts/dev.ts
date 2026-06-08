import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const useDist = process.argv.includes("--dist");
const port = Number(process.env.PORT ?? 5174);

if (useDist && !existsSync(join(root, "dist/index.html"))) {
  console.error("dist/index.html not found. Run bun run build first.");
  process.exit(1);
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url);

    if (useDist) {
      return serveFile(join(root, "dist"), url.pathname);
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = await readFile(join(root, "index.html"), "utf8");
      return htmlResponse(html);
    }

    if (url.pathname.startsWith("/src/")) {
      const built = await Bun.build({
        entrypoints: [join(root, url.pathname)],
        target: "browser",
        write: false,
        sourcemap: "inline",
      });

      if (!built.success || !built.outputs[0]) {
        return new Response("Build failed", { status: 500 });
      }

      return new Response(await built.outputs[0].text(), {
        headers: { "content-type": contentType(url.pathname) },
      });
    }

    return serveFile(root, url.pathname);
  },
});

console.log(`Claude Code Client running at http://${server.hostname}:${server.port}/`);

async function serveFile(baseDir: string, pathname: string): Promise<Response> {
  const safePath = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = join(baseDir, safePath === "/" ? "index.html" : safePath);

  if (!existsSync(filePath)) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(await readFile(filePath), {
    headers: { "content-type": contentType(filePath) },
  });
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function contentType(pathname: string): string {
  switch (extname(pathname)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".tsx":
    case ".ts":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}
