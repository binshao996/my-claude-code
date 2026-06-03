# 第 68 章：生产级可观测性与支持链路：日志、错误边界、诊断包、反馈、隐私脱敏、Issue 模板与最小复现

第 67 章补完了发布与分发链路。

这解决的是“如何把 Claude Code 可靠地发出去”。

本章继续往后走：当用户已经装上并开始使用之后，出了问题怎么办？

一个接近官方 Claude Code 的 CLI，不能只在 happy path 上表现得像官方。真正拉开差距的是：

- 崩溃时能不能留下足够线索？
- 用户能不能清楚知道会上传什么？
- 诊断信息能不能脱敏？
- 支持人员能不能快速复现？
- 日志是否能关联到 session？
- 反馈是否能带上版本、平台、Git 状态和错误摘要？
- 性能问题是否能独立生成报告？
- 隐私开关是否能阻止非必要网络请求？
- 公开 issue 是否不会泄露本地路径、密钥和完整 transcript？

当前仓库已经有不少相关实现：

- `src/utils/debug.ts`
- `src/utils/log.ts`
- `src/components/SentryErrorBoundary.tsx`
- `src/components/Feedback.tsx`
- `src/components/FeedbackSurvey/submitTranscriptShare.ts`
- `src/commands/feedback/index.ts`
- `src/commands/share/index.ts`
- `src/commands/issue/index.ts`
- `src/commands/perf-issue/index.ts`
- `src/utils/privacyLevel.ts`
- `src/services/diagnosticTracking.ts`
- `src/services/api/logging.ts`
- `packages/acp-link/src/logger.ts`
- `scripts/probe-local-wiring.ts`

这些模块说明项目已经有“可支持性”的骨架。

但要接近官方体验，还需要把它们收束成一条完整的支持链路。

---

## 68.1 什么是生产级支持链路

生产级支持链路不是“打印一堆日志”。

它是一套闭环：

```text
problem happens
  -> visible local error
  -> structured logs
  -> recent in-memory errors
  -> optional diagnostic bundle
  -> redaction pipeline
  -> user consent preview
  -> issue / feedback / support handoff
  -> support-side reproduction
  -> fix verification
```

这里最重要的是“可控”。

用户必须知道：

- 什么数据留在本地。
- 什么数据会被打包。
- 什么数据会被上传。
- 哪些字段永远不会被收集。
- 哪些内容只在用户明确确认后才会包含。

支持人员必须拿到：

- 版本和构建信息。
- 运行平台。
- Provider 配置形态。
- 会话摘要。
- 错误堆栈摘要。
- 相关工具调用失败摘要。
- 可复现步骤。
- 最小 fixture 或 mock。

两边目标不同，但中间必须通过同一套诊断模型连接。

---

## 68.2 当前已有入口

当前代码里已经有这些入口：

```text
--debug
--debug-file <path>
--debug-to-stderr

/feedback
/bug
/share
/issue
/perf-issue
/privacy-settings
```

还有几个内部支撑点：

```text
logForDebugging()
logError()
getInMemoryErrors()
logMCPError()
logMCPDebug()
captureAPIRequest()
SentryErrorBoundary
DiagnosticTrackingService
```

这说明当前项目已经不是“完全没有支持能力”。

本章的目标是把这些能力分层：

```text
local debug
  开发者本机排查

error capture
  当前会话内的异常和错误摘要

feedback report
  用户主动提交问题

session share
  用户主动分享会话日志

performance snapshot
  用户主动导出性能报告

diagnostic bundle
  建议新增：统一导出的支持包

support reproduction
  建议新增：支持侧复现脚本和 fixture
```

---

## 68.3 Debug 日志的真实行为

`src/utils/debug.ts` 里已经实现了比较完整的 debug 日志机制。

核心行为：

```text
debug mode enabled when:
  runtimeDebugEnabled
  DEBUG
  DEBUG_SDK
  --debug
  -d
  --debug-to-stderr
  --debug=<pattern>
  --debug-file
```

默认路径：

```text
<claude-config-home>/debug/<session-id>.txt
<claude-config-home>/debug/latest -> current log
```

这个设计非常关键。

支持人员不应该让用户去猜“日志在哪”。`latest` 链接让用户可以直接定位当前会话日志。

官方级实现应保留三种模式：

```text
normal
  默认不刷大量 debug 细节，避免污染终端和磁盘。

debug file
  写入 session-scoped 文件，适合复现问题。

debug stderr
  直接输出到 stderr，适合 CI、pipe mode 和一次性命令。
```

当前 `logForDebugging()` 还支持 level：

```ts
export type DebugLogLevel =
  | "verbose"
  | "debug"
  | "info"
  | "warn"
  | "error";
```

建议继续沿用这个模型，不要给每个模块自己造一套日志等级。

---

## 68.4 Debug 日志要写什么

Debug 日志不是 transcript。

它应该记录系统行为，而不是完整用户内容。

适合写入：

```text
session id
version
platform
provider label
model label
feature flags summary
command start/end
tool start/end
MCP connection state
LSP availability
settings parse result
plugin load result
network error classification
retry count
timeout duration
compaction trigger
permission prompt result category
```

不适合写入：

```text
full prompt
full tool output
raw file content
raw environment values
auth headers
access tokens
private key material
full shell command output containing secrets
```

建议把 debug log 看作“事件轨迹”，而不是“数据转储”。

一个事件可以这样表示：

```ts
type DebugEvent = {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  area:
    | "api"
    | "tool"
    | "mcp"
    | "lsp"
    | "plugin"
    | "settings"
    | "permission"
    | "runtime";
  message: string;
  sessionId: string;
  requestId?: string;
  durationMs?: number;
  fields?: Record<string, string | number | boolean | null>;
};
```

注意 `fields` 只能放安全元数据。

不要把它当成万能对象。

---

## 68.5 Error 日志的真实行为

`src/utils/log.ts` 已经有一套 error log 机制：

```text
logError(error)
  -> shortErrorStack()
  -> in-memory error log
  -> queued sink when sink not attached
  -> persistent sink after attach
```

关键点有三个。

第一，当前会话内存里最多保留最近错误：

```ts
const MAX_IN_MEMORY_ERRORS = 100;
```

这适合反馈报告。

第二，sink 可以晚绑定：

```text
early error
  -> queue
sink attached
  -> drain queue
```

CLI 启动期最容易出错。晚绑定队列可以避免“错误发生得太早所以丢了”。

第三，隐私级别会影响错误上报：

```text
cloud provider mode
DISABLE_ERROR_REPORTING
essential traffic only
  -> skip error reporting path
```

这一点必须延续到后续所有支持能力。

---

## 68.6 Error Boundary 的职责

`src/components/SentryErrorBoundary.tsx` 的行为很清晰：

```text
React render error
  -> stderr prints boundary name and component stack
  -> logError(error)
  -> captureException(error, metadata)
  -> UI fallback
```

这解决了终端 UI 的一个关键问题：

> React/Ink 层崩了，用户不能只看到一个空白终端。

官方级 error boundary 需要做到：

```text
1. 不吞掉错误
2. 不泄露敏感内容
3. 给用户一个可理解的 fallback
4. 把边界名称写入日志
5. 把 component stack 作为诊断线索
6. 提示用户如何导出诊断信息
```

建议 fallback 文案保持短：

```text
Claude Code UI failed to render.
Run with --debug-file <path> and retry, or export a diagnostic bundle.
```

不要在终端里打印完整支持教程。

---

## 68.7 支持链路数据分级

所有诊断数据都要先分级。

建议分成五级：

```ts
type SupportDataClass =
  | "public"
  | "safe_metadata"
  | "local_path"
  | "user_content"
  | "secret";
```

含义：

```text
public
  版本号、平台、CPU 架构、feature flag 名称。

safe_metadata
  模型名、provider 类型、工具名、错误类型、退出码。

local_path
  本地目录、仓库名、transcript 路径、配置路径。

user_content
  用户 prompt、assistant 回复、文件内容、工具输出。

secret
  token、key、password、authorization header、OAuth credential、private key。
```

默认支持包只能包含：

```text
public
safe_metadata
local_path after sanitization
```

`user_content` 必须显式选择。

`secret` 永远不允许进入最终包。

---

## 68.8 现有隐私级别

`src/utils/privacyLevel.ts` 已经定义了三档：

```text
default
no-telemetry
essential-traffic
```

解析逻辑：

```text
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  -> essential-traffic

DISABLE_TELEMETRY
  -> no-telemetry

otherwise
  -> default
```

支持链路必须遵守这个开关。

建议规则：

```text
default
  可显示反馈入口，可在用户确认后上传。

no-telemetry
  禁止后台遥测，但用户主动反馈仍可由产品策略决定是否可用。

essential-traffic
  禁止非必要网络请求，反馈、分享、自动上传全部关闭。
```

当前 `/feedback` 已经在 `essential-traffic` 下禁用。

这符合预期。

---

## 68.9 反馈命令的真实行为

`src/commands/feedback/index.ts` 把 `/feedback` 和 `/bug` 绑定到同一个组件。

它会被这些条件禁用：

```text
cloud provider mode
DISABLE_FEEDBACK_COMMAND
DISABLE_BUG_COMMAND
essential traffic only
internal user type
policy disallow product feedback
```

`src/components/Feedback.tsx` 的流程是：

```text
userInput
  -> 用户描述问题

consent
  -> 展示将包含哪些内容

submitting
  -> 提交报告

done
  -> 显示 feedback id
  -> 可打开浏览器草拟 GitHub issue
```

当前报告会包含：

```text
latest assistant message id
message count
datetime
description
platform
terminal
version
git repo metadata
normalized transcript
sanitized in-memory errors
last API request without messages
subagent transcripts
raw transcript jsonl when size allows
```

这个信息量已经很接近官方反馈。

但要注意一个边界：

反馈报告是“用户确认后上传”的入口，不等于默认后台上报。

这一点要在产品文案和实现里保持一致。

---

## 68.10 反馈确认页应该怎么写

确认页必须具体。

不要只写：

```text
This report may include diagnostic information.
```

这不够。

应该写：

```text
This report will include:
- your description
- platform and terminal
- Claude Code version
- Git branch and short commit when available
- current session transcript
- recent error summaries
```

如果将来新增诊断包，还要分成默认项和可选项：

```text
Included by default:
- version
- platform
- command mode
- settings parse status
- recent sanitized errors
- tool failure summary

Optional:
- session transcript summary
- full session transcript
- debug log tail
- perf snapshot
```

用户应该能在提交前看到“类别”，而不是只能相信一句笼统声明。

---

## 68.11 当前脱敏函数的分散问题

当前仓库里至少有几类脱敏逻辑：

```text
src/components/Feedback.tsx
  redactSensitiveInfo()

src/commands/share/index.ts
  maskSecrets()

src/commands/share/index.ts
  sanitizeErrorMessage()

src/commands/perf-issue/index.ts
  sanitizeErrorMessage()

packages/builtin-tools/src/tools/VaultHttpFetchTool/scrub.ts
  scrub secret forms
```

这些函数都各有价值，但分散会带来问题：

- 规则不一致。
- 新入口可能忘记调用。
- 测试覆盖重复。
- 某些入口默认只在指定 flag 下脱敏。
- 支持包很难统一声明“已经过同一条 redaction pipeline”。

建议新增一个统一模块：

```text
src/utils/redaction/
  rules.ts
  redactText.ts
  redactJson.ts
  redactPath.ts
  classify.ts
  report.ts
```

然后让 `/feedback`、`/share`、`/issue`、`/perf-issue` 和未来的诊断包都走同一条基础管道。

---

## 68.12 统一脱敏接口

建议接口不要只返回字符串。

脱敏结果还应该告诉调用方“做了哪些替换”。

```ts
type RedactionKind =
  | "api_key"
  | "auth_header"
  | "bearer_token"
  | "password"
  | "private_key"
  | "cloud_credential"
  | "local_home_path"
  | "email"
  | "high_entropy_token";

type RedactionHit = {
  kind: RedactionKind;
  count: number;
};

type RedactionResult = {
  text: string;
  hits: RedactionHit[];
  truncated: boolean;
};
```

调用方可以用 `hits` 显示安全摘要：

```text
Redaction applied:
- bearer_token: 2
- cloud_credential: 1
- local_home_path: 4
```

不要显示原始值。

---

## 68.13 文本脱敏规则

文本脱敏规则要覆盖常见泄露形态：

```ts
type RedactionRule = {
  kind: RedactionKind;
  pattern: RegExp;
  replacement: string;
};

const REDACTION_RULES: RedactionRule[] = [
  {
    kind: "auth_header",
    pattern: /authorization\s*[:=]\s*bearer\s+[A-Za-z0-9._~+/-]{16,}/gi,
    replacement: "authorization: bearer [REDACTED_TOKEN]",
  },
  {
    kind: "api_key",
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    replacement: "[REDACTED_API_KEY]",
  },
  {
    kind: "password",
    pattern: /(password\s*[:=]\s*)["']?[^"',\s)}\]]{8,}/gi,
    replacement: "$1[REDACTED_PASSWORD]",
  },
];
```

注意这里的规则只是示例。

生产实现要把规则放在测试覆盖里，而不是散落在组件文件中。

---

## 68.14 高熵 token 的风险

不能盲目把所有长字符串都替换掉。

例如：

```text
git commit sha
content hash
trace id
request id
base64 test fixture
```

这些值可能很长，但不一定是秘密。

当前 `/share` 的实现已经有一个正确判断：不默认脱敏泛化的长 hex 字符串，因为它会误伤 commit SHA。

统一脱敏模块也应该遵守这个原则。

建议只做两类高熵检测：

```text
1. 有上下文前缀的字段
   token=...
   secret=...
   password=...
   authorization=...

2. 有明确提供方前缀的 credential
   例如常见云厂商和代码托管平台 token 前缀
```

不要把“看起来随机”当成充分证据。

---

## 68.15 JSON 脱敏

诊断包主要是结构化数据。

不要先 `JSON.stringify()` 再做所有规则。

应该先按 key 分类。

```ts
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const SENSITIVE_KEYS = [
  "authorization",
  "cookie",
  "set-cookie",
  "token",
  "apiKey",
  "api_key",
  "password",
  "secret",
  "clientSecret",
  "privateKey",
];

function redactJson(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    return redactText(value).text;
  }

  if (Array.isArray(value)) {
    return value.map(redactJson);
  }

  if (value && typeof value === "object") {
    const out: { [key: string]: JsonValue } = {};
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_KEYS.some(pattern => key.toLowerCase().includes(pattern.toLowerCase()))) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = redactJson(child);
      }
    }
    return out;
  }

  return value;
}
```

Key-based 脱敏比纯正则更可靠。

二者应该叠加，而不是二选一。

---

## 68.16 路径脱敏

本地路径经常被低估。

这些路径可能包含：

```text
用户名
公司名
客户名
仓库名
feature 名称
内部 ticket id
```

建议默认处理：

```text
/Users/alice/work/acme-secret-project/src/foo.ts
  -> ~/work/<repo>/src/foo.ts

/home/bob/code/client-x/payment-api/.claude/settings.json
  -> ~/code/<repo>/.claude/settings.json
```

实现上可以分三档：

```ts
type PathPrivacyMode =
  | "basename"
  | "home_relative"
  | "hash_segments";
```

推荐默认：

```text
diagnostic bundle
  home_relative + repo name hash

issue body
  basename only unless user opts in

local debug
  full path allowed because it stays local
```

路径脱敏不能只处理当前系统的 home。

还要处理日志里可能出现的远程环境路径、容器路径和 Windows 风格路径。

---

## 68.17 诊断包应该是什么

建议新增一个统一导出能力：

```text
/diagnostics export
```

或者复用更短入口：

```text
/support
```

注意：这是建议新增，不是当前已经实现的命令。

诊断包不是完整 transcript 压缩包。

它应该是一个目录或归档，包含结构化 manifest：

```text
claude-diagnostics-<timestamp>-<session>.zip
  manifest.json
  environment.json
  health.json
  settings.json
  errors.json
  debug-tail.txt
  transcript-summary.jsonl
  perf.md
  redaction-report.json
```

默认不包含：

```text
full transcript
full debug log
full settings values
raw env values
file contents
shell history
auth material
```

---

## 68.18 诊断包 Manifest

Manifest 是支持包的入口。

建议结构：

```ts
type DiagnosticBundleManifest = {
  schemaVersion: 1;
  createdAt: string;
  sessionId: string;
  bundleId: string;
  cli: {
    version: string;
    buildTime?: string;
    buildCommit?: string;
    installKind?: string;
  };
  runtime: {
    bunVersion: string;
    platform: NodeJS.Platform;
    arch: string;
    terminal?: string;
  };
  privacy: {
    level: "default" | "no-telemetry" | "essential-traffic";
    fullTranscriptIncluded: boolean;
    fullDebugLogIncluded: boolean;
    localPathsMode: PathPrivacyMode;
  };
  files: Array<{
    path: string;
    sha256: string;
    bytes: number;
    description: string;
  }>;
};
```

每个子文件都要有 hash。

这不是为了防篡改的安全边界，而是为了支持侧确认“用户发来的包没有缺文件”。

---

## 68.19 环境快照

环境快照不能等同于 `process.env`。

只允许 allowlist。

```ts
type EnvironmentSnapshot = {
  platform: string;
  arch: string;
  bunVersion: string;
  cliVersion: string;
  cwdKind: "git" | "non_git" | "unknown";
  provider: {
    kind: string;
    baseUrlHost?: string;
    model?: string;
  };
  flags: {
    debug: boolean;
    debugToStderr: boolean;
    essentialTrafficOnly: boolean;
  };
};
```

Base URL 也要谨慎。

建议默认只保留 host：

```text
https://api.example.internal/v1/private/path
  -> api.example.internal
```

如果路径本身对排查重要，再让用户显式选择包含完整 URL。

---

## 68.20 Settings 快照

Settings 是高价值诊断信息，也是高风险信息。

支持包里不应该直接复制完整配置文件。

建议只导出：

```text
settings source list
parse success / failure
schema errors
enabled feature category
permission rule counts
MCP server count
plugin count
hook count
managed settings present
local override present
```

示例：

```ts
type SettingsSnapshot = {
  sources: Array<{
    kind: "user" | "project" | "local" | "managed";
    exists: boolean;
    parseOk: boolean;
    error?: string;
  }>;
  counts: {
    allowRules: number;
    denyRules: number;
    mcpServers: number;
    plugins: number;
    hooks: number;
  };
  warnings: string[];
};
```

如果用户愿意附带完整配置，也必须先走 JSON 脱敏，并展示 preview。

---

## 68.21 Transcript 摘要

Transcript 是最敏感的诊断信息之一。

当前 `/issue` 已经做了 summary：

```text
last N turns
each text truncated
recent tool_result errors
```

当前 `/share` 支持 summary-only：

```text
first 200 chars per turn
user / assistant only
```

这些思路是正确的。

诊断包默认应该采用摘要而不是全文。

建议摘要结构：

```ts
type TranscriptSummaryEntry = {
  index: number;
  role: "user" | "assistant";
  textPreview: string;
  toolNames?: string[];
  hasErrorToolResult?: boolean;
  timestamp?: string;
};
```

摘要限制：

```text
max turns: 10
max preview chars per message: 240
tool output: excluded by default
file content: excluded by default
```

如果用户选择 full transcript：

```text
1. 显示强提示
2. 先脱敏
3. 标记 manifest.fullTranscriptIncluded = true
4. 写入 redaction report
5. 支持取消
```

---

## 68.22 Debug Tail

完整 debug log 可能很大，也可能包含用户上下文。

默认支持包只应包含尾部。

建议：

```ts
type DebugTailOptions = {
  maxBytes: number;
  maxLines: number;
  redact: boolean;
};

const DEFAULT_DEBUG_TAIL_OPTIONS: DebugTailOptions = {
  maxBytes: 256 * 1024,
  maxLines: 2000,
  redact: true,
};
```

Tail 的价值是保留“问题发生前后的系统事件”。

不需要把整个会话都塞进去。

---

## 68.23 性能快照

`src/commands/perf-issue/index.ts` 已经实现了性能报告。

它会从 session log 里分析：

```text
token usage
cache usage
tool call counts
tool timing
turn count
message count
detected model
wall clock duration
process memory
process CPU
runtime versions
```

输出格式：

```text
md
json
csv
```

并且有 line cap：

```ts
const MAX_LOG_LINES = 20_000;
```

这是很好的安全阀。

诊断包可以直接复用 perf snapshot 的分析结果，而不是再写一套。

建议新增内部函数：

```ts
export function buildPerfSnapshot(options: {
  format: "json";
  lineLimit: number;
}): Promise<PerfSnapshot>;
```

命令层只负责展示和写文件。

诊断包层复用同一个分析函数。

---

## 68.24 Issue 命令的定位

`src/commands/issue/index.ts` 已经实现了 `/issue`。

它做了这些事：

```text
detect git remote
parse owner/repo
detect gh CLI
check whether issues enabled
detect issue template
build session summary
create issue or fallback to URL
save oversized draft locally
```

这个入口适合“公开或团队内 issue”。

它不应该默认包含完整 transcript。

当前实现使用摘要，这是正确方向。

官方级增强点：

```text
1. 自动附带 diagnostic bundle id，而不是 bundle 内容。
2. 公开 issue 中只放安全摘要。
3. 如果 body 超长，保存本地 draft，并提醒用户检查。
4. issue template 优先级高于自动生成结构。
5. error message 进入 body 前统一脱敏。
```

建议 issue body 标准结构：

```md
## Summary

## Expected Behavior

## Actual Behavior

## Environment

## Reproduction

## Diagnostics

## Additional Context
```

其中 `Diagnostics` 只放：

```text
diagnostic bundle id
CLI version
platform
sanitized error summary
```

不要直接贴完整日志。

---

## 68.25 Share 命令的定位

`src/commands/share/index.ts` 适合“用户主动分享当前 session log”。

它支持：

```text
--public
--private
--mask-secrets
--summary-only
--allow-public-fallback
```

当前隐私提示非常重要：

```text
JSONL contains everything typed in this session, including tool outputs.
Review before sharing.
```

官方级目标建议：

```text
1. 默认 summary-only。
2. 默认 mask-secrets。
3. full log 需要二次确认。
4. public 分享需要额外确认。
5. fallback 到公开 paste 服务必须显式 opt-in。
6. 上传前写本地临时文件，上传后清理。
```

这里的关键是默认值。

有能力脱敏不等于默认安全。

接近官方体验时，默认应该偏保守。

---

## 68.26 诊断包采集器

建议诊断包实现为多个 collector。

每个 collector 只负责一个领域。

```ts
type DiagnosticCollectorContext = {
  sessionId: string;
  createdAt: string;
  outputDir: string;
  includeUserContent: boolean;
  includeFullDebugLog: boolean;
  pathPrivacyMode: PathPrivacyMode;
};

type DiagnosticCollectorResult = {
  fileName: string;
  description: string;
  bytes: number;
  sha256: string;
  redactionHits: RedactionHit[];
};

type DiagnosticCollector = {
  name: string;
  collect(ctx: DiagnosticCollectorContext): Promise<DiagnosticCollectorResult | null>;
};
```

Collector 列表：

```text
environmentCollector
settingsCollector
errorsCollector
debugTailCollector
transcriptSummaryCollector
perfSnapshotCollector
doctorCollector
mcpCollector
lspCollector
pluginCollector
```

每个 collector 必须满足：

```text
fail closed
  单个 collector 失败不影响整个包生成。

redact before write
  写入磁盘前完成脱敏。

size cap
  每个文件有大小上限。

manifest entry
  每个输出都登记到 manifest。
```

---

## 68.27 Collector 错误处理

诊断包生成时不能因为某个模块坏了就整体失败。

否则最需要诊断的时候反而导不出来。

建议：

```ts
type CollectorFailure = {
  collector: string;
  message: string;
  recoverable: boolean;
};

type BundleBuildResult = {
  ok: boolean;
  bundlePath?: string;
  failures: CollectorFailure[];
};
```

流程：

```text
for each collector:
  try collect
  catch error
    sanitize error
    add failure to manifest
continue
```

最终只在这些情况失败：

```text
cannot create output dir
cannot write manifest
redaction pipeline failed hard
archive creation failed
```

其他都应该是 degraded bundle。

---

## 68.28 写包流程

推荐流程：

```text
1. create temp dir
2. collect files into temp dir
3. write redaction-report.json
4. write manifest.json
5. archive temp dir
6. verify archive can be read
7. move archive to final path
8. remove temp dir
```

Bun 环境下可以用 `Bun.write()` 写文件：

```ts
async function writeJsonFile(path: string, value: unknown): Promise<number> {
  const text = JSON.stringify(value, null, 2) + "\n";
  await Bun.write(path, text);
  return new TextEncoder().encode(text).byteLength;
}
```

Hash 可以使用 Web Crypto：

```ts
async function sha256File(path: string): Promise<string> {
  const bytes = await Bun.file(path).arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}
```

这里没有必要引入新的运行时假设。

---

## 68.29 Size Cap

每个诊断文件都必须有上限。

建议默认：

```ts
const SUPPORT_LIMITS = {
  debugTailBytes: 256 * 1024,
  transcriptSummaryBytes: 128 * 1024,
  errorLogBytes: 128 * 1024,
  settingsSnapshotBytes: 64 * 1024,
  perfSnapshotBytes: 256 * 1024,
  fullBundleBytes: 2 * 1024 * 1024,
} as const;
```

超过上限时：

```text
1. 截断
2. 标记 truncated=true
3. 在 redaction report 中记录
4. 不静默丢弃
```

不要为了“尽量完整”生成几十 MB 的包。

支持包越大，用户越不愿意发，支持侧也越难看。

---

## 68.30 Redaction Report

诊断包必须包含脱敏报告。

示例：

```json
{
  "schemaVersion": 1,
  "createdAt": "2026-05-27T00:00:00.000Z",
  "files": [
    {
      "path": "errors.json",
      "truncated": false,
      "hits": [
        { "kind": "auth_header", "count": 1 },
        { "kind": "local_home_path", "count": 3 }
      ]
    }
  ]
}
```

脱敏报告不包含原始值。

它的作用是：

- 给用户信心。
- 给支持侧解释为什么某些字段被替换。
- 给测试提供断言目标。

---

## 68.31 用户确认流程

诊断包导出可以有两种模式：

```text
local export
  只写本地文件，不上传。

submit
  用户确认后上传或附加到反馈。
```

建议默认只做 local export。

提交前显示：

```text
Diagnostic bundle will include:
- environment metadata
- sanitized settings summary
- recent sanitized errors
- debug log tail
- transcript summary
- performance snapshot

It will not include by default:
- full transcript
- file contents
- raw environment values
- secrets
```

如果用户选择 full transcript，再显示二次确认：

```text
Full transcript may include prompts, tool outputs, file paths, and code snippets.
Review the generated file before sharing.
```

这类确认不是形式主义。

它是支持链路的安全边界。

---

## 68.32 支持侧复现脚本

支持包只能告诉你发生了什么。

复现脚本告诉你如何让它再次发生。

建议每个高价值问题都能沉淀成：

```text
tests/repros/<issue-id>/
  README.md
  fixture/
  reproduce.test.ts
  expected.md
```

示例：

```ts
import { describe, expect, test } from "bun:test";
import { buildIssueBody } from "src/support/issueBody.js";

describe("repro issue body truncation", () => {
  test("keeps diagnostics section when body is too long", () => {
    const body = buildIssueBody({
      summary: "x".repeat(20_000),
      diagnostics: "diagnostic bundle: abc123",
    });

    expect(body).toContain("diagnostic bundle: abc123");
    expect(body.length).toBeLessThanOrEqual(8_000);
  });
});
```

运行：

```bash
bun test tests/repros/example/reproduce.test.ts
```

复现脚本不应该依赖真实用户密钥或真实远程服务。

需要 API 行为时使用 mock stream 或 fixture。

---

## 68.33 支持侧最小上下文

一个好 issue 不需要完整世界。

它需要最小上下文：

```text
what command
what version
what platform
what provider
what expected
what happened
what changed recently
can reproduce or not
diagnostic bundle id
sanitized error summary
```

建议内部支持模板：

```md
## Problem

## Impact

## Environment

## Reproduction

## Observed Logs

## Suspected Area

## Next Experiment
```

这个模板面向维护者，不一定直接给用户看。

用户看到的是更短的引导。

---

## 68.34 错误分类

支持链路需要错误分类，否则所有问题都叫“坏了”。

建议分类：

```ts
type SupportIssueArea =
  | "auth"
  | "api"
  | "model"
  | "stream"
  | "tool"
  | "permission"
  | "mcp"
  | "lsp"
  | "plugin"
  | "settings"
  | "terminal_ui"
  | "install_update"
  | "performance"
  | "unknown";
```

错误分类来源：

```text
API error classifier
tool result error
MCP connection error
LSP diagnostic tracking error
settings parser error
error boundary name
doctor warning category
auto updater status
```

诊断包 manifest 可以记录主分类：

```json
{
  "suspectedAreas": ["mcp", "settings"],
  "severity": "warning"
}
```

这能让支持侧先看正确文件。

---

## 68.35 事件、日志、诊断的边界

不要混淆三个概念。

```text
analytics event
  产品级计数和漏斗，不包含代码和路径。

debug log
  本地排查轨迹，默认留在本机。

diagnostic bundle
  用户主动导出的支持材料。
```

边界不清会导致两类问题：

- 支持信息不足。
- 隐私范围过大。

建议所有代码 review 都问一句：

```text
这条信息应该进入 event、debug log、还是 diagnostic bundle？
```

如果答案是“都可以”，说明分类还不清楚。

---

## 68.36 API 请求捕获

`captureAPIRequest()` 当前只保存不含 messages 的请求参数。

这是正确边界：

```text
retain:
  model
  temperature
  tools metadata
  betas
  system settings summary

do not retain globally:
  full messages
```

当前代码只对内部用户额外保留最后 messages 引用。

普通用户路径不应该因为支持功能而长期持有完整上下文。

诊断包也应沿用这个原则：

```text
default:
  last request metadata without messages

optional:
  transcript summary

explicit opt-in:
  full transcript
```

---

## 68.37 MCP 日志

`src/utils/log.ts` 已经提供：

```text
logMCPError(serverName, error)
logMCPDebug(serverName, message)
```

MCP 是高频支持问题来源。

诊断包里应该包含 MCP 摘要：

```ts
type McpSupportSnapshot = {
  servers: Array<{
    name: string;
    status: "connected" | "failed" | "disabled" | "unknown";
    transport: "stdio" | "sse" | "http" | "unknown";
    toolCount?: number;
    lastError?: string;
  }>;
};
```

不要包含：

```text
server command full args with secrets
environment values
OAuth tokens
raw server stdout
raw request payloads
```

如果 MCP server 的 command 本身需要展示，先做 argv 级脱敏。

---

## 68.38 LSP 与诊断跟踪

`src/services/diagnosticTracking.ts` 负责 IDE 诊断基线和新增诊断。

支持包可以提取：

```text
IDE connected or not
diagnostic tracking initialized or not
edited files count
new diagnostics count by severity
last diagnostic tracking error
```

不要导出完整源码片段。

如果需要定位，可以导出：

```ts
type LspDiagnosticSummary = {
  files: Array<{
    path: string;
    errorCount: number;
    warningCount: number;
    sources: string[];
    codes: string[];
  }>;
};
```

其中 `path` 仍然要走路径脱敏。

---

## 68.39 ACP / Remote 支持日志

`packages/acp-link/src/logger.ts` 使用 pino：

```text
debug mode:
  JSON to file
  pretty output to console

normal mode:
  pretty info output
```

ACP / Remote 这类长连接问题通常需要：

```text
connection id
session id
transport type
permission mode
agent process state
last heartbeat time
close code
close reason category
```

不需要默认导出：

```text
full websocket payload
raw prompt
auth token
remote environment values
```

这类日志最好单独 collector：

```text
remoteCollector
acpCollector
bridgeCollector
```

避免和普通 CLI debug 混在一起。

---

## 68.40 Feedback 与 Issue 的关系

`/feedback` 和 `/issue` 不是同一个东西。

```text
/feedback
  产品反馈入口，可能提交到服务端，带 feedback id。

/issue
  项目 issue 入口，面向 GitHub repo，适合公开或团队工作流。
```

当前 `Feedback` 成功后可以打开浏览器草拟 GitHub issue，并把 feedback id 放进去。

这是好的桥接方式。

建议保持：

```text
feedback report contains richer private support data
public issue contains minimal safe summary and feedback id
```

不要把完整 feedback 内容复制到公开 issue。

---

## 68.41 诊断包与 Feedback 的关系

未来建议：

```text
/feedback
  可以选择附加 diagnostic bundle。

/diagnostics export
  只导出本地 bundle。

/issue
  可以引用 bundle id 或本地路径，但不自动上传 bundle。
```

交互可以是：

```text
Submit feedback?
  Include diagnostic bundle? yes/no
  Include full transcript? no by default
  Include debug tail? yes by default
```

上传后返回：

```text
Feedback ID: fbk_...
Diagnostic Bundle ID: diag_...
```

公开 issue 只引用这些 id。

---

## 68.42 诊断包命令设计

建议命令：

```text
/diagnostics export
/diagnostics export --include-transcript
/diagnostics export --include-debug-log
/diagnostics export --format=zip
/diagnostics export --format=dir
```

非交互模式：

```bash
bun run src/entrypoints/cli.tsx diagnostics export --format=dir
```

如果最终 CLI 没有子命令，也可以先落地为内部脚本：

```bash
bun run scripts/export-diagnostics.ts
```

但用户体验上，最好最后收进 CLI 命令体系。

---

## 68.43 支持包文件命名

文件名应包含时间和 session 前缀：

```text
claude-diagnostics-2026-05-27T12-34-56Z-a1b2c3d4.zip
```

不要包含：

```text
repo name
branch name
user name
provider name
```

这些信息可以在 manifest 里脱敏后记录。

文件名本身可能会出现在邮件、工单系统、截图里，所以也要安全。

---

## 68.44 日志保留策略

日志无限增长会变成另一个问题。

建议：

```text
debug logs
  按 session 文件保存
  latest symlink 指向当前
  可按数量或时间清理

error logs
  最近 N 条内存保留
  文件保留仅用于内部或显式 debug

diagnostic bundles
  用户主动生成
  不自动上传
  可提供清理命令
```

清理策略：

```ts
type RetentionPolicy = {
  maxFiles: number;
  maxAgeDays: number;
  maxTotalBytes: number;
};
```

默认值要保守，避免删掉用户刚生成的支持包。

---

## 68.45 支持链路测试矩阵

支持链路必须有测试。

最低测试矩阵：

```text
redaction text
redaction json
path sanitization
bundle manifest
collector failure
size cap
transcript summary
debug tail
issue body truncation
feedback consent copy
privacy level gating
share option parsing
perf snapshot line cap
```

运行：

```bash
bun test src/utils/redaction
bun test src/support
bun test src/commands/share
bun test src/commands/issue
bun test src/commands/perf-issue
bun run typecheck
```

不要只靠人工试一次。

支持链路通常在异常路径触发，最容易被正常路径回归漏掉。

---

## 68.46 脱敏测试

脱敏测试必须覆盖“原始形式”和“派生形式”。

`scripts/probe-local-wiring.ts` 已经验证了 VaultHttpFetch 的几个关键点：

```text
Bearer-prefixed secret is redacted
raw and base64 forms are redacted
axios error config is not stringified with secret
```

统一脱敏模块也要延续这种思路。

示例：

```ts
import { describe, expect, test } from "bun:test";
import { redactText } from "src/utils/redaction/redactText.js";

describe("redactText", () => {
  test("redacts authorization headers", () => {
    const input = "authorization: bearer SECRET_TOKEN_EXAMPLE_123456789";
    const result = redactText(input);

    expect(result.text).not.toContain("SECRET_TOKEN_EXAMPLE_123456789");
    expect(result.text).toContain("[REDACTED_TOKEN]");
    expect(result.hits).toContainEqual({ kind: "bearer_token", count: 1 });
  });

  test("does not redact normal commit sha", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const result = redactText(`commit ${sha}`);

    expect(result.text).toContain(sha);
  });
});
```

不要在测试里使用真实 key。

使用明显的假值即可。

---

## 68.47 Bundle 测试

诊断包测试要验证结构，而不是只验证“文件存在”。

示例：

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDiagnosticBundle } from "src/support/diagnostics/buildBundle.js";

describe("buildDiagnosticBundle", () => {
  test("writes manifest and redaction report", async () => {
    const dir = await mkdtemp(join(tmpdir(), "diag-test-"));
    try {
      const result = await buildDiagnosticBundle({
        outputDir: dir,
        includeUserContent: false,
      });

      expect(result.ok).toBe(true);

      const manifest = JSON.parse(
        await readFile(join(result.bundleDir, "manifest.json"), "utf8"),
      ) as { files: Array<{ path: string }> };

      expect(manifest.files.some(file => file.path === "redaction-report.json")).toBe(true);
      expect(manifest.files.some(file => file.path === "transcript-full.jsonl")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

关键断言：

```text
manifest exists
redaction report exists
full transcript excluded by default
collector failure recorded
hash matches file content
size cap respected
```

---

## 68.48 Privacy Gating 测试

隐私级别是支持链路的硬门禁。

测试要覆盖：

```text
default
  feedback enabled when policy allows

no-telemetry
  analytics disabled

essential-traffic
  feedback disabled
  transcript share disabled
  automatic upload disabled
  local export still allowed
```

示例：

```ts
import { describe, expect, test } from "bun:test";
import { canSubmitDiagnostics } from "src/support/diagnostics/privacyGate.js";

describe("canSubmitDiagnostics", () => {
  test("blocks upload in essential traffic mode", () => {
    const result = canSubmitDiagnostics({
      privacyLevel: "essential-traffic",
      mode: "upload",
    });

    expect(result.allowed).toBe(false);
  });

  test("allows local export in essential traffic mode", () => {
    const result = canSubmitDiagnostics({
      privacyLevel: "essential-traffic",
      mode: "local-export",
    });

    expect(result.allowed).toBe(true);
  });
});
```

本地导出和网络上传必须分开判断。

否则会误伤用户自助排查能力。

---

## 68.49 支持命令的 UI 设计

终端 UI 里不要做复杂表单。

建议 `/diagnostics export` 使用简单多步：

```text
Step 1
  Show what will be included by default.

Step 2
  Ask optional full transcript.

Step 3
  Ask optional full debug log.

Step 4
  Write local bundle.

Step 5
  Show path and next action.
```

输出示例：

```text
Diagnostic bundle created:
  ~/.claude/diagnostics/claude-diagnostics-2026-05-27T12-34-56Z-a1b2c3d4.zip

Included:
  environment metadata
  settings summary
  recent errors
  debug tail
  transcript summary
  performance snapshot

Excluded:
  full transcript
  raw environment values
  secrets
```

这比一大段说明更可执行。

---

## 68.50 诊断包不要自动修复

诊断包只负责观察和导出。

不要在导出时顺手修配置、清缓存、重写 settings。

原因：

```text
1. 支持包应该可重复。
2. 采集过程不应改变问题现场。
3. 用户正在报问题时，不希望工具偷偷修改环境。
```

修复建议属于 `/doctor` 或明确的 repair command。

支持包可以引用 doctor 建议，但不要执行建议。

---

## 68.51 支持侧阅读顺序

生成诊断包后，支持侧应该有固定阅读顺序。

建议：

```text
1. manifest.json
2. redaction-report.json
3. environment.json
4. errors.json
5. settings.json
6. doctor.json
7. mcp.json / lsp.json / plugin.json
8. perf.md
9. transcript-summary.jsonl
10. debug-tail.txt
```

这个顺序对应：

```text
what is this package
is it safe
where did it run
what failed
what config shape
what subsystem
whether performance-related
what user was doing
what happened right before failure
```

把阅读顺序写进支持文档，能显著减少来回问用户。

---

## 68.52 公开 Issue 的隐私红线

公开 issue 中默认不能出现：

```text
full transcript
full prompt
full tool output
full local path
private repo URL with token
auth header
API key
cloud credential
customer name
private file content
internal endpoint path
```

允许出现：

```text
CLI version
platform
terminal
install kind
sanitized provider kind
model label
sanitized error class
short stack frame names
reproduction steps
diagnostic bundle id
```

如果用户坚持贴日志，CLI 应提示：

```text
Review the log before posting publicly.
Use summary mode when possible.
```

工具不能阻止用户手动复制，但可以把默认路径设计得安全。

---

## 68.53 支持包 Schema 版本

诊断包必须有 schemaVersion。

否则支持侧无法处理历史包。

```ts
type DiagnosticSchemaVersion = 1;
```

将来变更：

```text
v1
  manifest + environment + errors + summary

v2
  adds subsystem snapshots

v3
  adds signed manifest
```

读取端要做到：

```text
unknown newer schema
  显示 warning，但尽量读取已知字段。

older schema
  通过 migration 转成内部模型。
```

不要让支持工具只能读当前版本。

---

## 68.54 支持包签名是否需要

本地诊断包不是安全证明。

它是排查材料。

因此初期不需要复杂签名。

但可以做两件轻量事情：

```text
1. 每个文件记录 sha256。
2. manifest 记录生成 CLI 版本和 bundle id。
```

如果未来有企业支持场景，再考虑：

```text
signed manifest
managed org public key
upload receipt
tamper-evident audit chain
```

不要一开始就把支持包做成沉重的合规系统。

先把可复现和脱敏做好。

---

## 68.55 支持包与 release 的关系

第 67 章已经建立 release manifest。

第 68 章要把 release 信息放进诊断包：

```text
version
build time
build commit
release channel
install method
rollback pin
native binary path kind
```

支持人员看到问题时，第一问通常是：

```text
你运行的到底是哪一个版本？
```

诊断包应该直接回答。

如果当前版本落后于最新版本，可以只记录：

```text
update status: outdated
latest known version: x.y.z
```

不要在导出诊断包时自动更新。

---

## 68.56 Provider 信息

多 Provider 兼容层会增加支持复杂度。

诊断包应该记录：

```text
provider kind
model env override present
base URL host
stream adapter kind
gateway detected kind
```

不要记录：

```text
API key
full auth header
full request body
full response body
```

`src/services/api/logging.ts` 已经有 gateway 检测思路。

支持包可以复用其中的 provider metadata，但要先过滤字段。

特别注意：

```text
ANTHROPIC_BASE_URL can contain private host/path
```

默认只保留 hostname。

---

## 68.57 支持包不该包含源码

Claude Code 是 coding agent，很多错误发生在用户源码上下文里。

但支持包默认不应包含源码。

原因：

```text
1. 代码属于用户或公司。
2. 源码体积大。
3. 脱敏很难保证。
4. 多数框架问题靠路径、诊断、工具摘要就够定位。
```

如果确实需要最小代码复现，应该让用户创建单独 fixture。

CLI 可以生成模板：

```text
repro/
  README.md
  minimal-file.ts
  command.txt
```

但不要自动复制项目源码。

---

## 68.58 最小复现生成器

建议未来新增：

```text
/repro init
```

它只生成骨架：

```text
claude-repro/
  README.md
  environment.json
  steps.md
  expected.txt
  actual.txt
```

`steps.md` 模板：

```md
# Reproduction Steps

1. Start from a clean checkout.
2. Run:

```bash
bun install
bun run typecheck
```

3. Start Claude Code with:

```bash
bun run dev
```

4. Enter this prompt:

```text
<replace with minimal prompt>
```
```

注意这里要让用户自己填最小 prompt。

不要自动把完整历史 prompt 写进去。

---

## 68.59 失败提示要可执行

支持链路里所有失败提示都要包含下一步。

差的提示：

```text
Failed to submit feedback.
```

好的提示：

```text
Could not submit feedback because nonessential traffic is disabled.
Unset CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC or export a local diagnostic bundle instead.
```

差的提示：

```text
Session log not found.
```

好的提示：

```text
Session log not found for current session.
Send at least one message, then retry /share or /diagnostics export.
```

当前 `/share` 在 log 不存在时已经会提示 session 和 expected path。

后续支持包也应保持这种具体程度。

---

## 68.60 何时写 stderr

stderr 适合：

```text
fatal startup error
render error boundary
debug-to-stderr mode
non-interactive command failure
```

不适合：

```text
normal feedback progress
privacy warning
large diagnostic report
```

Ink UI 中，stderr 可能打乱布局。

所以普通错误尽量进入 UI state，真正越过 UI 层的异常才写 stderr。

`SentryErrorBoundary` 写 stderr 是合理的，因为这时 UI 层本身已经不可信。

---

## 68.61 支持链路的模块边界

建议新增模块结构：

```text
src/support/
  diagnostics/
    buildBundle.ts
    collectors/
      environment.ts
      settings.ts
      errors.ts
      debugTail.ts
      transcriptSummary.ts
      perf.ts
      mcp.ts
      lsp.ts
      plugins.ts
    manifest.ts
    limits.ts
    privacyGate.ts
  issue/
    buildIssueBody.ts
    template.ts
  repro/
    initRepro.ts

src/utils/redaction/
  redactText.ts
  redactJson.ts
  redactPath.ts
  rules.ts
  report.ts
```

命令层：

```text
src/commands/diagnostics/
src/commands/repro/
```

这样 `/feedback`、`/share`、`/issue` 不需要互相 import 组件里的 helper。

共享逻辑应该在 `src/support` 和 `src/utils/redaction`。

---

## 68.62 第一阶段落地计划

建议第一阶段只做本地导出，不做上传。

范围：

```text
1. 抽出 redaction 模块。
2. 让 /share 和 /feedback 复用基础 redaction。
3. 新增 diagnostic bundle builder。
4. 新增本地导出命令。
5. 生成 manifest、environment、errors、debug-tail、transcript-summary。
6. 加测试。
```

不做：

```text
automatic upload
signed bundle
full transcript upload
admin dashboard
support portal
```

这样 diff 小，风险可控。

---

## 68.63 第二阶段落地计划

第二阶段接入更完整支持体验：

```text
1. /feedback 可附加 diagnostic bundle。
2. /issue 引用 diagnostic bundle id。
3. /perf-issue 复用 support perf collector。
4. /doctor 可以提示 export diagnostics。
5. support-side reader 脚本读取 manifest 并生成摘要。
```

支持侧 reader 可以是：

```bash
bun run scripts/read-diagnostics.ts /path/to/bundle
```

输出：

```text
Bundle: diag_...
Version: ...
Platform: ...
Suspected areas: mcp, settings
Recent errors: 3
Transcript summary entries: 8
Redactions applied: 11
```

先让维护者能快速读包，再考虑更复杂的 UI。

---

## 68.64 第三阶段落地计划

第三阶段才考虑企业和远程支持：

```text
managed policy controls
organization upload endpoint
bundle retention policy
audit receipt
admin-side diagnostic search
remote session support correlation
```

这和第 69 章会衔接。

企业级支持不是单机 CLI 问题，它涉及组织策略、审计和集中化管理。

本章先把单机支持链路打牢。

---

## 68.65 代码 Review 清单

实现支持链路时，每个 PR 都要过这个清单：

```text
Data
  是否新增了可收集字段？
  字段属于哪个 data class？
  是否有默认排除 user content？

Privacy
  是否遵守 essential-traffic？
  是否有用户确认？
  是否有 redaction report？

Reliability
  collector 失败是否不影响整体？
  是否有 size cap？
  是否有 schemaVersion？

Testing
  是否覆盖脱敏？
  是否覆盖路径？
  是否覆盖 oversized log？
  是否覆盖隐私开关？

UX
  用户是否知道包含什么？
  失败提示是否可执行？
  输出路径是否明确？
```

这个清单比“看起来没问题”更可靠。

---

## 68.66 和官方 Claude Code 的差距

当前项目已经有：

```text
debug log
error log
feedback dialog
transcript share
issue command
perf snapshot
privacy level
error boundary
MCP error logging
diagnostic tracking
```

离更接近官方体验，还差：

```text
统一 redaction 模块
统一 diagnostic bundle
导出前 preview
本地支持包 reader
feedback 附加 bundle
issue 引用 bundle id
更严格默认分享策略
collector failure manifest
schema version migration
支持侧 repro fixture 规范
```

也就是说，不是缺一个大功能。

缺的是把已有碎片收束成一条稳定、可解释、可测试的支持链路。

---

## 68.67 本章最终目标架构

最终目标：

```text
User sees problem
  -> /doctor or automatic hint
  -> /diagnostics export
  -> local bundle generated
  -> user reviews or attaches to /feedback
  -> feedback returns id
  -> /issue creates safe public summary with feedback id
  -> maintainer reads bundle
  -> maintainer creates repro test
  -> fix lands with regression test
```

这条链路把“用户说坏了”变成“维护者能修”。

这才是生产级 CLI 的支持体验。

---

## 68.68 本章验收标准

如果要把本章内容落地成代码，建议验收标准是：

```text
1. /diagnostics export 可以生成本地支持包。
2. 默认包不包含 full transcript。
3. 默认包不包含 raw env。
4. 默认包不包含 secrets。
5. manifest 记录 schemaVersion、version、platform、files。
6. redaction-report 记录每个文件的脱敏命中。
7. collector 失败会进入 manifest，不会整体崩溃。
8. essential-traffic 禁止上传，但允许本地导出。
9. /issue 只包含安全摘要。
10. bun test 覆盖 redaction、bundle、privacy gate、issue body。
```

验证命令：

```bash
bun test src/utils/redaction
bun test src/support
bun test src/commands/share
bun test src/commands/issue
bun test src/commands/perf-issue
bun run typecheck
```

---

## 68.69 本章总结

第 68 章补的是“出了问题之后怎么办”。

当前仓库已经有很多关键能力：

- debug 日志。
- error 日志。
- error boundary。
- feedback 提交。
- transcript 分享。
- GitHub issue。
- performance snapshot。
- privacy level。

下一步不是再加一个孤立命令，而是统一：

- 数据分级。
- 脱敏规则。
- 诊断包格式。
- 用户确认流程。
- 支持侧复现规范。

当这些能力连成闭环后，Claude Code 才真正从“能跑的 CLI”进入“可维护、可支持、可规模化分发的 CLI”。

第 69 章可以继续补企业与团队运维平面：Managed Settings、组织策略、Fleet Rollout、审计导出、支持包集中管理、管理员诊断与团队级安全边界。
