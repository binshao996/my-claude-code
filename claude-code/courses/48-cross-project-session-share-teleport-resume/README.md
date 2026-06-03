# 第 48 章：跨项目恢复、Session 分享与 Teleport Resume

第 47 章把历史体验补到了本机当前仓库内：

- session picker。
- transcript 搜索。
- session 预览。
- 历史消息编辑。
- rewind conversation/code。
- partial compact。

但官方 Claude Code 的会话能力不止于“在当前仓库继续”。

真实工作流里，用户经常遇到这些场景：

- 打开了另一个 worktree，想恢复同一个 repo 的历史会话。
- 在 session picker 里搜到了另一个项目的会话，但当前 CWD 不匹配。
- 从远端 Claude Code session 继续到本机。
- 远端 session 对应某个 git branch，本机需要切到同一分支。
- 本机有未提交修改，切分支前需要提醒或 stash。
- 用户明确同意后，把 transcript 分享给服务端用于排查。
- 收到一个 session/share id，希望在本机导入或恢复。

本章会把 Mini 从“本地历史浏览器”推进到“跨项目、跨机器、可分享”的 session 系统。

## 本章目标

完成本章后，Mini 会新增：

1. `src/crossProjectResume/`：跨项目恢复检测和安全提示。
2. `src/teleport/`：远端 session 列表、拉取、repo 校验、branch checkout、恢复消息处理。
3. `src/sessionIngress/`：远端 transcript append/fetch 的最小协议。
4. `src/sessionShare/`：受控分享 bundle、脱敏、导入入口。
5. `/teleport` 命令：无参列远端 sessions，有参恢复指定远端 session。
6. `/share-session` 命令：明确用户确认后导出或上传 transcript。
7. `/resume` 的跨项目分支：当前 CWD 不匹配时给出可执行命令或直接恢复 same-repo worktree。
8. 测试覆盖：repo mismatch、git dirty、远端 fetch fallback、branch checkout 失败提示、分享脱敏和大 transcript 上限。

这一章不会做远端执行完整平台，也不会实现真正的云 IDE。

它只实现一个目标：session 可以安全地离开当前本地目录边界。

## 本章完成效果

### 跨项目恢复

用户在当前项目执行：

```txt
> /resume
```

打开 all projects 后选中另一个项目的 session：

```txt
Implement checkout flow
3d ago · feature/checkout · /Users/me/other-repo
```

如果它不是同一个 repo 的 worktree，Mini 不直接恢复，而是复制并展示命令：

```txt
This session belongs to another project.

Run this command to resume it:

cd /Users/me/other-repo && claude --resume 1f8c1d4c-1111-4444-8888-abcdefabcdef
```

如果它是同一个 repo 的另一个 worktree，Mini 可以直接恢复。

### Teleport Resume

用户执行：

```txt
> /teleport
```

Mini 拉取远端 Claude Code sessions：

```txt
Select a session to resume

Updated     Session Title
2h ago      Fix auth callback crash
1d ago      Implement checkout flow
3d ago      Improve docs build
```

选择一个 session 后，Mini：

```txt
◐ Teleporting session…

  ✓ Validating session
  ✓ Fetching session logs
  ◐ Getting branch info
  ○ Checking out branch
```

恢复成功后，当前 transcript 追加两条提示：

```txt
User(meta): This session is being continued from another machine...
System: Session resumed
```

这样模型知道：这不是普通用户输入，而是跨机器恢复后的运行时事实。

### Session 分享

用户执行：

```txt
> /share-session
```

Mini 显示确认：

```txt
Share current session transcript?

This will include:
- normalized conversation messages
- subagent transcripts
- raw JSONL only if under size limit

Secrets will be redacted before upload.
```

用户确认后才导出或上传。

分享永远不能静默发生。

## 真实工程给我们的关键启发

当前仓库里相关实现分散在这些文件：

```txt
src/utils/crossProjectResume.ts
src/screens/ResumeConversation.tsx
src/components/ResumeTask.tsx
src/components/TeleportError.tsx
src/components/TeleportStash.tsx
src/components/TeleportProgress.tsx
src/components/TeleportResumeWrapper.tsx
src/hooks/useTeleportResume.tsx
src/utils/teleport.tsx
src/utils/teleport/api.ts
src/services/api/sessionIngress.ts
src/components/FeedbackSurvey/submitTranscriptShare.ts
src/utils/ccshareResume.ts
```

几个事实要直接吸收：

1. 跨项目恢复不应盲目切换 CWD；不同 repo 时只提示 `cd ... && claude --resume ...`。
2. same-repo worktree 可以更宽松，允许直接恢复。
3. 远端 session 需要 Claude.ai OAuth；普通 API key 不够。
4. Teleport 前要检查组织策略、登录状态、git dirty 状态和 repo 是否匹配。
5. dirty worktree 下切分支前要提示 stash。
6. 远端 transcript 拉取优先使用 v2 events API，失败后 fallback 到旧 session ingress。
7. events API 要分页，cursor 是 opaque，不要自己解析。
8. 恢复远端 session 后要过滤 sidechain，只保留 transcript messages。
9. branch checkout 失败不一定要让恢复完全失败，可以带 warning 恢复。
10. 分享 transcript 必须脱敏，并且 raw JSONL 有 size guard。
11. 当前 `ccshareResume.ts` 仍是 stub，说明分享恢复是扩展点，不应在教程里假装完整。

## 推荐目录

新增：

```txt
src/
  crossProjectResume/
    check.ts
    command.ts
  teleport/
    types.ts
    api.ts
    prerequisites.ts
    repoValidation.ts
    branch.ts
    resume.ts
    picker.tsx
    progress.tsx
    command.ts
  sessionIngress/
    client.ts
    remoteLog.ts
  sessionShare/
    types.ts
    redact.ts
    collect.ts
    export.ts
    import.ts
    command.ts
tests/
  crossProjectResume/
    check.test.ts
  teleport/
    repoValidation.test.ts
    resume.test.ts
    branch.test.ts
  sessionIngress/
    client.test.ts
  sessionShare/
    redact.test.ts
    collect.test.ts
```

修改：

```txt
src/chat/commands.ts
src/screens/ResumeConversation.tsx
src/transcriptUx/sessionPicker.tsx
src/session/transcript.ts
```

如果你的 Mini 没有 Ink UI，`picker.tsx` 和 `progress.tsx` 可以先替换成纯文本输出。

核心是协议和边界，而不是 UI 框架。

改 `src/chat/commands.ts` 时继续保留 plan mode 内置命令：

```txt
/plan
/plan show
/plan clear
/plan exit
```

跨项目恢复只决定“加载哪条 transcript 和哪个 cwd”，不应该改变 `/plan` 的语义，也不应该丢掉 session JSONL 里的最新 plan entry。

## 一、跨项目恢复

第 47 章的 session picker 已经可以显示所有项目。

但真正选择一个跨项目 session 时，不能一律恢复。

要先判断：

```txt
当前 CWD == log.projectPath
  -> 正常恢复

当前 CWD != log.projectPath
  -> 是否 showAllProjects?
       否 -> 正常情况下不会出现
       是 -> 检查是否 same-repo worktree
```

same-repo worktree 可以恢复，因为它仍属于同一个仓库上下文。

不同 repo 则只给用户命令。

### 类型

`src/crossProjectResume/check.ts`

```ts
import { sep } from "node:path";
import type { SessionLogOption } from "../transcriptUx/types";

export type CrossProjectResumeResult =
  | { type: "same_project" }
  | { type: "same_repo_worktree"; projectPath: string }
  | { type: "different_project"; projectPath: string; command: string };

export function checkCrossProjectResume(input: {
  log: SessionLogOption;
  currentCwd: string;
  showAllProjects: boolean;
  worktreePaths: string[];
}): CrossProjectResumeResult {
  const { log, currentCwd, showAllProjects, worktreePaths } = input;

  if (!showAllProjects || !log.projectPath || log.projectPath === currentCwd) {
    return { type: "same_project" };
  }

  const isSameRepoWorktree = worktreePaths.some(
    worktree =>
      log.projectPath === worktree ||
      log.projectPath.startsWith(worktree + sep),
  );

  if (isSameRepoWorktree) {
    return {
      type: "same_repo_worktree",
      projectPath: log.projectPath,
    };
  }

  return {
    type: "different_project",
    projectPath: log.projectPath,
    command: buildCrossProjectResumeCommand(log.projectPath, log.sessionId),
  };
}

function buildCrossProjectResumeCommand(
  projectPath: string,
  sessionId: string,
): string {
  return `cd ${shellQuote(projectPath)} && claude --resume ${shellQuote(sessionId)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
```

真实实现里使用已有 shell quote helper。

不要手写 `cd ${path}`。

路径里可能有空格、括号或单引号。

### 接入 session picker

```ts
async function onSelectSession(log: SessionLogOption): Promise<void> {
  const cross = checkCrossProjectResume({
    log,
    currentCwd,
    showAllProjects,
    worktreePaths,
  });

  if (cross.type === "different_project") {
    await clipboard.write(cross.command);
    showCrossProjectMessage(cross.command);
    return;
  }

  await resumeLocalSession(log);
}
```

这里不要自动 `process.chdir()`。

CLI 运行中切 CWD 会影响：

- memory 文件发现。
- MCP server cwd。
- git 状态。
- 文件权限根目录。
- session path。
- tool working directory。

让用户在正确目录重新启动，是更安全的选择。

## 二、Teleport Resume 总览

Teleport Resume 的核心流程：

```txt
/teleport
  |
  |-- check prerequisites
  |     |-- Claude.ai login?
  |     |-- git worktree clean?
  |     |-- org policy allows remote sessions?
  |
  |-- fetch remote sessions
  |     |-- /v1/sessions
  |     |-- filter current repo
  |
  |-- user selects session
  |
  |-- fetch selected session metadata
  |     |-- validate repo match
  |
  |-- fetch transcript events
  |     |-- v2 teleport-events
  |     |-- fallback session-ingress
  |
  |-- filter transcript messages
  |
  |-- checkout branch
  |
  |-- append teleport resume notices
  |
  |-- start REPL with recovered messages
```

它和本地 resume 的区别：

| 维度 | 本地 resume | Teleport resume |
| --- | --- | --- |
| 数据源 | 本地 JSONL | 远端 Sessions API |
| 认证 | 不需要 | Claude.ai OAuth |
| repo 校验 | 项目路径 | git source owner/repo/host |
| branch | 本地当前分支 | 远端 session outcome branch |
| dirty worktree | 通常不关心 | 切分支前必须处理 |
| transcript | 本地 raw entries | 远端 events payload |
| 恢复提示 | 可选 | 必须告诉模型跨机器恢复 |

## 三、Teleport 类型

`src/teleport/types.ts`

```ts
import type { ChatMessage } from "../chat/types";

export type RemoteSessionStatus =
  | "requires_action"
  | "running"
  | "idle"
  | "archived";

export type RemoteGitSource = {
  type: "git_repository";
  url: string;
  revision?: string | null;
};

export type RemoteSessionResource = {
  id: string;
  title: string | null;
  session_status: RemoteSessionStatus;
  environment_id: string;
  created_at: string;
  updated_at: string;
  session_context: {
    sources: RemoteGitSource[];
    cwd: string;
    outcomes: Array<{
      type: "git_repository";
      git_info: {
        type: "github";
        repo: string;
        branches: string[];
      };
    }> | null;
    model: string | null;
    custom_system_prompt: string | null;
    append_system_prompt: string | null;
  };
};

export type CodeSession = {
  id: string;
  title: string;
  status: "idle" | "working" | "waiting" | "completed" | "archived";
  repo: {
    name: string;
    owner: { login: string };
    default_branch?: string;
  } | null;
  created_at: string;
  updated_at: string;
};

export type TeleportRemoteResponse = {
  log: ChatMessage[];
  branch?: string;
};

export type TeleportResult = {
  messages: ChatMessage[];
  branchName: string;
};

export type TeleportProgressStep =
  | "validating"
  | "fetching_logs"
  | "fetching_branch"
  | "checking_out"
  | "done";
```

## 四、认证与 Sessions API

Teleport 需要 Claude.ai OAuth。

普通 workspace API key 或 Anthropic API key 不够，因为远端 code sessions 属于用户账号和组织上下文。

`src/teleport/api.ts`

```ts
import type { CodeSession, RemoteSessionResource } from "./types";

export type OAuthContext = {
  accessToken: string;
  organizationId: string;
};

export async function prepareTeleportApiRequest(input: {
  getAccessToken: () => string | undefined;
  getOrganizationId: () => Promise<string | undefined>;
}): Promise<OAuthContext> {
  const accessToken = input.getAccessToken();
  if (!accessToken) {
    throw new Error(
      "Claude Code web sessions require authentication with a Claude.ai account. Run /login first.",
    );
  }

  const organizationId = await input.getOrganizationId();
  if (!organizationId) {
    throw new Error("Unable to get organization ID.");
  }

  return { accessToken, organizationId };
}

export async function fetchCodeSessions(input: {
  baseUrl: string;
  auth: OAuthContext;
  fetchJson: <T>(url: string, init: RequestInit) => Promise<T>;
}): Promise<CodeSession[]> {
  const response = await input.fetchJson<{
    data: RemoteSessionResource[];
  }>(`${input.baseUrl}/v1/sessions`, {
    headers: buildOAuthHeaders(input.auth),
  });

  return response.data.map(toCodeSession);
}

export async function fetchRemoteSession(input: {
  baseUrl: string;
  sessionId: string;
  auth: OAuthContext;
  fetchJson: <T>(url: string, init: RequestInit) => Promise<T>;
}): Promise<RemoteSessionResource> {
  return input.fetchJson<RemoteSessionResource>(
    `${input.baseUrl}/v1/sessions/${input.sessionId}`,
    { headers: buildOAuthHeaders(input.auth) },
  );
}

function buildOAuthHeaders(auth: OAuthContext): HeadersInit {
  return {
    Authorization: `Bearer ${auth.accessToken}`,
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "ccr-byoc-2025-07-29",
    "x-organization-uuid": auth.organizationId,
  };
}

function toCodeSession(session: RemoteSessionResource): CodeSession {
  const gitSource = session.session_context.sources.find(
    source => source.type === "git_repository",
  );

  const repo = gitSource?.url ? parseRepo(gitSource.url) : null;

  return {
    id: session.id,
    title: session.title ?? "Untitled",
    status: mapStatus(session.session_status),
    repo,
    created_at: session.created_at,
    updated_at: session.updated_at,
  };
}

function mapStatus(status: RemoteSessionResource["session_status"]): CodeSession["status"] {
  if (status === "running") return "working";
  return status;
}

function parseRepo(url: string): CodeSession["repo"] {
  const match = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) return null;
  const owner = match[1];
  const name = match[2];
  if (!owner || !name) return null;
  return { owner: { login: owner }, name };
}
```

真实实现还会做指数退避：

```txt
2s -> 4s -> 8s -> 16s
```

只重试网络错误和 5xx。

不要重试 401、403、404 这类明确错误。

## 五、Teleport 前置条件

Teleport 会切分支，必须先处理两个本地条件：

1. 用户已经用 Claude.ai 登录。
2. git 工作区是干净的，或者用户同意 stash。

`src/teleport/prerequisites.ts`

```ts
export type TeleportLocalIssue = "needs_login" | "needs_git_stash";

export async function getTeleportLocalIssues(input: {
  needsClaudeLogin: () => Promise<boolean>;
  isGitClean: () => Promise<boolean>;
}): Promise<Set<TeleportLocalIssue>> {
  const [needsLogin, isClean] = await Promise.all([
    input.needsClaudeLogin(),
    input.isGitClean(),
  ]);

  const issues = new Set<TeleportLocalIssue>();
  if (needsLogin) issues.add("needs_login");
  if (!isClean) issues.add("needs_git_stash");
  return issues;
}

export async function ensureTeleportPrerequisites(input: {
  needsClaudeLogin: () => Promise<boolean>;
  isGitClean: () => Promise<boolean>;
  promptLogin: () => Promise<void>;
  promptStash: () => Promise<void>;
}): Promise<void> {
  while (true) {
    const issues = await getTeleportLocalIssues({
      needsClaudeLogin: input.needsClaudeLogin,
      isGitClean: input.isGitClean,
    });

    if (issues.size === 0) return;

    if (issues.has("needs_login")) {
      await input.promptLogin();
      continue;
    }

    if (issues.has("needs_git_stash")) {
      await input.promptStash();
      continue;
    }
  }
}
```

`promptStash()` 里要列出受影响文件。

如果文件很多，只显示数量。

不要直接执行 stash。

用户必须确认。

## 六、Repo 校验

远端 session 通常绑定一个 git source。

本机恢复时必须确认当前仓库匹配：

- owner/repo 要匹配。
- host 也要匹配，避免 GitHub Enterprise 和 github.com 混淆。
- 如果 session 没有 repo source，可以允许恢复。

`src/teleport/repoValidation.ts`

```ts
import type { RemoteGitSource, RemoteSessionResource } from "./types";

export type RepoValidationResult =
  | { status: "match"; sessionRepo: string; currentRepo: string }
  | { status: "no_repo_required" }
  | { status: "not_in_repo"; sessionRepo: string; sessionHost?: string }
  | {
      status: "mismatch";
      sessionRepo: string;
      currentRepo: string;
      sessionHost?: string;
      currentHost?: string;
    }
  | { status: "error"; errorMessage: string };

export async function validateSessionRepository(input: {
  session: RemoteSessionResource;
  detectCurrentRepo: () => Promise<{ host: string; repo: string } | null>;
}): Promise<RepoValidationResult> {
  const gitSource = input.session.session_context.sources.find(
    (source): source is RemoteGitSource => source.type === "git_repository",
  );

  const sessionParsed = gitSource?.url ? parseGitRemote(gitSource.url) : null;
  if (!sessionParsed) {
    return { status: "no_repo_required" };
  }

  const current = await input.detectCurrentRepo();
  if (!current) {
    return {
      status: "not_in_repo",
      sessionRepo: sessionParsed.repo,
      sessionHost: sessionParsed.host,
    };
  }

  const repoMatches =
    current.repo.toLowerCase() === sessionParsed.repo.toLowerCase();
  const hostMatches =
    stripPort(current.host.toLowerCase()) ===
    stripPort(sessionParsed.host.toLowerCase());

  if (repoMatches && hostMatches) {
    return {
      status: "match",
      sessionRepo: sessionParsed.repo,
      currentRepo: current.repo,
    };
  }

  return {
    status: "mismatch",
    sessionRepo: sessionParsed.repo,
    currentRepo: current.repo,
    sessionHost: sessionParsed.host,
    currentHost: current.host,
  };
}

function parseGitRemote(url: string): { host: string; repo: string } | null {
  const ssh = url.match(/^git@([^:]+):([^/]+\/[^/]+?)(?:\.git)?$/);
  if (ssh?.[1] && ssh[2]) {
    return { host: ssh[1], repo: ssh[2] };
  }

  const https = url.match(/^https?:\/\/([^/]+)\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (https?.[1] && https[2]) {
    return { host: https[1], repo: https[2] };
  }

  return null;
}

function stripPort(host: string): string {
  return host.replace(/:\d+$/, "");
}
```

UI 上要把错误说清楚：

```txt
You must run claude --teleport <id> from a checkout of owner/repo.
This repo is another-owner/another-repo.
```

如果是 GHE，要显示 host：

```txt
ghe.example.com/owner/repo
```

## 七、拉取远端 Transcript

真实实现现在有两条路径：

1. 新路径：`/v1/code/sessions/{id}/teleport-events`
2. 旧路径：`/v1/session_ingress/session/{id}`

Mini 也按这个顺序实现。

`src/sessionIngress/remoteLog.ts`

```ts
import type { ChatMessage } from "../chat/types";
import type { OAuthContext } from "../teleport/api";

export type RemoteTranscriptEntry = ChatMessage | {
  type: string;
  [key: string]: unknown;
};

type TeleportEventsResponse = {
  data: Array<{
    event_id: string;
    event_type: string;
    payload: RemoteTranscriptEntry | null;
    created_at: string;
  }>;
  next_cursor?: string | null;
};

export async function getTeleportEvents(input: {
  baseUrl: string;
  sessionId: string;
  auth: OAuthContext;
  fetchJson: <T>(url: string, init: RequestInit) => Promise<T>;
}): Promise<RemoteTranscriptEntry[] | null> {
  const all: RemoteTranscriptEntry[] = [];
  let cursor: string | undefined;
  const maxPages = 100;

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ limit: "1000" });
    if (cursor) params.set("cursor", cursor);

    const url = `${input.baseUrl}/v1/code/sessions/${input.sessionId}/teleport-events?${params.toString()}`;
    const response = await input.fetchJson<TeleportEventsResponse>(url, {
      headers: buildOAuthHeaders(input.auth),
    });

    if (!Array.isArray(response.data)) {
      return null;
    }

    for (const event of response.data) {
      if (event.payload !== null) {
        all.push(event.payload);
      }
    }

    if (response.next_cursor == null) {
      return all;
    }
    cursor = response.next_cursor;
  }

  return all;
}

export async function getSessionIngressLogs(input: {
  baseUrl: string;
  sessionId: string;
  auth: OAuthContext;
  fetchJson: <T>(url: string, init: RequestInit) => Promise<T>;
}): Promise<RemoteTranscriptEntry[] | null> {
  const response = await input.fetchJson<{ loglines: RemoteTranscriptEntry[] }>(
    `${input.baseUrl}/v1/session_ingress/session/${input.sessionId}`,
    { headers: buildOAuthHeaders(input.auth) },
  );
  return Array.isArray(response.loglines) ? response.loglines : null;
}

function buildOAuthHeaders(auth: OAuthContext): HeadersInit {
  return {
    Authorization: `Bearer ${auth.accessToken}`,
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    "x-organization-uuid": auth.organizationId,
  };
}
```

`next_cursor == null` 很重要。

有些服务端序列化会返回 `null`，不是 `undefined`。

只判断 `=== undefined` 可能导致 cursor 变成字符串 `"null"`，进入死循环或请求错误。

## 八、Session Ingress Append 协议

如果 Mini 还要把本地 transcript 同步到远端，需要一个 append 协议。

真实实现使用：

- `Last-Uuid` header。
- per-session sequential queue。
- 409 conflict 时采用服务端 last uuid。
- 401 直接失败。
- 网络错误、5xx、429 retry。

`src/sessionIngress/client.ts`

```ts
import type { ChatMessage } from "../chat/types";

type AppendHeaders = Record<string, string>;

export class SessionIngressClient {
  private readonly lastUuidBySession = new Map<string, string>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly input: {
      authToken: () => string | undefined;
      put: (url: string, entry: ChatMessage, headers: AppendHeaders) => Promise<{
        status: number;
        headers: Record<string, string | undefined>;
      }>;
      fetchLogs: (sessionId: string) => Promise<ChatMessage[]>;
    },
  ) {}

  append(sessionId: string, url: string, entry: ChatMessage): Promise<boolean> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.appendImpl(sessionId, url, entry));
    this.queues.set(sessionId, next);
    return next;
  }

  private async appendImpl(
    sessionId: string,
    url: string,
    entry: ChatMessage,
  ): Promise<boolean> {
    const token = this.input.authToken();
    if (!token) return false;

    for (let attempt = 1; attempt <= 10; attempt++) {
      const headers: AppendHeaders = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      };

      const lastUuid = this.lastUuidBySession.get(sessionId);
      if (lastUuid) {
        headers["Last-Uuid"] = lastUuid;
      }

      const response = await this.input.put(url, entry, headers);

      if (response.status === 200 || response.status === 201) {
        this.lastUuidBySession.set(sessionId, entry.id);
        return true;
      }

      if (response.status === 401) {
        return false;
      }

      if (response.status === 409) {
        const serverLastUuid = response.headers["x-last-uuid"];
        if (serverLastUuid === entry.id) {
          this.lastUuidBySession.set(sessionId, entry.id);
          return true;
        }

        if (serverLastUuid) {
          this.lastUuidBySession.set(sessionId, serverLastUuid);
          continue;
        }

        const logs = await this.input.fetchLogs(sessionId);
        const adopted = logs.at(-1)?.id;
        if (!adopted) return false;
        this.lastUuidBySession.set(sessionId, adopted);
        continue;
      }

      if (attempt === 10) return false;
      await sleep(Math.min(500 * 2 ** (attempt - 1), 8_000));
    }

    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}
```

这个协议的目标不是“绝不冲突”。

它的目标是冲突可检测、可恢复、不乱序。

## 九、恢复远端 session

核心函数：

`src/teleport/resume.ts`

```ts
import type {
  CodeSession,
  RemoteSessionResource,
  TeleportRemoteResponse,
} from "./types";
import { fetchRemoteSession, type OAuthContext } from "./api";
import { validateSessionRepository } from "./repoValidation";
import { getSessionIngressLogs, getTeleportEvents } from "../sessionIngress/remoteLog";
import type { ChatMessage } from "../chat/types";

export async function teleportResumeCodeSession(input: {
  baseUrl: string;
  sessionId: string;
  auth: OAuthContext;
  isRemoteSessionsAllowed: () => boolean;
  detectCurrentRepo: () => Promise<{ host: string; repo: string } | null>;
  fetchJson: <T>(url: string, init: RequestInit) => Promise<T>;
  onProgress?: (step: "validating" | "fetching_logs" | "fetching_branch") => void;
}): Promise<TeleportRemoteResponse> {
  if (!input.isRemoteSessionsAllowed()) {
    throw new Error("Remote sessions are disabled by policy.");
  }

  input.onProgress?.("validating");
  const session = await fetchRemoteSession({
    baseUrl: input.baseUrl,
    sessionId: input.sessionId,
    auth: input.auth,
    fetchJson: input.fetchJson,
  });

  const repo = await validateSessionRepository({
    session,
    detectCurrentRepo: input.detectCurrentRepo,
  });

  if (repo.status === "not_in_repo") {
    throw new Error(
      `Run Mini from a checkout of ${repo.sessionRepo} to teleport this session.`,
    );
  }
  if (repo.status === "mismatch") {
    throw new Error(
      `Run Mini from ${repo.sessionRepo}. Current repo is ${repo.currentRepo}.`,
    );
  }
  if (repo.status === "error") {
    throw new Error(repo.errorMessage);
  }

  input.onProgress?.("fetching_logs");
  let entries = await getTeleportEvents({
    baseUrl: input.baseUrl,
    sessionId: input.sessionId,
    auth: input.auth,
    fetchJson: input.fetchJson,
  });

  if (entries === null) {
    entries = await getSessionIngressLogs({
      baseUrl: input.baseUrl,
      sessionId: input.sessionId,
      auth: input.auth,
      fetchJson: input.fetchJson,
    });
  }

  if (entries === null) {
    throw new Error("Failed to fetch session logs.");
  }

  input.onProgress?.("fetching_branch");

  return {
    log: entries.filter(isTeleportTranscriptMessage),
    branch: getBranchFromSession(session),
  };
}

function isTeleportTranscriptMessage(entry: unknown): entry is ChatMessage {
  if (!entry || typeof entry !== "object") return false;
  const record = entry as Record<string, unknown>;
  if (record.isSidechain === true) return false;
  return (
    record.type === "message" ||
    record.type === "user" ||
    record.type === "assistant" ||
    record.type === "system" ||
    record.type === "attachment"
  );
}

function getBranchFromSession(session: RemoteSessionResource): string | undefined {
  const outcome = session.session_context.outcomes?.find(
    item => item.type === "git_repository",
  );
  return outcome?.git_info.branches[0];
}
```

真实实现里 `isTranscriptMessage()` 使用本地统一 type guard。

Mini 也应该复用第 44 章的 transcript entry 判定，不要在多个地方各写一套。

## 十、Branch Checkout

Teleport 不是只恢复消息。

如果远端 session 在某个 branch 上工作，本机应该尝试 checkout 到对应 branch。

策略：

```txt
branch 不存在
  -> fetch origin branch
  -> checkout --track origin/branch

branch 已存在
  -> checkout branch

checkout 失败
  -> 恢复 session，但添加 warning
```

`src/teleport/branch.ts`

```ts
export type BranchCheckoutResult = {
  branchName: string;
  error: Error | null;
};

export async function checkOutTeleportedSessionBranch(input: {
  branch?: string;
  git: {
    currentBranch: () => Promise<string>;
    fetchBranch: (branch: string) => Promise<void>;
    checkout: (branch: string) => Promise<void>;
    checkoutTrack: (branch: string) => Promise<void>;
    hasLocalBranch: (branch: string) => Promise<boolean>;
  };
}): Promise<BranchCheckoutResult> {
  try {
    if (input.branch) {
      await input.git.fetchBranch(input.branch);
      const hasLocal = await input.git.hasLocalBranch(input.branch);
      if (hasLocal) {
        await input.git.checkout(input.branch);
      } else {
        await input.git.checkoutTrack(input.branch);
      }
    }

    return {
      branchName: await input.git.currentBranch(),
      error: null,
    };
  } catch (error) {
    return {
      branchName: await input.git.currentBranch(),
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
```

为什么 branch checkout 错误不一定 throw？

因为 transcript 恢复和 branch 切换是两个独立结果。

branch 失败时，用户仍然可能想查看远端会话内容。

但必须告诉模型和用户：

```txt
Session resumed without branch: failed to checkout branch ...
```

## 十一、处理恢复消息

远端 messages 不能直接塞进 REPL。

至少要做三件事：

1. 反序列化历史消息，修复中断工具对。
2. 追加 meta user message，告诉模型这是跨机器继续。
3. 追加 system message，告诉用户是否成功切到 branch。

`src/teleport/processMessages.ts`

```ts
import type { ChatMessage } from "../chat/types";

export function processMessagesForTeleportResume(input: {
  messages: ChatMessage[];
  cwd: string;
  branchError: Error | null;
  deserializeMessages: (messages: ChatMessage[]) => ChatMessage[];
  createSystemMessage: (text: string, level: "suggestion" | "warning") => ChatMessage;
  createUserMessage: (text: string, meta: boolean) => ChatMessage;
}): ChatMessage[] {
  const deserialized = input.deserializeMessages(input.messages);

  const meta = input.createUserMessage(
    `This session is being continued from another machine. Application state may have changed. The updated working directory is ${input.cwd}`,
    true,
  );

  const system =
    input.branchError === null
      ? input.createSystemMessage("Session resumed", "suggestion")
      : input.createSystemMessage(
          `Session resumed without branch: ${input.branchError.message}`,
          "warning",
        );

  return [...deserialized, meta, system];
}
```

这个 meta user message 会进入模型上下文。

它不是为了展示给用户，而是为了避免模型误以为文件状态、路径和远端完全一致。

## 十二、Teleport Picker

`/teleport` 无参时，应该列出远端 sessions。

真实实现会：

- 检测当前 repo。
- 拉取 Sessions API。
- 如果能检测 repo，只显示当前 repo 的 sessions。
- 按 `updated_at` 倒序。
- 显示 title 和更新时间。

`src/teleport/picker.tsx`

```tsx
import * as React from "react";
import { Box, Text } from "ink";
import type { CodeSession } from "./types";

type Props = {
  sessions: CodeSession[];
  currentRepo: string | null;
  onSelect: (session: CodeSession) => void;
  onCancel: () => void;
};

export function TeleportPicker({
  sessions,
  currentRepo,
  onSelect,
}: Props): React.ReactNode {
  const [focusedIndex, setFocusedIndex] = React.useState(0);

  return (
    <Box flexDirection="column">
      <Text bold>
        Select a session to resume
        {currentRepo ? <Text dimColor> ({currentRepo})</Text> : null}
      </Text>

      <Text bold>Updated     Session Title</Text>
      {sessions.map((session, index) => (
        <Text
          key={session.id}
          color={index === focusedIndex ? "cyan" : undefined}
        >
          {index === focusedIndex ? "› " : "  "}
          {formatRelative(session.updated_at).padEnd(10)}
          {session.title}
        </Text>
      ))}

      <Text dimColor>Enter confirm · Esc cancel</Text>
    </Box>
  );
}

function formatRelative(value: string): string {
  const ms = Date.now() - new Date(value).getTime();
  const hours = Math.round(ms / 3_600_000);
  if (hours < 1) return "now";
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
```

Headless 或 local command 环境不一定能安全挂起一个完整交互 UI。

所以 `/teleport --print` 或不支持 JSX 交互时可以输出文本列表：

```txt
## Available sessions (most recent first)

  01. Fix auth callback crash                       idle        2026-05-26  id=...
  02. Implement checkout flow                       running     2026-05-25  id=...

Run `/teleport <session-id>` to resume a session.
```

## 十三、`/teleport` 命令

命令行为：

| 输入 | 行为 |
| --- | --- |
| `/teleport` | 拉远端 session list |
| `/teleport <session-id>` | 恢复指定远端 session |
| `/teleport --print` | 输出 session list |
| `/teleport <session-id> --print` | headless 拉取并输出状态 |

`src/teleport/command.ts`

```ts
export async function runTeleportCommand(input: {
  args: string;
  openPicker: () => Promise<void>;
  resumeRemote: (sessionId: string) => Promise<void>;
  printSessions: () => Promise<string>;
  print: (text: string) => void;
}): Promise<{ type: "skip" }> {
  const raw = input.args.trim();
  const printMode = raw === "--print" || raw.startsWith("--print ");
  const sessionId = printMode ? raw.replace(/^--print\s*/, "").trim() : raw;

  if (!sessionId) {
    if (printMode) {
      input.print(await input.printSessions());
    } else {
      await input.openPicker();
    }
    return { type: "skip" };
  }

  if (!isValidSessionId(sessionId)) {
    input.print(`Invalid session id "${sessionId}".`);
    return { type: "skip" };
  }

  await input.resumeRemote(sessionId);
  return { type: "skip" };
}

function isValidSessionId(value: string): boolean {
  return /^[0-9a-f-]{8,}$/i.test(value);
}
```

`skip` 的原因和 `/rewind` 一样：

Teleport 是本地控制命令，不应该作为普通用户消息进入模型上下文。

恢复成功后，系统会主动插入 teleport meta message。

## 十四、Session 分享的原则

分享 transcript 是敏感能力。

默认规则必须保守：

1. 不自动分享。
2. 每次分享都需要用户明确确认。
3. 分享前脱敏。
4. raw JSONL 有大小上限。
5. 子 agent transcript 要明确纳入提示。
6. 上传失败不影响当前会话。
7. 分享返回的是 `shareId`，不是本地路径。

真实实现里，反馈调查会问用户是否允许分享 transcript。

Mini 可以先做显式命令 `/share-session`。

## 十五、分享 Bundle 类型

`src/sessionShare/types.ts`

```ts
import type { ChatMessage } from "../chat/types";

export type SessionShareTrigger =
  | "manual_command"
  | "bad_feedback"
  | "good_feedback"
  | "frustration"
  | "memory_survey";

export type SessionShareBundle = {
  format: "ccmini-session-share";
  version: 1;
  createdAt: string;
  trigger: SessionShareTrigger;
  appVersion: string;
  platform: string;
  sessionId: string;
  transcript: unknown;
  subagentTranscripts?: Record<string, unknown>;
  rawTranscriptJsonl?: string;
};

export type SessionShareResult = {
  success: boolean;
  shareId?: string;
  error?: string;
};
```

这里的 `transcript` 建议使用 API-normalized messages，而不是 UI render messages。

原因是排查问题时通常需要模型看到的上下文。

但 raw JSONL 也有价值，所以在 size limit 下可以附带。

## 十六、脱敏

脱敏要在序列化后做最后一遍。

`src/sessionShare/redact.ts`

```ts
const REDACTION_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-ant-[a-zA-Z0-9_-]{12,}\b/g, "[REDACTED_ANTHROPIC_KEY]"],
  [/\bsk-[a-zA-Z0-9_-]{12,}\b/g, "[REDACTED_API_KEY]"],
  [/\bghp_[a-zA-Z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bgithub_pat_[a-zA-Z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bBearer\s+[a-zA-Z0-9._-]{20,}\b/g, "Bearer [REDACTED_TOKEN]"],
  [/("?(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)"?\s*[:=]\s*)"[^"]+"/gi, "$1\"[REDACTED]\""],
];

export function redactSessionShareContent(content: string): string {
  let output = content;
  for (const [pattern, replacement] of REDACTION_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}
```

不要把脱敏当作完美安全措施。

它只是最后一道防线。

UI 上仍然要告诉用户 transcript 可能包含项目内容。

## 十七、收集分享内容

`src/sessionShare/collect.ts`

```ts
import { readFile, stat } from "node:fs/promises";
import type { ChatMessage } from "../chat/types";
import type { SessionShareBundle, SessionShareTrigger } from "./types";

const MAX_RAW_TRANSCRIPT_BYTES = 50 * 1024 * 1024;

export async function collectSessionShareBundle(input: {
  messages: ChatMessage[];
  trigger: SessionShareTrigger;
  sessionId: string;
  appVersion: string;
  transcriptPath: string;
  normalizeMessagesForAPI: (messages: ChatMessage[]) => unknown;
  loadSubagentTranscripts: (messages: ChatMessage[]) => Promise<Record<string, unknown>>;
}): Promise<SessionShareBundle> {
  const transcript = input.normalizeMessagesForAPI(input.messages);
  const subagentTranscripts = await input.loadSubagentTranscripts(input.messages);
  const rawTranscriptJsonl = await readRawTranscriptIfSmall(input.transcriptPath);

  return {
    format: "ccmini-session-share",
    version: 1,
    createdAt: new Date().toISOString(),
    trigger: input.trigger,
    appVersion: input.appVersion,
    platform: process.platform,
    sessionId: input.sessionId,
    transcript,
    subagentTranscripts:
      Object.keys(subagentTranscripts).length > 0 ? subagentTranscripts : undefined,
    rawTranscriptJsonl,
  };
}

async function readRawTranscriptIfSmall(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (info.size > MAX_RAW_TRANSCRIPT_BYTES) {
      return undefined;
    }
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}
```

raw JSONL 超过 50MB 时跳过。

不要为了分享功能把大 transcript 一次性读进内存。

## 十八、导出与上传

Mini 可以同时支持两种分享：

1. 本地导出：生成 `.ccsession.json`。
2. 远端上传：POST 到服务端，返回 share id。

`src/sessionShare/export.ts`

```ts
import { writeFile } from "node:fs/promises";
import { redactSessionShareContent } from "./redact";
import type { SessionShareBundle, SessionShareResult } from "./types";

export async function exportSessionShareBundle(input: {
  bundle: SessionShareBundle;
  outputPath: string;
}): Promise<SessionShareResult> {
  const json = JSON.stringify(input.bundle, null, 2);
  const redacted = redactSessionShareContent(json);
  await writeFile(input.outputPath, redacted, { encoding: "utf8", mode: 0o600 });
  return { success: true, shareId: input.outputPath };
}

export async function uploadSessionShareBundle(input: {
  bundle: SessionShareBundle;
  endpoint: string;
  appearanceId: string;
  getAuthHeaders: () => Promise<Record<string, string>>;
  postJson: <T>(url: string, body: unknown, headers: Record<string, string>) => Promise<T>;
}): Promise<SessionShareResult> {
  const content = redactSessionShareContent(JSON.stringify(input.bundle));
  const headers = {
    "Content-Type": "application/json",
    ...(await input.getAuthHeaders()),
  };

  const result = await input.postJson<{ transcript_id?: string }>(
    input.endpoint,
    { content, appearance_id: input.appearanceId },
    headers,
  );

  return {
    success: true,
    shareId: result.transcript_id,
  };
}
```

上传 endpoint 要由配置提供。

教程里不要硬编码私有服务地址。

真实工程中确实有固定 API，但 Mini 应保持可替换。

## 十九、导入 Share

当前仓库的 `ccshareResume.ts` 是 stub。

这意味着分享恢复仍是扩展点。

Mini 可以先定义接口：

`src/sessionShare/import.ts`

```ts
import { readFile } from "node:fs/promises";
import type { SessionLogOption } from "../transcriptUx/types";
import type { SessionShareBundle } from "./types";

export function parseSessionShareId(value: string): string | null {
  const trimmed = value.trim();
  if (/^ccshare_[a-zA-Z0-9_-]{8,}$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

export async function loadLocalSessionShare(path: string): Promise<SessionShareBundle> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isSessionShareBundle(parsed)) {
    throw new Error("Invalid session share bundle.");
  }
  return parsed;
}

export function sessionShareToLogOption(bundle: SessionShareBundle): SessionLogOption {
  return {
    sessionId: bundle.sessionId,
    fullPath: "",
    projectPath: "",
    messages: [],
    messageCount: Array.isArray(bundle.transcript) ? bundle.transcript.length : 0,
    createdAt: bundle.createdAt,
    modifiedAt: bundle.createdAt,
    firstPrompt: "Imported shared session",
    customTitle: "Shared session",
    isLite: true,
  };
}

function isSessionShareBundle(value: unknown): value is SessionShareBundle {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.format === "ccmini-session-share" && record.version === 1;
}
```

如果未来接入远端 share id：

```txt
/resume ccshare_xxx
  -> parse share id
  -> fetch share bundle
  -> validate format
  -> import transcript
  -> open preview or resume
```

注意：导入外部 transcript 不应自动执行工具。

它只是恢复对话上下文。

## 二十、`/share-session` 命令

`src/sessionShare/command.ts`

```ts
export async function runShareSessionCommand(input: {
  confirm: (message: string) => Promise<boolean>;
  collect: () => Promise<unknown>;
  exportLocal: (bundle: unknown) => Promise<string>;
  uploadRemote?: (bundle: unknown) => Promise<string>;
  preferRemote: boolean;
  print: (text: string) => void;
}): Promise<{ type: "skip" }> {
  const ok = await input.confirm(
    [
      "Share current session transcript?",
      "",
      "This may include prompts, tool results, file paths, and project content.",
      "Secrets will be redacted before export.",
    ].join("\n"),
  );

  if (!ok) {
    input.print("Session share cancelled.");
    return { type: "skip" };
  }

  const bundle = await input.collect();
  const id =
    input.preferRemote && input.uploadRemote
      ? await input.uploadRemote(bundle)
      : await input.exportLocal(bundle);

  input.print(`Session shared: ${id}`);
  return { type: "skip" };
}
```

同样返回 `skip`。

分享命令不应该污染模型上下文。

## 二十一、失败处理矩阵

| 场景 | 行为 |
| --- | --- |
| 未登录 Claude.ai | 提示 `/login` |
| 组织策略禁用 remote sessions | 直接失败 |
| 当前目录不是 git repo | 提示从正确 repo checkout 运行 |
| 当前 repo 与远端 session repo 不匹配 | 提示正确 repo |
| worktree dirty | 提示 stash 或取消 |
| session id 格式明显不对 | 本地拒绝 |
| Sessions API 401 | 提示重新登录 |
| Sessions API 404 | session not found |
| v2 teleport-events 失败 | fallback session ingress |
| v2 events cursor 超页数 | 返回已有内容并 warning |
| transcript logs 为空 | 失败，不启动 REPL |
| branch checkout 失败 | 恢复 messages，但加 warning |
| raw JSONL 太大 | 分享时跳过 raw |
| 上传分享失败 | 不影响当前会话 |

这张表要写进测试或至少写进手工验证。

跨机器恢复最怕“半成功但用户不知道哪里失败”。

## 二十二、测试：跨项目恢复

`tests/crossProjectResume/check.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { checkCrossProjectResume } from "../../src/crossProjectResume/check";
import type { SessionLogOption } from "../../src/transcriptUx/types";

function log(projectPath: string): SessionLogOption {
  return {
    sessionId: "abc12345",
    fullPath: `${projectPath}/abc12345.jsonl`,
    projectPath,
    messages: [],
    messageCount: 0,
    createdAt: "2026-05-26T00:00:00.000Z",
    modifiedAt: "2026-05-26T00:00:00.000Z",
    isLite: true,
  };
}

describe("checkCrossProjectResume", () => {
  test("allows same project", () => {
    expect(
      checkCrossProjectResume({
        log: log("/repo"),
        currentCwd: "/repo",
        showAllProjects: true,
        worktreePaths: [],
      }).type,
    ).toBe("same_project");
  });

  test("allows same repo worktree", () => {
    expect(
      checkCrossProjectResume({
        log: log("/repo-worktrees/feature-a"),
        currentCwd: "/repo",
        showAllProjects: true,
        worktreePaths: ["/repo-worktrees"],
      }).type,
    ).toBe("same_repo_worktree");
  });

  test("returns command for different project", () => {
    const result = checkCrossProjectResume({
      log: log("/other repo"),
      currentCwd: "/repo",
      showAllProjects: true,
      worktreePaths: [],
    });

    expect(result.type).toBe("different_project");
    if (result.type === "different_project") {
      expect(result.command).toContain("claude --resume abc12345");
      expect(result.command).toContain("'\\/other repo'".replace("\\/", "/"));
    }
  });
});
```

## 二十三、测试：Repo 校验

`tests/teleport/repoValidation.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { validateSessionRepository } from "../../src/teleport/repoValidation";
import type { RemoteSessionResource } from "../../src/teleport/types";

function session(url: string): RemoteSessionResource {
  return {
    id: "s1",
    title: "Test",
    session_status: "idle",
    environment_id: "env",
    created_at: "2026-05-26T00:00:00.000Z",
    updated_at: "2026-05-26T00:00:00.000Z",
    session_context: {
      cwd: "/repo",
      sources: [{ type: "git_repository", url }],
      outcomes: null,
      custom_system_prompt: null,
      append_system_prompt: null,
      model: null,
    },
  };
}

describe("validateSessionRepository", () => {
  test("matches owner repo and host", async () => {
    const result = await validateSessionRepository({
      session: session("git@github.com:acme/app.git"),
      detectCurrentRepo: async () => ({
        host: "github.com",
        repo: "acme/app",
      }),
    });

    expect(result.status).toBe("match");
  });

  test("detects host mismatch", async () => {
    const result = await validateSessionRepository({
      session: session("git@ghe.example.com:acme/app.git"),
      detectCurrentRepo: async () => ({
        host: "github.com",
        repo: "acme/app",
      }),
    });

    expect(result.status).toBe("mismatch");
  });
});
```

## 二十四、测试：远端 transcript fallback

```ts
import { describe, expect, test } from "bun:test";
import { teleportResumeCodeSession } from "../../src/teleport/resume";

describe("teleportResumeCodeSession", () => {
  test("falls back to session ingress when teleport events return null", async () => {
    const calls: string[] = [];

    const result = await teleportResumeCodeSession({
      baseUrl: "https://api.example.test",
      sessionId: "s1",
      auth: { accessToken: "token", organizationId: "org" },
      isRemoteSessionsAllowed: () => true,
      detectCurrentRepo: async () => ({ host: "github.com", repo: "acme/app" }),
      fetchJson: async url => {
        calls.push(url);
        if (url.includes("/v1/sessions/s1")) {
          return {
            id: "s1",
            title: "Test",
            session_status: "idle",
            environment_id: "env",
            created_at: "2026-05-26T00:00:00.000Z",
            updated_at: "2026-05-26T00:00:00.000Z",
            session_context: {
              cwd: "/repo",
              sources: [{ type: "git_repository", url: "git@github.com:acme/app.git" }],
              outcomes: null,
              custom_system_prompt: null,
              append_system_prompt: null,
              model: null,
            },
          };
        }
        if (url.includes("teleport-events")) {
          return { data: "bad" };
        }
        return {
          loglines: [
            {
              id: "u1",
              role: "user",
              type: "message",
              content: [{ type: "text", text: "hello" }],
            },
          ],
        };
      },
    });

    expect(result.log).toHaveLength(1);
    expect(calls.some(url => url.includes("session_ingress"))).toBe(true);
  });
});
```

## 二十五、测试：分享脱敏

`tests/sessionShare/redact.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { redactSessionShareContent } from "../../src/sessionShare/redact";

describe("redactSessionShareContent", () => {
  test("redacts common token shapes", () => {
    const result = redactSessionShareContent(
      'api_key="sk-ant-abcdefghijklmnopqrstuvwxyz"',
    );

    expect(result).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(result).toContain("[REDACTED");
  });

  test("leaves normal content intact", () => {
    expect(redactSessionShareContent("Use Bun for commands.")).toBe(
      "Use Bun for commands.",
    );
  });
});
```

## 二十六、测试：raw transcript size guard

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { collectSessionShareBundle } from "../../src/sessionShare/collect";

describe("collectSessionShareBundle", () => {
  test("skips raw JSONL when file is too large", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccmini-share-"));
    try {
      const transcriptPath = join(dir, "session.jsonl");
      await writeFile(transcriptPath, "x".repeat(51 * 1024 * 1024));

      const bundle = await collectSessionShareBundle({
        messages: [],
        trigger: "manual_command",
        sessionId: "s1",
        appVersion: "test",
        transcriptPath,
        normalizeMessagesForAPI: () => [],
        loadSubagentTranscripts: async () => ({}),
      });

      expect(bundle.rawTranscriptJsonl).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

## 二十七、手动验证

先跑相关测试：

```bash
bun test tests/crossProjectResume tests/teleport tests/sessionShare
```

再跑类型检查：

```bash
bun run typecheck
```

手动验证跨项目恢复：

```txt
1. 在项目 A 创建一个 session。
2. 在项目 B 打开 /resume。
3. 切到 all projects。
4. 选择项目 A 的 session。
5. 确认 Mini 没有直接恢复，而是展示 cd + --resume 命令。
6. 复制命令执行后，确认能在项目 A 恢复。
```

手动验证 same-repo worktree：

```txt
1. 同一个 repo 建两个 worktree。
2. 在 worktree A 创建 session。
3. 在 worktree B 打开 all projects。
4. 选择 worktree A session。
5. 确认允许直接恢复。
```

手动验证 Teleport：

```txt
1. 确认已用 Claude.ai 登录。
2. 确认 git 工作区干净。
3. 运行 /teleport。
4. 选择当前 repo 的远端 session。
5. 确认 repo mismatch 会被拦截。
6. 确认 dirty worktree 会要求 stash。
7. 确认恢复后有 Session resumed 提示。
```

手动验证分享：

```txt
1. 创建含工具调用的会话。
2. 运行 /share-session。
3. 取消一次，确认没有输出文件或上传。
4. 再确认分享，检查导出内容。
5. 人工放入 secret-like 字符串，确认输出中被 redacted。
6. 准备超过 50MB 的 transcript，确认 raw JSONL 被跳过。
```

## 常见错误

### 直接恢复不同项目 session

不要这样做。

不同项目意味着完全不同的文件系统上下文。

恢复消息本身很容易，错误的是让模型以为当前目录就是原来的目录。

### Teleport 使用 API key

远端 code sessions 使用 Claude.ai OAuth。

API key 不能替代。

### dirty worktree 下自动切分支

这是数据安全事故。

必须提示 stash 或取消。

### repo 只比较 owner/repo，不比较 host

GitHub Enterprise 用户会踩坑。

`github.com/acme/app` 和 `ghe.example.com/acme/app` 不是同一个仓库。

### teleport-events 不分页

远端 session 很长时，一页不够。

必须循环 cursor，并加 max pages 防护。

### 把 sidechain transcript 当主对话恢复

子 agent/sidechain transcript 不应该混进主 REPL。

它可以用于调试或分享，但主恢复要过滤。

### 分享时读取超大 raw JSONL

这会让分享功能 OOM。

raw JSONL 必须有大小上限。

### 分享前不脱敏

绝对不行。

即使用户确认分享，也要做 redaction。

## 和官方能力的差距

本章完成后，Mini 已经具备跨边界 session 能力，但仍有差距：

| 能力 | 本章 Mini | 更完整实现 |
| --- | --- | --- |
| 跨项目恢复 | cd 命令 + same-repo worktree | 更完整的 repo path mapping |
| 远端 session list | 当前 repo filter | 多 repo picker、状态分类、分页 |
| repo mismatch | 文本错误 | 可选择已知 checkout 路径 |
| dirty worktree | stash prompt | 更细粒度变更展示 |
| remote transcript | v2 + fallback | 事件增量同步、断点续传 |
| branch checkout | fetch + checkout | branch reuse/outcome policy |
| share session | 本地导出/上传接口 | 官方 ccshare id 恢复 |
| transcript share | redaction + size guard | 用户授权、appearance id、服务端脱敏 |
| session ingress | append/fetch 协议 | 远端 worker SSE 与 live sync |

下一步要继续贴近官方，可以补：

1. Remote Control Server session ingress：让远端 worker 实时把 transcript 写回本机/服务端。
2. ACP load/resume session：让外部 IDE 或 Web UI 调用同一套恢复接口。
3. Background remote tasks：把 teleport session 作为后台任务管理。
4. Remote session detail dialog：查看远端状态、dismiss、archive、teleport。

## 本章小结

第 48 章把 Mini 的 session 能力从本机当前项目扩展到了更真实的工作边界：

```txt
local transcript
  -> cross-project detection
  -> safe resume command

remote Sessions API
  -> repo validation
  -> transcript event fetch
  -> branch checkout
  -> teleport resume notices

session share
  -> collect
  -> redact
  -> size guard
  -> export/upload
  -> future import
```

这章最重要的原则是：跨边界恢复必须显式处理上下文差异。

本地恢复可以假设 CWD、branch、文件状态大致一致。

Teleport Resume 不能这么假设。

它必须把 repo、branch、dirty worktree、认证、远端 transcript、分享脱敏全部当成一等公民。

到这里，Mini 不只是“像官方 Claude Code 一样能恢复历史”，而是开始具备“跨工作区和跨机器继续工作”的架构基础。

下一章可以继续补 **远程控制、Background Sessions 与任务生命周期**：把已经恢复的远端会话变成可查看、可挂起、可继续、可归档的长期任务。
