// 16add: Quality gate orchestrator — run typecheck → test → build → check:dist → smoke
type Step = {
  name: string;
  command: string[];
};

const steps: Step[] = [
  { name: "typecheck", command: ["bun", "run", "typecheck"] },
  { name: "test", command: ["bun", "test"] },
  { name: "build", command: ["bun", "run", "build"] },
  { name: "check:dist", command: ["bun", "run", "check:dist"] },
  { name: "smoke", command: ["bun", "run", "smoke"] },
];

for (const step of steps) {
  await runStep(step);
}

console.log("");
console.log("All quality checks passed.");

async function runStep(step: Step): Promise<void> {
  console.log("");
  console.log(`▶ ${step.name}`);

  const startedAt = Date.now();
  const proc = Bun.spawn(step.command, {
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;
  const durationMs = Date.now() - startedAt;

  if (exitCode !== 0) {
    console.error(`✗ ${step.name} failed in ${durationMs}ms`);
    process.exit(exitCode);
  }

  console.log(`✓ ${step.name} passed in ${durationMs}ms`);
}
