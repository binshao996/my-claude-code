# 第 54 章：Environment Runner、BYOC 与远程工作区调度

第 53 章补完了 daemon supervisor：

```txt
长期进程
environment 注册
work queue
capacity
heartbeat
session child lifecycle
token refresh re-dispatch
```

这让本机能够长期接单。

但真正接到一个远程任务后，还缺一层：

```txt
任务到底在哪个目录跑？
仓库如何准备？
分支如何 checkout？
附件文件如何下载？
环境变量如何注入？
session token 过期后如何刷新？
模型子进程如何带着 CCR v2 启动？
输出文件如何回传？
自托管 runner 如何轮询远端？
```

第 53 章解决的是“谁接单”。

本章解决的是“接单后怎么准备可执行环境”。

到本章结束，你的 Mini 会具备：

- `environment-runner` fast path
- `self-hosted-runner` fast path
- Work Secret v2 解析
- source checkout
- workspace root 隔离
- session 目录隔离
- uploads 目录准备
- outputs 目录准备
- `--file` 附件下载协议
- BYOC 环境变量注入
- CCR v2 远程 IO 启动参数
- runner version header
- `update_environment_variables` 运行期刷新
- session access token refresh
- file persistence 扫描与上传
- remote setup 的凭据导入流程
- 自托管 runner 注册、轮询、ack、complete
- 远程工作区生命周期清理

本章会把远程控制从：

```txt
daemon 能接到 work item
```

推进到：

```txt
daemon 能把 work item 放进一个真实仓库目录里执行，并把输入输出同步回远端
```

## 参考源码

本章参考这些真实模块：

```txt
src/entrypoints/cli.tsx
src/environment-runner/main.ts
src/self-hosted-runner/main.ts

src/commands/remote-setup/index.ts
src/commands/remote-setup/api.ts
src/commands/remote-setup/remote-setup.tsx

src/cli/remoteIO.ts
src/cli/structuredIO.ts
src/entrypoints/sdk/controlSchemas.ts
src/entrypoints/sdk/controlTypes.ts
src/entrypoints/sdk/coreSchemas.ts

src/main.tsx
src/services/api/filesApi.ts
src/utils/filePersistence/filePersistence.ts
src/utils/filePersistence/outputsScanner.ts
src/utils/filePersistence/types.ts

docs/features/tier3-stubs.md
```

当前源码里有一个现实状态：

```txt
src/environment-runner/main.ts
src/self-hosted-runner/main.ts
```

这两个文件目前仍是 stub。

但入口已经接好了：

```txt
claude environment-runner
claude self-hosted-runner
```

并且已有这些可复用能力：

```txt
remote setup
Files API download / upload
--file startup download
BYOC file persistence
update_environment_variables control message
RemoteIO runner version header
CCR v2 transport
```

所以本章不是凭空设计新系统，而是把已有的入口和协议补成 Mini 可运行版本。

## 真实入口

`src/entrypoints/cli.tsx` 已经有两个 fast path：

```ts
if (feature('BYOC_ENVIRONMENT_RUNNER') && args[0] === 'environment-runner') {
  profileCheckpoint('cli_environment_runner_path');
  const { environmentRunnerMain } = await import('../environment-runner/main.js');
  await environmentRunnerMain(args.slice(1));
  return;
}

if (feature('SELF_HOSTED_RUNNER') && args[0] === 'self-hosted-runner') {
  profileCheckpoint('cli_self_hosted_runner_path');
  const { selfHostedRunnerMain } = await import('../self-hosted-runner/main.js');
  await selfHostedRunnerMain(args.slice(1));
  return;
}
```

这个设计很重要。

Runner 不能走完整 interactive CLI 的启动路径。

原因是：

```txt
runner 是 headless worker
runner 启动时还没有用户输入
runner 需要先拿 work，再 spawn 真正的 Claude Code child
runner 不应该加载 REPL UI
runner 的生命周期由远端 work queue 驱动
```

因此入口必须放在 `main.tsx` 之前。

这是本章 Mini 的第一个硬约束：

```txt
environment-runner 和 self-hosted-runner 必须是轻量入口。
不要让它们先加载完整 CLI。
```

## 真实运行期协议

现有源码已经暴露了几条关键协议。

第一条：RemoteIO 会带 runner version header。

`src/cli/remoteIO.ts`：

```ts
const erVersion = process.env.CLAUDE_CODE_ENVIRONMENT_RUNNER_VERSION;
if (erVersion) {
  headers['x-environment-runner-version'] = erVersion;
}
```

并且 reconnect 时重新读取：

```ts
const freshErVersion = process.env.CLAUDE_CODE_ENVIRONMENT_RUNNER_VERSION;
if (freshErVersion) {
  h['x-environment-runner-version'] = freshErVersion;
}
```

第二条：StructuredIO 能处理环境变量刷新。

`src/cli/structuredIO.ts`：

```ts
if (message.type === 'update_environment_variables') {
  const variables = message.variables ?? {};
  const keys = Object.keys(variables);
  for (const [key, value] of Object.entries(variables)) {
    process.env[key] = value;
  }
  logForDebugging(
    `[structuredIO] applied update_environment_variables: ${keys.join(', ')}`,
  );
  return undefined;
}
```

第三条：SDK stdin schema 已经注册了这个消息。

`src/entrypoints/sdk/controlSchemas.ts`：

```ts
export const SDKUpdateEnvironmentVariablesMessageSchema = lazySchema(() =>
  z
    .object({
      type: z.literal('update_environment_variables'),
      variables: z.record(z.string(), z.string()),
    })
    .describe('Updates environment variables at runtime.'),
);
```

第四条：BYOC 文件回传只在特定环境启用。

`src/utils/filePersistence/filePersistence.ts`：

```ts
export function isFilePersistenceEnabled(): boolean {
  if (feature('FILE_PERSISTENCE')) {
    return (
      getEnvironmentKind() === 'byoc' &&
      !!getSessionIngressAuthToken() &&
      !!process.env.CLAUDE_CODE_REMOTE_SESSION_ID
    );
  }
  return false;
}
```

第五条：BYOC 判断来自环境变量。

`src/utils/filePersistence/outputsScanner.ts`：

```ts
export function getEnvironmentKind(): EnvironmentKind | null {
  const kind = process.env.CLAUDE_CODE_ENVIRONMENT_KIND;
  if (kind === 'byoc' || kind === 'anthropic_cloud') {
    return kind;
  }
  return null;
}
```

第六条：文件下载入口已经挂到主 CLI。

`src/main.tsx`：

```ts
.option(
  '--file <specs...>',
  'File resources to download at startup. Format: file_id:relative_path (e.g., --file file_abc:doc.txt file_def:img.png)',
)
```

启动时会读取 session token，然后调用：

```ts
downloadSessionFiles(files, config);
```

这说明 environment runner 不必自己实现附件下载。

它只需要 spawn child 时把 `--file` 参数传进去。

## 总体架构

第 54 章最终链路如下：

```txt
RCS / Claude Web
  -> create session
  -> create work item
  -> encrypt work secret

daemon remoteControl worker
  -> poll work
  -> ack
  -> hand work secret to environment-runner

environment-runner
  -> parse work secret
  -> prepare workspace
  -> checkout source
  -> prepare uploads / outputs
  -> spawn child Claude Code
  -> send update_environment_variables when token refreshes
  -> wait child exit
  -> run file persistence path through child
  -> complete work

child Claude Code
  -> remote IO
  -> CCR v2
  -> Files API download / upload
  -> structured stdout / stdin
```

Runner 的边界要清楚：

```txt
RCS 负责排队、租约、session token。
daemon 负责长期接单和 capacity。
environment-runner 负责 workspace 和 child process。
child CLI 负责真实对话、工具、CCR v2、文件同步。
```

不要把这些职责混在一个文件里。

否则后续排障会非常痛苦：

```txt
session 没启动
  是 work queue 问题？
  是 checkout 问题？
  是 token 问题？
  是 child crash？
  是 CCR v2 reconnect？
```

分层之后，每层都有独立日志和测试。

## 最终目录

本章建议把 Mini 拆成这些文件：

```txt
src/environment-runner/main.ts
src/environment-runner/types.ts
src/environment-runner/args.ts
src/environment-runner/secrets.ts
src/environment-runner/api.ts
src/environment-runner/workspace.ts
src/environment-runner/gitSource.ts
src/environment-runner/env.ts
src/environment-runner/files.ts
src/environment-runner/sessionExecutor.ts
src/environment-runner/lifecycle.ts

src/self-hosted-runner/main.ts
src/self-hosted-runner/config.ts
src/self-hosted-runner/api.ts
src/self-hosted-runner/pollLoop.ts

src/commands/remote-setup/api.ts
src/commands/remote-setup/remote-setup.tsx

src/utils/filePersistence/filePersistence.ts
src/utils/filePersistence/outputsScanner.ts
src/services/api/filesApi.ts
```

其中已有文件继续复用。

新增实现集中在：

```txt
src/environment-runner/*
src/self-hosted-runner/*
```

## 概念模型

先定义几个对象：

```txt
Environment
  一台可执行远程任务的运行环境

Runner
  这台环境里的常驻进程

Work Item
  一个待执行 session

Work Secret
  执行 session 所需的敏感配置

Workspace
  本地磁盘上为一个 session 准备的目录

Child CLI
  真正运行 Claude Code 的子进程
```

关系如下：

```txt
environment
  has many work items over time

work item
  has one work secret
  has one remote session id
  has one workspace dir while running
  has one child process while active

workspace dir
  contains repo checkout
  contains uploads
  contains outputs
```

目录约定如下：

```txt
runnerRoot/
  environments/
    env_123/
      sessions/
        sess_abc/
          repo/
          sess_abc/
            uploads/
            .claude-code/
              outputs/
          runner-state.json
```

这里有一个细节：

现有 Files API 下载路径使用：

```txt
{cwd}/{session_id}/uploads
```

现有 file persistence 上传路径使用：

```txt
{cwd}/{session_id}/.claude-code/outputs
```

所以 child 的 cwd 应该是 session workspace 的上层：

```txt
cwd = .../sessions/sess_abc/repo
```

如果 repo 就是 cwd，那么文件路径会变成：

```txt
repo/sess_abc/uploads
repo/sess_abc/.claude-code/outputs
```

这和现有实现兼容。

如果你希望 uploads / outputs 放在 repo 外，就必须改 Files API 路径函数。

Mini 先不要改。

## Work Secret

第 53 章已经有 Work Secret 的雏形。

本章把它扩展成可执行结构：

```ts
export type EnvironmentKind = 'byoc' | 'anthropic_cloud';

export type GitSource = {
  type: 'git';
  remoteUrl: string;
  ref?: string;
  branch?: string;
  commit?: string;
  shallow?: boolean;
};

export type FileAttachment = {
  fileId: string;
  relativePath: string;
};

export type WorkSecretV2 = {
  version: 2;
  workId: string;
  sessionId: string;
  streamUrl: string;
  sessionAccessToken: string;
  organizationId?: string;
  environmentId: string;
  environmentKind: EnvironmentKind;
  source: GitSource;
  prompt?: string;
  model?: string;
  permissionMode?: string;
  claudeCodeArgs?: string[];
  files?: FileAttachment[];
  environmentVariables?: Record<string, string>;
  runnerVersion?: string;
  workerEpoch?: number;
};
```

字段含义：

| 字段 | 作用 |
| --- | --- |
| `workId` | work queue 里的租约对象 |
| `sessionId` | 远端 session id |
| `streamUrl` | child 连接 CCR / session ingress 的 URL |
| `sessionAccessToken` | child 访问 session 的 bearer token |
| `environmentId` | 当前 runner 对应的远程环境 |
| `environmentKind` | `byoc` 时启用本地 outputs 上传 |
| `source` | 仓库来源 |
| `files` | 启动前下载的附件 |
| `environmentVariables` | 注入给 child 的环境变量 |
| `runnerVersion` | RemoteIO header 使用 |
| `workerEpoch` | CCR v2 worker 身份 |

注意：

```txt
secret 里可以有 token。
日志里永远不要输出 secret 原文。
```

所以解析结果也不要随手 `JSON.stringify`。

## Secret Redaction

先做一个很小的 redaction helper：

```ts
const SECRET_KEYS = [
  'token',
  'secret',
  'authorization',
  'sessionAccessToken',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
] as const;

export function redactValue(key: string, value: string): string {
  const lower = key.toLowerCase();
  if (SECRET_KEYS.some(part => lower.includes(part.toLowerCase()))) {
    return '[REDACTED]';
  }
  return value;
}

export function redactRecord(
  record: Record<string, string>,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    next[key] = redactValue(key, value);
  }
  return next;
}
```

测试要覆盖：

```txt
sessionAccessToken 被隐藏
ANTHROPIC_AUTH_TOKEN 被隐藏
普通变量保留
大小写不影响判断
```

## Secret Parser

Runner 可以从文件、stdin 或环境变量拿 secret。

Mini 先支持三种输入：

```txt
--secret-file path
--secret-json base64-json
stdin
```

实现：

```ts
import { readFile } from 'fs/promises';

export type RunnerArgs = {
  secretFile?: string;
  secretJson?: string;
  once: boolean;
  workspaceRoot: string;
};

export function parseRunnerArgs(args: string[]): RunnerArgs {
  const parsed: RunnerArgs = {
    once: false,
    workspaceRoot: process.env.CLAUDE_CODE_RUNNER_ROOT ?? '.claude-runner',
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--once') {
      parsed.once = true;
      continue;
    }
    if (arg === '--workspace-root') {
      parsed.workspaceRoot = requireValue(args, index);
      index += 1;
      continue;
    }
    if (arg === '--secret-file') {
      parsed.secretFile = requireValue(args, index);
      index += 1;
      continue;
    }
    if (arg === '--secret-json') {
      parsed.secretJson = requireValue(args, index);
      index += 1;
      continue;
    }
    throw new Error(`Unknown environment-runner argument: ${arg}`);
  }

  return parsed;
}

function requireValue(args: string[], index: number): string {
  const value = args[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${args[index]}`);
  }
  return value;
}

export async function readSecretInput(args: RunnerArgs): Promise<string> {
  if (args.secretFile) {
    return await readFile(args.secretFile, 'utf8');
  }

  if (args.secretJson) {
    return Buffer.from(args.secretJson, 'base64url').toString('utf8');
  }

  return await readAllStdin();
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}
```

不要为了方便把 secret 放进命令行日志。

命令行参数会被系统进程列表看到。

生产环境更适合：

```txt
stdin
短期文件
父进程管道
```

`--secret-json` 只适合本地测试。

## Secret Validation

不要直接信任远端传入的 JSON。

Mini 可以用显式 type guard：

```ts
export function parseWorkSecret(raw: string): WorkSecretV2 {
  const value = JSON.parse(raw) as unknown;
  if (!isRecord(value)) {
    throw new Error('Work secret must be an object');
  }

  const version = value.version;
  if (version !== 2) {
    throw new Error('Unsupported work secret version');
  }

  const source = value.source;
  if (!isRecord(source) || source.type !== 'git') {
    throw new Error('Work secret requires a git source');
  }

  return {
    version: 2,
    workId: requireString(value, 'workId'),
    sessionId: requireString(value, 'sessionId'),
    streamUrl: requireString(value, 'streamUrl'),
    sessionAccessToken: requireString(value, 'sessionAccessToken'),
    organizationId: optionalString(value, 'organizationId'),
    environmentId: requireString(value, 'environmentId'),
    environmentKind: requireEnvironmentKind(value.environmentKind),
    source: {
      type: 'git',
      remoteUrl: requireString(source, 'remoteUrl'),
      ref: optionalString(source, 'ref'),
      branch: optionalString(source, 'branch'),
      commit: optionalString(source, 'commit'),
      shallow: typeof source.shallow === 'boolean' ? source.shallow : true,
    },
    prompt: optionalString(value, 'prompt'),
    model: optionalString(value, 'model'),
    permissionMode: optionalString(value, 'permissionMode'),
    claudeCodeArgs: optionalStringArray(value, 'claudeCodeArgs'),
    files: optionalFiles(value.files),
    environmentVariables: optionalStringRecord(value.environmentVariables),
    runnerVersion: optionalString(value, 'runnerVersion'),
    workerEpoch:
      typeof value.workerEpoch === 'number' ? value.workerEpoch : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(
  value: Record<string, unknown>,
  key: string,
): string {
  const next = value[key];
  if (typeof next !== 'string' || next.length === 0) {
    throw new Error(`Missing required string: ${key}`);
  }
  return next;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const next = value[key];
  if (next === undefined || next === null) {
    return undefined;
  }
  if (typeof next !== 'string') {
    throw new Error(`Invalid string: ${key}`);
  }
  return next;
}

function requireEnvironmentKind(value: unknown): EnvironmentKind {
  if (value === 'byoc' || value === 'anthropic_cloud') {
    return value;
  }
  throw new Error('Invalid environment kind');
}
```

文件附件解析：

```ts
function optionalFiles(value: unknown): FileAttachment[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error('files must be an array');
  }

  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`files[${index}] must be an object`);
    }
    return {
      fileId: requireString(item, 'fileId'),
      relativePath: requireString(item, 'relativePath'),
    };
  });
}

function optionalStringArray(
  value: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const next = value[key];
  if (next === undefined || next === null) {
    return undefined;
  }
  if (!Array.isArray(next) || next.some(item => typeof item !== 'string')) {
    throw new Error(`Invalid string array: ${key}`);
  }
  return [...next];
}

function optionalStringRecord(value: unknown): Record<string, string> {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error('environmentVariables must be an object');
  }

  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val !== 'string') {
      throw new Error(`environment variable ${key} must be a string`);
    }
    result[key] = val;
  }
  return result;
}
```

这里不用宽松解析。

Runner 是执行层，输入错了要快速失败。

## Workspace Root

workspace root 必须满足几个要求：

```txt
可配置
默认在用户数据目录或当前目录下
每个 environment 隔离
每个 session 隔离
禁止路径穿越
清理时只能删自己的 session 目录
```

实现：

```ts
import { mkdir, rm } from 'fs/promises';
import { resolve, relative, join } from 'path';

export type WorkspaceLayout = {
  root: string;
  environmentDir: string;
  sessionDir: string;
  repoDir: string;
  stateFile: string;
};

export async function prepareWorkspaceLayout(input: {
  workspaceRoot: string;
  environmentId: string;
  sessionId: string;
}): Promise<WorkspaceLayout> {
  const root = resolve(input.workspaceRoot);
  const environmentDir = safeJoin(root, 'environments', input.environmentId);
  const sessionDir = safeJoin(environmentDir, 'sessions', input.sessionId);
  const repoDir = safeJoin(sessionDir, 'repo');
  const stateFile = safeJoin(sessionDir, 'runner-state.json');

  await mkdir(repoDir, { recursive: true });

  return {
    root,
    environmentDir,
    sessionDir,
    repoDir,
    stateFile,
  };
}

export function safeJoin(root: string, ...parts: string[]): string {
  const target = resolve(root, ...parts);
  const rel = relative(root, target);
  if (rel.startsWith('..') || rel === '..') {
    throw new Error(`Path escapes workspace root: ${target}`);
  }
  return target;
}

export async function removeSessionDir(layout: WorkspaceLayout): Promise<void> {
  const rel = relative(layout.root, layout.sessionDir);
  if (rel.startsWith('..') || rel === '..' || rel.length === 0) {
    throw new Error('Refusing to remove path outside runner root');
  }
  await rm(layout.sessionDir, { recursive: true, force: true });
}
```

不要把 cleanup 写成：

```ts
await rm(workspaceRoot, { recursive: true, force: true });
```

runner root 可能还有其他 session。

只能删当前 session 目录。

## Git Source

Mini 只实现 git source。

原因：

```txt
官方远程工作区核心就是从代码托管平台准备仓库。
其他来源可以后续扩展。
```

checkout 需要支持：

```txt
clone 新仓库
fetch 已有仓库
checkout branch
checkout ref
checkout commit
shallow clone
```

实现：

```ts
import { existsSync } from 'fs';
import { join } from 'path';
import { spawnChecked } from './process.js';
import type { GitSource } from './types.js';

export async function prepareGitSource(input: {
  source: GitSource;
  repoDir: string;
  env: Record<string, string>;
}): Promise<void> {
  const gitDir = join(input.repoDir, '.git');
  if (!existsSync(gitDir)) {
    await cloneRepository(input);
  } else {
    await fetchRepository(input);
  }

  await checkoutTarget(input);
}

async function cloneRepository(input: {
  source: GitSource;
  repoDir: string;
  env: Record<string, string>;
}): Promise<void> {
  const args = ['clone'];
  if (input.source.shallow !== false) {
    args.push('--depth', '1');
  }
  if (input.source.branch) {
    args.push('--branch', input.source.branch);
  }
  args.push(input.source.remoteUrl, input.repoDir);

  await spawnChecked('git', args, {
    cwd: input.repoDir,
    env: input.env,
    redactArgs: [input.source.remoteUrl],
  });
}

async function fetchRepository(input: {
  source: GitSource;
  repoDir: string;
  env: Record<string, string>;
}): Promise<void> {
  const args = ['fetch', '--prune', 'origin'];
  if (input.source.ref) {
    args.push(input.source.ref);
  }
  await spawnChecked('git', args, {
    cwd: input.repoDir,
    env: input.env,
  });
}

async function checkoutTarget(input: {
  source: GitSource;
  repoDir: string;
  env: Record<string, string>;
}): Promise<void> {
  const target =
    input.source.commit ??
    input.source.ref ??
    (input.source.branch ? `origin/${input.source.branch}` : 'HEAD');

  await spawnChecked('git', ['checkout', '--force', target], {
    cwd: input.repoDir,
    env: input.env,
  });
}
```

这里 `spawnChecked` 要做三件事：

```txt
收集退出码
限制日志
隐藏敏感参数
```

## Process Helper

用 Bun 的进程 API：

```ts
export type SpawnOptions = {
  cwd: string;
  env: Record<string, string>;
  redactArgs?: string[];
};

export async function spawnChecked(
  command: string,
  args: string[],
  options: SpawnOptions,
): Promise<void> {
  const proc = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    const safeArgs = redactArgs(args, options.redactArgs ?? []);
    const message = [
      `Command failed: ${command} ${safeArgs.join(' ')}`,
      `exit code: ${exitCode}`,
      stderr.trim(),
    ]
      .filter(Boolean)
      .join('\n');
    throw new Error(message);
  }

  if (stdout.trim()) {
    logRunnerDebug(`command output: ${stdout.trim()}`);
  }
}

function redactArgs(args: string[], secrets: string[]): string[] {
  return args.map(arg =>
    secrets.includes(arg) ? '[REDACTED]' : arg,
  );
}
```

不要把 remote URL 带 token 的情况直接写进日志。

更好的方式是通过 git credential helper 或 token header。

Mini 先至少保证错误日志不输出完整 remote URL。

## Git Auth

BYOC 常见认证来源有两种：

```txt
用户已经在本机配好 git 凭据
remote setup 已经把 GitHub token 导入远端服务
```

当前仓库的 `/web-setup` 做了第二件事。

`src/commands/remote-setup/api.ts` 有：

```ts
const CCR_BYOC_BETA_HEADER = 'ccr-byoc-2025-07-29';
```

导入 token 时会请求：

```txt
POST /v1/code/github/import-token
```

并带：

```txt
anthropic-beta: ccr-byoc-2025-07-29
x-organization-uuid
```

本章 Mini 不需要重写这段。

需要做的是：

```txt
remote setup 负责让服务端能取到代码托管凭据。
environment runner 负责在本机 checkout。
如果 checkout 需要本地凭据，就只从环境变量或系统 credential helper 读取。
```

不要在 Work Secret 里长期保存原始 GitHub token。

如果必须短期下发，也要：

```txt
一次性
过期时间
日志隐藏
只注入当前 checkout 进程
不写入 repo config
```

## Environment Merge

child CLI 的环境变量来自四层：

```txt
基础 process.env
runner 固定变量
work secret environmentVariables
运行期 token refresh 变量
```

固定变量包括：

```txt
CLAUDE_CODE_ENVIRONMENT_KIND
CLAUDE_CODE_ENVIRONMENT_RUNNER_VERSION
CLAUDE_CODE_REMOTE_SESSION_ID
CLAUDE_CODE_SESSION_ACCESS_TOKEN
CLAUDE_CODE_USE_CCR_V2
CLAUDE_CODE_WORKER_EPOCH
```

实现：

```ts
const BLOCKED_ENV_KEYS = new Set([
  'BUN_INSTALL',
  'HOME',
  'PWD',
  'OLDPWD',
]);

export function buildChildEnv(input: {
  baseEnv: NodeJS.ProcessEnv;
  secret: WorkSecretV2;
  workspace: WorkspaceLayout;
}): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(input.baseEnv)) {
    if (typeof value !== 'string') {
      continue;
    }
    env[key] = value;
  }

  for (const [key, value] of Object.entries(input.secret.environmentVariables ?? {})) {
    assertSafeEnvKey(key);
    env[key] = value;
  }

  env.CLAUDE_CODE_ENVIRONMENT_KIND = input.secret.environmentKind;
  env.CLAUDE_CODE_ENVIRONMENT_RUNNER_VERSION =
    input.secret.runnerVersion ?? 'mini-dev';
  env.CLAUDE_CODE_REMOTE_SESSION_ID = input.secret.sessionId;
  env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = input.secret.sessionAccessToken;
  env.CLAUDE_CODE_USE_CCR_V2 = '1';

  if (typeof input.secret.workerEpoch === 'number') {
    env.CLAUDE_CODE_WORKER_EPOCH = String(input.secret.workerEpoch);
  }

  return env;
}

function assertSafeEnvKey(key: string): void {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
    throw new Error(`Invalid environment variable key: ${key}`);
  }
  if (BLOCKED_ENV_KEYS.has(key)) {
    throw new Error(`Blocked environment variable key: ${key}`);
  }
}
```

是否允许覆盖 `HOME` 要谨慎。

如果你希望每个 workspace 有独立 home，可以显式设置：

```txt
CLAUDE_CONFIG_DIR
XDG_CONFIG_HOME
```

但不要让远端 secret 随意覆盖 `HOME`。

## DeepSeek / Anthropic SDK 兼容点

前面章节已经讨论过：

```txt
保持 @anthropic-ai/sdk 不变
通过 ANTHROPIC_BASE_URL
通过 ANTHROPIC_AUTH_TOKEN
通过 ANTHROPIC_MODEL
```

Environment Runner 这里不需要改 SDK。

它只负责把这些变量注入 child：

```ts
environmentVariables: {
  ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
  ANTHROPIC_MODEL: 'deepseek-v4-flash',
}
```

密钥不要写进教程、代码或仓库。

应该由调用方在创建 environment 或 work secret 时传入：

```txt
ANTHROPIC_AUTH_TOKEN = 来自安全配置
```

child 进程看到这些变量后，原有 `@anthropic-ai/sdk` 调用路径不需要改变。

这也是本章环境变量注入的价值：

```txt
provider compatibility belongs to configuration
API client implementation stays stable
```

## File Attachments

现有主 CLI 支持：

```txt
--file file_id:relative_path
```

解析函数在 `src/services/api/filesApi.ts`：

```ts
export function parseFileSpecs(fileSpecs: string[]): File[] {
  const files: File[] = [];
  const expandedSpecs = fileSpecs.flatMap(s => s.split(' ').filter(Boolean));

  for (const spec of expandedSpecs) {
    const colonIndex = spec.indexOf(':');
    if (colonIndex === -1) {
      continue;
    }

    const fileId = spec.substring(0, colonIndex);
    const relativePath = spec.substring(colonIndex + 1);

    if (!fileId || !relativePath) {
      continue;
    }

    files.push({ fileId, relativePath });
  }

  return files;
}
```

下载路径由：

```ts
buildDownloadPath(basePath, sessionId, relativePath)
```

生成：

```txt
{basePath}/{sessionId}/uploads/{relativePath}
```

所以 runner 构造 child args 时只要加：

```ts
export function buildFileArgs(files: FileAttachment[] | undefined): string[] {
  if (!files || files.length === 0) {
    return [];
  }

  const args = ['--file'];
  for (const file of files) {
    args.push(`${file.fileId}:${file.relativePath}`);
  }
  return args;
}
```

不要在 runner 自己下载附件。

原因：

```txt
主 CLI 已经知道 session token
主 CLI 已经有路径校验
主 CLI 会在 REPL 渲染前等待下载完成
复用它能减少协议分叉
```

## Child Args

child CLI 的最小启动参数：

```txt
--output-format stream-json
--input-format stream-json
--verbose
--resume <session-id>
```

远程 stream URL 由已有远程 IO 选项注入。

Mini 可以约定：

```txt
--remote-stream-url <url>
```

如果你的仓库现有参数名不同，以现有代码为准。

本章重点是构造原则：

```ts
export function buildChildArgs(secret: WorkSecretV2): string[] {
  const args: string[] = [];

  args.push('-p');
  if (secret.prompt) {
    args.push(secret.prompt);
  } else {
    args.push('');
  }

  args.push('--output-format', 'stream-json');
  args.push('--input-format', 'stream-json');
  args.push('--verbose');

  if (secret.model) {
    args.push('--model', secret.model);
  }

  if (secret.permissionMode) {
    args.push('--permission-mode', secret.permissionMode);
  }

  args.push('--resume', secret.sessionId);
  args.push('--remote-stream-url', secret.streamUrl);

  args.push(...buildFileArgs(secret.files));

  if (secret.claudeCodeArgs) {
    args.push(...secret.claudeCodeArgs);
  }

  return args;
}
```

如果当前项目没有 `--remote-stream-url`，可以用已有的 remote IO 开关替代。

关键是不在 runner 里实现对话协议。

Runner 只 spawn child。

## Session Executor

`sessionExecutor` 负责：

```txt
spawn child
pipe stdout
pipe stderr
等待退出
支持 abort
发送环境变量刷新消息
```

类型：

```ts
export type RunningSession = {
  process: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
  exited: Promise<number>;
  sendControlMessage(message: unknown): Promise<void>;
  terminate(): Promise<void>;
};
```

实现：

```ts
export function spawnSession(input: {
  bin: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdout: WritableStream<Uint8Array>;
  stderr: WritableStream<Uint8Array>;
}): RunningSession {
  const proc = Bun.spawn([input.bin, ...input.args], {
    cwd: input.cwd,
    env: input.env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  void proc.stdout.pipeTo(input.stdout, { preventClose: true });
  void proc.stderr.pipeTo(input.stderr, { preventClose: true });

  return {
    process: proc,
    exited: proc.exited,
    async sendControlMessage(message: unknown) {
      const line = `${JSON.stringify(message)}\n`;
      const writer = proc.stdin.getWriter();
      try {
        await writer.write(new TextEncoder().encode(line));
      } finally {
        writer.releaseLock();
      }
    },
    async terminate() {
      proc.kill('SIGTERM');
      const code = await Promise.race([
        proc.exited,
        delay(8000).then(() => null),
      ]);
      if (code === null) {
        proc.kill('SIGKILL');
        await proc.exited;
      }
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

这里 stdin 必须保留。

因为 token refresh 会通过：

```txt
update_environment_variables
```

写给 child。

## Runtime Token Refresh

远端 session token 可能过期。

第 53 章里 daemon / bridge 已经有 re-dispatch 的思路。

第 54 章要让 child 进程真正接收新 token。

现有 StructuredIO 支持：

```json
{"type":"update_environment_variables","variables":{"CLAUDE_CODE_SESSION_ACCESS_TOKEN":"fresh"}}
```

Mini runner 需要在拿到新 token 后：

```ts
export async function applyTokenRefresh(input: {
  session: RunningSession;
  token: string;
}): Promise<void> {
  await input.session.sendControlMessage({
    type: 'update_environment_variables',
    variables: {
      CLAUDE_CODE_SESSION_ACCESS_TOKEN: input.token,
    },
  });
}
```

如果同时更新 runner version：

```ts
export async function applyRunnerVersionRefresh(input: {
  session: RunningSession;
  token: string;
  runnerVersion: string;
}): Promise<void> {
  await input.session.sendControlMessage({
    type: 'update_environment_variables',
    variables: {
      CLAUDE_CODE_SESSION_ACCESS_TOKEN: input.token,
      CLAUDE_CODE_ENVIRONMENT_RUNNER_VERSION: input.runnerVersion,
    },
  });
}
```

RemoteIO reconnect 时会重新读取：

```txt
CLAUDE_CODE_SESSION_ACCESS_TOKEN
CLAUDE_CODE_ENVIRONMENT_RUNNER_VERSION
```

所以 child 不需要重启。

这是官方体验非常关键的一点：

```txt
session 可长时间运行
token 可轮换
连接可重建
进程不必丢上下文
```

## Environment Runner Main

把前面模块串起来：

```ts
export async function environmentRunnerMain(args: string[]): Promise<void> {
  const runnerArgs = parseRunnerArgs(args);
  const rawSecret = await readSecretInput(runnerArgs);
  const secret = parseWorkSecret(rawSecret);

  const layout = await prepareWorkspaceLayout({
    workspaceRoot: runnerArgs.workspaceRoot,
    environmentId: secret.environmentId,
    sessionId: secret.sessionId,
  });

  const env = buildChildEnv({
    baseEnv: process.env,
    secret,
    workspace: layout,
  });

  await prepareGitSource({
    source: secret.source,
    repoDir: layout.repoDir,
    env,
  });

  const childArgs = buildChildArgs(secret);
  const session = spawnSession({
    bin: process.argv[0],
    args: ['run', 'src/entrypoints/cli.tsx', ...childArgs],
    cwd: layout.repoDir,
    env,
    stdout: streamFromConsole('stdout'),
    stderr: streamFromConsole('stderr'),
  });

  const exitCode = await session.exited;
  if (exitCode !== 0) {
    throw new Error(`Child session exited with code ${exitCode}`);
  }
}
```

这里示例使用：

```txt
process.argv[0] run src/entrypoints/cli.tsx
```

在构建产物里应该改成：

```txt
当前可执行文件路径
```

可以封装：

```ts
export function getClaudeExecutable(): string[] {
  if (process.env.CLAUDE_CODE_DEV_ENTRY) {
    return [process.argv[0], 'run', process.env.CLAUDE_CODE_DEV_ENTRY];
  }
  return [process.execPath];
}
```

再 spawn：

```ts
const executable = getClaudeExecutable();
const session = spawnSession({
  bin: executable[0],
  args: [...executable.slice(1), ...childArgs],
  cwd: layout.repoDir,
  env,
  stdout: streamFromConsole('stdout'),
  stderr: streamFromConsole('stderr'),
});
```

## Runner State

为了排障，每个 session 写一个状态文件：

```ts
export type RunnerSessionState = {
  workId: string;
  sessionId: string;
  environmentId: string;
  repoDir: string;
  startedAt: string;
  updatedAt: string;
  status: 'preparing' | 'running' | 'completed' | 'failed';
  exitCode?: number;
  error?: string;
};
```

写入：

```ts
import { writeFile } from 'fs/promises';

export async function writeRunnerState(
  stateFile: string,
  state: RunnerSessionState,
): Promise<void> {
  await writeFile(
    stateFile,
    `${JSON.stringify(state, null, 2)}\n`,
    'utf8',
  );
}
```

状态更新点：

```txt
prepareWorkspaceLayout 后 -> preparing
prepareGitSource 后 -> running
child exit 0 -> completed
child exit non-zero -> failed
catch error -> failed
```

状态文件不要写入：

```txt
sessionAccessToken
API key
完整环境变量
remote URL 中的 secret
```

## Lifecycle Wrapper

把状态写入和 cleanup 包起来：

```ts
export async function runWorkSecret(input: {
  args: RunnerArgs;
  secret: WorkSecretV2;
}): Promise<number> {
  const layout = await prepareWorkspaceLayout({
    workspaceRoot: input.args.workspaceRoot,
    environmentId: input.secret.environmentId,
    sessionId: input.secret.sessionId,
  });

  const baseState: RunnerSessionState = {
    workId: input.secret.workId,
    sessionId: input.secret.sessionId,
    environmentId: input.secret.environmentId,
    repoDir: layout.repoDir,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'preparing',
  };

  await writeRunnerState(layout.stateFile, baseState);

  try {
    const exitCode = await executePreparedSession({
      args: input.args,
      secret: input.secret,
      layout,
    });

    await writeRunnerState(layout.stateFile, {
      ...baseState,
      updatedAt: new Date().toISOString(),
      status: exitCode === 0 ? 'completed' : 'failed',
      exitCode,
    });

    return exitCode;
  } catch (error) {
    await writeRunnerState(layout.stateFile, {
      ...baseState,
      updatedAt: new Date().toISOString(),
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
```

cleanup 策略不要默认删除。

建议：

```txt
成功后可延迟删除
失败后保留一段时间
超过配额后清理最旧 session
```

开发阶段保留目录更利于排查。

## Self-hosted Runner

`self-hosted-runner` 和 `environment-runner` 的区别：

```txt
environment-runner
  执行一个 work secret
  更像单次 worker

self-hosted-runner
  长期注册环境
  轮询远端 work
  拿到 work 后调用 environment-runner 的执行函数
```

也就是说：

```txt
self-hosted-runner = poll loop + runWorkSecret
```

配置：

```ts
export type SelfHostedRunnerConfig = {
  baseUrl: string;
  runnerToken: string;
  environmentId: string;
  workspaceRoot: string;
  capacity: number;
  pollIntervalMs: number;
};
```

加载：

```ts
export function loadSelfHostedRunnerConfig(): SelfHostedRunnerConfig {
  return {
    baseUrl: requireEnv('CLAUDE_CODE_RUNNER_BASE_URL'),
    runnerToken: requireEnv('CLAUDE_CODE_RUNNER_TOKEN'),
    environmentId: requireEnv('CLAUDE_CODE_ENVIRONMENT_ID'),
    workspaceRoot:
      process.env.CLAUDE_CODE_RUNNER_ROOT ?? '.claude-runner',
    capacity: parseIntegerEnv('CLAUDE_CODE_RUNNER_CAPACITY', 1),
    pollIntervalMs: parseIntegerEnv('CLAUDE_CODE_RUNNER_POLL_MS', 2000),
  };
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function parseIntegerEnv(key: string, fallback: number): number {
  const value = process.env[key];
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid integer environment variable: ${key}`);
  }
  return parsed;
}
```

这里 token 只从环境变量读取。

不要写到 config 文件。

## Self-hosted API Client

需要最少四个接口：

```txt
register
poll
ack
complete
```

类型：

```ts
export type RunnerWorkItem = {
  workId: string;
  leaseId: string;
  secret: WorkSecretV2;
};

export type PollResult =
  | { type: 'work'; work: RunnerWorkItem }
  | { type: 'empty' };
```

实现：

```ts
export class SelfHostedRunnerApi {
  constructor(private readonly config: SelfHostedRunnerConfig) {}

  async register(): Promise<void> {
    await this.request('/v1/self-hosted-runner/register', {
      method: 'POST',
      body: {
        environment_id: this.config.environmentId,
        capacity: this.config.capacity,
      },
    });
  }

  async poll(): Promise<PollResult> {
    const response = await this.request('/v1/self-hosted-runner/poll', {
      method: 'POST',
      body: {
        environment_id: this.config.environmentId,
        capacity: this.config.capacity,
      },
    });

    if (!isRecord(response) || response.type === 'empty') {
      return { type: 'empty' };
    }

    if (response.type !== 'work' || !isRecord(response.work)) {
      throw new Error('Invalid poll response');
    }

    return {
      type: 'work',
      work: {
        workId: requireString(response.work, 'workId'),
        leaseId: requireString(response.work, 'leaseId'),
        secret: parseWorkSecret(
          JSON.stringify(response.work.secret),
        ),
      },
    };
  }

  async ack(work: RunnerWorkItem): Promise<void> {
    await this.request('/v1/self-hosted-runner/ack', {
      method: 'POST',
      body: {
        work_id: work.workId,
        lease_id: work.leaseId,
      },
    });
  }

  async complete(work: RunnerWorkItem, result: WorkCompleteResult): Promise<void> {
    await this.request('/v1/self-hosted-runner/complete', {
      method: 'POST',
      body: {
        work_id: work.workId,
        lease_id: work.leaseId,
        result,
      },
    });
  }

  private async request(
    path: string,
    input: { method: string; body: unknown },
  ): Promise<unknown> {
    const response = await fetch(`${this.config.baseUrl}${path}`, {
      method: input.method,
      headers: {
        authorization: `Bearer ${this.config.runnerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input.body),
    });

    if (!response.ok) {
      throw new Error(`Runner API failed: ${response.status}`);
    }

    return await response.json();
  }
}
```

端点路径可以按你的 RCS 实现调整。

但语义不要变：

```txt
poll 拿 work
ack 表示本机已经承诺执行
complete 表示 child 已结束
```

## Poll Loop

自托管 runner 的主循环：

```ts
export async function selfHostedRunnerMain(args: string[]): Promise<void> {
  const config = loadSelfHostedRunnerConfig();
  const api = new SelfHostedRunnerApi(config);
  const pool = new ActiveWorkPool(config.capacity);

  await api.register();

  const abort = createSignalHandlers();

  while (!abort.signal.aborted) {
    if (pool.atCapacity()) {
      await pool.waitForCapacityOrDelay(config.pollIntervalMs);
      continue;
    }

    const poll = await api.poll();
    if (poll.type === 'empty') {
      await delay(config.pollIntervalMs);
      continue;
    }

    await api.ack(poll.work);

    pool.add(
      poll.work.workId,
      runOneWork({
        api,
        work: poll.work,
        workspaceRoot: config.workspaceRoot,
      }),
    );
  }

  await pool.terminateAll();
}
```

`runOneWork`：

```ts
async function runOneWork(input: {
  api: SelfHostedRunnerApi;
  work: RunnerWorkItem;
  workspaceRoot: string;
}): Promise<void> {
  const startedAt = Date.now();
  try {
    const exitCode = await runWorkSecret({
      args: {
        once: true,
        workspaceRoot: input.workspaceRoot,
      },
      secret: input.work.secret,
    });

    await input.api.complete(input.work, {
      type: exitCode === 0 ? 'succeeded' : 'failed',
      exitCode,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    await input.api.complete(input.work, {
      type: 'failed',
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    });
  }
}
```

不要在 `runOneWork` 里吞掉 complete。

如果 complete 失败，至少要记录可重试状态。

## Active Work Pool

capacity 控制：

```ts
export class ActiveWorkPool {
  private readonly active = new Map<string, Promise<void>>();
  private wakeCapacity: (() => void) | undefined;

  constructor(private readonly capacity: number) {}

  atCapacity(): boolean {
    return this.active.size >= this.capacity;
  }

  add(workId: string, work: Promise<void>): void {
    this.active.set(workId, work);
    work.finally(() => {
      this.active.delete(workId);
      this.wakeCapacity?.();
      this.wakeCapacity = undefined;
    });
  }

  async waitForCapacityOrDelay(ms: number): Promise<void> {
    if (!this.atCapacity()) {
      return;
    }

    await Promise.race([
      new Promise<void>(resolve => {
        this.wakeCapacity = resolve;
      }),
      delay(ms),
    ]);
  }

  async terminateAll(): Promise<void> {
    await Promise.allSettled(this.active.values());
  }
}
```

这和第 53 章的 capacity wake 是同一个思想。

满载时不要继续拉 work。

否则会出现：

```txt
远端以为 work 已派发
本机没有能力执行
lease 过期后产生重复执行
```

## Ack 时机

self-hosted runner 里 ack 必须发生在：

```txt
poll 拿到 work
本机确认还有 capacity
准备开始 runOneWork
```

不要在 poll 前 ack。

不要在 child 启动成功后才 ack。

原因：

```txt
ack 太早：本机可能没 capacity，work 被吞。
ack 太晚：checkout 很慢，远端可能把 work 派给别人。
```

Mini 的折中：

```txt
pool 有容量 -> ack -> runOneWork
```

如果 ack 后 checkout 失败，就 complete failed。

这样远端有明确结果。

## File Persistence

现有 file persistence 已经有 BYOC 模式。

链路：

```txt
turn starts
child records turnStartTime
turn ends
executeFilePersistence
  -> runFilePersistence
  -> getEnvironmentKind
  -> require session token
  -> require remote session id
  -> scan outputs dir
  -> uploadSessionFiles
  -> emit files_persisted system message
```

outputs 目录：

```txt
{cwd}/{sessionId}/.claude-code/outputs
```

扫描：

```ts
const modifiedFiles = await findModifiedFiles(turnStartTime, outputsDir);
```

过滤：

```txt
只要普通文件
跳过 symlink
mtime >= turnStartTime
最多 FILE_COUNT_LIMIT
relative path 不允许跑出 outputsDir
```

上传：

```txt
POST /v1/files
anthropic-beta: files-api-2025-04-14,oauth-2025-04-20
purpose: user_data
```

成功后 child 会发：

```json
{
  "type": "system",
  "subtype": "files_persisted",
  "files": [
    {
      "filename": "result.txt",
      "file_id": "file_abc"
    }
  ],
  "failed": [],
  "processed_at": "2026-05-27T00:00:00.000Z",
  "uuid": "uuid",
  "session_id": "session"
}
```

Runner 需要做的只有：

```txt
设置 CLAUDE_CODE_ENVIRONMENT_KIND=byoc
设置 CLAUDE_CODE_REMOTE_SESSION_ID
设置 CLAUDE_CODE_SESSION_ACCESS_TOKEN
让 child cwd 和 outputs 路径规则兼容
```

不要再写一套上传器。

## Outputs Contract

给模型和工具约定输出目录：

```txt
./{sessionId}/.claude-code/outputs
```

这可以通过系统提示或远程任务上下文告诉 child：

```txt
When producing files for the remote user, write them under:
./${sessionId}/.claude-code/outputs
```

但不要硬编码到所有工具里。

原因：

```txt
普通本地 CLI 不应该被 BYOC 输出目录影响。
只有远程 session 需要这个约定。
```

## Upload Safety

现有上传器做了几件安全事：

```txt
读取内容后再判断大小
单文件最大 500MB
并发限制
非重试错误直接返回失败
网络错误重试
multipart boundary 使用 randomUUID
```

Runner 不要绕过它。

如果要扩展，只加这些：

```txt
总字节数上限
忽略目录配置
文件名规范化
secret scan
```

不要让 outputs 上传整个 repo。

只上传 outputs 目录。

## Remote Setup

`/web-setup` 已经做了远程代码环境的用户准备。

流程：

```txt
检查是否登录 Claude
检查 gh 是否可用且已登录
读取 gh auth token
用 RedactedGithubToken 包装
请求 import-token
best effort 创建 Default environment
打开 Web Code 页面
```

关键类：

```ts
export class RedactedGithubToken {
  readonly #value: string;
  constructor(raw: string) {
    this.#value = raw;
  }
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return '[REDACTED:gh-token]';
  }
  toJSON(): string {
    return '[REDACTED:gh-token]';
  }
}
```

这个设计值得 Mini 学：

```txt
默认输出永远是 redacted
只有 HTTP body 构造点调用 reveal
异常日志不包含 request body
```

导入接口：

```ts
const headers = {
  ...getOAuthHeaders(accessToken),
  'anthropic-beta': CCR_BYOC_BETA_HEADER,
  'x-organization-uuid': orgUUID,
};
```

本章不需要改 `/web-setup`。

但要把它纳入整条链路：

```txt
用户本地 /web-setup
  -> 服务端保存代码托管凭据
  -> Web 创建 session
  -> RCS 下发 source
  -> runner checkout
```

## Cloud Default Environment

`createDefaultEnvironment()` 当前会创建：

```txt
name: Default
kind: anthropic_cloud
cwd: /home/user
languages:
  python 3.11
  node 20
network:
  allow_default_hosts: true
```

Mini 可以借鉴字段，但 BYOC 本地 runner 不需要完全一致。

BYOC 更关心：

```txt
workspaceRoot
capacity
git auth
allowed source hosts
env var injection
cleanup policy
```

不要把 cloud environment 的 `cwd` 当成本机真实路径。

本机路径由 runner config 决定。

## Source Host Allowlist

BYOC runner 会在用户机器上 clone 远端地址。

必须控制来源。

Mini 加一个 allowlist：

```ts
export function assertAllowedRemote(remoteUrl: string, allowedHosts: string[]): void {
  const url = new URL(remoteUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'ssh:') {
    throw new Error('Unsupported git remote protocol');
  }

  if (!allowedHosts.includes(url.hostname)) {
    throw new Error(`Git remote host is not allowed: ${url.hostname}`);
  }
}
```

配置：

```txt
CLAUDE_CODE_RUNNER_ALLOWED_GIT_HOSTS=github.com,gitlab.example.com
```

解析：

```ts
export function getAllowedGitHosts(): string[] {
  const raw = process.env.CLAUDE_CODE_RUNNER_ALLOWED_GIT_HOSTS;
  if (!raw) {
    return ['github.com'];
  }
  return raw
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}
```

不要默认允许任意 host。

否则远端任务可以让 runner 连接内部地址。

## Workspace Trust

Child CLI 可能会要求 workspace trust。

远程 session 里通常不能弹交互框。

Mini 有两个选择：

```txt
严格：未信任直接失败
托管：runner 为自己的 workspace root 建立隔离信任
```

建议 Mini 先严格：

```ts
export function assertWorkspaceCanRun(layout: WorkspaceLayout): void {
  if (!layout.repoDir.startsWith(layout.root)) {
    throw new Error('Workspace is outside runner root');
  }
}
```

如果后续要自动信任，只信任：

```txt
runnerRoot/environments/{environmentId}/sessions/{sessionId}/repo
```

不要信任用户 home。

## Permission Mode

远程 runner 的 permission mode 不能随便默认 bypass。

推荐策略：

```txt
work secret 显式带 permissionMode
没有就使用服务端 environment policy
没有 policy 就 default
```

构造 child args：

```ts
if (secret.permissionMode) {
  args.push('--permission-mode', secret.permissionMode);
}
```

不要让用户 prompt 通过文本控制 permission mode。

permission 是 session 元数据，不是模型上下文。

## Logs

Runner 日志要分层：

```txt
runner lifecycle
workspace preparation
git checkout
child process
remote API
file persistence
```

示例：

```ts
export function logRunnerInfo(message: string): void {
  process.stderr.write(`[environment-runner] ${message}\n`);
}

export function logRunnerError(message: string): void {
  process.stderr.write(`[environment-runner:error] ${message}\n`);
}

export function logRunnerDebug(message: string): void {
  if (process.env.CLAUDE_CODE_RUNNER_DEBUG === '1') {
    process.stderr.write(`[environment-runner:debug] ${message}\n`);
  }
}
```

日志里禁止：

```txt
完整 secret
session token
authorization header
API key
remote URL embedded credential
环境变量全量 dump
```

可以记录：

```txt
workId
sessionId
environmentId
status
exitCode
durationMs
repo host
branch / ref
```

## Graceful Shutdown

Runner 需要处理：

```txt
SIGINT
SIGTERM
远端 cancel
poll loop abort
child exit
```

信号 helper：

```ts
export function createSignalHandlers(): { signal: AbortSignal } {
  const controller = new AbortController();

  const abort = () => {
    controller.abort();
  };

  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);

  return { signal: controller.signal };
}
```

child shutdown：

```ts
export async function stopRunningSession(
  session: RunningSession,
): Promise<void> {
  await session.terminate();
}
```

self-hosted runner 退出时：

```txt
停止 poll
不再 ack 新 work
等待 active work 完成一小段时间
超时后 terminate child
complete failed 或 canceled
```

不要直接 `process.exit`。

否则 complete 可能发不出去。

## Cancel Work

远端取消 session 时，runner 应该收到 control 或 API 状态。

Mini 可以在 heartbeat / poll 返回里加：

```ts
export type RunnerControl =
  | { type: 'continue' }
  | { type: 'cancel'; reason: string }
  | { type: 'refresh_env'; variables: Record<string, string> };
```

处理：

```ts
async function applyRunnerControl(
  session: RunningSession,
  control: RunnerControl,
): Promise<boolean> {
  if (control.type === 'continue') {
    return true;
  }

  if (control.type === 'refresh_env') {
    await session.sendControlMessage({
      type: 'update_environment_variables',
      variables: control.variables,
    });
    return true;
  }

  await session.terminate();
  return false;
}
```

这里返回 `false` 表示 session 已被取消。

随后 complete：

```txt
type: canceled
reason
```

## Environment Runner API

如果 environment-runner 不是被 self-hosted-runner 调用，而是直接对接 RCS，它也需要 API：

```txt
claim
heartbeat
refresh token
complete
```

Mini 可以先不做。

第 53 章的 daemon / bridge loop 已经负责这些。

本章推荐结构：

```txt
daemon bridge loop
  -> 负责 RCS work API
  -> 拿到 work secret 后调用 runWorkSecret

environment-runner
  -> 只负责执行
```

self-hosted-runner 是另一种部署模式：

```txt
self-hosted-runner
  -> 自己负责 RCS work API
  -> 内部调用 runWorkSecret
```

这样两种模式复用同一个执行核心。

## 与第 53 章对接

第 53 章的 `spawnSession` 可以改成：

```ts
async function spawnSessionFromWork(work: WorkItem): Promise<ChildHandle> {
  const secret = decryptWorkSecret(work.encryptedSecret);

  const proc = Bun.spawn(
    [
      process.execPath,
      'environment-runner',
      '--secret-json',
      Buffer.from(JSON.stringify(secret)).toString('base64url'),
      '--workspace-root',
      getRunnerRoot(),
    ],
    {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  return {
    pid: proc.pid,
    exited: proc.exited,
    kill: signal => proc.kill(signal),
  };
}
```

但更好的方式是直接 import：

```ts
await runWorkSecret({
  args: {
    once: true,
    workspaceRoot: getRunnerRoot(),
  },
  secret,
});
```

直接 import 的优点：

```txt
少一层进程
更容易传 AbortSignal
更容易测试
```

独立进程的优点：

```txt
隔离更强
crash 不影响 daemon
日志边界清楚
```

Mini 可以先直接 import。

如果后续追求稳定性，再拆成独立 process。

## RCS Work Secret 生成

RCS 创建 work item 时要生成 secret：

```ts
export function buildWorkSecret(input: {
  workId: string;
  sessionId: string;
  environmentId: string;
  streamUrl: string;
  sessionAccessToken: string;
  source: GitSource;
  files?: FileAttachment[];
  environmentVariables?: Record<string, string>;
  model?: string;
  permissionMode?: string;
  runnerVersion?: string;
  workerEpoch?: number;
}): WorkSecretV2 {
  return {
    version: 2,
    workId: input.workId,
    sessionId: input.sessionId,
    environmentId: input.environmentId,
    environmentKind: 'byoc',
    streamUrl: input.streamUrl,
    sessionAccessToken: input.sessionAccessToken,
    source: input.source,
    files: input.files,
    environmentVariables: input.environmentVariables ?? {},
    model: input.model,
    permissionMode: input.permissionMode,
    runnerVersion: input.runnerVersion,
    workerEpoch: input.workerEpoch,
  };
}
```

Secret 应该加密存储。

如果 Mini 还没有加密层，至少不要把它写入普通日志。

## Stream URL

child 需要连接远端 stream。

第 52 章已经补了 CCR v2：

```txt
SSE connect
POST event
worker_epoch
internal events
resume cursor
```

本章只补 env：

```txt
CLAUDE_CODE_USE_CCR_V2=1
CLAUDE_CODE_SESSION_ACCESS_TOKEN
CLAUDE_CODE_REMOTE_SESSION_ID
CLAUDE_CODE_WORKER_EPOCH
```

RemoteIO 会在构造 transport 时加：

```txt
Authorization: Bearer <token>
x-environment-runner-version: <version>
```

因此 token refresh 必须能更新 child `process.env`。

这就是 `update_environment_variables` 的作用。

## Worker Epoch

worker epoch 用来区分同一个 session 的不同 worker incarnation。

典型场景：

```txt
worker A 连接后崩溃
worker B 接管同一个 session
worker A 的旧连接延迟发来事件
服务端需要拒绝旧事件
```

Work Secret 下发：

```ts
workerEpoch: 7
```

child env：

```ts
env.CLAUDE_CODE_WORKER_EPOCH = String(secret.workerEpoch);
```

CCR v2 client 上报时带 epoch。

如果你的第 52 章 Mini 已经实现 `worker_epoch`，这里只需要透传。

## Session ID

有两个 session id 概念：

```txt
CLI 内部 session id
远端 remote session id
```

BYOC 文件路径和 Files API 使用：

```txt
CLAUDE_CODE_REMOTE_SESSION_ID
```

所以 runner 必须设置：

```ts
env.CLAUDE_CODE_REMOTE_SESSION_ID = secret.sessionId;
```

不要只依赖 CLI 内部随机 session id。

否则会出现：

```txt
附件下载到一个目录
outputs 上传扫描另一个目录
服务端收到的 files_persisted 对不上 session
```

## Main CLI 的 File Download

主 CLI 启动时：

```txt
读取 --file
读取 CLAUDE_CODE_SESSION_ACCESS_TOKEN
确定 session id
调用 downloadSessionFiles
REPL 渲染前 await 下载完成
```

这保证模型开始执行前附件已经在磁盘。

Runner 需要保证 child 有：

```txt
CLAUDE_CODE_SESSION_ACCESS_TOKEN
CLAUDE_CODE_REMOTE_SESSION_ID
--file ...
```

如果缺 token，主 CLI 会报：

```txt
Session token required for file downloads.
```

这是正确失败。

不要让 runner 捕获后继续跑。

附件缺失时继续执行会产生更难理解的错误。

## Environment Variable Refresh 安全

现有 StructuredIO 会把消息里的变量直接写入 `process.env`。

这很强，也有风险。

Runner 发送刷新消息前要过滤：

```ts
const REFRESH_ALLOWED_KEYS = new Set([
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'CLAUDE_CODE_ENVIRONMENT_RUNNER_VERSION',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
]);

export function filterRefreshVariables(
  variables: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(variables)) {
    if (!REFRESH_ALLOWED_KEYS.has(key)) {
      continue;
    }
    result[key] = value;
  }
  return result;
}
```

不要把任意远端变量透传给已运行 child。

尤其不要刷新：

```txt
PATH
HOME
SHELL
PWD
```

## Runner Version

设置：

```ts
env.CLAUDE_CODE_ENVIRONMENT_RUNNER_VERSION =
  secret.runnerVersion ?? MINI_RUNNER_VERSION;
```

版本常量：

```ts
export const MINI_RUNNER_VERSION = '54.0.0-mini';
```

服务端可以用这个 header 做：

```txt
兼容性判断
灰度控制
诊断
强制升级提示
```

不要把版本放进 prompt。

它是 transport metadata。

## Tests：Secret Parser

测试：

```ts
import { describe, expect, test } from 'bun:test';
import { parseWorkSecret } from '../secrets.js';

describe('parseWorkSecret', () => {
  test('parses v2 git work secret', () => {
    const secret = parseWorkSecret(
      JSON.stringify({
        version: 2,
        workId: 'work_1',
        sessionId: 'sess_1',
        streamUrl: 'https://example.test/stream',
        sessionAccessToken: 'token',
        environmentId: 'env_1',
        environmentKind: 'byoc',
        source: {
          type: 'git',
          remoteUrl: 'https://github.com/acme/repo.git',
          branch: 'main',
        },
      }),
    );

    expect(secret.workId).toBe('work_1');
    expect(secret.source.type).toBe('git');
    expect(secret.environmentKind).toBe('byoc');
  });

  test('rejects missing session token', () => {
    expect(() =>
      parseWorkSecret(
        JSON.stringify({
          version: 2,
          workId: 'work_1',
          sessionId: 'sess_1',
          streamUrl: 'https://example.test/stream',
          environmentId: 'env_1',
          environmentKind: 'byoc',
          source: {
            type: 'git',
            remoteUrl: 'https://github.com/acme/repo.git',
          },
        }),
      ),
    ).toThrow('sessionAccessToken');
  });
});
```

## Tests：Workspace

测试路径隔离：

```ts
import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { prepareWorkspaceLayout, safeJoin } from '../workspace.js';

describe('workspace', () => {
  test('creates session repo layout under root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-'));
    const layout = await prepareWorkspaceLayout({
      workspaceRoot: root,
      environmentId: 'env_1',
      sessionId: 'sess_1',
    });

    expect(layout.repoDir.includes('env_1')).toBe(true);
    expect(layout.repoDir.includes('sess_1')).toBe(true);
  });

  test('safeJoin rejects traversal', () => {
    expect(() => safeJoin('/tmp/root', '..', 'other')).toThrow();
  });
});
```

## Tests：Environment Merge

测试：

```ts
import { describe, expect, test } from 'bun:test';
import { buildChildEnv } from '../env.js';

describe('buildChildEnv', () => {
  test('injects BYOC and CCR variables', () => {
    const env = buildChildEnv({
      baseEnv: {},
      workspace: fakeLayout(),
      secret: fakeSecret({
        environmentVariables: {
          ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
          ANTHROPIC_MODEL: 'deepseek-v4-flash',
        },
      }),
    });

    expect(env.CLAUDE_CODE_ENVIRONMENT_KIND).toBe('byoc');
    expect(env.CLAUDE_CODE_USE_CCR_V2).toBe('1');
    expect(env.CLAUDE_CODE_REMOTE_SESSION_ID).toBe('sess_1');
    expect(env.ANTHROPIC_MODEL).toBe('deepseek-v4-flash');
  });

  test('rejects blocked keys from remote variables', () => {
    expect(() =>
      buildChildEnv({
        baseEnv: {},
        workspace: fakeLayout(),
        secret: fakeSecret({
          environmentVariables: {
            HOME: '/tmp/evil',
          },
        }),
      }),
    ).toThrow('Blocked environment variable key');
  });
});
```

## Tests：File Args

测试：

```ts
import { describe, expect, test } from 'bun:test';
import { buildFileArgs } from '../files.js';

describe('buildFileArgs', () => {
  test('builds startup file arguments', () => {
    expect(
      buildFileArgs([
        { fileId: 'file_1', relativePath: 'a.txt' },
        { fileId: 'file_2', relativePath: 'dir/b.txt' },
      ]),
    ).toEqual(['--file', 'file_1:a.txt', 'file_2:dir/b.txt']);
  });

  test('returns empty args without files', () => {
    expect(buildFileArgs(undefined)).toEqual([]);
  });
});
```

## Tests：Token Refresh

测试 `sendControlMessage`：

```ts
import { describe, expect, test } from 'bun:test';
import { applyTokenRefresh } from '../sessionExecutor.js';

describe('applyTokenRefresh', () => {
  test('sends update_environment_variables message', async () => {
    const messages: unknown[] = [];
    await applyTokenRefresh({
      token: 'fresh',
      session: {
        async sendControlMessage(message) {
          messages.push(message);
        },
      } as Pick<RunningSession, 'sendControlMessage'>,
    });

    expect(messages).toEqual([
      {
        type: 'update_environment_variables',
        variables: {
          CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'fresh',
        },
      },
    ]);
  });
});
```

测试里可以用窄类型替身。

不需要启动真实 child。

## Tests：Self-hosted Poll Loop

测试重点：

```txt
poll empty 后等待
poll work 后 ack 再 run
capacity 满时不 poll
run 成功后 complete succeeded
run 失败后 complete failed
```

示例：

```ts
import { describe, expect, test } from 'bun:test';

describe('self-hosted poll loop', () => {
  test('acks before running work', async () => {
    const events: string[] = [];
    const api = fakeApi({
      pollResult: fakeWork(),
      onAck: () => events.push('ack'),
      onComplete: () => events.push('complete'),
    });

    await runPollIteration({
      api,
      pool: fakePool(1),
      workspaceRoot: '/tmp/root',
      runWork: async () => {
        events.push('run');
        return 0;
      },
    });

    expect(events).toEqual(['ack', 'run', 'complete']);
  });
});
```

把 poll loop 拆出 `runPollIteration` 会让测试容易很多。

## Tests：Files API Path

现有 `buildDownloadPath` 已经做路径穿越校验。

建议补测试：

```ts
import { describe, expect, test } from 'bun:test';
import { buildDownloadPath } from '../../services/api/filesApi.js';

describe('buildDownloadPath', () => {
  test('places uploads under session directory', () => {
    expect(
      buildDownloadPath('/work/repo', 'sess_1', 'docs/a.txt'),
    ).toBe('/work/repo/sess_1/uploads/docs/a.txt');
  });

  test('rejects traversal', () => {
    expect(buildDownloadPath('/work/repo', 'sess_1', '../secret')).toBeNull();
  });
});
```

## 手动验证

入口验证：

```bash
FEATURE_BYOC_ENVIRONMENT_RUNNER=1 bun run src/entrypoints/cli.tsx environment-runner --help
```

self-hosted 入口：

```bash
FEATURE_SELF_HOSTED_RUNNER=1 bun run src/entrypoints/cli.tsx self-hosted-runner --help
```

单元测试：

```bash
bun test src/environment-runner src/self-hosted-runner src/utils/filePersistence src/services/api/filesApi.ts
```

类型检查：

```bash
bun run typecheck
```

本地单次执行可以用：

```bash
FEATURE_BYOC_ENVIRONMENT_RUNNER=1 bun run src/entrypoints/cli.tsx environment-runner --secret-file /tmp/work-secret.json --workspace-root /tmp/cc-runner --once
```

注意：

```txt
/tmp/work-secret.json 里不要放真实长期密钥。
本地测试用短期 token 或 mock token。
```

## Debug Checklist

### runner 没启动

检查 feature：

```txt
BYOC_ENVIRONMENT_RUNNER
SELF_HOSTED_RUNNER
```

检查 fast path 是否在 `main.tsx` 加载前执行。

### checkout 失败

检查：

```txt
remoteUrl host 是否在 allowlist
本机 git 凭据是否可用
branch / ref / commit 是否存在
错误日志是否隐藏 token
```

### 附件没出现

检查 child 是否带了：

```txt
--file
CLAUDE_CODE_SESSION_ACCESS_TOKEN
CLAUDE_CODE_REMOTE_SESSION_ID
```

检查路径：

```txt
{cwd}/{sessionId}/uploads
```

### outputs 没上传

检查：

```txt
FEATURE_FILE_PERSISTENCE
CLAUDE_CODE_ENVIRONMENT_KIND=byoc
CLAUDE_CODE_REMOTE_SESSION_ID
CLAUDE_CODE_SESSION_ACCESS_TOKEN
outputs 目录是否写在 {cwd}/{sessionId}/.claude-code/outputs
```

### token refresh 后仍然 401

检查：

```txt
runner 是否写入 update_environment_variables
child stdin 是否保持打开
StructuredIO 是否收到消息
RemoteIO refreshHeaders 是否重新读取 env
```

### runner version header 缺失

检查：

```txt
CLAUDE_CODE_ENVIRONMENT_RUNNER_VERSION
RemoteIO 初始化 headers
RemoteIO refreshHeaders
```

### self-hosted 重复执行 work

检查：

```txt
ack 时机
leaseId 是否传回 complete
capacity 满时是否还在 poll
complete 失败是否重试或记录
```

### 退出后 work 一直 running

检查：

```txt
child exit 是否进入 complete
SIGTERM 是否等待 complete
runOneWork catch 是否仍然 complete failed
```

## 和官方能力的差距

本章 Mini 已经补上 Environment Runner 主体，但和官方实现仍有差距：

| 能力 | 本章 Mini | 更完整实现 |
| --- | --- | --- |
| Runner 入口 | fast path + 单次执行 | signed runner、自动升级 |
| Work Secret | JSON v2 | 加密 envelope、短期 lease token |
| Source | git clone / fetch | 多 provider、PR checkout、patch apply |
| Git auth | 本机凭据 / setup 后端 | scoped token、credential broker |
| Workspace | session 目录隔离 | overlay、snapshot、配额管理 |
| Env vars | allowlist + merge | secret store、动态策略 |
| Token refresh | stdin control message | lease manager、自动轮换 |
| File inputs | `--file` 复用 | 大附件分片、校验和 |
| File outputs | outputs 扫描上传 | server-side manifest、去重 |
| Self-hosted | register / poll / ack / complete | mTLS、fleet manager、remote config |
| Cleanup | 手动或延迟 | TTL reaper、失败保留策略 |
| Observability | state file + stderr | structured logs、trace id、metrics |

但从目标看，本章已经补齐了“接近官方 Claude Code”的关键执行层：

```txt
远端任务
  -> 本机 runner
  -> repo workspace
  -> child Claude Code
  -> CCR v2
  -> 文件输入输出
  -> token refresh
```

## 本章小结

第 54 章把第 53 章的 daemon work queue 接到了真实执行环境。

核心链路是：

```txt
self-hosted-runner / daemon
  -> poll work
  -> ack
  -> parse Work Secret v2
  -> prepare workspace
  -> checkout git source
  -> build child env
  -> spawn Claude Code child
  -> pass files through --file
  -> stream via CCR v2
  -> refresh env through update_environment_variables
  -> upload outputs through file persistence
  -> complete work
```

本章最重要的原则：

```txt
runner 不实现对话协议，只准备环境并 spawn child。
secret 永远不进日志。
child cwd 必须兼容 uploads / outputs 路径。
token refresh 走结构化 stdin，不重启 child。
file download / upload 复用已有 Files API。
ack 和 capacity 必须和执行生命周期一致。
```

到这里，Mini 已经从“远程 session 能通信”推进到“远程 session 能在真实仓库工作区里执行”。

下一章可以继续补 **沙箱、权限策略与远程命令安全**：让 BYOC / self-hosted runner 在执行 shell、文件写入和网络访问时具备更接近官方的安全边界。
