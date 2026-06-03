// 16add: Smoke test — verify built CLI starts and basic flags work
type RunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

await assertCommand(["dist/ccmini", "--version"], output => {
  if (!output.stdout.includes("Claude Code Mini")) {
    throw new Error("version output does not include product name");
  }
});

await assertCommand(["dist/ccmini", "--help"], output => {
  if (!output.stdout.includes("Usage")) {
    throw new Error("help output does not include Usage");
  }
});

console.log("smoke test passed");

async function assertCommand(
  command: string[],
  assertOutput: (output: RunResult) => void,
): Promise<void> {
  const result = await run(command);

  if (result.exitCode !== 0) {
    throw new Error(
      [
        `Command failed: ${command.join(" ")}`,
        `exitCode: ${result.exitCode}`,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  assertOutput(result);
}

async function run(command: string[]): Promise<RunResult> {
  const proc = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}
