# 第 41 章：认证、Provider 配置与密钥管理

第四十章把插件分发推进到“可验证”。

下一块必须收束的是认证和 Provider 配置。

如果这一层没有设计好，Mini 很快会出现几类问题：

- API key 被写进配置文件。
- 调试日志打印了 token。
- `baseUrl`、`model`、`key` 分散在多个模块里。
- DeepSeek、Anthropic、OpenAI-compatible 概念混在一起。
- `/login` 改了一个位置，但实际请求读的是另一个位置。
- 运行时错误只说 401，不知道当前到底用了哪个认证来源。

真实 Claude Code 这一层很复杂，因为它同时支持：

- Anthropic API key。
- Claude.ai OAuth。
- Workspace key。
- Bedrock、Vertex、Foundry。
- OpenAI、Gemini、Grok 兼容层。
- `apiKeyHelper`。
- Keychain 和本地 fallback。
- managed session、remote session、SSH auth proxy。

Mini 不复制全部商业逻辑。

Mini 这一章只做一件事：

> 保持 `@anthropic-ai/sdk` 不变，统一管理 Anthropic-compatible Provider 的 `baseUrl`、`model`、`auth token` 和安全输出。

也就是说，你之前直接可用的 DeepSeek 配置仍然是主线：

```bash
export ANTHROPIC_AUTH_TOKEN="<your-deepseek-key>"
export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
export ANTHROPIC_MODEL="deepseek-v4-flash"
```

本章不会要求你安装官方 Claude Code。

本章也不会把 DeepSeek 改成 OpenAI-compatible 路线。

DeepSeek 的 Anthropic-compatible endpoint 已经可以直接被 `@anthropic-ai/sdk` 使用，所以 Mini 继续用这条路径。

## 本章目标

完成本章后，Mini 会具备：

1. 统一的认证配置读取入口。
2. 统一的 Provider 配置读取入口。
3. `ANTHROPIC_AUTH_TOKEN` 优先的 Bearer token 模式。
4. `ANTHROPIC_API_KEY` 兼容的 API key 模式。
5. `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_MODEL` 的集中解析。
6. `@anthropic-ai/sdk` 客户端创建函数。
7. 密钥脱敏工具。
8. `/auth` 状态命令。
9. `/login` 的最小安全版本。
10. `auth doctor` 诊断命令。
11. 密钥不进入 transcript、日志、配置打印。
12. Provider 配置测试。

这一章的工程目标是：

> 请求层永远只消费一个 `ResolvedProviderAuth`，其他模块不直接读取密钥环境变量。

## 本章完成效果

配置 DeepSeek：

```bash
export ANTHROPIC_AUTH_TOKEN="<your-deepseek-key>"
export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
export ANTHROPIC_MODEL="deepseek-v4-flash"
```

运行：

```bash
bun run dev
```

查看认证状态：

```txt
> /auth
```

输出类似：

```txt
Auth

Provider: anthropic-compatible
Base URL: https://api.deepseek.com/anthropic
Model: deepseek-v4-flash
Auth source: ANTHROPIC_AUTH_TOKEN
Auth mode: bearer-token
Token: set
```

注意，这里不会显示真实 token。

诊断：

```txt
> /auth doctor
```

输出类似：

```txt
Auth Doctor

OK    ANTHROPIC_BASE_URL is valid
OK    ANTHROPIC_MODEL is set
OK    ANTHROPIC_AUTH_TOKEN is set
OK    no raw secret found in Mini config
WARN  ANTHROPIC_API_KEY is also set; bearer token will win
```

如果没有配置 token：

```txt
Auth Doctor

OK     ANTHROPIC_BASE_URL is valid
OK     ANTHROPIC_MODEL is set
ERROR  missing auth token

Set one of:
  export ANTHROPIC_AUTH_TOKEN="<token>"
  export ANTHROPIC_API_KEY="<key>"
```

## 真实工程如何处理

先看真实工程的几个关键点。

### Provider 选择

`src/utils/model/providers.ts` 负责选择 API provider。

它不是直接创建客户端，而是回答：

```txt
当前请求应该走 firstParty、bedrock、vertex、foundry、openai、gemini 还是 grok？
```

真实工程的优先级大致是：

1. 用户设置中的 `modelType`。
2. 云 provider 相关环境变量。
3. OpenAI、Gemini、Grok 兼容层环境变量。
4. 默认 first-party。

Mini 这一章不做多 provider 分发。

Mini 只保留一个 provider：

```txt
anthropic-compatible
```

它覆盖两类场景：

- Anthropic 官方 Messages API。
- DeepSeek Anthropic-compatible endpoint。

### SDK 客户端创建

真实工程的 `src/services/api/client.ts` 使用 `@anthropic-ai/sdk` 创建客户端。

这里有几个重要行为：

- 请求头会统一加上 session id、user agent 等元数据。
- OAuth token 和 API key 是不同 auth plane。
- `ANTHROPIC_AUTH_TOKEN` 会以 Bearer token 形式进入 Authorization header。
- API key 会走 SDK 的 `apiKey` 配置。
- Bedrock、Vertex、Foundry 会返回不同 SDK client。

Mini 只保留 Anthropic-compatible 路径。

最关键的是这条：

```txt
ANTHROPIC_AUTH_TOKEN -> Authorization: Bearer <token>
```

这正好匹配你现在的 DeepSeek 用法。

### Auth source 优先级

真实工程的 `src/utils/auth.ts` 会区分很多来源：

- `ANTHROPIC_AUTH_TOKEN`。
- `CLAUDE_CODE_OAUTH_TOKEN`。
- OAuth token file descriptor。
- `apiKeyHelper`。
- Claude.ai OAuth 本地 token。
- `ANTHROPIC_API_KEY`。
- keychain 或 config 里的 managed key。

Mini 不需要这些全部来源。

但 Mini 必须保留一个思想：

> 认证来源必须可解释。

也就是说，运行时不能只返回一个字符串 token。

应该返回：

```ts
{
  mode: "bearer-token",
  source: "ANTHROPIC_AUTH_TOKEN",
  secret: "...",
}
```

报告时只显示 `mode` 和 `source`。

请求时才使用 `secret`。

### `/login`

真实工程的 `/login` 同时处理：

- Workspace key。
- Claude.ai OAuth。
- 删除已保存 key。
- 登录后刷新 policy、feature、cache、remote managed settings。
- 切换账号后清理和认证绑定的历史块。

Mini 先做最小版本：

- 展示当前 auth 状态。
- 支持写一个用户级 settings 文件。
- 默认建议使用环境变量。
- 永远不把 token 打印出来。

### Secure storage

真实工程的 `src/utils/secureStorage/` 在 macOS 上优先使用 Keychain，其他平台有 fallback。

Mini 这一章先做接口，不强行实现系统 Keychain：

```ts
interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
```

默认路径仍然推荐环境变量。

如果你要保存密钥，只保存到用户级目录，并设置权限。

不要写进项目目录。

## 核心边界

这一层要先把三个概念拆开。

### Provider

Provider 回答：

```txt
请求发到哪里，用什么协议？
```

本章只有：

```txt
anthropic-compatible
```

### Model

Model 回答：

```txt
这次请求用哪个模型名？
```

它来自：

```txt
ANTHROPIC_MODEL
```

或者第二十章里的模型路由。

### Auth

Auth 回答：

```txt
请求如何证明身份？
```

本章支持：

- Bearer token：`ANTHROPIC_AUTH_TOKEN`。
- API key：`ANTHROPIC_API_KEY`。

这三个概念不要混在一个字符串里。

错误示例：

```ts
const model = process.env.ANTHROPIC_MODEL ?? "deepseek-v4-flash";
const key = process.env.ANTHROPIC_AUTH_TOKEN;
const url = process.env.ANTHROPIC_BASE_URL;
```

如果每个调用点都这么写，后面会很难维护。

正确做法：

```ts
const resolved = resolveProviderAuth();
const client = createAnthropicCompatibleClient(resolved);
```

## 本章项目结构变化

新增：

```txt
src/
  auth/
    types.ts
    env.ts
    redaction.ts
    providerConfig.ts
    resolver.ts
    client.ts
    status.ts
    doctor.ts
    login.ts
    secretStore.ts
    __tests__/
      redaction.test.ts
      providerConfig.test.ts
      resolver.test.ts
      doctor.test.ts
  commands/
    auth.ts
```

会修改：

```txt
src/
  llm/
    anthropic.ts
  commands/
    index.ts
```

如果你的 Mini 文件名不同，以已有的 LLM client 和 command registry 为准。

关键是：模型请求不再直接读 `process.env.ANTHROPIC_AUTH_TOKEN`。

## Step 1：定义类型

新增 `src/auth/types.ts`：

```ts
export type ProviderId = "anthropic-compatible";

export type AuthMode = "bearer-token" | "api-key" | "none";

export type AuthSource =
  | "ANTHROPIC_AUTH_TOKEN"
  | "ANTHROPIC_API_KEY"
  | "secret-store"
  | "none";

export interface ProviderConfig {
  provider: ProviderId;
  baseUrl: string;
  model: string;
}

export interface ResolvedAuth {
  mode: AuthMode;
  source: AuthSource;
  secret: string | null;
}

export interface ResolvedProviderAuth {
  provider: ProviderConfig;
  auth: ResolvedAuth;
}

export interface PublicAuthStatus {
  provider: ProviderId;
  baseUrl: string;
  model: string;
  authMode: AuthMode;
  authSource: AuthSource;
  tokenSet: boolean;
}
```

注意两个设计点。

第一，`ResolvedAuth` 可以包含 secret。

第二，`PublicAuthStatus` 永远不能包含 secret。

这能避免 UI、日志、错误对象不小心把密钥带出去。

## Step 2：读取环境变量

新增 `src/auth/env.ts`：

```ts
export interface EnvReader {
  get(name: string): string | undefined;
}

export const processEnvReader: EnvReader = {
  get(name: string) {
    const value = process.env[name];
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  },
};

export function readEnv(reader: EnvReader, name: string): string | undefined {
  return reader.get(name);
}
```

这里看起来很小，但它让测试变简单。

不要在测试里反复污染 `process.env`。

测试可以传一个假的 reader：

```ts
const env = {
  get(name: string) {
    return map[name];
  },
};
```

## Step 3：Provider 配置

新增 `src/auth/providerConfig.ts`：

```ts
import type { EnvReader } from "./env";
import type { ProviderConfig } from "./types";

const DEFAULT_BASE_URL = "https://api.deepseek.com/anthropic";
const DEFAULT_MODEL = "deepseek-v4-flash";

export function resolveProviderConfig(env: EnvReader): ProviderConfig {
  const baseUrl = env.get("ANTHROPIC_BASE_URL") ?? DEFAULT_BASE_URL;
  const model = env.get("ANTHROPIC_MODEL") ?? DEFAULT_MODEL;

  assertValidBaseUrl(baseUrl);
  assertValidModel(model);

  return {
    provider: "anthropic-compatible",
    baseUrl,
    model,
  };
}

function assertValidBaseUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("ANTHROPIC_BASE_URL must be a valid URL.");
  }

  if (url.protocol !== "https:" && !isLocalhost(url.hostname)) {
    throw new Error("ANTHROPIC_BASE_URL must use https unless it is localhost.");
  }
}

function assertValidModel(value: string): void {
  if (!value.trim()) {
    throw new Error("ANTHROPIC_MODEL must not be empty.");
  }
}

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}
```

为什么默认值还是 DeepSeek？

因为本课程前面已经选择了 DeepSeek Anthropic-compatible 作为可直接运行的主线。

如果你要切回 Anthropic 官方 API，只需要：

```bash
export ANTHROPIC_AUTH_TOKEN="<your-token>"
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
export ANTHROPIC_MODEL="<your-model>"
```

如果你要更贴近官方 CLI 的默认行为，也可以把默认 base URL 改成官方地址。

但课程实现建议不要把默认值散落在 LLM client、model router、command 里。

默认值只能在 `providerConfig.ts`。

## Step 4：认证解析

新增 `src/auth/resolver.ts`：

```ts
import type { EnvReader } from "./env";
import { resolveProviderConfig } from "./providerConfig";
import type { ResolvedAuth, ResolvedProviderAuth } from "./types";

export interface SecretStoreReader {
  get(name: string): Promise<string | null>;
}

export async function resolveProviderAuth(
  env: EnvReader,
  secretStore?: SecretStoreReader,
): Promise<ResolvedProviderAuth> {
  const provider = resolveProviderConfig(env);
  const auth = await resolveAuth(env, secretStore);

  return { provider, auth };
}

export async function resolveAuth(
  env: EnvReader,
  secretStore?: SecretStoreReader,
): Promise<ResolvedAuth> {
  const bearer = env.get("ANTHROPIC_AUTH_TOKEN");
  if (bearer) {
    return {
      mode: "bearer-token",
      source: "ANTHROPIC_AUTH_TOKEN",
      secret: bearer,
    };
  }

  const apiKey = env.get("ANTHROPIC_API_KEY");
  if (apiKey) {
    return {
      mode: "api-key",
      source: "ANTHROPIC_API_KEY",
      secret: apiKey,
    };
  }

  const stored = await secretStore?.get("anthropic-compatible-token");
  if (stored) {
    return {
      mode: "bearer-token",
      source: "secret-store",
      secret: stored,
    };
  }

  return {
    mode: "none",
    source: "none",
    secret: null,
  };
}
```

这里的优先级是刻意的：

```txt
ANTHROPIC_AUTH_TOKEN
  ↓
ANTHROPIC_API_KEY
  ↓
secret-store
  ↓
none
```

为什么 `ANTHROPIC_AUTH_TOKEN` 优先？

因为 DeepSeek Anthropic-compatible 使用 Bearer token 更直接。

这也匹配你之前的实际配置。

如果两个变量都设置了，Mini 应该使用 `ANTHROPIC_AUTH_TOKEN`，并在 doctor 里提示冲突。

## Step 5：脱敏工具

新增 `src/auth/redaction.ts`：

```ts
const SECRET_NAME_RE = /(token|api[_-]?key|secret|password|credential)/i;

export function maskSecret(value: string | null | undefined): string {
  if (!value) return "unset";

  const length = value.length;
  if (length < 12) return `[redacted] (${length} chars)`;

  return `${value.slice(0, 4)}...${value.slice(-4)} (${length} chars)`;
}

export function isSecretLikeName(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}

export function redactKnownSecrets(input: string, secrets: Array<string | null | undefined>): string {
  let output = input;

  for (const secret of secrets) {
    if (!secret) continue;
    output = output.split(secret).join("[REDACTED]");
  }

  return output;
}

export function sanitizeEnvForDisplay(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    result[name] = isSecretLikeName(name) ? maskSecret(value) : value;
  }

  return result;
}
```

这不是加密。

这是输出安全。

所有 UI、日志、错误详情、transcript 都应该只用脱敏后的值。

不要做这种事：

```ts
throw new Error(`Auth failed with token ${token}`);
```

应该做：

```ts
throw new Error(`Auth failed with source ${source}`);
```

## Step 6：创建 SDK 客户端

新增 `src/auth/client.ts`：

```ts
import Anthropic from "@anthropic-ai/sdk";
import type { ResolvedProviderAuth } from "./types";

export function createAnthropicCompatibleClient(resolved: ResolvedProviderAuth): Anthropic {
  const { provider, auth } = resolved;

  if (auth.mode === "none" || !auth.secret) {
    throw new Error("Missing auth token. Set ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY.");
  }

  if (auth.mode === "bearer-token") {
    return new Anthropic({
      apiKey: null,
      baseURL: provider.baseUrl,
      defaultHeaders: {
        Authorization: `Bearer ${auth.secret}`,
      },
    });
  }

  return new Anthropic({
    apiKey: auth.secret,
    baseURL: provider.baseUrl,
  });
}
```

这就是本章和你之前问题的核心答案。

继续使用：

```ts
import Anthropic from "@anthropic-ai/sdk";
```

不换 SDK。

不新增 DeepSeek SDK。

不写协议适配层。

只把配置集中在一个地方：

```ts
createAnthropicCompatibleClient(resolveProviderAuth(...))
```

DeepSeek 的三个环境变量分别落到：

```txt
ANTHROPIC_AUTH_TOKEN -> defaultHeaders.Authorization
ANTHROPIC_BASE_URL   -> SDK baseURL
ANTHROPIC_MODEL      -> messages.create({ model })
```

## Step 7：改造 LLM client

假设第二章或第二十章里已经有 `src/llm/anthropic.ts`。

原来可能是：

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});
```

改成：

```ts
import { createAnthropicCompatibleClient } from "../auth/client";
import { processEnvReader } from "../auth/env";
import { resolveProviderAuth } from "../auth/resolver";

export async function createLlmClient() {
  const resolved = await resolveProviderAuth(processEnvReader);
  return {
    client: createAnthropicCompatibleClient(resolved),
    provider: resolved.provider,
  };
}
```

发送消息时：

```ts
export async function runMessage(input: string) {
  const { client, provider } = await createLlmClient();

  const response = await client.messages.create({
    model: provider.model,
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: input,
      },
    ],
  });

  return response;
}
```

注意：`model` 从 `provider.model` 来。

不要在这里再读 `process.env.ANTHROPIC_MODEL`。

如果你已经实现了第二十章的 ModelRouter，那么这里应改成：

```ts
const route = modelRouter.resolve({ role: "main" });

const response = await client.messages.create({
  model: route.model,
  max_tokens: route.capability.maxOutputTokens,
  messages,
});
```

Provider 配置提供默认模型。

ModelRouter 可以覆盖具体模型。

两者不冲突。

## Step 8：公开状态

新增 `src/auth/status.ts`：

```ts
import type { ResolvedProviderAuth, PublicAuthStatus } from "./types";

export function toPublicAuthStatus(resolved: ResolvedProviderAuth): PublicAuthStatus {
  return {
    provider: resolved.provider.provider,
    baseUrl: resolved.provider.baseUrl,
    model: resolved.provider.model,
    authMode: resolved.auth.mode,
    authSource: resolved.auth.source,
    tokenSet: resolved.auth.secret !== null && resolved.auth.secret.length > 0,
  };
}

export function formatAuthStatus(status: PublicAuthStatus): string {
  return [
    "Auth",
    "",
    `Provider: ${status.provider}`,
    `Base URL: ${status.baseUrl}`,
    `Model: ${status.model}`,
    `Auth source: ${status.authSource}`,
    `Auth mode: ${status.authMode}`,
    `Token: ${status.tokenSet ? "set" : "unset"}`,
  ].join("\n");
}
```

这个模块只能接收 `ResolvedProviderAuth`，但输出必须是 public 状态。

不要提供 `formatResolvedAuth()` 这种容易误用的函数。

## Step 9：实现 `/auth`

新增 `src/commands/auth.ts`：

```ts
import { processEnvReader } from "../auth/env";
import { runAuthDoctor, formatAuthDoctor } from "../auth/doctor";
import { resolveProviderAuth } from "../auth/resolver";
import { formatAuthStatus, toPublicAuthStatus } from "../auth/status";

export async function authCommand(args: string[]): Promise<string> {
  const subcommand = args[0];

  if (subcommand === "doctor") {
    const report = await runAuthDoctor(processEnvReader);
    return formatAuthDoctor(report);
  }

  const resolved = await resolveProviderAuth(processEnvReader);
  return formatAuthStatus(toPublicAuthStatus(resolved));
}
```

注册到命令系统：

```ts
import { authCommand } from "./auth";

registry.register({
  name: "auth",
  description: "Show authentication and provider status",
  run: authCommand,
});
```

现在用户可以运行：

```txt
> /auth
```

和：

```txt
> /auth doctor
```

## Step 10：Auth Doctor

新增 `src/auth/doctor.ts`：

```ts
import type { EnvReader } from "./env";
import { resolveProviderAuth } from "./resolver";

export type DoctorLevel = "ok" | "warn" | "error";

export interface DoctorItem {
  level: DoctorLevel;
  message: string;
}

export interface AuthDoctorReport {
  items: DoctorItem[];
}

export async function runAuthDoctor(env: EnvReader): Promise<AuthDoctorReport> {
  const items: DoctorItem[] = [];

  try {
    const resolved = await resolveProviderAuth(env);

    items.push({ level: "ok", message: "ANTHROPIC_BASE_URL is valid" });
    items.push({ level: "ok", message: "ANTHROPIC_MODEL is set" });

    if (resolved.auth.mode === "none") {
      items.push({ level: "error", message: "missing auth token" });
    } else {
      items.push({ level: "ok", message: `${resolved.auth.source} is set` });
    }

    if (env.get("ANTHROPIC_AUTH_TOKEN") && env.get("ANTHROPIC_API_KEY")) {
      items.push({
        level: "warn",
        message: "ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY are both set; bearer token will win",
      });
    }
  } catch (error) {
    items.push({
      level: "error",
      message: error instanceof Error ? error.message : "unknown auth error",
    });
  }

  return { items };
}

export function formatAuthDoctor(report: AuthDoctorReport): string {
  const lines = ["Auth Doctor", ""];

  for (const item of report.items) {
    lines.push(`${label(item.level)}  ${item.message}`);
  }

  const hasMissingAuth = report.items.some(
    item => item.level === "error" && item.message.includes("missing auth token"),
  );

  if (hasMissingAuth) {
    lines.push("");
    lines.push("Set one of:");
    lines.push('  export ANTHROPIC_AUTH_TOKEN="<token>"');
    lines.push('  export ANTHROPIC_API_KEY="<key>"');
  }

  return lines.join("\n");
}

function label(level: DoctorLevel): string {
  if (level === "ok") return "OK   ";
  if (level === "warn") return "WARN ";
  return "ERROR";
}
```

Doctor 的作用不是发请求。

Doctor 的作用是解释本地配置。

这一点很重要。

如果 doctor 为了检查 token 是否有效而直接打远程 API，会引入：

- 网络慢。
- 额度消耗。
- 密钥泄漏风险。
- CI 环境不稳定。

Mini 第一版只做本地静态诊断。

后续可以加显式命令：

```txt
> /auth ping
```

这种命令再去发最小 API 请求。

## Step 11：最小 `/login`

本课程主线推荐使用环境变量。

但为了更接近官方体验，Mini 可以提供最小 `/login`。

它不是 OAuth。

它只是一个安全配置入口。

新增 `src/auth/login.ts`：

```ts
import { mkdir, chmod, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

export interface MiniSettings {
  provider?: {
    baseUrl?: string;
    model?: string;
  };
}

const SETTINGS_DIR = join(homedir(), ".mini-claude");
const SETTINGS_FILE = join(SETTINGS_DIR, "settings.json");

export async function saveProviderSettings(settings: MiniSettings): Promise<void> {
  await mkdir(SETTINGS_DIR, { recursive: true });
  await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf8");
  await chmod(SETTINGS_FILE, 0o600).catch(() => undefined);
}

export async function readProviderSettings(): Promise<MiniSettings> {
  try {
    const raw = await readFile(SETTINGS_FILE, "utf8");
    const parsed = JSON.parse(raw) as MiniSettings;
    return parsed;
  } catch {
    return {};
  }
}
```

这里故意不保存 token。

settings 只保存非敏感配置：

```json
{
  "provider": {
    "baseUrl": "https://api.deepseek.com/anthropic",
    "model": "deepseek-v4-flash"
  }
}
```

token 仍然来自：

```bash
export ANTHROPIC_AUTH_TOKEN="<your-deepseek-key>"
```

为什么？

因为用户级 settings 文件即使 `chmod 600`，本质上仍是明文。

Mini 要先把最安全、最容易解释的路径做好。

## Step 12：让配置文件参与解析

如果你希望 `/login` 保存的 base URL 和 model 生效，可以扩展 `providerConfig.ts`。

```ts
import type { EnvReader } from "./env";
import { readProviderSettings } from "./login";
import type { ProviderConfig } from "./types";

const DEFAULT_BASE_URL = "https://api.deepseek.com/anthropic";
const DEFAULT_MODEL = "deepseek-v4-flash";

export async function resolveProviderConfig(env: EnvReader): Promise<ProviderConfig> {
  const settings = await readProviderSettings();

  const baseUrl =
    env.get("ANTHROPIC_BASE_URL") ??
    settings.provider?.baseUrl ??
    DEFAULT_BASE_URL;

  const model =
    env.get("ANTHROPIC_MODEL") ??
    settings.provider?.model ??
    DEFAULT_MODEL;

  assertValidBaseUrl(baseUrl);
  assertValidModel(model);

  return {
    provider: "anthropic-compatible",
    baseUrl,
    model,
  };
}
```

优先级变成：

```txt
environment
  ↓
user settings
  ↓
default
```

这也是官方 CLI 常见的配置模式。

环境变量适合临时覆盖。

settings 适合长期默认值。

默认值适合开箱可运行。

## Step 13：SecretStore 接口

如果你确实想提供持久化 token，可以加 SecretStore。

新增 `src/auth/secretStore.ts`：

```ts
import { chmod, mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const SECRET_DIR = join(homedir(), ".mini-claude");
const SECRET_FILE = join(SECRET_DIR, "secrets.json");

export function createFileSecretStore(): SecretStore {
  return {
    async get(key) {
      const data = await readSecrets();
      return data[key] ?? null;
    },

    async set(key, value) {
      const data = await readSecrets();
      data[key] = value;
      await writeSecrets(data);
    },

    async delete(key) {
      const data = await readSecrets();
      delete data[key];
      await writeSecrets(data);
    },
  };
}

async function readSecrets(): Promise<Record<string, string>> {
  try {
    const raw = await readFile(SECRET_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

async function writeSecrets(data: Record<string, string>): Promise<void> {
  await mkdir(SECRET_DIR, { recursive: true });
  await writeFile(SECRET_FILE, JSON.stringify(data, null, 2), "utf8");
  await chmod(SECRET_FILE, 0o600).catch(() => undefined);
}
```

但要在文档和 UI 中写清楚：

```txt
This stores the token in a local user-only file. Prefer environment variables for shared machines.
```

更接近官方的后续版本应该做：

- macOS Keychain。
- Linux libsecret。
- Windows Credential Manager。
- 明文文件 fallback。

本章只要求接口先稳定。

## Step 14：配置 DeepSeek 的推荐方式

本课程推荐把 DeepSeek 配置写在 shell 环境里。

```bash
export ANTHROPIC_AUTH_TOKEN="<your-deepseek-key>"
export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
export ANTHROPIC_MODEL="deepseek-v4-flash"
```

如果你有启动脚本，可以这样：

```bash
bun run dev
```

不要把真实 key 写进：

- `src/`。
- `courses/`。
- `.mini/` 项目配置。
- transcript。
- test fixture。
- issue 模板。
- debug log。

如果需要在项目里记录配置示例，只能写：

```bash
export ANTHROPIC_AUTH_TOKEN="<your-deepseek-key>"
export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
export ANTHROPIC_MODEL="deepseek-v4-flash"
```

不要写真实值。

## Step 15：为什么不用 OpenAI-compatible provider

真实工程里已经有 OpenAI、Gemini、Grok adapter。

项目里也能看到 `providerRegistry` 支持 DeepSeek OpenAI-compatible：

```txt
deepseek -> https://api.deepseek.com/v1
```

但本课程当前不走那条路径。

原因很简单：

1. 你当前的 DeepSeek Anthropic-compatible 已经能直接使用。
2. 这条路径可以继续使用 `@anthropic-ai/sdk`。
3. 工具调用、messages 结构、stream 事件都更接近 Claude Code 主线。
4. 不需要写 OpenAI Chat Completions 到 Anthropic event 的 adapter。

后续如果要支持更多供应商，再做 provider adapter。

但第 41 章的 Mini 应该把当前最短路径做稳。

## Step 16：避免配置混淆

最容易出错的是同时存在多套变量。

例如：

```bash
export ANTHROPIC_AUTH_TOKEN="<deepseek-key>"
export ANTHROPIC_API_KEY="<anthropic-key>"
export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
export ANTHROPIC_MODEL="deepseek-v4-flash"
```

Mini 的策略是：

```txt
ANTHROPIC_AUTH_TOKEN wins
```

但 doctor 要提示：

```txt
WARN  ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY are both set; bearer token will win
```

另一个错误是：

```bash
export ANTHROPIC_AUTH_TOKEN="<deepseek-key>"
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
export ANTHROPIC_MODEL="deepseek-v4-flash"
```

这会把 DeepSeek 模型名发到 Anthropic 官方地址。

Mini 可以做弱校验：

```ts
export function inferProviderWarning(baseUrl: string, model: string): string | null {
  const host = new URL(baseUrl).hostname;

  if (host.includes("anthropic.com") && model.includes("deepseek")) {
    return "model looks like DeepSeek but base URL is Anthropic";
  }

  if (host.includes("deepseek.com") && model.includes("claude")) {
    return "model looks like Claude but base URL is DeepSeek";
  }

  return null;
}
```

这类校验只能 warning。

不要直接阻断。

有些用户会通过内部网关代理模型名。

## Step 17：请求错误脱敏

LLM 请求失败时，错误对象可能包含请求信息。

新增一个安全包装：

```ts
import { redactKnownSecrets } from "./redaction";
import type { ResolvedProviderAuth } from "./types";

export function formatAuthError(error: unknown, resolved: ResolvedProviderAuth): Error {
  const raw = error instanceof Error ? error.message : String(error);
  const sanitized = redactKnownSecrets(raw, [resolved.auth.secret]);

  return new Error(
    [
      "Model request failed.",
      `Provider: ${resolved.provider.provider}`,
      `Base URL: ${resolved.provider.baseUrl}`,
      `Model: ${resolved.provider.model}`,
      `Auth source: ${resolved.auth.source}`,
      `Detail: ${sanitized}`,
    ].join("\n"),
  );
}
```

这里可以显示：

- Provider。
- Base URL。
- Model。
- Auth source。

但不能显示：

- Token。
- API key。
- Authorization header。
- `x-api-key` header。

## Step 18：Transcript 安全

如果 Mini 已经实现 transcript，需要加入一条规则：

> transcript 记录配置来源，不记录配置值。

可以记录：

```json
{
  "type": "auth_status",
  "provider": "anthropic-compatible",
  "baseUrl": "https://api.deepseek.com/anthropic",
  "model": "deepseek-v4-flash",
  "authSource": "ANTHROPIC_AUTH_TOKEN",
  "authMode": "bearer-token",
  "tokenSet": true
}
```

不要记录：

```json
{
  "token": "real-token-value"
}
```

更稳的做法是 transcript 只接收 `PublicAuthStatus`。

类型上让它拿不到 `ResolvedAuth.secret`。

## Step 19：日志安全

给日志模块加一层全局 redact。

例如：

```ts
import { redactKnownSecrets } from "../auth/redaction";

const activeSecrets = new Set<string>();

export function registerSecretForRedaction(secret: string | null | undefined): void {
  if (secret) activeSecrets.add(secret);
}

export function debugLog(message: string): void {
  const sanitized = redactKnownSecrets(message, Array.from(activeSecrets));
  console.error(sanitized);
}
```

在启动时：

```ts
const resolved = await resolveProviderAuth(processEnvReader);
registerSecretForRedaction(resolved.auth.secret);
```

这不是替代良好代码习惯。

它只是最后一道防线。

调用方仍然不应该主动拼接 token。

## Step 20：测试 redaction

新增 `src/auth/__tests__/redaction.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { maskSecret, redactKnownSecrets, sanitizeEnvForDisplay } from "../redaction";

describe("maskSecret", () => {
  test("does not expose short secrets", () => {
    expect(maskSecret("abc123")).toBe("[redacted] (6 chars)");
  });

  test("shows only prefix and suffix for long secrets", () => {
    expect(maskSecret("sk-ant-api03-abcdefghijklmnopqrstuvwxyz")).toContain("...");
    expect(maskSecret("sk-ant-api03-abcdefghijklmnopqrstuvwxyz")).not.toContain("abcdefghijklmnop");
  });
});

describe("redactKnownSecrets", () => {
  test("removes known secret values", () => {
    const output = redactKnownSecrets("failed with token secret-value", ["secret-value"]);
    expect(output).toBe("failed with token [REDACTED]");
  });
});

describe("sanitizeEnvForDisplay", () => {
  test("masks secret-like names", () => {
    const result = sanitizeEnvForDisplay({
      ANTHROPIC_AUTH_TOKEN: "secret-value-123456",
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
    });

    expect(result.ANTHROPIC_AUTH_TOKEN).not.toBe("secret-value-123456");
    expect(result.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic");
  });
});
```

## Step 21：测试 Provider 配置

新增 `src/auth/__tests__/providerConfig.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { resolveProviderConfig } from "../providerConfig";
import type { EnvReader } from "../env";

function env(values: Record<string, string | undefined>): EnvReader {
  return {
    get(name) {
      return values[name];
    },
  };
}

describe("resolveProviderConfig", () => {
  test("uses DeepSeek defaults", () => {
    const result = resolveProviderConfig(env({}));

    expect(result.provider).toBe("anthropic-compatible");
    expect(result.baseUrl).toBe("https://api.deepseek.com/anthropic");
    expect(result.model).toBe("deepseek-v4-flash");
  });

  test("uses environment overrides", () => {
    const result = resolveProviderConfig(
      env({
        ANTHROPIC_BASE_URL: "https://api.example.com/anthropic",
        ANTHROPIC_MODEL: "custom-model",
      }),
    );

    expect(result.baseUrl).toBe("https://api.example.com/anthropic");
    expect(result.model).toBe("custom-model");
  });

  test("rejects invalid base URL", () => {
    expect(() =>
      resolveProviderConfig(
        env({
          ANTHROPIC_BASE_URL: "not a url",
        }),
      ),
    ).toThrow("ANTHROPIC_BASE_URL");
  });
});
```

如果你把 `resolveProviderConfig` 改成 async 读取 settings，测试也改成 `await`。

## Step 22：测试 Auth Resolver

新增 `src/auth/__tests__/resolver.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { resolveAuth } from "../resolver";
import type { EnvReader } from "../env";

function env(values: Record<string, string | undefined>): EnvReader {
  return {
    get(name) {
      return values[name];
    },
  };
}

describe("resolveAuth", () => {
  test("prefers ANTHROPIC_AUTH_TOKEN", async () => {
    const result = await resolveAuth(
      env({
        ANTHROPIC_AUTH_TOKEN: "bearer",
        ANTHROPIC_API_KEY: "api-key",
      }),
    );

    expect(result.mode).toBe("bearer-token");
    expect(result.source).toBe("ANTHROPIC_AUTH_TOKEN");
    expect(result.secret).toBe("bearer");
  });

  test("falls back to ANTHROPIC_API_KEY", async () => {
    const result = await resolveAuth(
      env({
        ANTHROPIC_API_KEY: "api-key",
      }),
    );

    expect(result.mode).toBe("api-key");
    expect(result.source).toBe("ANTHROPIC_API_KEY");
    expect(result.secret).toBe("api-key");
  });

  test("returns none when no auth is configured", async () => {
    const result = await resolveAuth(env({}));

    expect(result.mode).toBe("none");
    expect(result.source).toBe("none");
    expect(result.secret).toBeNull();
  });

  test("uses secret store after env vars", async () => {
    const result = await resolveAuth(env({}), {
      async get(name) {
        expect(name).toBe("anthropic-compatible-token");
        return "stored-token";
      },
    });

    expect(result.mode).toBe("bearer-token");
    expect(result.source).toBe("secret-store");
    expect(result.secret).toBe("stored-token");
  });
});
```

## Step 23：测试 Doctor

新增 `src/auth/__tests__/doctor.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { runAuthDoctor } from "../doctor";
import type { EnvReader } from "../env";

function env(values: Record<string, string | undefined>): EnvReader {
  return {
    get(name) {
      return values[name];
    },
  };
}

describe("runAuthDoctor", () => {
  test("reports ok for DeepSeek Anthropic-compatible config", async () => {
    const report = await runAuthDoctor(
      env({
        ANTHROPIC_AUTH_TOKEN: "token",
        ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
        ANTHROPIC_MODEL: "deepseek-v4-flash",
      }),
    );

    expect(report.items.some(item => item.level === "error")).toBe(false);
  });

  test("reports missing auth", async () => {
    const report = await runAuthDoctor(
      env({
        ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
        ANTHROPIC_MODEL: "deepseek-v4-flash",
      }),
    );

    expect(report.items).toContainEqual({
      level: "error",
      message: "missing auth token",
    });
  });

  test("warns when both bearer token and api key are set", async () => {
    const report = await runAuthDoctor(
      env({
        ANTHROPIC_AUTH_TOKEN: "token",
        ANTHROPIC_API_KEY: "key",
      }),
    );

    expect(report.items.some(item => item.level === "warn")).toBe(true);
  });
});
```

## Step 24：手动验收

设置 DeepSeek：

```bash
export ANTHROPIC_AUTH_TOKEN="<your-deepseek-key>"
export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
export ANTHROPIC_MODEL="deepseek-v4-flash"
```

运行：

```bash
bun run dev
```

在 Mini 里执行：

```txt
> /auth
```

期望：

```txt
Auth

Provider: anthropic-compatible
Base URL: https://api.deepseek.com/anthropic
Model: deepseek-v4-flash
Auth source: ANTHROPIC_AUTH_TOKEN
Auth mode: bearer-token
Token: set
```

执行：

```txt
> /auth doctor
```

期望没有 error。

再临时去掉 token：

```bash
unset ANTHROPIC_AUTH_TOKEN
bun run dev
```

执行：

```txt
> /auth doctor
```

期望：

```txt
ERROR  missing auth token
```

再测试普通消息：

```txt
> 只回复 ok
```

期望模型正常返回。

## Step 25：自动化验收

运行 auth 测试：

```bash
bun test src/auth/__tests__/redaction.test.ts
bun test src/auth/__tests__/providerConfig.test.ts
bun test src/auth/__tests__/resolver.test.ts
bun test src/auth/__tests__/doctor.test.ts
```

运行全量类型检查：

```bash
bun run typecheck
```

如果你已经把 `/auth` 接入命令系统，也跑命令测试：

```bash
bun test src/commands/__tests__/auth.test.ts
```

## 常见坑

第一，把 DeepSeek key 写成 `ANTHROPIC_API_KEY`。

不是一定不能用。

但本课程主线建议使用 `ANTHROPIC_AUTH_TOKEN`，因为它会以 Bearer token 形式发送，更贴近你当前可用配置。

第二，把 `ANTHROPIC_BASE_URL` 写成 OpenAI-compatible 地址。

这章走的是 Anthropic-compatible。

DeepSeek 地址应该是：

```txt
https://api.deepseek.com/anthropic
```

不是：

```txt
https://api.deepseek.com/v1
```

`/v1` 是 OpenAI-compatible 路线。

第三，在 `/auth` 输出里显示 token preview。

最好不要。

对用户来说，只知道 token 是否 set、来源是什么就够了。

第四，把密钥保存到项目配置。

项目配置经常会提交到仓库。

密钥只能在环境变量、用户级 secret store 或系统凭据管理器里。

第五，错误信息包含请求 header。

很多 SDK error 会携带 request/response 信息。

格式化错误前先 redact。

第六，Provider 配置直接发起网络请求验证。

本地 doctor 应该快、稳定、无额度消耗。

网络验证应该做成显式 ping。

第七，把 provider 和 model 混成一个配置。

`deepseek-v4-flash` 是模型名。

`https://api.deepseek.com/anthropic` 是 provider endpoint。

`ANTHROPIC_AUTH_TOKEN` 是认证来源。

三者必须分开。

第八，OpenAI-compatible 和 Anthropic-compatible 混用。

如果使用：

```txt
https://api.deepseek.com/anthropic
```

就继续走 `@anthropic-ai/sdk`。

如果使用：

```txt
https://api.deepseek.com/v1
```

才需要 OpenAI-compatible adapter。

本章不做 adapter。

## 和官方 Claude Code 的距离

这一章之后，Mini 仍然比官方少很多认证能力：

- 没有完整 Claude.ai OAuth。
- 没有 device trust。
- 没有 managed settings。
- 没有 remote auth proxy。
- 没有云 provider 凭据刷新。
- 没有系统 Keychain 完整实现。

但 Mini 已经接近官方的关键架构原则：

- Provider 选择和模型选择分离。
- 认证来源可解释。
- 请求层集中创建 SDK client。
- 密钥默认走环境变量。
- UI 和日志只显示 public auth status。
- Doctor 解释本地配置。
- `@anthropic-ai/sdk` 保持为 Anthropic-compatible 主链路。

这比“在请求函数里随手读三个环境变量”稳定得多。

## 小结

本章把 Mini 的认证和 Provider 配置收束到统一入口。

现在 Mini 支持：

- DeepSeek Anthropic-compatible 配置。
- `ANTHROPIC_AUTH_TOKEN` Bearer token。
- `ANTHROPIC_API_KEY` fallback。
- `ANTHROPIC_BASE_URL`。
- `ANTHROPIC_MODEL`。
- `@anthropic-ai/sdk` 客户端集中创建。
- Auth status。
- Auth doctor。
- 密钥脱敏。
- 用户级非敏感 settings。
- 可扩展 SecretStore。

最重要的是：

```txt
SDK 不换。
Provider 不散。
Secret 不打印。
```

下一章可以继续做 **OAuth 与订阅态**：补上 Claude.ai OAuth 的最小设备码流程、token refresh、订阅状态显示、API key 模式和 OAuth 模式的切换边界。
