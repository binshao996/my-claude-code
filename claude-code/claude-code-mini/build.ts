// 16add: Bun build script — outputs dist/cli.js + dist/ccmini executable
import { chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const outdir = "dist";

await rm(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["src/entrypoints/cli.ts"],
  outdir,
  target: "bun",
  splitting: true,
  sourcemap: "linked",
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});

if (!result.success) {
  console.error("Build failed:");

  for (const log of result.logs) {
    console.error(log);
  }

  process.exit(1);
}

const executablePath = join(outdir, "ccmini");

await writeFile(
  executablePath,
  "#!/usr/bin/env bun\nimport './cli.js';\n",
);

await chmod(executablePath, 0o755);

console.log(`Built ${result.outputs.length} files into ${outdir}/`);
console.log(`Generated ${executablePath}`);
