# 第 62 章：插件、技能、Agent 与 Hook 的统一策略治理

第 61 章把工具权限抽象成了统一 policy layer。

这一章继续扩展边界。

Claude Code 不只有 tools。

它还有：

```txt
plugins
skills
agents
hooks
MCP servers
LSP servers
commands
output styles
```

这些都是扩展能力。

只治理 tool permission 还不够。

因为扩展能力可以绕过 tool permission：

```txt
plugin 带来新的 command
skill 带来新的 allowedTools
agent 带来自己的 tools / hooks / MCP
hook 可以执行命令、调用模型、发 HTTP 请求
MCP server 可以动态暴露工具
```

如果没有统一治理层，系统会出现一个很危险的状态：

```txt
工具调用被策略保护
扩展加载却没有策略保护
```

官方 Claude Code 的思路是：扩展不是天然可信的。

扩展必须被：

```txt
来源约束
结构验证
能力收敛
运行时隔离
审计追踪
托管策略控制
```

本章就补这层能力。

## 本章目标

本章完成后，Mini 要具备这些能力：

```txt
统一 ExtensionPolicyEngine
统一扩展来源信任模型
插件 marketplace allowlist / blocklist
插件组件 manifest 校验
Skill 来源治理
Agent 来源治理
Hook 来源治理
Agent frontmatter 能力降级
Hook managed-only / disable-all 策略
strictPluginOnlyCustomization
扩展加载审计
扩展运行审计
```

最终形成这条链路：

```txt
settings / plugin manifest / file frontmatter
  -> parse
  -> validate
  -> classify source
  -> evaluate extension policy
  -> load allowed extension
  -> strip forbidden capabilities
  -> register runtime surface
  -> audit
```

## 为什么工具策略还不够

假设第 61 章已经实现了：

```txt
Bash(git push:*) -> ask
Edit(.claude/**) -> safetyCheck ask
mcp__github -> allow
```

这只能保护单次 tool_use。

但下面这些仍然可能绕过：

```txt
项目里的 skill 定义 allowed-tools: Bash
项目里的 agent 定义 permissionMode: bypassPermissions
项目里的 hook 在 PostToolUse 执行 shell command
插件自带 MCP server 暴露更多工具
插件 command 在 prompt 里执行 shell interpolation
```

所以扩展治理要回答三个问题。

第一：这个扩展从哪里来？

```txt
built-in
managed policy
plugin marketplace
user config
project config
local config
inline session
```

第二：这个来源是否被允许加载这个 surface？

```txt
skills
agents
hooks
mcp
commands
lsp
```

第三：即使允许加载，哪些能力需要降级？

```txt
permissionMode
hooks
mcpServers
allowedTools
sensitive config
HTTP hook target
shell command hook
```

## 当前源码中的治理点

当前仓库已经有不少治理逻辑，只是分散在不同模块。

Skill 加载：

```txt
src/skills/loadSkillsDir.ts
```

关键点：

```txt
managed skills 从 managed .claude/skills 加载
user skills 从 home skills 加载
project skills 从项目层级加载
strictPluginOnlyCustomization('skills') 会跳过 user/project
dynamic skill discovery 在 locked 时跳过
skill frontmatter 会解析 allowed-tools / hooks / model / agent
```

Agent 加载：

```txt
packages/builtin-tools/src/tools/AgentTool/loadAgentsDir.ts
src/utils/plugins/loadPluginAgents.ts
packages/builtin-tools/src/tools/AgentTool/runAgent.ts
```

关键点：

```txt
agent frontmatter 支持 tools / disallowedTools / skills / mcpServers / hooks / permissionMode
plugin agents 会被命名空间化为 plugin:agent
plugin agent 故意忽略 permissionMode / hooks / mcpServers
strictPluginOnlyCustomization('mcp') 会阻止 user agent frontmatter MCP
strictPluginOnlyCustomization('hooks') 会阻止 user agent frontmatter hooks
```

Hook 加载：

```txt
src/schemas/hooks.ts
src/utils/hooks/hooksConfigSnapshot.ts
src/utils/hooks/registerFrontmatterHooks.ts
src/utils/plugins/loadPluginHooks.ts
```

关键点：

```txt
hook 类型包括 command / prompt / http / agent
hook 支持 if 条件
policySettings.disableAllHooks 可以禁用全部 hooks
policySettings.allowManagedHooksOnly 只允许 managed hooks
strictPluginOnlyCustomization('hooks') 阻止 user/project/local hooks
plugin hooks 单独注册并保留 pluginRoot / pluginName / pluginId
```

Plugin 加载：

```txt
src/utils/plugins/schemas.ts
src/utils/plugins/pluginLoader.ts
src/utils/plugins/marketplaceHelpers.ts
src/utils/plugins/pluginPolicy.ts
src/utils/plugins/managedPlugins.ts
```

关键点：

```txt
manifest schema 定义 commands / agents / skills / hooks / mcpServers / lspServers
组件路径必须是相对路径
路径 traversal 会被校验
reserved marketplace name 有防冒充校验
strictKnownMarketplaces 是 marketplace allowlist
blockedMarketplaces 是 marketplace blocklist
enabledPlugins 可以由 policySettings 管控
isPluginBlockedByPolicy 阻止安装或启用被组织禁用的插件
```

这些点已经很接近官方思路。

Mini 要做的是把它们抽象成一个统一策略层。

## 扩展面模型

先定义 surface。

```ts
export type ExtensionSurface =
  | 'plugin'
  | 'skill'
  | 'agent'
  | 'hook'
  | 'mcp'
  | 'lsp'
  | 'command'
  | 'outputStyle'
```

再定义扩展来源。

```ts
export type ExtensionSourceKind =
  | 'builtin'
  | 'policySettings'
  | 'plugin'
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'flagSettings'
  | 'session'
  | 'inline'
```

来源不是简单字符串，它应该有 trust level。

```ts
export type ExtensionSource = {
  kind: ExtensionSourceKind
  id: string
  displayName: string
  trustedByAdmin: boolean
  writableByUser: boolean
  pluginId?: string
  marketplace?: string
}
```

推荐信任划分：

```txt
builtin          trusted
policySettings  trusted
plugin          trusted only if marketplace policy passed
userSettings    user controlled
projectSettings project controlled
localSettings   user controlled
flagSettings    session controlled
session         runtime controlled
inline          session controlled
```

注意：plugin 不是天然 trusted。

plugin 只有在通过 marketplace policy、安装状态和 enabled policy 后，才进入 trusted 插件来源。

## 扩展 artifact 模型

所有扩展都可以归一成 artifact。

```ts
export type ExtensionArtifact = {
  id: string
  surface: ExtensionSurface
  source: ExtensionSource
  name: string
  path?: string
  manifestPath?: string
  capabilities: ExtensionCapability[]
  raw: unknown
}
```

capability 表达它要做什么。

```ts
export type ExtensionCapability =
  | { type: 'toolAccess'; tools: string[] }
  | { type: 'hook'; events: string[]; hookTypes: HookType[] }
  | { type: 'mcpServer'; servers: string[] }
  | { type: 'lspServer'; servers: string[] }
  | { type: 'modelOverride'; model: string }
  | { type: 'permissionMode'; mode: PermissionMode }
  | { type: 'shellExecution'; reason: string }
  | { type: 'httpRequest'; urls: string[] }
  | { type: 'sensitiveConfig'; keys: string[] }
```

这样 policy engine 不需要知道所有 manifest 细节。

它只需要判断：

```txt
这个来源能不能在这个 surface 上申请这些 capability
```

## 扩展策略输出

策略输出同样不能只是 boolean。

```ts
export type ExtensionPolicyDecision =
  | {
      behavior: 'allow'
      reason: ExtensionPolicyReason
      audit: ExtensionPolicyAudit
    }
  | {
      behavior: 'deny'
      reason: ExtensionPolicyReason
      message: string
      audit: ExtensionPolicyAudit
    }
  | {
      behavior: 'allowWithStrippedCapabilities'
      reason: ExtensionPolicyReason
      stripped: ExtensionCapability[]
      audit: ExtensionPolicyAudit
    }
```

为什么需要 `allowWithStrippedCapabilities`？

因为很多扩展不是全有或全无。

例如 plugin agent：

```txt
agent 本身可以加载
但 permissionMode / hooks / mcpServers 要忽略
```

如果只能 allow / deny，就会很粗糙。

官方体验更像：

```txt
加载可用部分
剥离越权部分
记录为什么剥离
```

## Policy Snapshot

扩展策略也需要 snapshot。

```ts
export type ExtensionPolicySnapshot = {
  version: string
  createdAt: number
  strictPluginOnlyCustomization:
    | true
    | ExtensionSurface[]
    | undefined
  allowManagedHooksOnly: boolean
  disableAllHooks: boolean
  strictKnownMarketplaces?: MarketplaceSource[]
  blockedMarketplaces?: MarketplaceSource[]
  enabledPlugins?: Record<string, boolean | string[] | undefined>
  pluginTrustMessage?: string
}
```

这个 snapshot 应该从 `policySettings` 构建。

不要从 merged settings 里读这些企业策略。

原因是：

```txt
企业策略必须只由 policySettings 决定
普通用户设置不能伪装成企业策略
```

## strictPluginOnlyCustomization

这是本章核心开关。

它可以是：

```json
{
  "strictPluginOnlyCustomization": true
}
```

也可以是：

```json
{
  "strictPluginOnlyCustomization": ["skills", "hooks", "mcp"]
}
```

语义：

```txt
被锁定的 surface 不再加载 user/project/local 自定义内容
managed 内容仍然允许
built-in 内容仍然允许
plugin 内容仍然允许
plugin 是否允许由 marketplace policy 决定
```

这体现了一个企业治理模型：

```txt
不要让任意项目文件扩展 Claude Code
只允许管理员认可的 plugin 扩展 Claude Code
```

这和第 61 章的 `allowManagedPermissionRulesOnly` 不同。

`allowManagedPermissionRulesOnly` 管权限规则。

`strictPluginOnlyCustomization` 管扩展入口。

## Source Trusted 判断

Mini 可以先实现这个函数。

```ts
export function isAdminTrustedExtensionSource(
  source: ExtensionSource,
): boolean {
  switch (source.kind) {
    case 'builtin':
    case 'policySettings':
      return true
    case 'plugin':
      return source.trustedByAdmin
    default:
      return false
  }
}
```

`plugin.trustedByAdmin` 的前提：

```txt
marketplace source 未被 blockedMarketplaces 命中
strictKnownMarketplaces 为空或命中
plugin 未被 enabledPlugins false 禁用
plugin manifest 校验通过
plugin 安装状态为 enabled
```

不要让插件绕过 marketplace policy。

如果插件是 inline session plugin，也要标成：

```txt
source.kind = inline
trustedByAdmin = false
```

除非用户显式用某个开发模式允许。

## Surface Lock 判断

```ts
export function isSurfaceLocked(
  surface: ExtensionSurface,
  snapshot: ExtensionPolicySnapshot,
): boolean {
  const policy = snapshot.strictPluginOnlyCustomization
  if (policy === true) return true
  if (Array.isArray(policy)) return policy.includes(surface)
  return false
}
```

加载 artifact 前先判断：

```ts
export function evaluateSurfaceLoad(
  artifact: ExtensionArtifact,
  snapshot: ExtensionPolicySnapshot,
): ExtensionPolicyDecision {
  if (
    isSurfaceLocked(artifact.surface, snapshot) &&
    !isAdminTrustedExtensionSource(artifact.source)
  ) {
    return denyExtension(
      artifact,
      `Surface ${artifact.surface} is locked to plugin or managed sources`,
    )
  }

  return allowExtension(artifact)
}
```

这条规则要应用到所有入口：

```txt
skill directory discovery
dynamic skill activation
agent directory discovery
frontmatter hook registration
settings hooks
project MCP config
additional directories
```

不要只在 UI 隐藏。

运行时加载必须拦截。

## Plugin Marketplace Policy

插件入口必须先检查 marketplace source。

最小策略：

```txt
blockedMarketplaces 先判断
strictKnownMarketplaces 后判断
blocked 命中 -> deny
allowlist 未配置 -> allow
allowlist 为空 -> deny all
allowlist 配置 -> 必须命中
```

示例：

```ts
export function evaluateMarketplaceSource(
  source: MarketplaceSource,
  snapshot: ExtensionPolicySnapshot,
): ExtensionPolicyDecision {
  if (matchesAny(source, snapshot.blockedMarketplaces ?? [])) {
    return denyMarketplace(source, 'blocked by managed policy')
  }

  const allowlist = snapshot.strictKnownMarketplaces
  if (!allowlist) return allowMarketplace(source)

  if (allowlist.length === 0) {
    return denyMarketplace(source, 'managed policy blocks all marketplaces')
  }

  if (!matchesAny(source, allowlist)) {
    return denyMarketplace(source, 'not in managed marketplace allowlist')
  }

  return allowMarketplace(source)
}
```

匹配时要支持：

```txt
exact source
hostPattern
pathPattern
github source 与 git URL 等价
blocklist ref/path wildcard
```

这里有一个原则：

```txt
blockedMarketplaces 必须在下载前检查
```

不能先 clone 或 fetch 再判断。

否则被组织禁止的源已经触达了本地文件系统。

## Plugin Manifest Governance

插件 manifest 不是只读 metadata。

它会声明能力。

典型字段：

```json
{
  "name": "internal-review",
  "version": "1.0.0",
  "commands": "./commands",
  "skills": "./skills",
  "agents": "./agents",
  "hooks": "./hooks/hooks.json",
  "mcpServers": "./mcp.json",
  "lspServers": "./lsp.json",
  "userConfig": {
    "endpoint": {
      "type": "string",
      "title": "Endpoint",
      "description": "Internal service endpoint"
    }
  }
}
```

加载时要做四层校验。

第一层：结构校验。

```txt
manifest JSON 可解析
字段类型符合 schema
未知顶层字段可以忽略
嵌套配置字段严格校验
```

第二层：路径校验。

```txt
所有组件路径必须是相对路径
必须以 ./ 开头
不能包含 ..
不能逃出 plugin root
```

第三层：名称校验。

```txt
plugin name 不能为空
不能包含空格
marketplace name 不能伪装官方名称
reserved marketplace name 必须来自官方组织
```

第四层：能力校验。

```txt
hooks 是否允许
mcpServers 是否允许
lspServers 是否允许
settings 是否只包含 allowlisted keys
sensitive userConfig 不能注入 prompt
```

这四层都应该写入 load audit。

## Plugin Component Policy

插件不是整体一刀切。

每个组件都要单独决策。

```ts
export type PluginComponentPolicyInput = {
  pluginId: string
  marketplace: string
  component:
    | 'command'
    | 'skill'
    | 'agent'
    | 'hook'
    | 'mcpServer'
    | 'lspServer'
    | 'settings'
  path?: string
  capabilities: ExtensionCapability[]
}
```

例如：

```txt
插件 commands 允许
插件 skills 允许
插件 hooks 禁止
插件 MCP servers 只允许组织 allowlist 内的 server
插件 settings 只允许 agent 配置
```

这样企业可以先开放低风险扩展，逐步开放高风险扩展。

## Skill Governance

Skill 的主要风险不是“读 markdown”。

风险在 frontmatter。

常见字段：

```txt
allowed-tools
hooks
model
agent
disable-model-invocation
paths
shell
```

治理要点：

```txt
source 是否允许加载 skill
allowed-tools 是否超过当前策略允许
hooks 是否允许注册
paths 条件是否只是激活条件，不是权限条件
plugin skill 是否正确命名空间化
sensitive config 不进入 prompt
```

Skill policy 输入：

```ts
export type SkillPolicyInput = {
  name: string
  source: ExtensionSource
  loadedFrom: 'file' | 'plugin' | 'mcp' | 'builtin'
  allowedTools: string[]
  hooks?: HooksSettings
  paths?: string[]
  model?: string
}
```

如果 `strictPluginOnlyCustomization` 锁住 skills：

```txt
user skill -> deny load
project skill -> deny load
dynamic discovered skill -> deny load
managed skill -> allow
plugin skill -> allow if plugin trusted
builtin skill -> allow
```

如果 skill 带 hooks，还要额外进入 hook policy。

不要因为 skill 本身允许，就自动允许它的 hooks。

## Skill allowed-tools

Skill 的 `allowed-tools` 很容易被误解。

它不是永久授权。

它只是这个 command 运行期间的 scoped permission suggestion。

Mini 应该按这个模型实现：

```txt
skill allowed-tools -> command source allow rules
只在执行该 skill prompt 时注入
执行结束后不污染 session 永久规则
仍然不能覆盖 deny / ask / safetyCheck / managed policy
```

示例：

```yaml
allowed-tools:
  - Read
  - Bash(bun test:*)
```

运行时可以把它放入：

```txt
alwaysAllowRules.command
```

但 policy engine 要保证：

```txt
command source 低于 deny / ask / safetyCheck
```

不要把它写入 user settings。

## Agent Governance

Agent 是更高风险的扩展。

它可以带：

```txt
tools
disallowedTools
skills
mcpServers
hooks
permissionMode
memory
background
isolation
```

治理规则要更严格。

推荐：

```txt
user/project agent 可以声明 tools / disallowedTools / skills
user/project agent 的 mcpServers 在 mcp locked 时跳过
user/project agent 的 hooks 在 hooks locked 时跳过
plugin agent 不解析 permissionMode / hooks / mcpServers
policySettings agent 可以声明受管 hooks / MCP
built-in agent 可以按内置能力执行
```

当前源码里已经有一个重要安全决定：

```txt
plugin agents intentionally do not parse permissionMode / hooks / mcpServers
```

这是对的。

因为 plugin agent 是插件的一部分。

插件已经在 install time 被用户信任。

但如果某个 agent 文件内部又静默声明 hooks 或 MCP，就会把安装时的信任边界扩大。

所以它应该被剥离。

## Agent Tool Resolution

Agent 的工具列表要走统一 resolver。

```txt
tools undefined -> all filtered tools
tools ['*'] -> all filtered tools
disallowedTools -> 从候选工具里剔除
Agent(x,y) -> 限制可启动的子 agent 类型
```

但 resolver 还要接入 policy。

```ts
export function resolveAgentToolsWithPolicy(
  agent: AgentDefinition,
  availableTools: Tool[],
  policy: ExtensionPolicySnapshot,
): ResolvedAgentTools {
  const resolved = resolveAgentTools(agent, availableTools)

  return {
    ...resolved,
    resolvedTools: resolved.resolvedTools.filter(tool =>
      isToolAllowedForAgentSurface(tool, agent, policy),
    ),
  }
}
```

这能避免：

```txt
agent tools: '*'
```

在企业环境里拿到不该拿到的工具。

第 61 章的 tool policy 仍然会在单次 tool_use 执行时拦截。

但 Agent prompt 中暴露的工具列表也要尽量收敛。

不要把明知不可用的工具给模型看。

## Agent MCP Governance

Agent frontmatter 的 MCP 有两种来源。

第一种：user/project agent 自带。

```yaml
mcpServers:
  - name: internal-docs
```

第二种：plugin agent 自带。

当前源码选择：

```txt
plugin agent 不解析 mcpServers
```

这能防止某个 plugin agent 文件私自扩大 MCP 能力。

如果插件要提供 MCP server，应该走 manifest 级别：

```json
{
  "mcpServers": "./mcp.json"
}
```

这样它会经过：

```txt
plugin manifest validation
marketplace policy
MCP server policy
plugin install trust boundary
```

不要让 agent 文件本身成为第二条 MCP 安装通道。

## Hook Governance

Hook 是最高风险扩展之一。

它可以在这些时机运行：

```txt
PreToolUse
PostToolUse
PermissionRequest
UserPromptSubmit
SessionStart
SessionEnd
Stop
SubagentStart
SubagentStop
PreCompact
PostCompact
ConfigChange
FileChanged
```

Hook 类型：

```txt
command
prompt
http
agent
```

风险分别是：

```txt
command -> 本地命令执行
prompt  -> 额外模型调用和上下文泄漏
http    -> 网络外发和 secret header
agent   -> 自动启动子 agent
```

所以 Hook policy 要分两层。

加载层：

```txt
这个来源能不能注册 hook
这个 hook event 是否允许
这个 hook type 是否允许
这个 hook target 是否允许
```

执行层：

```txt
if 条件是否命中
timeout 是否受限
HTTP URL 是否在 allowlist
env var interpolation 是否在 allowlist
command 是否要进入 shell policy
agent hook 是否要进入 agent policy
```

## Hook Managed-only

两个开关要分清。

```json
{
  "allowManagedHooksOnly": true
}
```

含义：

```txt
只运行 policySettings 里的 hooks
普通 user/project/local hooks 不运行
```

另一个：

```json
{
  "disableAllHooks": true
}
```

如果来自 policySettings：

```txt
全部 hooks 都禁用，包括 managed hooks
```

如果来自非托管 settings：

```txt
只能禁用非托管 hooks
managed hooks 仍然运行
```

这点很重要。

用户不能通过自己的 settings 禁用组织强制 hook。

## Frontmatter Hook 注册

Skill 和 Agent 都可能带 frontmatter hooks。

治理规则：

```txt
先判断 artifact 是否允许加载
再判断 hooks surface 是否允许
再注册 session-scoped hook
```

伪代码：

```ts
export function maybeRegisterFrontmatterHooks(
  artifact: ExtensionArtifact,
  hooks: HooksSettings | undefined,
  snapshot: ExtensionPolicySnapshot,
): void {
  if (!hooks) return

  const hookArtifact: ExtensionArtifact = {
    ...artifact,
    surface: 'hook',
    capabilities: extractHookCapabilities(hooks),
  }

  const decision = evaluateExtensionPolicy(hookArtifact, snapshot)
  if (decision.behavior === 'deny') {
    auditExtensionDecision(decision)
    return
  }

  registerFrontmatterHooks(...)
}
```

不要因为 agent 本身允许加载，就自动允许 agent hooks。

## HTTP Hook 约束

HTTP hook 要额外处理：

```txt
URL allowlist
SSRF guard
header env interpolation
sensitive header redaction
timeout
payload size
```

Mini 可以先实现：

```ts
export type HttpHookPolicy = {
  allowedUrls?: string[]
  allowedEnvVars?: string[]
  maxTimeoutMs: number
  maxPayloadBytes: number
}
```

执行前检查：

```txt
hook.url matches allowedUrls
headers only interpolate allowed env vars
request body redacts secrets in audit
```

不要把完整 header 写入审计。

审计里只记录：

```txt
header names
redacted values
url host
matched policy
```

## Command Hook 约束

Command hook 的本质是 shell 执行。

不要把它当普通配置。

执行前要生成一个 policy request：

```ts
export type HookCommandExecutionRequest = {
  hookId: string
  source: ExtensionSource
  event: string
  command: string
  shell: 'bash' | 'powershell'
  cwd: string
}
```

再进入 shell policy：

```txt
managed hook command -> 可按 managed trust 运行
plugin hook command -> 受 plugin trust 和 hook policy 控制
project hook command -> 受普通权限和 strict policy 控制
```

最保守第一版：

```txt
policySettings hook 可以运行
trusted plugin hook 可以运行
user/project hook 需要普通 hook policy 允许
strict hooks locked 时 user/project hook 不注册
```

后续可以对 command 内容再做 Bash 规则匹配。

## Plugin Settings 合并

插件可能声明 settings。

源码里已经限制：

```txt
Only allowlisted keys are kept
```

Mini 也必须这么做。

不要允许插件写入：

```txt
permissions
env
hooks
enabledPlugins
strictKnownMarketplaces
blockedMarketplaces
forceLoginMethod
```

否则插件就可以自我提权。

建议第一版只允许：

```txt
agent
```

或更严格：

```txt
不允许插件合并 settings
```

等插件系统稳定后再开放。

## User Config 与 Secret

插件 `userConfig` 有两类值。

```txt
non-sensitive
sensitive
```

non-sensitive 可以进入：

```txt
MCP env
hook command
skill / agent prompt
```

sensitive 不能进入 prompt。

它只能进入：

```txt
受控 env
安全存储
redacted audit
```

规则：

```txt
skill content 替换 sensitive -> placeholder
agent prompt 替换 sensitive -> placeholder
hook header 替换 sensitive -> redacted audit
MCP env 可以使用，但不写日志
```

这能避免插件把 token 注入模型上下文。

## 扩展加载顺序

推荐统一加载顺序：

```txt
1. built-in
2. managed policy extensions
3. trusted plugins
4. user settings
5. project settings
6. local settings
7. session inline
```

但不同 surface 的覆盖规则不同。

Skill：

```txt
同名时更近路径或更高优先级 wins
plugin skill 命名空间化，避免冲突
```

Agent：

```txt
built-in + plugin + custom 合并
active list 再按可用性过滤
```

Hook：

```txt
不覆盖，按 event/matcher 累积
但 managed-only 会过滤来源
plugin hook 注册要 atomic swap
```

Plugin：

```txt
enabledPlugins 决定启用
policy false 强制禁用
manifest error 不阻塞其它插件
```

## 扩展审计

第 60、61 章已经做了 tool 和 policy audit。

扩展也要审计。

事件：

```ts
export type ExtensionAuditEvent =
  | {
      type: 'extension_load_decision'
      surface: ExtensionSurface
      artifactId: string
      sourceKind: ExtensionSourceKind
      sourceId: string
      behavior: 'allow' | 'deny' | 'allowWithStrippedCapabilities'
      strippedCapabilities?: ExtensionCapability[]
      reason: string
      policyVersion: string
      createdAt: number
    }
  | {
      type: 'extension_runtime_event'
      surface: ExtensionSurface
      artifactId: string
      event: string
      inputHash?: string
      result: 'started' | 'completed' | 'failed' | 'skipped'
      createdAt: number
    }
```

必须记录：

```txt
plugin loaded / blocked
marketplace blocked
skill loaded / skipped
agent loaded / stripped
hook registered / skipped
hook executed / failed
MCP from plugin loaded / blocked
```

这能回答：

```txt
这次会话为什么出现这个 skill？
这个 hook 是谁注册的？
这个 agent 为什么没有 MCP？
这个 plugin 为什么被禁用？
```

## ExtensionPolicyEngine

整合成一个入口。

```ts
export class ExtensionPolicyEngine {
  constructor(private snapshot: ExtensionPolicySnapshot) {}

  evaluate(artifact: ExtensionArtifact): ExtensionPolicyDecision {
    const surfaceDecision = this.evaluateSurface(artifact)
    if (surfaceDecision.behavior === 'deny') return surfaceDecision

    const capabilityDecision = this.evaluateCapabilities(artifact)
    if (capabilityDecision.behavior !== 'allow') return capabilityDecision

    return allowExtension(artifact, this.snapshot)
  }

  evaluateMarketplace(source: MarketplaceSource): ExtensionPolicyDecision {
    return evaluateMarketplaceSource(source, this.snapshot)
  }
}
```

`evaluateCapabilities` 里处理：

```txt
plugin agent permissionMode -> strip
plugin agent hooks -> strip
plugin agent mcpServers -> strip
hook disabled -> deny
HTTP hook non-allowed URL -> deny
skill allowedTools too broad -> strip or ask
plugin settings non-allowlisted key -> strip
```

## 接入 Skill Loader

Skill loader 的核心改造：

```ts
async function loadSkillWithPolicy(
  file: SkillFile,
  source: ExtensionSource,
  policy: ExtensionPolicyEngine,
): Promise<Command | null> {
  const command = parseSkill(file)
  const artifact = skillToArtifact(command, source, file.path)
  const decision = policy.evaluate(artifact)

  auditExtensionDecision(decision)

  if (decision.behavior === 'deny') return null

  return applyStrippedCapabilitiesToSkill(command, decision)
}
```

如果 locked：

```txt
user skill -> null
project skill -> null
managed skill -> command
plugin skill -> command if plugin trusted
```

dynamic skill discovery 也必须走这条路径。

不要只改启动加载。

## 接入 Agent Loader

Agent loader 的核心改造：

```ts
function loadAgentWithPolicy(
  rawAgent: ParsedAgent,
  source: ExtensionSource,
  policy: ExtensionPolicyEngine,
): AgentDefinition | null {
  const artifact = agentToArtifact(rawAgent, source)
  const decision = policy.evaluate(artifact)

  auditExtensionDecision(decision)

  if (decision.behavior === 'deny') return null

  return stripAgentCapabilities(rawAgent, decision)
}
```

`stripAgentCapabilities`：

```ts
function stripAgentCapabilities(
  agent: AgentDefinition,
  decision: ExtensionPolicyDecision,
): AgentDefinition {
  if (decision.behavior !== 'allowWithStrippedCapabilities') return agent

  let result = { ...agent }
  for (const cap of decision.stripped) {
    if (cap.type === 'permissionMode') {
      delete result.permissionMode
    }
    if (cap.type === 'hook') {
      delete result.hooks
    }
    if (cap.type === 'mcpServer') {
      delete result.mcpServers
    }
  }
  return result
}
```

这比直接在 loader 里散落 `delete` 更可审计。

## 接入 Hook Registry

Hook registry 的核心改造：

```ts
function registerHookWithPolicy(
  hook: HookCommand,
  event: HookEvent,
  matcher: string,
  source: ExtensionSource,
  policy: ExtensionPolicyEngine,
): boolean {
  const artifact = hookToArtifact(hook, event, matcher, source)
  const decision = policy.evaluate(artifact)

  auditExtensionDecision(decision)

  if (decision.behavior === 'deny') return false

  addSessionHook(...)
  return true
}
```

Plugin hooks 也走同一套判断。

但要保留现有的 atomic swap：

```txt
旧 plugin hooks 保持有效
新 plugin hooks 全部解析完成
clear old plugin hooks
register new plugin hooks
```

不要在中间状态把 hooks 清空。

## 接入 Plugin Loader

Plugin loader 的核心改造：

```ts
async function loadPluginWithPolicy(
  pluginId: string,
  source: MarketplaceSource,
  policy: ExtensionPolicyEngine,
): Promise<LoadedPlugin | null> {
  const marketplaceDecision = policy.evaluateMarketplace(source)
  auditExtensionDecision(marketplaceDecision)
  if (marketplaceDecision.behavior === 'deny') return null

  if (isPluginBlockedByPolicy(pluginId)) {
    return null
  }

  const plugin = await loadAndValidatePlugin(pluginId)
  const componentDecisions = evaluatePluginComponents(plugin, policy)

  return applyComponentPolicy(plugin, componentDecisions)
}
```

组件策略：

```txt
commands -> command artifacts
skills -> skill artifacts
agents -> agent artifacts
hooks -> hook artifacts
mcpServers -> mcp artifacts
lspServers -> lsp artifacts
settings -> settings capability
```

这能把插件内部所有能力都放进同一套治理框架。

## UI 表达

`/plugin`、`/skills`、`/agents`、`/hooks` 都应该展示来源和策略状态。

示例：

```txt
skill: verify
source: plugin internal-review@corp
policy: allowed
```

```txt
agent: repo-auditor
source: project settings
policy: loaded, hooks stripped
reason: hooks surface locked to plugin-only
```

```txt
hook: PostToolUse command
source: project settings
policy: skipped
reason: allowManagedHooksOnly
```

不要只显示“没有加载”。

用户需要知道为什么。

## 测试清单

本章测试可以分成八组。

Skill：

```txt
skills locked 时跳过 user skill
skills locked 时跳过 project skill
skills locked 时仍加载 managed skill
skills locked 时仍加载 trusted plugin skill
dynamic skill discovery 遵守 locked
skill hooks 进入 hook policy
```

Agent：

```txt
agents locked 时跳过 user/project agent
plugin agent 被命名空间化
plugin agent 忽略 permissionMode
plugin agent 忽略 hooks
plugin agent 忽略 mcpServers
user agent 在 mcp locked 时跳过 frontmatter MCP
user agent 在 hooks locked 时跳过 frontmatter hooks
```

Hook：

```txt
policySettings disableAllHooks 禁用全部 hooks
non-managed disableAllHooks 不禁用 managed hooks
allowManagedHooksOnly 只加载 managed hooks
strict hooks locked 时跳过 settings hooks
plugin hooks atomic swap
frontmatter hooks 按 source 判断
```

Plugin：

```txt
blockedMarketplaces 在下载前阻止
strictKnownMarketplaces 未命中时阻止
policy false 的 plugin 不能 enable
reserved marketplace name 防冒充
manifest 路径不能逃出 plugin root
plugin settings 只保留 allowlisted keys
```

MCP：

```txt
plugin manifest MCP 进入 MCP server policy
plugin agent frontmatter MCP 被忽略
project agent frontmatter MCP 在 locked 时跳过
MCP server blocked 时不进入 tool registry
```

Secret：

```txt
sensitive userConfig 不进入 skill prompt
sensitive userConfig 不进入 agent prompt
hook header audit redacts sensitive values
MCP env 不写明文日志
```

审计：

```txt
load allow 记录 source / surface
load deny 记录 reason
stripped capability 记录字段
runtime hook execution 记录 result
policyVersion 写入每个事件
```

回归：

```txt
锁定 skills 不影响 built-in skills
锁定 hooks 不影响 trusted plugin hooks
锁定 mcp 不影响 managed MCP
插件加载失败不阻塞其它插件
```

## 示例测试

```ts
test('strict skills policy skips project skills', async () => {
  const policy = extensionPolicy({
    strictPluginOnlyCustomization: ['skill'],
  })

  const artifact = skillArtifact({
    name: 'project-verify',
    source: source('projectSettings'),
  })

  const decision = policy.evaluate(artifact)

  expect(decision.behavior).toBe('deny')
  expect(decision.reason.type).toBe('surfaceLocked')
})
```

```ts
test('managed skill still loads when skills are locked', async () => {
  const policy = extensionPolicy({
    strictPluginOnlyCustomization: ['skill'],
  })

  const artifact = skillArtifact({
    name: 'managed-verify',
    source: source('policySettings'),
  })

  const decision = policy.evaluate(artifact)

  expect(decision.behavior).toBe('allow')
})
```

```ts
test('plugin agent strips escalated frontmatter capabilities', async () => {
  const policy = extensionPolicy({})

  const artifact = agentArtifact({
    name: 'reviewer',
    source: trustedPluginSource('reviewer@corp'),
    capabilities: [
      { type: 'permissionMode', mode: 'bypassPermissions' },
      { type: 'hook', events: ['PostToolUse'], hookTypes: ['command'] },
      { type: 'mcpServer', servers: ['hidden'] },
    ],
  })

  const decision = policy.evaluate(artifact)

  expect(decision.behavior).toBe('allowWithStrippedCapabilities')
  expect(decision.stripped).toHaveLength(3)
})
```

```ts
test('blocked marketplace is denied before fetch', async () => {
  const policy = extensionPolicy({
    blockedMarketplaces: [{ source: 'github', repo: 'bad/plugins' }],
  })

  const decision = policy.evaluateMarketplace({
    source: 'github',
    repo: 'bad/plugins',
  })

  expect(decision.behavior).toBe('deny')
  expect(fetchMarketplace).not.toHaveBeenCalled()
})
```

```ts
test('non-managed disableAllHooks keeps managed hooks', () => {
  const snapshot = hooksSnapshot({
    merged: {
      disableAllHooks: true,
      hooks: { PostToolUse: [projectHook()] },
    },
    policySettings: {
      hooks: { SessionStart: [managedHook()] },
    },
  })

  expect(snapshot.SessionStart).toHaveLength(1)
  expect(snapshot.PostToolUse).toBeUndefined()
})
```

## 常见错误

错误一：

```txt
只在 UI 隐藏 project skill
```

正确：

```txt
loader 必须跳过 project skill
```

错误二：

```txt
plugin agent 允许声明 permissionMode
```

正确：

```txt
plugin agent 的 permissionMode 必须忽略或剥离
```

错误三：

```txt
插件 marketplace 先下载后检查 policy
```

正确：

```txt
下载前检查 blocked / allowlist
```

错误四：

```txt
skill allowed-tools 写入永久 settings
```

正确：

```txt
只作为 command-scoped allow rules
```

错误五：

```txt
用户 settings 能 disable managed hooks
```

正确：

```txt
只有 policySettings.disableAllHooks 能禁用 managed hooks
```

错误六：

```txt
hook 是否执行只看 event matcher
```

正确：

```txt
先看 source policy，再看 event matcher
```

错误七：

```txt
sensitive userConfig 注入 skill prompt
```

正确：

```txt
sensitive userConfig 只能进入受控 env 或安全存储，prompt 中用 placeholder
```

错误八：

```txt
extension audit 只记录插件名
```

正确：

```txt
记录 surface / source / capability / policyVersion / decision
```

## 本章完成后的能力

Mini 的治理模型从：

```txt
只治理 tool_use
```

升级成：

```txt
治理所有扩展入口
```

它具备：

```txt
ExtensionPolicyEngine
ExtensionSurface
ExtensionSource trust model
marketplace source policy
plugin component policy
skill source policy
agent capability stripping
hook managed-only policy
frontmatter hook governance
secret-safe userConfig
extension audit event
```

这让 Mini 更接近官方 Claude Code：

```txt
插件不能绕过组织策略
项目文件不能随意注册扩展
Skill 不能偷偷扩大永久权限
Agent 不能通过 frontmatter 静默提权
Hook 不能绕过 managed-only
敏感配置不会进入模型上下文
扩展加载和运行都可审计
```

## 和官方 Claude Code 的差距

这一章仍然没有完全覆盖官方级别的扩展治理。

仍然缺：

```txt
插件签名和供应链证明
插件 SBOM
插件权限声明和用户确认 UI
插件组件级 install-time consent
Hook command 内容级安全分类
HTTP hook SSRF 完整防护
LSP server sandbox
MCPB bundle 签名校验
跨设备 plugin policy sync
企业策略热更新冲突处理
extension audit export
```

但到这里，Mini 已经有了关键抽象：

```txt
tool 是能力
plugin / skill / agent / hook 是能力来源
能力来源必须先被治理
能力执行才能被信任
```

下一章如果继续，建议补 **扩展签名、版本锁定与供应链安全**：把 plugin / marketplace / MCP bundle 的来源、版本、完整性和回滚全部纳入安全模型。
