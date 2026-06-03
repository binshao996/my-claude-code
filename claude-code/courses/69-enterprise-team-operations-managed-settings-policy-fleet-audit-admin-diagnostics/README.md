# 第 69 章：企业与团队运维平面：Managed Settings、组织策略、Fleet Rollout、审计导出、集中支持包、管理员诊断与团队安全边界

第 68 章补了生产级可观测性与支持链路。

这解决的是“单个用户出问题时如何可诊断、可脱敏、可复现”。

本章继续往上走：如果不是一个用户，而是一整个团队、一个企业、几十台机器、多个远程环境在使用 Claude Code，怎么管？

一个接近官方 Claude Code 的 CLI，企业与团队场景至少要回答：

- 管理员如何下发统一配置？
- 用户本地设置和组织策略谁优先？
- 危险环境变量如何被拦截？
- 远程设置失败时是否能继续工作？
- 策略变更如何热更新？
- 插件、Agent、Hook、MCP 是否能被组织治理？
- 远程会话如何认证、续期、断线恢复？
- 团队记忆如何避免同步密钥？
- 管理员如何收到用户的升级或额度申请？
- 支持包如何集中登记和审计？
- 大规模 rollout 如何分批、回滚、冻结？

当前仓库已经有这些相关实现：

- `src/services/remoteManagedSettings/index.ts`
- `src/services/remoteManagedSettings/syncCache.ts`
- `src/services/remoteManagedSettings/syncCacheState.ts`
- `src/services/remoteManagedSettings/securityCheck.tsx`
- `src/components/ManagedSettingsSecurityDialog/utils.ts`
- `src/utils/settings/mdm/settings.ts`
- `src/utils/settings/mdm/rawRead.ts`
- `src/utils/settings/mdm/constants.ts`
- `src/utils/settings/managedPath.ts`
- `src/utils/managedEnv.ts`
- `src/utils/managedEnvConstants.ts`
- `src/services/policyLimits/index.ts`
- `src/services/policyLimits/types.ts`
- `src/services/settingsSync/index.ts`
- `src/utils/plugins/pluginPolicy.ts`
- `src/utils/plugins/managedPlugins.ts`
- `src/utils/settings/pluginOnlyPolicy.ts`
- `src/utils/settings/changeDetector.ts`
- `src/services/teamMemorySync/secretScanner.ts`
- `src/services/teamMemorySync/teamMemSecretGuard.ts`
- `src/services/api/adminRequests.ts`
- `src/utils/remoteTriggerAudit.ts`
- `src/bridge/trustedDevice.ts`
- `src/bridge/jwtUtils.ts`
- `packages/remote-control-server/src/config.ts`
- `packages/remote-control-server/src/auth/middleware.ts`
- `packages/remote-control-server/src/routes/v1/environments.ts`
- `packages/remote-control-server/src/routes/v2/worker-events.ts`
- `docs/telemetry-remote-config-audit.md`
- `docs/features/remote-control-self-hosting.md`

这些模块已经把企业运维平面的骨架搭起来了。

本章要做的是把它们整理成一套可落地的控制平面。

---

## 69.1 企业运维平面是什么

企业运维平面不是一个单独功能。

它是一组控制面：

```text
admin policy
  管理员声明允许什么、禁止什么、强制什么。

settings distribution
  把策略可靠下发到 CLI、桌面端、远程环境和自托管后端。

runtime enforcement
  CLI 在启动、热更新、工具调用、插件加载、远程会话中执行策略。

audit trail
  记录关键动作、失败、用户确认和远程触发。

support operations
  把单机诊断包、反馈 id、issue、远程 session 关联起来。

fleet rollout
  按组织、团队、用户、设备或环境分批发布策略和版本。
```

可以把它理解成：

```text
individual CLI
  解决单人效率

team CLI
  解决多人一致性

enterprise CLI
  解决集中治理、审计、升级、支持和安全边界
```

如果没有企业运维平面，Claude Code 在团队中会出现这些问题：

- 每个人 Provider 不一致。
- 每个人权限规则不同。
- 某些人安装了未审核插件。
- 远程会话权限不可追踪。
- 敏感环境变量从项目设置里被注入。
- 管理员无法知道某项策略是否生效。
- 支持侧拿不到统一诊断上下文。

---

## 69.2 当前已有能力分层

当前仓库的企业能力大致分为六层：

```text
Managed Settings
  remote managed settings
  MDM / registry / managed file
  managed-settings.d drop-in

Policy Limits
  organization restrictions from API
  feature enable / disable
  fail-open with essential-traffic exception

Settings Sync
  user settings and memory sync
  CCR download path
  file size cap

Customization Governance
  plugin policy
  strict plugin-only customization
  managed plugin lock

Remote Operations
  RCS
  bridge sessions
  trusted device token
  worker JWT
  environment registration

Audit and Support
  remote trigger audit
  diagnostics no-PII logs
  admin requests
  future centralized diagnostic bundle registry
```

这已经不只是本地 CLI。

它开始具备“组织可控”的形态。

---

## 69.3 控制面与数据面的边界

企业系统最容易混乱的是控制面和数据面混在一起。

建议边界：

```text
Control Plane
  settings
  policy
  rollout
  auth
  audit metadata
  environment registration
  support bundle metadata

Data Plane
  model requests
  tool execution
  transcript
  file edits
  shell output
  MCP payload
```

管理员应该能控制：

```text
Provider routing
allowed tools
MCP server policy
plugin marketplace
remote sessions
telemetry mode
diagnostic export policy
update channel
```

管理员不应该默认看到：

```text
full prompt
full transcript
file content
tool output
secrets
private local paths
```

企业平面的核心原则：

> 管理员控制行为边界，不默认接管用户内容。

---

## 69.4 Managed Settings 的优先级

当前 MDM 注释里已经写出关键规则：

```text
remote
  -> HKLM / plist
  -> managed-settings.json
  -> HKCU
```

这是 policy settings 的“first source wins”。

含义：

```text
remote managed settings 存在
  使用远程策略。

否则有设备级 MDM
  使用设备级策略。

否则有 managed-settings.json 或 drop-in
  使用本机文件策略。

否则 Windows HKCU
  使用用户级策略。
```

这个优先级的设计很重要。

它避免了“多个管理来源互相 merge 后产生意外组合”的问题。

组织级策略应该可预测：

```text
highest-priority source owns the policy layer
```

不要把多个策略来源随意深合并。

---

## 69.5 Remote Managed Settings

`src/services/remoteManagedSettings/index.ts` 负责远程管理设置。

它的设计要点：

```text
endpoint
  /api/claude_code/settings

auth
  API key or OAuth

eligibility
  first-party provider
  first-party base URL
  Console users with API key
  OAuth Enterprise / Team
  externally injected OAuth tokens let API decide

caching
  local file cache
  checksum as If-None-Match
  304 uses cached settings

polling
  every 1 hour

failure mode
  stale cache if available
  otherwise fail open
```

这套行为是企业 CLI 的基本盘。

企业策略服务出问题时，CLI 不能整体不可用。

但已经缓存过的策略也不能轻易丢失。

所以正确策略是：

```text
remote fetch success
  apply new settings

remote unchanged
  use cache

remote failure with cache
  use stale cache

remote failure without cache
  fail open
```

---

## 69.6 Remote Settings Cache

当前 cache 文件名：

```text
remote-settings.json
```

位置在 Claude config home 目录下。

`syncCacheState.ts` 特意拆成 leaf module，避免 settings/auth 循环依赖。

这件事在企业启动路径里很关键。

远程策略往往要在 CLI 初始化早期加载：

```text
startup
  -> apply user / flag env
  -> determine remote settings eligibility
  -> read remote cache
  -> merge policy settings
  -> initialize tools / plugins / MCP
```

如果这里形成循环依赖，会导致：

- 启动变慢。
- settings cache 被提前污染。
- 某些 Commander 定义期读取到错误配置。
- headless 模式和交互模式行为不同。

所以 remote settings 相关模块要保持轻依赖。

---

## 69.7 Checksum 与 304

当前远程设置使用 checksum：

```ts
export function computeChecksumFromSettings(settings: SettingsJson): string {
  const sorted = sortKeysDeep(settings);
  const normalized = jsonStringify(sorted);
  const hash = createHash("sha256").update(normalized).digest("hex");
  return `sha256:${hash}`;
}
```

设计目标：

```text
same settings
  same checksum

same checksum sent as If-None-Match
  server can return 304

304
  local cache remains valid
```

这里有一个细节：key 必须递归排序。

否则相同配置因为 JSON key 顺序不同，会产生不同 hash。

企业配置下发必须避免无意义变更。

无意义变更会造成：

- 热更新噪音。
- 用户安全弹窗重复出现。
- 配置审计难以阅读。
- 大规模 rollout 中误判策略已变更。

---

## 69.8 安全检查弹窗

`src/services/remoteManagedSettings/securityCheck.tsx` 会在远程设置包含危险项且危险项变化时弹窗。

危险设置由 `extractDangerousSettings()` 提取：

```text
dangerous shell settings
dangerous env vars
hooks
```

危险 env 的判断逻辑：

```text
env key not in SAFE_ENV_VARS
  -> dangerous
```

弹窗只显示名称，不显示值。

这是正确设计。

原因：

- 值可能包含密钥。
- 值可能包含内网地址。
- 值可能包含用户路径。
- 用户只需要知道“哪些能力被管理员下发”。

安全弹窗的职责不是审计全部配置，而是拦截会改变执行边界的配置。

---

## 69.9 危险设置类型

当前 `DANGEROUS_SHELL_SETTINGS` 包含：

```text
apiKeyHelper
awsAuthRefresh
awsCredentialExport
gcpAuthRefresh
otelHeadersHelper
statusLine
```

这些字段危险的原因是：

```text
they can execute shell code
they can produce credentials
they can redirect observability headers
they can alter terminal-visible behavior
```

Hooks 也被视为危险。

因为 hooks 本质上是在特定事件点执行外部逻辑。

企业策略可以下发 hooks，但用户应该知道这个边界变化。

---

## 69.10 Safe Env 与 Trusted Sources

`src/utils/managedEnv.ts` 将 setting sources 分为信任源和项目源。

可信源：

```text
userSettings
flagSettings
policySettings
```

项目源：

```text
projectSettings
localSettings
```

启动前，可信源可以应用全部 env。

项目源只能应用 `SAFE_ENV_VARS` 中的安全变量。

原因很直接：

```text
project settings live inside the repository
repository content can be malicious
project settings must not redirect provider or auth before trust
```

这正是 coding agent 需要的边界。

一个仓库不应该通过 `.claude/settings.json` 偷偷改：

```text
base URL
auth token
proxy
TLS behavior
provider routing
credential helper
```

---

## 69.11 Host Managed Provider

`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` 是一个关键边界。

当宿主环境拥有推理路由权时，settings-sourced env 不能覆盖 provider 相关变量。

当前代码会过滤 provider-managed env：

```text
provider selection
base URL
project / resource id
region
auth
model defaults
```

这适用于：

- Desktop host 启动 CLI 子进程。
- 企业 wrapper 统一注入 Provider。
- 远程环境由控制面决定推理路由。
- 自托管执行环境不允许用户覆盖模型网关。

企业平面要明确一条规则：

> Host-owned routing beats user-owned settings.

否则用户本地配置会破坏组织统一网关、审计和配额控制。

---

## 69.12 MDM 与本地托管设置

`src/utils/settings/mdm/settings.ts` 支持：

```text
macOS
  /Library/Managed Preferences/<user>/com.anthropic.claudecode.plist
  /Library/Managed Preferences/com.anthropic.claudecode.plist

Windows
  HKLM\SOFTWARE\Policies\ClaudeCode
  HKCU\SOFTWARE\Policies\ClaudeCode

Linux
  /etc/claude-code/managed-settings.json
```

托管文件路径由 `managedPath.ts` 决定：

```text
macOS
  /Library/Application Support/ClaudeCode

Windows
  C:\Program Files\ClaudeCode

Linux
  /etc/claude-code
```

还有 drop-in 目录：

```text
managed-settings.d/
```

用途：

```text
base managed-settings.json
  基础策略

managed-settings.d/*.json
  分片覆盖
  alphabetically merged
  later files win
```

这是 fleet rollout 很实用的机制。

管理员可以用多个小文件分批管理策略，而不是每次重写一个巨大 JSON。

---

## 69.13 MDM Raw Read

`rawRead.ts` 的设计很克制。

它只做：

```text
macOS
  plutil read plist as JSON

Windows
  reg query HKLM / HKCU

Linux
  no MDM equivalent
```

它避免重依赖。

原因是 MDM 读取会在启动早期触发。

启动早期的代码应该：

```text
minimal imports
bounded timeout
no settings dependency
no auth dependency
no UI dependency
```

当前超时：

```text
5000 ms
```

这很好。

企业策略读取不能无限阻塞启动。

---

## 69.14 MDM Poll 与热更新

`src/utils/settings/changeDetector.ts` 做了两类监听：

```text
file watch
  user/project/local/managed files

MDM poll
  registry/plist changes every 30 minutes
```

它还处理：

```text
write stabilization
internal writes
delete-and-recreate grace period
ConfigChange hooks
centralized settings cache reset
```

这套机制是企业热更新的基础。

策略变更不能只在下一次启动生效。

但热更新也不能粗暴：

```text
partial write
  wait for stability

internal write
  ignore to avoid feedback loop

blocking hook
  do not apply change

policy source changed
  reset cache once, fan out
```

这里最关键的是 centralized cache reset。

一次配置变化只应该触发一次重新读取，而不是每个 listener 都重读一遍。

---

## 69.15 Policy Limits

`src/services/policyLimits/index.ts` 是组织级限制服务。

它和 remote managed settings 很像：

```text
endpoint
  /api/claude_code/policy_limits

eligibility
  first-party provider
  first-party base URL
  API key users
  OAuth Team / Enterprise users

caching
  policy-limits.json
  checksum
  304 support

polling
  every 1 hour

failure
  stale cache if available
  otherwise fail open
```

返回 schema：

```ts
type PolicyLimitsResponse = {
  restrictions: Record<string, { allowed: boolean }>;
};
```

不存在的 policy 默认允许。

这符合 fail-open 设计。

但有一个例外。

---

## 69.16 Essential Traffic 下的 Fail Closed

当前 policy limits 对 `allow_product_feedback` 做了特殊处理：

```text
essential-traffic only
cache unavailable
allow_product_feedback
  -> false
```

这很重要。

普通企业策略可以 fail open，避免控制面故障影响用户工作。

但隐私或合规模式下，某些能力必须 fail closed。

建议把 policy 分成三类：

```ts
type PolicyFailureMode =
  | "fail_open"
  | "fail_closed_when_privacy_restricted"
  | "fail_closed_always";
```

默认：

```text
normal productivity policy
  fail_open

privacy-sensitive policy
  fail_closed_when_privacy_restricted

dangerous remote execution policy
  fail_closed_always
```

不要把所有策略都用同一个失败语义。

---

## 69.17 Policy Taxonomy

建议企业 policy 按领域分类：

```text
feedback
  allow_product_feedback

remote
  allow_remote_sessions
  allow_remote_triggers

customization
  allow_user_plugins
  strict_known_marketplaces
  strict_plugin_only_customization

tools
  allow_bash
  allow_web_fetch
  allow_mcp

privacy
  allow_transcript_share
  allow_diagnostic_upload
  force_essential_traffic

updates
  allowed_update_channel
  minimum_version
  maximum_version
```

每个 policy 都要声明：

```ts
type EnterprisePolicyDefinition = {
  key: string;
  description: string;
  defaultAllowed: boolean;
  failureMode: PolicyFailureMode;
  affects: Array<"cli" | "remote" | "plugins" | "support" | "telemetry">;
};
```

这样 UI、doctor、diagnostic bundle 和 admin console 都可以用同一份定义。

---

## 69.18 插件策略

当前仓库已有两层插件治理：

```text
isPluginBlockedByPolicy(pluginId)
getManagedPluginNames()
```

策略来源：

```text
policySettings.enabledPlugins
```

语义：

```text
plugin@marketplace: true
  managed allowed / enabled

plugin@marketplace: false
  policy blocked
```

被 policy blocked 的插件不能被用户安装或启用。

这正是企业插件治理的核心。

建议统一几个 chokepoint：

```text
install
enable
auto-enable from settings
marketplace browse
plugin update
plugin command invocation
```

如果只在 UI 里隐藏，不够。

真正的 enforce 必须在 install / enable / load 路径。

---

## 69.19 Strict Plugin-Only Customization

`strictPluginOnlyCustomization` 解决的是另一类问题：

> 用户或项目能不能通过本地文件自定义 Agent、Command、Hook 等表面？

当前逻辑：

```text
true
  lock all customization surfaces

array
  lock listed surfaces only

undefined
  no lock
```

允许绕过的 source：

```text
plugin
policySettings
built-in
builtin
bundled
```

这个策略适合企业环境：

```text
custom agents
custom commands
frontmatter hooks
workflow definitions
```

如果组织要求所有自定义能力必须来自审核插件，那么项目目录里的本地自定义就应该被跳过。

这能避免仓库提交恶意 Hook 或 Agent。

---

## 69.20 权限规则治理

`permissionValidation.ts` 已经包含大量规则验证。

企业平面要把权限规则视为 policy surface，而不是普通用户偏好。

权限规则至少分三类：

```text
org allow / deny / ask
  policySettings 管理员下发

team baseline
  project settings 或插件下发

user preference
  userSettings / localSettings
```

合并原则：

```text
deny wins over allow
policy deny cannot be overridden
policy allow can reduce prompts but must be scoped
whole-tool allow for secret-bearing tools must remain forbidden
```

权限规则必须继续保持可解释。

当一个工具被拦截时，用户应该知道：

```text
blocked by organization policy
blocked by project rule
requires approval
invalid rule ignored
```

---

## 69.21 Settings Sync 不是 Policy

`src/services/settingsSync/index.ts` 同步的是用户设置和 memory。

它不是企业策略。

当前同步内容：

```text
~/.claude/settings.json
~/.claude/CLAUDE.md
projects/<projectId>/.claude/settings.local.json
projects/<projectId>/CLAUDE.local.md
```

它的行为：

```text
interactive CLI
  upload changed local entries

CCR / remote mode
  download remote entries before plugin install
```

文件大小限制：

```text
500 KB per file
```

这和 Managed Settings 的区别：

```text
Settings Sync
  user convenience
  user-owned data
  can be skipped

Managed Settings
  admin policy
  organization-owned control
  higher precedence
```

不要把二者合并。

否则用户同步会意外覆盖管理员策略。

---

## 69.22 Settings Sync 的安全边界

Settings Sync 有几个正确做法：

```text
OAuth only
first-party only
feature gated
file size capped
changed entries only
project id from git remote hash
internal writes marked
settings and memory caches reset after apply
```

企业场景建议再补：

```text
sync allowlist
  管理员可禁用项目本地文件同步。

conflict report
  同步写入了哪些 key，哪些被跳过。

dry-run mode
  只显示将应用内容，不写磁盘。

admin policy override display
  明确告诉用户哪些同步设置被 policySettings 覆盖。
```

这些不需要一次做完。

但从模型上要把 user sync 和 policy enforcement 分清。

---

## 69.23 团队记忆与密钥扫描

`src/services/teamMemorySync/secretScanner.ts` 已经有客户端密钥扫描。

`teamMemSecretGuard.ts` 会在写入团队记忆路径前检查内容。

核心语义：

```text
team memory is shared
secrets must not leave machine
model cannot write secret-looking content into team memory
```

这是团队协作场景里非常重要的一层。

团队记忆不是个人草稿。

它应该遵守：

```text
no credentials
no private tokens
no customer secrets
no private key material
no temporary incident tokens
```

如果扫描命中，错误提示应该包含：

```text
detected label
why blocked
how to fix
```

但不要包含原始 secret。

---

## 69.24 Admin Requests

`src/services/api/adminRequests.ts` 已经支持用户向管理员发起请求。

当前类型：

```text
limit_increase
seat_upgrade
```

状态：

```text
pending
approved
dismissed
```

这说明 CLI 已经开始接入组织流程。

建议扩展思路：

```text
request remote session permission
request plugin approval
request higher model tier
request diagnostic upload approval
request tool policy exception
```

这些请求都应该有统一模型：

```ts
type AdminActionRequest = {
  id: string;
  type: string;
  requester: string;
  organizationId: string;
  status: "pending" | "approved" | "dismissed";
  createdAt: string;
  details: Record<string, unknown>;
};
```

用户不应该为了一个策略例外去找文档或线下沟通。

CLI 可以把“需要管理员处理”变成结构化请求。

---

## 69.25 Remote Control Server

`packages/remote-control-server` 是团队运维平面的另一半。

它提供：

```text
session management
message streaming
permission approval
environment registration
heartbeat and reconnect
API key auth
worker JWT auth
web UI
```

RCS 的配置包括：

```text
RCS_PORT
RCS_HOST
RCS_API_KEYS
RCS_BASE_URL
RCS_JWT_EXPIRES_IN
RCS_DISCONNECT_TIMEOUT
RCS_WS_IDLE_TIMEOUT
RCS_WS_KEEPALIVE_INTERVAL
```

这类后端适合企业自托管。

但要接近官方体验，还需要把它接入组织策略：

```text
which users can start remote sessions
which environments are registered
which permissions can be approved remotely
which sessions require elevated auth
how long session tokens live
where audit events are retained
```

RCS 不是单纯的“远程 UI”。

它是组织远程操作控制面。

---

## 69.26 RCS 认证模型

`auth/middleware.ts` 支持几类认证：

```text
Bearer token
API key
WebSocket subprotocol token
worker JWT
UUID fallback for no-login web routes
```

关键设计：

```text
WebSocket auth token should not be in query string.
```

当前实现使用 `Sec-WebSocket-Protocol` 传递编码 token。

这是好的。

query string 会被代理、日志和浏览器历史更容易记录。

企业环境中，认证材料必须避免进入：

```text
URL
access log
reverse proxy metrics labels
browser history
issue report
diagnostic bundle
```

---

## 69.27 Worker JWT

RCS 的 worker events 入口支持 worker JWT。

`sessionIngressAuth` 会校验：

```text
token valid
session_id matches route param
```

这点很关键。

否则一个 worker token 可能写入其他 session。

企业远程执行应该遵守：

```text
token scoped to session
token expires
token refresh is explicit
event ingestion checks session existence
delivery tracking is idempotent
```

当前 `worker-events.ts` 对不存在 session 返回 404，并对 event 写入做 publish。

这已经是合理基础。

---

## 69.28 Trusted Device

`src/bridge/trustedDevice.ts` 实现了 trusted device token。

设计要点：

```text
enroll during fresh login
store token in secure storage
send only when gate enabled
env token can override for enterprise wrapper
skip enrollment in essential-traffic mode
best effort, does not block login
```

企业场景里，远程会话通常比普通本地会话更敏感。

它可能涉及：

```text
remote permission approval
long-running session
browser-side operator
worker process
multiple devices
```

trusted device 是提升远程会话认证强度的方式之一。

但它不能替代组织策略。

正确组合：

```text
org policy allows remote
user authenticated
device trusted
session token scoped
permission approval audited
```

---

## 69.29 Token Refresh

`src/bridge/jwtUtils.ts` 提供 token refresh scheduler。

它会：

```text
decode JWT exp
refresh before expiry
retry missing OAuth token
cap consecutive failures
cancel stale timers by generation
schedule follow-up refresh
```

长连接远程会话必须有这个能力。

否则企业环境中会出现：

- 一小时后远程 session 静默失效。
- UI 还显示连接，worker 已无权限。
- 用户批准了权限请求但事件写入失败。
- 支持侧无法判断是网络断开还是 token 过期。

建议诊断包和 admin diagnostics 记录：

```text
token refresh scheduled
last refresh success time
consecutive refresh failures
session expiry time
```

不要记录 token 本身。

---

## 69.30 Remote Trigger Audit

`src/utils/remoteTriggerAudit.ts` 已经实现了本地 JSONL 审计：

```text
.claude/remote-trigger-audit.jsonl
```

记录字段：

```ts
type RemoteTriggerAuditRecord = {
  auditId: string;
  action: string;
  triggerId?: string;
  ok: boolean;
  status?: number;
  error?: string;
  createdAt: number;
};
```

读取时最多返回：

```text
200 records
```

这是很好的最小审计模型。

企业版可以继续扩展：

```text
actor
source
environment id
session id
policy version
decision
duration
failure category
```

但不要把 prompt 或 tool output 塞进 audit。

Audit 是行为记录，不是内容备份。

---

## 69.31 审计事件分类

建议企业审计事件分成：

```text
policy
  policy fetched
  policy changed
  policy rejected by user
  policy source changed

remote
  environment registered
  session started
  session attached
  permission approved
  permission rejected
  interrupt sent
  session archived

customization
  plugin installed
  plugin blocked by policy
  agent skipped by plugin-only policy
  hook blocked

support
  diagnostic bundle exported
  diagnostic bundle uploaded
  feedback submitted
  issue created

auth
  trusted device enrolled
  token refresh failed
  admin request created
```

每条事件最少字段：

```ts
type AuditEvent = {
  id: string;
  type: string;
  createdAt: string;
  actor?: string;
  sessionId?: string;
  environmentId?: string;
  policyVersion?: string;
  outcome: "ok" | "failed" | "blocked";
  reason?: string;
};
```

禁止字段：

```text
raw token
raw prompt
raw tool output
raw settings values
full local path
```

---

## 69.32 Fleet Rollout

Fleet rollout 是组织级发布策略。

它不是简单“发新版”。

它至少要控制：

```text
version
channel
feature flags
managed settings
policy limits
plugin marketplace
remote session availability
diagnostic upload availability
```

建议 rollout 分层：

```text
ring 0
  internal maintainers

ring 1
  small pilot team

ring 2
  selected projects

ring 3
  whole organization

ring 4
  default for future users
```

每个 ring 都要有：

```text
targeting rule
start time
success metrics
abort conditions
rollback target
support owner
```

没有 rollback target 的 rollout 不应该开始。

---

## 69.33 Rollout Manifest

建议企业策略下发一份 rollout manifest。

```ts
type FleetRolloutManifest = {
  schemaVersion: 1;
  rolloutId: string;
  createdAt: string;
  channel: "stable" | "beta" | "internal";
  target: {
    orgIds?: string[];
    teamIds?: string[];
    userIds?: string[];
    deviceGroups?: string[];
  };
  constraints: {
    minVersion?: string;
    maxVersion?: string;
    requiredFeatures?: string[];
    blockedFeatures?: string[];
  };
  rollback: {
    previousRolloutId?: string;
    pinnedVersion?: string;
    disableFeatures?: string[];
  };
};
```

这个 manifest 可以不直接存在于当前仓库。

但 release、remote settings、policy limits、RCS 都应该能被它解释。

否则每个系统都有自己的 rollout 语义，会很难排查。

---

## 69.34 版本与策略的关系

策略不能假设所有客户端都是最新。

企业环境里常见：

```text
some users on stable
some users pinned
some remote workers updated first
some desktop hosts lag behind
some plugin cache old
```

因此策略必须声明兼容范围：

```text
requires cli >= x.y.z
ignored by cli < x.y.z
fallback behavior
```

CLI 收到未知策略 key 时：

```text
unknown policy
  ignore by default
  record warning in diagnostics
```

但如果策略是安全关键，服务端不能下发给不支持的客户端。

这属于 rollout 系统的职责。

---

## 69.35 集中支持包管理

第 68 章设计的是本地诊断包。

企业平面要补的是集中登记。

建议模型：

```text
local diagnostic bundle
  generated by CLI

bundle registration
  uploads manifest and redaction report metadata

bundle upload
  optional, policy-controlled, user-confirmed

admin console
  shows bundle id, owner, session, version, redaction status
```

集中平台不应该默认拿到完整包。

可以先登记 metadata：

```ts
type DiagnosticBundleRegistration = {
  bundleId: string;
  userId?: string;
  orgId?: string;
  sessionId: string;
  cliVersion: string;
  platform: string;
  createdAt: string;
  redactionSummary: Record<string, number>;
  includedFiles: string[];
  fullTranscriptIncluded: boolean;
};
```

管理员看到 metadata 后，再决定是否请用户上传完整包。

---

## 69.36 管理员诊断视图

管理员诊断不等于用户诊断。

用户诊断关注：

```text
why my CLI failed
```

管理员诊断关注：

```text
which policy applies
which source won
which users affected
which version they run
which remote environment failed
which rollout ring they belong to
```

建议新增 admin diagnostics 输出：

```text
policy source
policy checksum
policy fetched at
policy cache age
policy restrictions count
managed plugins count
remote settings dangerous fields count
settings sync status
RCS environment id
trusted device status
rollout ring
```

这些信息可以进入第 68 章的 diagnostic bundle，但要按安全分级过滤。

---

## 69.37 `/status` 与 `/doctor` 的企业扩展

第 66 章已经讲过 `/status` 和 `/doctor`。

企业扩展建议：

```text
/status
  show policy source
  show remote managed settings state
  show policy limits state
  show remote session allowed or blocked
  show plugin governance mode

/doctor
  diagnose stale policy cache
  diagnose invalid managed settings
  diagnose dangerous settings pending approval
  diagnose remote settings fetch failure
  diagnose RCS auth failure
  diagnose settings sync conflict
```

输出示例：

```text
Enterprise Policy
  Source: remote managed settings
  Cache: valid, fetched 12m ago
  Restrictions: 3
  Plugin governance: strict marketplaces
  Remote sessions: allowed
```

不要把策略原始值直接展示出来。

展示来源、状态、计数和原因就够。

---

## 69.38 遥测与远程配置审计

`docs/telemetry-remote-config-audit.md` 已经对遥测和远程配置做过梳理。

企业平面要延续那里的边界：

```text
telemetry
  product events and metrics

remote config
  feature flags and dynamic settings

managed settings
  admin-controlled policy

settings sync
  user-owned convenience sync

diagnostics
  user-confirmed support material
```

这些通道不能混。

尤其不能用 telemetry 通道偷带诊断内容。

如果需要支持材料，走诊断包和用户确认。

如果需要产品指标，走事件或 metrics，并遵守 privacy level。

---

## 69.39 Privacy Level 与组织策略

`src/utils/privacyLevel.ts` 提供：

```text
default
no-telemetry
essential-traffic
```

组织策略可以收紧 privacy level。

但用户设置不应该放宽组织策略。

建议合并规则：

```text
effectivePrivacyLevel =
  most restrictive of:
    organization policy
    managed settings
    environment variables
    user settings
```

如果组织要求 essential traffic：

```text
feedback upload disabled
diagnostic upload disabled
automatic remote config optional
local diagnostic export allowed
model traffic still allowed
```

这里要区分“必要业务流量”和“非必要辅助流量”。

不要因为 essential traffic 禁掉本地导出。

---

## 69.40 策略源可解释性

企业用户经常问：

> 为什么这个设置改不动？

CLI 必须能回答。

建议每个 effective setting 都能追踪 source：

```ts
type EffectiveSetting<T> = {
  value: T;
  source:
    | "remotePolicy"
    | "mdm"
    | "managedFile"
    | "user"
    | "project"
    | "local"
    | "flag"
    | "default";
  locked: boolean;
};
```

UI 可以展示：

```text
Provider routing is managed by your organization.
Source: remote managed settings
```

不要只显示“permission denied”。

企业策略越强，解释越重要。

---

## 69.41 配置冲突处理

冲突常见于：

```text
policy disables plugin, user enables plugin
policy forces provider, user sets different provider
policy requires plugin-only, project defines hook
policy disables feedback, user runs /feedback
policy blocks remote, user starts bridge
```

建议统一冲突结果：

```ts
type PolicyConflict = {
  surface: string;
  requestedBy: "user" | "project" | "plugin" | "remote";
  blockedBy: "policySettings" | "policyLimits" | "host";
  reason: string;
  userMessage: string;
};
```

这样：

- UI 可展示。
- debug log 可记录。
- diagnostic bundle 可汇总。
- 测试可断言。

---

## 69.42 远程会话策略

远程会话应有独立 policy。

建议最少：

```text
allow_remote_sessions
allow_remote_permission_approval
allow_remote_file_edit
allow_remote_bash
allow_remote_mcp
require_trusted_device
max_remote_session_duration
max_idle_duration
```

这些 policy 不能只在 Web UI 控制。

CLI worker、bridge client、RCS server 都要执行相同约束。

否则攻击面会绕过 UI：

```text
direct HTTP call
stale worker
old CLI
replayed session token
```

策略执行点应该是多层的：

```text
CLI
  don't start disallowed remote mode

RCS
  reject disallowed session actions

Worker
  refuse tool categories not allowed remotely

Permission pipeline
  mark remote approvals separately
```

---

## 69.43 远程权限审计

第 60 章已经讲过远程权限审批。

企业平面要把它接进审计：

```text
who approved
what tool
what pattern
which session
which environment
from which device
policy mode
decision time
```

不要记录：

```text
full command if it contains secrets
full file content
tool output
auth headers
```

对 Bash 类工具，建议审计中保存：

```text
command category
sanitized command preview
permission rule matched
hash of full command
```

这样支持侧可以关联问题，又不默认泄露命令全文。

---

## 69.44 企业 Kill Switch

企业控制面需要紧急开关。

典型 kill switch：

```text
disable remote sessions
disable plugin install
disable untrusted marketplaces
disable feedback upload
disable transcript share
disable dangerous hooks
disable specific MCP server
force model downgrade
pin max version
```

Kill switch 必须满足：

```text
fast propagation
cache aware
visible in status
audited
reversible
tested
```

不要把 kill switch 设计成只能等下一次版本发布。

它应该通过 policy limits 或 remote managed settings 下发。

---

## 69.45 Admin Console 的最小模型

如果要做企业管理 UI，最小模型不是“漂亮 dashboard”。

最小模型是：

```text
Policies
  查看和修改组织策略

Rollouts
  查看当前 ring 和版本

Environments
  注册的远程环境、心跳、版本

Sessions
  远程 session、状态、审批记录

Diagnostics
  支持包 metadata、反馈 id、issue link

Requests
  用户发起的 admin requests

Audit
  策略、远程、支持、插件事件
```

先做这些信息结构，再做视觉优化。

---

## 69.46 RCS 与 Admin Console 的关系

RCS 当前更像远程会话后端。

Admin Console 是组织治理后端。

两者可以共用：

```text
environment registry
session store
event stream
auth middleware
audit sink
diagnostic metadata
```

但职责不同：

```text
RCS
  real-time control and streaming

Admin Console
  policy, rollout, audit, support operations
```

不要把所有企业功能都塞进 RCS。

RCS 可以成为其中一个数据源。

---

## 69.47 支持包集中管理流程

建议流程：

```text
user hits problem
  -> /diagnostics export
  -> local bundle created
  -> user submits /feedback
  -> bundle metadata registered
  -> admin/support sees feedback id and bundle id
  -> support requests full bundle if needed
  -> user confirms upload
  -> support reads bundle
  -> repro test created
```

管理员看到的默认信息：

```text
bundle id
feedback id
version
platform
policy source
redaction summary
suspected areas
full transcript included or not
```

管理员默认不应看到完整 transcript。

---

## 69.48 本地策略包

企业环境可能不能访问云端控制面。

所以需要本地策略包：

```text
managed-settings.json
managed-settings.d/*.json
policy-limits.json cache
plugin allowlist
marketplace mirror config
release channel pin
```

这些都可以被 IT 工具部署到机器。

本地策略包应该：

```text
validate schema
report source
support dry-run
show in doctor
avoid user-writable location for high-priority policy
```

Windows HKCU 是最低优先级，因为它是用户可写。

这点当前设计已经体现。

---

## 69.49 策略 Dry Run

建议新增：

```text
claude policy check <path>
```

或者内部脚本：

```bash
bun run scripts/check-managed-policy.ts /path/to/managed-settings.json
```

输出：

```text
schema valid
dangerous settings:
  hooks
  statusLine
policy effects:
  plugins locked
  remote sessions disabled
  custom hooks plugin-only
warnings:
  unknown key ignored by this CLI version
```

这对管理员非常有用。

不要等部署到用户机器上才发现 schema 错误。

---

## 69.50 策略版本化

Managed settings 当前主要是 settings JSON。

企业规模下建议增加 envelope：

```ts
type ManagedPolicyEnvelope = {
  schemaVersion: 1;
  policyId: string;
  revision: number;
  createdAt: string;
  createdBy?: string;
  settings: Record<string, unknown>;
};
```

CLI 仍然可以只吃 `settings`。

但控制面和审计需要：

```text
policy id
revision
created by
rollout ring
```

否则支持人员只能看到“有一个设置”，看不到它来自哪一次变更。

---

## 69.51 诊断包里的企业字段

第 68 章的诊断包应加入企业字段。

建议：

```json
{
  "enterprise": {
    "policySource": "remote",
    "policyChecksum": "sha256:...",
    "policyCacheAgeSeconds": 720,
    "policyLimitsLoaded": true,
    "remoteSessionsAllowed": true,
    "pluginGovernance": "strict-known-marketplaces",
    "settingsSyncState": "downloaded",
    "rolloutRing": "ring-1"
  }
}
```

注意：

```text
policy checksum yes
raw policy values no
counts yes
secret env values no
```

企业字段主要用于解释“为什么行为如此”，不是为了复制组织策略。

---

## 69.52 管理员可见性与用户信任

企业工具容易让用户不信任。

所以 CLI 应该明确说明：

```text
Your organization manages these settings:
- plugin sources
- remote sessions
- provider routing

Claude Code does not include full transcripts in admin diagnostics by default.
```

这种透明度比隐藏策略更好。

用户知道边界，才会愿意在企业环境里使用。

---

## 69.53 管理策略不能绕过本地安全

管理员策略也不能无限制。

例如：

```text
remote policy 下发危险 env
  需要安全弹窗。

managed policy 启用 hooks
  需要显示 hooks 存在。

policy allow Bash whole-tool
  仍需遵守工具自身的安全规则。

policy 启用插件
  仍需插件来源校验。
```

组织管理员是高信任来源，但不是让 CLI 放弃本地安全模型的理由。

这点当前 dangerous settings dialog 已经体现。

---

## 69.54 企业策略与本地 Trust Dialog

Trust Dialog 面向项目目录。

Managed Settings 面向组织策略。

二者不能互相替代。

关系：

```text
organization policy
  controls global boundaries

project trust
  controls whether this repository is trusted

tool permission
  controls each sensitive action
```

例如：

```text
org allows Bash
project not trusted
  still prompt / restrict

org denies remote sessions
project trusted
  remote still denied
```

层级不能混乱。

---

## 69.55 远程环境注册

RCS 的 environment route 支持：

```text
POST /v1/environments/bridge
DELETE /v1/environments/bridge/:id
POST /v1/environments/:id/bridge/reconnect
```

企业运维应记录：

```text
environment id
username
host label
CLI version
platform
last heartbeat
session id
reconnect count
status
```

不要记录：

```text
raw env
raw command line with secrets
home path
tokens
```

环境注册是 fleet visibility 的基础。

没有环境清单，就谈不上 rollout 和集中诊断。

---

## 69.56 断线与恢复

远程环境一定会断线。

控制面要区分：

```text
network disconnect
worker crash
token expired
policy denied reconnect
session archived
server restart
```

不同原因对应不同处理：

```text
network
  wait reconnect

token
  refresh or re-auth

policy
  show blocked by org

crash
  request diagnostic bundle

server restart
  show volatile store warning
```

RCS 当前是内存存储。

企业版如果要跨重启保留 session 和 audit，需要持久化层。

---

## 69.57 审计存储

最小本地审计可以用 JSONL。

企业集中审计需要：

```text
append-only
time indexed
actor indexed
session indexed
retention policy
export API
redaction guarantee
```

导出格式建议：

```text
jsonl
csv
parquet later if needed
```

CLI 侧只要保证事件结构稳定。

集中存储可以后续演进。

---

## 69.58 审计导出命令

建议本地支持：

```text
/audit export
```

或者脚本：

```bash
bun run scripts/export-audit.ts
```

默认导出：

```text
remote trigger audit
settings policy changes
dangerous settings decisions
plugin policy blocks
diagnostic bundle exports
```

不导出：

```text
transcript
tool output
raw secrets
raw settings values
```

这和诊断包类似，但面向行为审计，不面向 bug 复现。

---

## 69.59 企业测试矩阵

现有可直接跑的相关测试包括：

```bash
bun test src/utils/__tests__/remoteTriggerAudit.test.ts
bun test packages/remote-control-server/src/__tests__/auth.test.ts
bun test packages/remote-control-server/src/__tests__/middleware.test.ts
bun test packages/remote-control-server/src/__tests__/routes.test.ts
bun test packages/remote-control-server/src/__tests__/services.test.ts
bun run typecheck
```

建议补齐的新测试方向：

```text
remote managed settings checksum stability
remote managed settings stale cache fallback
dangerous settings changed prompt
MDM parse and first-source-wins
managed-settings.d ordering
policy limits essential-traffic fail closed
plugin policy block chokepoints
strict plugin-only source filtering
settings sync size cap
team memory secret guard
trusted device enrollment skip in essential traffic
worker JWT session mismatch rejection
```

企业能力的测试重点不是 happy path。

重点是：

```text
auth missing
network timeout
stale cache
invalid schema
old client
policy conflict
privacy restricted
dangerous setting
token expiry
```

---

## 69.60 策略 Schema 测试

Managed settings schema 不能只靠生产解析。

建议有独立测试：

```ts
import { describe, expect, test } from "bun:test";
import { SettingsSchema } from "src/utils/settings/types.js";

describe("managed settings schema", () => {
  test("accepts policy plugin lock", () => {
    const parsed = SettingsSchema().safeParse({
      enabledPlugins: {
        "security-tools@company": false,
      },
    });

    expect(parsed.success).toBe(true);
  });

  test("rejects invalid permission rule shape", () => {
    const parsed = SettingsSchema().safeParse({
      permissions: {
        allow: [""],
      },
    });

    expect(parsed.success).toBe(false);
  });
});
```

这类测试应该覆盖管理员真实会写的配置。

---

## 69.61 First-Source-Wins 测试

MDM / managed file / HKCU 优先级必须有测试。

伪代码：

```ts
import { describe, expect, test } from "bun:test";
import { parseRegQueryStdout } from "src/utils/settings/mdm/settings.js";

describe("MDM registry parsing", () => {
  test("extracts Settings JSON from registry output", () => {
    const stdout = [
      "",
      "    Settings    REG_SZ    {\"forceLoginMethod\":\"console\"}",
      "",
    ].join("\n");

    expect(parseRegQueryStdout(stdout)).toBe(
      "{\"forceLoginMethod\":\"console\"}",
    );
  });
});
```

优先级测试要验证：

```text
remote beats local MDM
HKLM beats managed file
managed file beats HKCU
drop-in disables HKCU fallback
```

这些测试防止企业部署出现“某些机器读到低优先级策略”。

---

## 69.62 Remote Policy 失败测试

远程策略失败路径必须明确。

测试矩阵：

```text
200 valid
200 invalid schema
204 no content
304 unchanged
404 no settings
401 auth error
timeout
network failure
cache exists
cache missing
```

预期：

```text
invalid schema
  do not apply

304
  keep cache

404
  clear stale cache

failure with cache
  use stale cache

failure without cache
  fail open
```

这个比单纯 mock 一次成功请求更重要。

---

## 69.63 RCS 测试

RCS 已经有多组测试。

企业扩展应继续覆盖：

```text
API key auth
Bearer token auth
WebSocket auth protocol decode
JWT session mismatch
environment register
session events
worker state update
disconnect monitor
SSE writer
work dispatch
```

运行：

```bash
bun test packages/remote-control-server/src/__tests__/auth.test.ts
bun test packages/remote-control-server/src/__tests__/ws-handler.test.ts
bun test packages/remote-control-server/src/__tests__/work-dispatch.test.ts
bun test packages/remote-control-server/src/__tests__/disconnect-monitor.test.ts
```

远程控制是企业风险最高的区域之一。

任何 auth 或 session scope 改动都应该先跑这些测试。

---

## 69.64 企业验收标准

如果要把本章内容落地成代码，建议验收标准：

```text
1. Remote Managed Settings 支持缓存、304、stale fallback。
2. Dangerous settings 变化会触发安全确认。
3. MDM / managed file / HKCU 优先级可测试。
4. Policy Limits 支持 fail-open 和 privacy-sensitive fail-closed。
5. 插件安装、启用、加载都执行 policy block。
6. strictPluginOnlyCustomization 能跳过用户/项目来源。
7. Settings Sync 不覆盖 policySettings。
8. Team Memory 写入前扫描 secret-looking 内容。
9. RCS 远程 session token scoped to session。
10. Remote trigger audit 可导出最近记录。
11. Diagnostic bundle 包含企业策略 metadata，不包含原始策略值。
12. `/status` 或 `/doctor` 能解释 policy source。
```

验证命令：

```bash
bun test src/utils/__tests__/remoteTriggerAudit.test.ts
bun test packages/remote-control-server/src/__tests__/auth.test.ts
bun test packages/remote-control-server/src/__tests__/middleware.test.ts
bun test packages/remote-control-server/src/__tests__/routes.test.ts
bun test packages/remote-control-server/src/__tests__/services.test.ts
bun run typecheck
```

---

## 69.65 当前差距

当前仓库已经具备：

- Remote Managed Settings。
- MDM / registry / managed file 读取。
- policy limits。
- settings sync。
- plugin policy。
- strict plugin-only customization。
- team memory secret guard。
- admin requests。
- remote trigger audit。
- trusted device。
- worker JWT。
- RCS session / environment / event routes。

离更接近官方企业体验，还差：

```text
统一 policy definition registry
policy source explanation UI
policy dry-run checker
centralized audit export
diagnostic bundle registration
admin diagnostics view
fleet rollout manifest
rollout ring targeting
remote session org policy enforcement across all layers
policy schema migration
support bundle admin workflow
```

这不是一个单点缺口。

这是“把现有企业能力连成控制平面”的缺口。

---

## 69.66 推荐落地顺序

建议按风险和收益排序：

```text
Phase 1
  policy source explanation in /status and /doctor
  policy dry-run checker
  more tests for remote managed settings and policy limits

Phase 2
  diagnostic bundle enterprise metadata
  audit export
  plugin policy chokepoint audit

Phase 3
  admin diagnostics view
  diagnostic bundle registration
  admin request expansion

Phase 4
  fleet rollout manifest
  rollout rings
  centralized policy console
```

先把本地可解释性和测试补足。

再做集中化。

否则 admin console 只会把不可解释的问题放大。

---

## 69.67 本章总结

第 69 章补的是“组织如何管理 Claude Code”。

当前项目已经不只是单机 CLI。

它已经有：

- 远程托管设置。
- 设备级托管设置。
- 组织级 policy limits。
- 用户设置同步。
- 插件治理。
- 团队记忆密钥扫描。
- 管理员请求。
- 远程控制后端。
- 远程触发审计。
- 可信设备与 session token。

下一步要做的是统一：

- policy 定义。
- policy 来源解释。
- rollout 语义。
- audit 事件模型。
- enterprise diagnostic metadata。
- admin-side support workflow。

当这些能力连起来后，Claude Code 才真正具备团队和企业可运营性。

第 70 章可以继续补高隔离与私有化部署：离线安装、artifact mirror、私有模型网关、策略包离线下发、离线文档、更新镜像、内网 RCS、无外网诊断与合规验收。
