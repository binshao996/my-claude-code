import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const distDir = join(root, "dist");
const assetsDir = join(distDir, "assets");

await rm(distDir, { force: true, recursive: true });
await mkdir(assetsDir, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(root, "src/main.tsx")],
  outdir: assetsDir,
  target: "browser",
  sourcemap: "external",
  naming: {
    entry: "[name].[ext]",
    asset: "[name].[ext]",
  },
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

await writeFile(
  join(distDir, "index.html"),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Claude Code Client</title>
    <link rel="stylesheet" href="/assets/main.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/assets/main.js"></script>
  </body>
</html>
`,
);

console.log("built dist/index.html");
