# 第 42 章：OAuth 与订阅态

第四十一章把认证和 Provider 配置收束到统一入口。

现在 Mini 已经能稳定处理：

- `ANTHROPIC_AUTH_TOKEN`。
- `ANTHROPIC_API_KEY`。
- `ANTHROPIC_BASE_URL`。
- `ANTHROPIC_MODEL`。
- DeepSeek Anthropic-compatible。
- `@anthropic-ai/sdk` 客户端创建。
- Auth status 和 auth doctor。

这一章继续往官方 Claude Code 靠近：补上 Claude.ai OAuth 和订阅态。

但先明确边界。

本课程当前主线仍然是：

```bash
export ANTHROPIC_AUTH_TOKEN="<your-deepseek-key>"
export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
export ANTHROPIC_MODEL="deepseek-v4-flash"
```

这是 DeepSeek Anthropic-compatible 路径。

它不需要 Claude.ai OAuth。

OAuth 是为了接近官方 Claude Code 的登录体验：

- 浏览器登录。
- 本地 callback。
- token 持久化。
- token refresh。
- 订阅态显示。
- API key 模式和订阅模式的明确切换。

## 一个重要纠正

上一章结尾提到“设备码流程”。

更准确地说，官方 Claude Code 的 Claude.ai 登录主线不是 device code flow。

真实工程里 Claude.ai 使用的是：

```txt
OAuth Authorization Code + PKCE
```

流程是：

1. CLI 生成 `code_verifier`、`code_challenge`、`state`。
2. CLI 启动一个临时 localhost callback server。
3. CLI 打开浏览器授权 URL。
4. 浏览器登录后重定向回 `http://localhost:<port>/callback`。
5. CLI 校验 `state`，拿到 authorization code。
6. CLI 用 code + verifier 换 access token 和 refresh token。
7. CLI 拉取 profile，得到订阅类型。
8. CLI 保存 token 和订阅态。

如果浏览器 callback 不可用，真实工程还支持手动粘贴 code。

Mini 这一章也按这个形态设计。

不要把 ChatGPT device flow 或 OpenAI-compatible provider 混进 Claude.ai OAuth 主线。

## 本章目标

完成本章后，Mini 会具备：

1. OAuth 配置模块。
2. PKCE 工具。
3. 临时 localhost callback listener。
4. OAuth authorization URL 构造。
5. authorization code 换 token。
6. refresh token 刷新 access token。
7. token 过期判断。
8. OAuth token store。
9. 订阅 profile 解析。
10. `/login claude`。
11. `/logout`。
12. `/auth` 展示订阅态。
13. `auth doctor` 诊断 OAuth 和 API key 冲突。
14. 请求前自动 refresh。
15. 401 后强制 refresh。
16. OAuth 单元测试。

这一章的工程目标是：

> OAuth 是一个独立 auth plane，不要覆盖 DeepSeek 环境变量主线。

## 本章完成效果

DeepSeek 仍然这样用：

```bash
export ANTHROPIC_AUTH_TOKEN="<your-deepseek-key>"
export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
export ANTHROPIC_MODEL="deepseek-v4-flash"
bun run dev
```

查看状态：

```txt
> /auth
```

输出：

```txt
Auth

Provider: anthropic-compatible
Base URL: https://api.deepseek.com/anthropic
Model: deepseek-v4-flash
Auth source: ANTHROPIC_AUTH_TOKEN
Auth mode: bearer-token
Token: set
Subscription: not active
```

如果你走 Claude.ai OAuth：

```txt
> /login claude
```

浏览器登录完成后：

```txt
Login successful.
```

再看：

```txt
> /auth
```

输出：

```txt
Auth

Provider: anthropic-compatible
Base URL: https://api.anthropic.com
Model: <configured-model>
Auth source: claude.ai
Auth mode: oauth
Token: set
Subscription: pro
```

如果 OAuth token 快过期，请求前会自动 refresh。

如果 API 返回 OAuth 401，Mini 会清缓存并强制 refresh 一次。

## 真实工程如何处理

先对照真实工程。

### OAuth 配置

`src/constants/oauth.ts` 定义 OAuth 端点：

- authorize URL。
- token URL。
- profile URL 所属 API base。
- client id。
- success URL。
- manual redirect URL。
- scopes。

真实工程区分 prod、staging、local 和 custom OAuth URL。

Mini 只保留 prod。

### PKCE

`src/services/oauth/crypto.ts` 负责：

- `generateCodeVerifier()`。
- `generateCodeChallenge()`。
- `generateState()`。

这里使用随机字节 + SHA-256 + base64url。

### Callback listener

`src/services/oauth/auth-code-listener.ts` 启动临时 HTTP server。

它只做一件事：

```txt
接收 /callback?code=...&state=...
```

然后校验 state。

它不是 OAuth server。

它只是 redirect capture。

### OAuth service

`src/services/oauth/index.ts` 的 `OAuthService` 串起完整流程：

1. 启动 callback listener。
2. 生成 PKCE。
3. 构造 automatic 和 manual URL。
4. 打开浏览器。
5. 等待 authorization code。
6. 交换 token。
7. 拉取 profile。
8. 返回标准化 `OAuthTokens`。

### Token exchange 和 refresh

`src/services/oauth/client.ts` 负责：

- `buildAuthUrl()`。
- `exchangeCodeForTokens()`。
- `refreshOAuthToken()`。
- `isOAuthTokenExpired()`。
- `fetchProfileInfo()`。

真实工程会在 refresh 时尽量复用已有 profile，减少请求量。

Mini 可以先简单实现。

### Token 存储和缓存

`src/utils/auth.ts` 负责：

- `saveOAuthTokensIfNeeded()`。
- `getClaudeAIOAuthTokens()`。
- `getClaudeAIOAuthTokensAsync()`。
- `clearOAuthTokenCache()`。
- `checkAndRefreshOAuthTokenIfNeeded()`。
- `handleOAuth401Error()`。
- `isClaudeAISubscriber()`。
- `getSubscriptionType()`。

真实工程还处理：

- keychain fallback。
- 跨进程缓存失效。
- refresh lock。
- 401 并发去重。
- file descriptor token。
- managed OAuth context。

Mini 只保留最关键部分。

### 登录 UI

`src/components/ConsoleOAuthFlow.tsx` 是交互式 UI。

它会显示登录选项：

- Claude account with subscription。
- Anthropic Console account。
- Anthropic-compatible endpoint。
- OpenAI-compatible endpoint。
- 云 provider。

Mini 不需要完整 UI。

先做命令：

```txt
> /login claude
```

再把状态显示接回 `/auth`。

## Auth plane 设计

Mini 现在有三类认证来源。

```txt
external bearer token
  ANTHROPIC_AUTH_TOKEN

external api key
  ANTHROPIC_API_KEY

claude.ai oauth
  stored OAuth access token + refresh token
```

优先级建议保持：

```txt
ANTHROPIC_AUTH_TOKEN
  ↓
ANTHROPIC_API_KEY
  ↓
Claude.ai OAuth
  ↓
none
```

为什么 OAuth 不抢第一？

因为用户如果显式设置了环境变量，通常是在做临时覆盖、CI、代理或 DeepSeek Anthropic-compatible。

官方工程里也会避免 managed session 误读用户本地 API key。

Mini 第一版先使用一个简单规则：

> 显式环境变量优先于本地 OAuth。

这能保护你的 DeepSeek 主线。

## 本章项目结构变化

新增：

```txt
src/
  oauth/
    types.ts
    config.ts
    pkce.ts
    authCodeListener.ts
    oauthClient.ts
    oauthService.ts
    tokenStore.ts
    refresh.ts
    subscription.ts
    __tests__/
      pkce.test.ts
      oauthClient.test.ts
      tokenStore.test.ts
      refresh.test.ts
      subscription.test.ts
  commands/
    login.ts
    logout.ts
```

会修改：

```txt
src/
  auth/
    types.ts
    resolver.ts
    status.ts
    doctor.ts
    client.ts
  commands/
    auth.ts
    index.ts
  llm/
    anthropic.ts
```

如果你的 Mini 文件名不同，以已有模块为准。

关键是把 OAuth 生命周期放在 `src/oauth/`，不要散落到 LLM client 里。

## Step 1：OAuth 类型

新增 `src/oauth/types.ts`：

```ts
export type OAuthScope =
  | "user:profile"
  | "user:inference"
  | "user:sessions:claude_code"
  | "user:mcp_servers"
  | "user:file_upload";

export type SubscriptionType =
  | "free"
  | "pro"
  | "max"
  | "team"
  | "enterprise"
  | "unknown";

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  scopes: OAuthScope[];
  subscriptionType: SubscriptionType | null;
  rateLimitTier: string | null;
}

export interface OAuthTokenExchangeResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

export interface OAuthProfileResponse {
  account?: {
    uuid?: string;
    email?: string;
    display_name?: string;
    created_at?: string;
  };
  organization?: {
    uuid?: string;
    organization_type?: string;
    rate_limit_tier?: string | null;
    subscription_created_at?: string | null;
  };
}
```

真实工程的类型文件当前是 decompiled stub。

Mini 这里要补成真实类型。

不要用 `any`。

## Step 2：OAuth 配置

新增 `src/oauth/config.ts`：

```ts
export interface OAuthConfig {
  authorizeUrl: string;
  tokenUrl: string;
  profileUrl: string;
  successUrl: string;
  manualRedirectUrl: string;
  clientId: string;
  scopes: string[];
}

export const CLAUDE_AI_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
] as const;

export function getOAuthConfig(): OAuthConfig {
  return {
    authorizeUrl: "https://claude.com/cai/oauth/authorize",
    tokenUrl: "https://platform.claude.com/v1/oauth/token",
    profileUrl: "https://api.anthropic.com/api/oauth/profile",
    successUrl: "https://platform.claude.com/oauth/code/success?app=mini-claude",
    manualRedirectUrl: "https://platform.claude.com/oauth/code/callback",
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    scopes: [...CLAUDE_AI_SCOPES],
  };
}
```

这里沿用真实工程的 public client id。

如果你不希望 Mini 直接使用官方 OAuth app，可以改成自己的 OAuth app。

但课程目标是接近官方 Claude Code，所以这里先保持结构一致。

## Step 3：PKCE 工具

新增 `src/oauth/pkce.ts`：

```ts
import { createHash, randomBytes } from "node:crypto";

function base64Url(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function generateCodeVerifier(): string {
  return base64Url(randomBytes(32));
}

export function generateCodeChallenge(verifier: string): string {
  return base64Url(createHash("sha256").update(verifier).digest());
}

export function generateState(): string {
  return base64Url(randomBytes(32));
}
```

PKCE 的意义是：

- CLI 不需要 client secret。
- token exchange 必须带上 code verifier。
- 授权 code 被截获也很难被直接换 token。

`state` 的意义是防 CSRF。

callback 收到的 state 必须和本地生成的一致。

## Step 4：AuthCodeListener

新增 `src/oauth/authCodeListener.ts`：

```ts
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export class AuthCodeListener {
  private server: Server;
  private expectedState: string | null = null;
  private resolveCode: ((code: string) => void) | null = null;
  private rejectCode: ((error: Error) => void) | null = null;

  constructor(private readonly callbackPath = "/callback") {
    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "localhost", () => {
        const address = this.server.address() as AddressInfo;
        resolve(address.port);
      });
    });
  }

  waitForCode(expectedState: string): Promise<string> {
    this.expectedState = expectedState;

    return new Promise((resolve, reject) => {
      this.resolveCode = resolve;
      this.rejectCode = reject;
    });
  }

  close(): void {
    this.server.close();
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname !== this.callbackPath) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (!code) {
      this.fail(res, "Authorization code not found");
      return;
    }

    if (state !== this.expectedState) {
      this.fail(res, "Invalid state parameter");
      return;
    }

    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Login complete. You can return to Mini.");

    this.resolveCode?.(code);
    this.resolveCode = null;
    this.rejectCode = null;
  }

  private fail(res: ServerResponse, message: string): void {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(message);
    this.rejectCode?.(new Error(message));
    this.resolveCode = null;
    this.rejectCode = null;
  }
}
```

真实工程会在成功后 redirect 到 success URL。

Mini 第一版直接显示文本即可。

等 UI 更完整后再补 redirect。

## Step 5：构造授权 URL

新增 `src/oauth/oauthClient.ts`：

```ts
import { getOAuthConfig } from "./config";
import type { OAuthProfileResponse, OAuthTokenExchangeResponse, OAuthTokens, SubscriptionType } from "./types";

export function buildAuthorizationUrl(input: {
  codeChallenge: string;
  state: string;
  port: number;
  manual?: boolean;
}): string {
  const config = getOAuthConfig();
  const url = new URL(config.authorizeUrl);

  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set(
    "redirect_uri",
    input.manual ? config.manualRedirectUrl : `http://localhost:${input.port}/callback`,
  );
  url.searchParams.set("scope", config.scopes.join(" "));
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", input.state);

  return url.toString();
}
```

这里保留两个 URL：

- automatic：localhost callback。
- manual：平台 callback 页面，用户复制 code。

Mini 先实现 automatic。

manual 可以作为后续补充。

## Step 6：换 token

继续在 `src/oauth/oauthClient.ts` 添加：

```ts
export async function exchangeCodeForTokens(input: {
  authorizationCode: string;
  state: string;
  codeVerifier: string;
  port: number;
}): Promise<OAuthTokenExchangeResponse> {
  const config = getOAuthConfig();

  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: input.authorizationCode,
      redirect_uri: `http://localhost:${input.port}/callback`,
      client_id: config.clientId,
      code_verifier: input.codeVerifier,
      state: input.state,
    }),
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`);
  }

  return (await response.json()) as OAuthTokenExchangeResponse;
}
```

这里不要打印 response body。

OAuth 错误响应有时会包含敏感上下文。

需要调试时，先做 redaction。

## Step 7：刷新 token

继续添加：

```ts
export async function refreshOAuthToken(refreshToken: string): Promise<OAuthTokens> {
  const config = getOAuthConfig();

  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.clientId,
      scope: config.scopes.join(" "),
    }),
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`);
  }

  const data = (await response.json()) as OAuthTokenExchangeResponse;
  const profile = await fetchProfileInfo(data.access_token).catch(() => undefined);

  return formatOAuthTokens(data, profile);
}

export function isOAuthTokenExpired(expiresAt: number | null): boolean {
  if (expiresAt === null) return false;

  const refreshBufferMs = 5 * 60 * 1000;
  return Date.now() + refreshBufferMs >= expiresAt;
}
```

提前 5 分钟刷新。

不要等到最后一毫秒。

请求发出去、网络排队、服务端时钟和本地时钟都有误差。

## Step 8：拉取订阅 profile

继续添加：

```ts
export async function fetchProfileInfo(accessToken: string): Promise<OAuthProfileResponse | undefined> {
  const config = getOAuthConfig();

  const response = await fetch(config.profileUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    return undefined;
  }

  return (await response.json()) as OAuthProfileResponse;
}

export function subscriptionFromProfile(profile: OAuthProfileResponse | undefined): SubscriptionType | null {
  const orgType = profile?.organization?.organization_type;

  switch (orgType) {
    case "claude_pro":
      return "pro";
    case "claude_max":
      return "max";
    case "claude_team":
      return "team";
    case "claude_enterprise":
      return "enterprise";
    default:
      return null;
  }
}

export function formatOAuthTokens(
  response: OAuthTokenExchangeResponse,
  profile?: OAuthProfileResponse,
): OAuthTokens {
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token ?? null,
    expiresAt: Date.now() + response.expires_in * 1000,
    scopes: parseScopes(response.scope),
    subscriptionType: subscriptionFromProfile(profile),
    rateLimitTier: profile?.organization?.rate_limit_tier ?? null,
  };
}

function parseScopes(scope: string | undefined): OAuthTokens["scopes"] {
  const allowed = new Set([
    "user:profile",
    "user:inference",
    "user:sessions:claude_code",
    "user:mcp_servers",
    "user:file_upload",
  ]);

  return (scope ?? "")
    .split(/\s+/)
    .filter((item): item is OAuthTokens["scopes"][number] => allowed.has(item));
}
```

订阅态来自 profile。

Mini 不需要一开始就判断所有套餐权益。

先显示：

```txt
pro | max | team | enterprise | none
```

就足够支撑 UX 和后续权限分流。

## Step 9：OAuthService

新增 `src/oauth/oauthService.ts`：

```ts
import { AuthCodeListener } from "./authCodeListener";
import { buildAuthorizationUrl, exchangeCodeForTokens, fetchProfileInfo, formatOAuthTokens } from "./oauthClient";
import { generateCodeChallenge, generateCodeVerifier, generateState } from "./pkce";
import type { OAuthTokens } from "./types";

export interface BrowserOpener {
  open(url: string): Promise<void>;
}

export class OAuthService {
  private listener: AuthCodeListener | null = null;

  async login(opener: BrowserOpener): Promise<OAuthTokens> {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = generateState();

    this.listener = new AuthCodeListener();
    const port = await this.listener.start();

    const url = buildAuthorizationUrl({
      codeChallenge,
      state,
      port,
    });

    const codePromise = this.listener.waitForCode(state);
    await opener.open(url);

    try {
      const authorizationCode = await codePromise;
      const tokenResponse = await exchangeCodeForTokens({
        authorizationCode,
        state,
        codeVerifier,
        port,
      });
      const profile = await fetchProfileInfo(tokenResponse.access_token).catch(() => undefined);
      return formatOAuthTokens(tokenResponse, profile);
    } finally {
      this.listener.close();
    }
  }
}
```

`BrowserOpener` 是接口。

不要在 OAuthService 里直接依赖具体 UI。

终端命令可以实现：

```ts
const opener = {
  async open(url: string) {
    console.log(`Open this URL:\n${url}`);
    await openBrowser(url);
  },
};
```

测试里可以假装打开浏览器。

## Step 10：TokenStore

新增 `src/oauth/tokenStore.ts`：

```ts
import { chmod, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthTokens } from "./types";

const DIR = join(homedir(), ".mini-claude");
const FILE = join(DIR, "oauth.json");

export interface OAuthTokenStore {
  read(): Promise<OAuthTokens | null>;
  write(tokens: OAuthTokens): Promise<void>;
  clear(): Promise<void>;
}

export function createFileOAuthTokenStore(): OAuthTokenStore {
  return {
    async read() {
      try {
        const raw = await readFile(FILE, "utf8");
        return JSON.parse(raw) as OAuthTokens;
      } catch {
        return null;
      }
    },

    async write(tokens) {
      await mkdir(DIR, { recursive: true });
      await writeFile(FILE, JSON.stringify(tokens, null, 2), "utf8");
      await chmod(FILE, 0o600).catch(() => undefined);
    },

    async clear() {
      await rm(FILE, { force: true });
    },
  };
}
```

这仍然不是最理想的安全存储。

更接近官方的做法是：

- macOS Keychain。
- Linux secret service。
- Windows Credential Manager。
- 文件 fallback。

但 Mini 可以先用用户目录文件，并限制权限。

不要把 OAuth token 存到项目目录。

## Step 11：Refresh 管理器

新增 `src/oauth/refresh.ts`：

```ts
import { isOAuthTokenExpired, refreshOAuthToken } from "./oauthClient";
import type { OAuthTokenStore } from "./tokenStore";
import type { OAuthTokens } from "./types";

let inFlightRefresh: Promise<OAuthTokens | null> | null = null;

export async function getFreshOAuthTokens(store: OAuthTokenStore): Promise<OAuthTokens | null> {
  const tokens = await store.read();

  if (!tokens?.refreshToken) {
    return tokens;
  }

  if (!isOAuthTokenExpired(tokens.expiresAt)) {
    return tokens;
  }

  if (!inFlightRefresh) {
    inFlightRefresh = refreshAndStore(store, tokens.refreshToken).finally(() => {
      inFlightRefresh = null;
    });
  }

  return inFlightRefresh;
}

export async function forceRefreshOAuthTokens(store: OAuthTokenStore): Promise<OAuthTokens | null> {
  const tokens = await store.read();
  if (!tokens?.refreshToken) return null;
  return refreshAndStore(store, tokens.refreshToken);
}

async function refreshAndStore(store: OAuthTokenStore, refreshToken: string): Promise<OAuthTokens | null> {
  try {
    const refreshed = await refreshOAuthToken(refreshToken);
    await store.write(refreshed);
    return refreshed;
  } catch {
    return null;
  }
}
```

真实工程有跨进程 lock。

Mini 第一版只做进程内去重。

当你开始支持多个 Mini 进程同时运行时，再加文件锁。

## Step 12：订阅态模块

新增 `src/oauth/subscription.ts`：

```ts
import type { OAuthTokens, SubscriptionType } from "./types";

export interface SubscriptionStatus {
  active: boolean;
  type: SubscriptionType | null;
  rateLimitTier: string | null;
}

export function getSubscriptionStatus(tokens: OAuthTokens | null): SubscriptionStatus {
  if (!tokens?.accessToken) {
    return {
      active: false,
      type: null,
      rateLimitTier: null,
    };
  }

  return {
    active: true,
    type: tokens.subscriptionType,
    rateLimitTier: tokens.rateLimitTier,
  };
}

export function formatSubscription(status: SubscriptionStatus): string {
  if (!status.active) return "not active";
  return status.type ?? "active";
}
```

注意，`active=true` 只表示存在可用 OAuth token。

`type=null` 可能表示：

- profile 拉取失败。
- token scope 不足。
- 账户不是订阅账户。
- 服务端返回了新套餐类型。

UI 不应该把 `null` 简单等同于失败。

## Step 13：扩展 Auth 类型

修改第 41 章的 `src/auth/types.ts`：

```ts
export type AuthMode = "bearer-token" | "api-key" | "oauth" | "none";

export type AuthSource =
  | "ANTHROPIC_AUTH_TOKEN"
  | "ANTHROPIC_API_KEY"
  | "claude.ai"
  | "secret-store"
  | "none";

export interface PublicAuthStatus {
  provider: ProviderId;
  baseUrl: string;
  model: string;
  authMode: AuthMode;
  authSource: AuthSource;
  tokenSet: boolean;
  subscription: {
    active: boolean;
    type: "free" | "pro" | "max" | "team" | "enterprise" | "unknown" | null;
  };
}
```

把订阅态放到 public status。

不要把 OAuth access token 放进去。

## Step 14：扩展 Auth resolver

修改 `src/auth/resolver.ts`：

```ts
import type { EnvReader } from "./env";
import { resolveProviderConfig } from "./providerConfig";
import type { ResolvedAuth, ResolvedProviderAuth } from "./types";
import type { OAuthTokenStore } from "../oauth/tokenStore";
import { getFreshOAuthTokens } from "../oauth/refresh";

export async function resolveProviderAuth(
  env: EnvReader,
  options: {
    oauthStore?: OAuthTokenStore;
  } = {},
): Promise<ResolvedProviderAuth> {
  const provider = resolveProviderConfig(env);
  const auth = await resolveAuth(env, options.oauthStore);

  return { provider, auth };
}

export async function resolveAuth(
  env: EnvReader,
  oauthStore?: OAuthTokenStore,
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

  const oauth = oauthStore ? await getFreshOAuthTokens(oauthStore) : null;
  if (oauth?.accessToken) {
    return {
      mode: "oauth",
      source: "claude.ai",
      secret: oauth.accessToken,
    };
  }

  return {
    mode: "none",
    source: "none",
    secret: null,
  };
}
```

这一步是这一章最重要的接缝。

LLM 请求层不关心 token 是环境变量还是 OAuth。

它只关心：

```ts
ResolvedAuth
```

## Step 15：OAuth client 创建

修改第 41 章的 `src/auth/client.ts`：

```ts
import Anthropic from "@anthropic-ai/sdk";
import type { ResolvedProviderAuth } from "./types";

export function createAnthropicCompatibleClient(resolved: ResolvedProviderAuth): Anthropic {
  const { provider, auth } = resolved;

  if (auth.mode === "none" || !auth.secret) {
    throw new Error("Missing auth. Run /login claude or set ANTHROPIC_AUTH_TOKEN.");
  }

  if (auth.mode === "bearer-token" || auth.mode === "oauth") {
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

OAuth 和 `ANTHROPIC_AUTH_TOKEN` 都是 Bearer header。

差异在 source 和生命周期：

- `ANTHROPIC_AUTH_TOKEN` 由用户管理。
- OAuth token 由 Mini refresh。

## Step 16：请求前 refresh

在 LLM client 请求前确保 resolver 使用 OAuth store：

```ts
import { createAnthropicCompatibleClient } from "../auth/client";
import { processEnvReader } from "../auth/env";
import { resolveProviderAuth } from "../auth/resolver";
import { createFileOAuthTokenStore } from "../oauth/tokenStore";

const oauthStore = createFileOAuthTokenStore();

export async function createLlmClient() {
  const resolved = await resolveProviderAuth(processEnvReader, {
    oauthStore,
  });

  return {
    resolved,
    client: createAnthropicCompatibleClient(resolved),
  };
}
```

这样每次创建 client 前都会检查 OAuth token 是否需要 refresh。

如果你缓存 client，需要额外注意：

- token refresh 后旧 client 的 Authorization header 已经过期。
- 最简单的办法是不要长期缓存带 token 的 client。
- 或者 client 缓存 key 必须包含 access token 版本。

Mini 第一版建议每次请求创建 client。

## Step 17：401 后强制 refresh

如果请求失败并确认是 OAuth 401，可以强制 refresh 一次。

```ts
import { forceRefreshOAuthTokens } from "../oauth/refresh";
import { createFileOAuthTokenStore } from "../oauth/tokenStore";

const oauthStore = createFileOAuthTokenStore();

export async function runWithOAuthRetry<T>(
  authMode: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (authMode !== "oauth" || !isUnauthorized(error)) {
      throw error;
    }

    const refreshed = await forceRefreshOAuthTokens(oauthStore);
    if (!refreshed) {
      throw error;
    }

    return await operation();
  }
}

function isUnauthorized(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as Record<string, unknown>;
  return record.status === 401 || record.statusCode === 401;
}
```

真实工程会比较失败 token 和当前 keychain token，避免多个进程重复 refresh。

Mini 先做一次 retry。

不要无限 retry。

## Step 18：实现 `/login claude`

新增 `src/commands/login.ts`：

```ts
import { OAuthService } from "../oauth/oauthService";
import { createFileOAuthTokenStore } from "../oauth/tokenStore";

export async function loginCommand(args: string[]): Promise<string> {
  const method = args[0];

  if (method !== "claude") {
    return [
      "Usage:",
      "  /login claude",
      "",
      "DeepSeek Anthropic-compatible does not need OAuth.",
      "Set ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, and ANTHROPIC_MODEL instead.",
    ].join("\n");
  }

  const service = new OAuthService();
  const store = createFileOAuthTokenStore();

  const tokens = await service.login({
    async open(url) {
      console.log(`Open this URL to login:\n${url}`);
      await openUrl(url);
    },
  });

  await store.write(tokens);

  return "Login successful.";
}

async function openUrl(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", url]
        : ["xdg-open", url];

  Bun.spawn(command, {
    stdout: "ignore",
    stderr: "ignore",
  });
}
```

这里用了 `Bun.spawn`，符合本项目运行时。

注意：文档示例里不会自动帮用户粘贴任何 token。

OAuth token 只进 store。

## Step 19：实现 `/logout`

新增 `src/commands/logout.ts`：

```ts
import { createFileOAuthTokenStore } from "../oauth/tokenStore";

export async function logoutCommand(): Promise<string> {
  const store = createFileOAuthTokenStore();
  await store.clear();
  return "Logged out.";
}
```

Mini 第一版 logout 只清本地 token。

真实工程还会清：

- auth caches。
- API key。
- policy cache。
- user cache。
- remote managed settings。
- OAuth account info。

Mini 后面章节可以再补。

## Step 20：扩展 `/auth`

修改 `src/auth/status.ts`：

```ts
import type { OAuthTokenStore } from "../oauth/tokenStore";
import { getFreshOAuthTokens } from "../oauth/refresh";
import { getSubscriptionStatus, formatSubscription } from "../oauth/subscription";
import type { PublicAuthStatus, ResolvedProviderAuth } from "./types";

export async function toPublicAuthStatus(
  resolved: ResolvedProviderAuth,
  oauthStore?: OAuthTokenStore,
): Promise<PublicAuthStatus> {
  const oauthTokens = oauthStore ? await getFreshOAuthTokens(oauthStore) : null;
  const subscription = getSubscriptionStatus(oauthTokens);

  return {
    provider: resolved.provider.provider,
    baseUrl: resolved.provider.baseUrl,
    model: resolved.provider.model,
    authMode: resolved.auth.mode,
    authSource: resolved.auth.source,
    tokenSet: resolved.auth.secret !== null && resolved.auth.secret.length > 0,
    subscription: {
      active: subscription.active,
      type: subscription.type,
    },
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
    `Subscription: ${formatSubscription({
      active: status.subscription.active,
      type: status.subscription.type,
      rateLimitTier: null,
    })}`,
  ].join("\n");
}
```

这里有一个细节：

如果当前请求实际使用的是 `ANTHROPIC_AUTH_TOKEN`，仍然可以展示本地 OAuth subscription 状态。

但建议 UI 说明当前 auth source。

用户看到：

```txt
Auth source: ANTHROPIC_AUTH_TOKEN
Subscription: pro
```

就知道当前请求没有使用 subscription token。

## Step 21：扩展 doctor

修改 `src/auth/doctor.ts`：

```ts
import type { OAuthTokenStore } from "../oauth/tokenStore";
import { getFreshOAuthTokens } from "../oauth/refresh";
import { isOAuthTokenExpired } from "../oauth/oauthClient";

export async function addOAuthDoctorItems(
  items: DoctorItem[],
  oauthStore?: OAuthTokenStore,
): Promise<void> {
  if (!oauthStore) {
    items.push({ level: "warn", message: "OAuth token store is not configured" });
    return;
  }

  const tokens = await oauthStore.read();
  if (!tokens) {
    items.push({ level: "ok", message: "Claude.ai OAuth is not logged in" });
    return;
  }

  items.push({ level: "ok", message: "Claude.ai OAuth token is stored" });

  if (tokens.refreshToken) {
    items.push({ level: "ok", message: "OAuth refresh token is available" });
  } else {
    items.push({ level: "warn", message: "OAuth refresh token is missing" });
  }

  if (isOAuthTokenExpired(tokens.expiresAt)) {
    const fresh = await getFreshOAuthTokens(oauthStore);
    if (fresh?.accessToken) {
      items.push({ level: "ok", message: "OAuth token refresh succeeded" });
    } else {
      items.push({ level: "error", message: "OAuth token is expired and refresh failed" });
    }
  }
}
```

再补冲突提示：

```ts
if (env.get("ANTHROPIC_AUTH_TOKEN") && oauthTokens) {
  items.push({
    level: "warn",
    message: "ANTHROPIC_AUTH_TOKEN is set; Claude.ai OAuth will not be used for model requests",
  });
}
```

对你当前 DeepSeek 用法来说，这个 warning 是正常的。

它不是错误。

## Step 22：更新 Provider 默认值

第 41 章默认 `ANTHROPIC_BASE_URL` 指向 DeepSeek。

OAuth 登录后，如果用户没有显式设置 base URL，理论上应该走 Anthropic 官方 API。

这里有两种方案。

方案 A：继续默认 DeepSeek。

优点：

- 课程主线稳定。
- 不会因为用户 OAuth 登录改变 DeepSeek 使用方式。

缺点：

- OAuth token 不适合 DeepSeek endpoint。

方案 B：根据 auth source 动态选择默认 base URL。

```ts
function defaultBaseUrlForAuthSource(source: AuthSource): string {
  if (source === "claude.ai") return "https://api.anthropic.com";
  return "https://api.deepseek.com/anthropic";
}
```

推荐 Mini 使用方案 B，但只在 `ANTHROPIC_BASE_URL` 没设置时生效。

规则：

```txt
ANTHROPIC_BASE_URL 显式设置
  永远尊重用户

未设置 ANTHROPIC_BASE_URL + OAuth
  https://api.anthropic.com

未设置 ANTHROPIC_BASE_URL + env token
  https://api.deepseek.com/anthropic
```

这能兼顾：

- 你的 DeepSeek 主线。
- 官方 Claude.ai OAuth 行为。

实现上要避免循环依赖。

可以先解析 auth source，再解析 provider config：

```ts
const auth = await resolveAuth(env, oauthStore);
const provider = resolveProviderConfig(env, {
  defaultBaseUrl:
    auth.source === "claude.ai"
      ? "https://api.anthropic.com"
      : "https://api.deepseek.com/anthropic",
});
```

## Step 23：测试 PKCE

新增 `src/oauth/__tests__/pkce.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { generateCodeChallenge, generateCodeVerifier, generateState } from "../pkce";

describe("pkce", () => {
  test("generates verifier and state", () => {
    expect(generateCodeVerifier().length).toBeGreaterThan(20);
    expect(generateState().length).toBeGreaterThan(20);
  });

  test("generates deterministic challenge for verifier", () => {
    const verifier = "test-verifier";

    expect(generateCodeChallenge(verifier)).toBe(generateCodeChallenge(verifier));
    expect(generateCodeChallenge(verifier)).not.toBe(verifier);
  });
});
```

## Step 24：测试 OAuth client

新增 `src/oauth/__tests__/oauthClient.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { buildAuthorizationUrl, isOAuthTokenExpired, subscriptionFromProfile } from "../oauthClient";

describe("buildAuthorizationUrl", () => {
  test("includes PKCE and callback params", () => {
    const url = new URL(
      buildAuthorizationUrl({
        codeChallenge: "challenge",
        state: "state-value",
        port: 12345,
      }),
    );

    expect(url.searchParams.get("client_id")).toBeTruthy();
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge")).toBe("challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("state-value");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:12345/callback");
  });
});

describe("isOAuthTokenExpired", () => {
  test("treats null expiry as not expired", () => {
    expect(isOAuthTokenExpired(null)).toBe(false);
  });

  test("uses refresh buffer", () => {
    expect(isOAuthTokenExpired(Date.now() + 60_000)).toBe(true);
    expect(isOAuthTokenExpired(Date.now() + 60 * 60 * 1000)).toBe(false);
  });
});

describe("subscriptionFromProfile", () => {
  test("maps claude_pro to pro", () => {
    expect(
      subscriptionFromProfile({
        organization: {
          organization_type: "claude_pro",
        },
      }),
    ).toBe("pro");
  });

  test("returns null for unknown profile", () => {
    expect(subscriptionFromProfile(undefined)).toBeNull();
  });
});
```

## Step 25：测试 TokenStore

新增 `src/oauth/__tests__/tokenStore.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import type { OAuthTokenStore } from "../tokenStore";
import type { OAuthTokens } from "../types";

function memoryStore(): OAuthTokenStore {
  let value: OAuthTokens | null = null;

  return {
    async read() {
      return value;
    },
    async write(tokens) {
      value = tokens;
    },
    async clear() {
      value = null;
    },
  };
}

describe("OAuthTokenStore", () => {
  test("writes and clears tokens", async () => {
    const store = memoryStore();

    await store.write({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 1000,
      scopes: ["user:inference"],
      subscriptionType: "pro",
      rateLimitTier: null,
    });

    expect((await store.read())?.accessToken).toBe("access");

    await store.clear();
    expect(await store.read()).toBeNull();
  });
});
```

## Step 26：测试 subscription

新增 `src/oauth/__tests__/subscription.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { formatSubscription, getSubscriptionStatus } from "../subscription";

describe("getSubscriptionStatus", () => {
  test("returns inactive without tokens", () => {
    expect(getSubscriptionStatus(null)).toEqual({
      active: false,
      type: null,
      rateLimitTier: null,
    });
  });

  test("returns active subscription", () => {
    const status = getSubscriptionStatus({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 1000,
      scopes: ["user:inference"],
      subscriptionType: "max",
      rateLimitTier: "default",
    });

    expect(status.active).toBe(true);
    expect(status.type).toBe("max");
  });
});

describe("formatSubscription", () => {
  test("formats inactive", () => {
    expect(formatSubscription({ active: false, type: null, rateLimitTier: null })).toBe("not active");
  });

  test("formats active unknown type", () => {
    expect(formatSubscription({ active: true, type: null, rateLimitTier: null })).toBe("active");
  });
});
```

## Step 27：手动验收

DeepSeek 路线：

```bash
export ANTHROPIC_AUTH_TOKEN="<your-deepseek-key>"
export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
export ANTHROPIC_MODEL="deepseek-v4-flash"
bun run dev
```

执行：

```txt
> /auth
```

期望：

```txt
Auth source: ANTHROPIC_AUTH_TOKEN
Auth mode: bearer-token
Subscription: not active
```

Claude.ai OAuth 路线：

```bash
unset ANTHROPIC_AUTH_TOKEN
unset ANTHROPIC_API_KEY
unset ANTHROPIC_BASE_URL
bun run dev
```

执行：

```txt
> /login claude
```

浏览器登录完成后：

```txt
> /auth
```

期望：

```txt
Auth source: claude.ai
Auth mode: oauth
Token: set
Subscription: pro
```

具体套餐可能是 `pro`、`max`、`team` 或 `enterprise`。

退出：

```txt
> /logout
```

再看：

```txt
> /auth
```

期望 OAuth 订阅态消失。

## Step 28：自动化验收

运行测试：

```bash
bun test src/oauth/__tests__/pkce.test.ts
bun test src/oauth/__tests__/oauthClient.test.ts
bun test src/oauth/__tests__/tokenStore.test.ts
bun test src/oauth/__tests__/refresh.test.ts
bun test src/oauth/__tests__/subscription.test.ts
```

运行类型检查：

```bash
bun run typecheck
```

如果你接入了命令系统：

```bash
bun test src/commands/__tests__/login.test.ts
bun test src/commands/__tests__/logout.test.ts
bun test src/commands/__tests__/auth.test.ts
```

## 常见坑

第一，把 Claude.ai OAuth 做成 device code。

官方 Claude 主线是 authorization code + PKCE + localhost callback。

不要为了省事改成不匹配的形态。

第二，OAuth 登录覆盖 DeepSeek 环境变量。

用户显式设置 `ANTHROPIC_AUTH_TOKEN` 时，应该继续使用环境变量。

OAuth 只在没有显式外部认证时接管请求。

第三，OAuth token 存到项目目录。

OAuth token 属于用户，不属于项目。

只能进用户级 secret storage。

第四，缓存带 token 的 SDK client。

token refresh 后，旧 client 的 Authorization header 可能失效。

Mini 第一版每次请求创建 client 更稳。

第五，profile 拉取失败就判定登录失败。

token exchange 成功才是登录核心。

profile 失败会导致订阅态未知，但不一定要阻止用户使用。

第六，state 不校验。

这是 OAuth callback 的基本安全要求。

第七，refresh 无限重试。

请求 401 后最多强制 refresh 一次。

再失败就提示重新登录。

第八，doctor 发起完整模型请求。

OAuth doctor 只检查本地 token、过期时间和 refresh 能力。

模型请求应该是显式 `/auth ping`。

第九，在 transcript 里保存 OAuth token。

transcript 只能记录：

```txt
authSource=claude.ai
authMode=oauth
subscription=pro
```

不能记录 access token 或 refresh token。

## 和官方 Claude Code 的距离

这一章之后，Mini 已经接近官方的 OAuth 骨架：

- Authorization Code + PKCE。
- localhost callback。
- manual fallback 的扩展点。
- access token。
- refresh token。
- profile。
- subscription type。
- token refresh。
- 401 recovery。
- `/login`、`/logout`、`/auth`。

仍然缺少：

- 完整 Ink 登录 UI。
- Console OAuth 创建 API key。
- managed settings。
- force login org。
- SSO login method。
- trusted device。
- remote session auth proxy。
- Keychain/libsecret/Credential Manager。
- 跨进程 refresh lock。
- OAuth scopes 迁移。
- roles 和 first-token-date 等附加 profile。

但 Mini 已经有了正确主干。

后续补这些能力时，不需要推翻 auth resolver。

## 小结

本章给 Mini 增加了 Claude.ai OAuth 和订阅态。

现在 Mini 支持：

- DeepSeek Anthropic-compatible 环境变量主线。
- Claude.ai OAuth 可选登录。
- PKCE。
- localhost callback。
- token exchange。
- token refresh。
- OAuth token store。
- subscription status。
- `/login claude`。
- `/logout`。
- `/auth` 展示订阅态。
- OAuth 401 refresh retry。

关键边界是：

```txt
DeepSeek key 是外部 bearer token。
Claude.ai login 是 OAuth token。
两者都是 Bearer header。
但来源、生命周期、默认 base URL 不同。
```

下一章可以继续做 **官方 API 错误恢复与重试策略**：把 401、429、529、overloaded、stream 中断、max output、prompt too long、provider-specific error 统一整理成可解释、可恢复的错误管道。
