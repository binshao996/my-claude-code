# 第 61 章：策略引擎、规则匹配 DSL 与企业托管权限

第 60 章把远程审批做成了一个可以排队、审计和回放的系统。

这一章继续往上一层走：把每一次审批之前的判断抽象成统一的
policy layer。

也就是从：

```txt
某个工具请求权限
弹窗让用户点允许或拒绝
```

升级成：

```txt
工具请求进入策略引擎
策略引擎收集规则来源
规则匹配器产生 allow / deny / ask
安全检查和托管策略覆盖普通规则
审批 UI 只处理策略仍然无法自动决定的请求
```

官方 Claude Code 的权限体验并不是单个弹窗堆出来的。

它背后至少有几层：

```txt
permission rules
permission modes
tool-specific checks
filesystem safety policy
MCP server policy
managed settings
policy limits
remote approval transport
audit and replay
```

Mini 如果要接近官方 Claude Code，就不能继续把权限判断散落在每个工具里。

这一章要补的就是这层统一策略。

## 本章目标

本章完成后，Mini 要具备这些能力：

```txt
统一的 PermissionPolicyEngine
稳定的规则 DSL
可解释的决策结果
多来源权限规则合并
企业托管设置只读化
deny 优先于 ask，ask 优先于 allow
安全检查不被 bypass 绕过
MCP server allowlist / denylist
MCP tool 级规则匹配
远程审批携带策略快照
审计事件记录命中的规则来源
```

最后会得到这样一条权限流水线：

```txt
tool_use
  -> normalize tool identity
  -> collect policy sources
  -> validate rule syntax
  -> evaluate deny rules
  -> evaluate ask rules
  -> run tool-specific check
  -> run safety checks
  -> apply permission mode
  -> evaluate allow rules
  -> ask user if still unresolved
```

## 先看官方骨架

当前仓库里，权限策略已经分散在多个文件里。

第一类是规则结构：

```txt
src/utils/permissions/PermissionRule.ts
src/utils/permissions/permissionRuleParser.ts
src/utils/settings/permissionValidation.ts
```

规则行为只有三种：

```txt
allow
deny
ask
```

规则值只有两段：

```txt
toolName
ruleContent?
```

因此规则 DSL 的基础形态就是：

```txt
Tool
Tool(content)
```

例如：

```txt
Bash(git status:*)
Bash(bun run test:*)
Read(src/**)
Edit(courses/**)
mcp__github
mcp__github__create_issue
mcp__github__*
```

第二类是规则来源：

```txt
src/utils/settings/constants.ts
src/utils/permissions/permissionsLoader.ts
```

现有来源包括：

```txt
userSettings
projectSettings
localSettings
flagSettings
policySettings
cliArg
command
session
```

其中真正可以被用户写入的只有：

```txt
userSettings
projectSettings
localSettings
session
cliArg
command
```

而这些是只读或系统控制的：

```txt
policySettings
flagSettings
```

第三类是执行顺序：

```txt
src/utils/permissions/permissions.ts
src/utils/permissions/pathValidation.ts
src/utils/permissions/filesystem.ts
```

关键顺序是：

```txt
deny whole tool
ask whole tool
tool.checkPermissions
tool-specific deny
tool requires user interaction
tool-specific ask
safetyCheck
bypassPermissions
whole-tool allow
passthrough -> ask
mode transform
auto classifier
headless hook fallback
```

注意：这不是普通优先级表。

这是一条安全流水线。

如果顺序写错，就会出现严重问题。

比如：

```txt
bypassPermissions 先于 safetyCheck
```

会导致 `.git`、`.claude`、shell 配置文件等敏感路径被绕过。

正确顺序必须保证：

```txt
safetyCheck before bypass
```

第四类是托管策略：

```txt
src/utils/settings/settings.ts
src/utils/settings/managedPath.ts
src/utils/settings/mdm/settings.ts
src/utils/services/policyLimits
```

现有托管策略来源遵循：

```txt
remote managed settings
admin MDM / plist / HKLM
managed-settings.json
managed-settings.d/*.json
HKCU fallback
```

并且 `policySettings` 是 first-source-wins：

```txt
找到最高优先级且有效的托管来源
只使用这一份作为 policySettings
不会再和低优先级托管来源混合
```

这点非常重要。

如果不同托管来源混合，管理员会很难解释最终策略来自哪里。

## 为什么要有 Policy Engine

没有 policy engine 时，Mini 的权限系统通常会变成这样：

```txt
BashTool 里判断 Bash 规则
FileEditTool 里判断路径
MCP 初始化里判断 server
远程审批里又判断一次
settings 里又验证一次
UI 里又隐藏某些按钮
```

短期能跑，长期会出问题。

典型问题有五类。

第一类：同一条规则解释不一致。

```txt
Bash(git status:*)
```

在 UI 里被当成 prefix，在后端被当成 exact。

结果是用户以为已经授权，实际运行仍然询问。

第二类：来源优先级不一致。

```txt
policySettings deny
localSettings allow
```

如果某个工具只读了 local，就会绕过组织策略。

第三类：MCP 名称不一致。

MCP 工具在 UI 上可能显示为：

```txt
github - create_issue
```

但权限规则应该匹配：

```txt
mcp__github__create_issue
```

如果不统一 tool identity，内置工具规则可能误匹配 MCP 工具。

第四类：远程审批缺少上下文。

远程端看到：

```txt
Allow Bash?
```

但看不到为什么要问：

```txt
matched rule: Bash(git push:*) from policySettings
decision: ask
mode: default
```

用户就无法判断这是不是正常。

第五类：审计不可解释。

执行后只记录：

```txt
tool allowed
```

但没有记录：

```txt
which rule
which source
which mode
which safety check
which input hash
```

这样第 60 章的安全回放也无法证明策略是否正确。

所以这一章要做的不是多写几个 `if`，而是定义一个统一策略引擎。

## Mini 的目标结构

建议新增或拆出这些模块：

```txt
src/policy/types.ts
src/policy/ruleDsl.ts
src/policy/sourceLoader.ts
src/policy/matchers.ts
src/policy/engine.ts
src/policy/explain.ts
src/policy/managedSettings.ts
src/policy/mcpPolicy.ts
src/policy/audit.ts
```

如果暂时不想动源码结构，也可以先放在：

```txt
src/utils/permissions/policyEngine.ts
```

但从长期结构看，`policy` 应该独立出来。

原因是它不只服务权限弹窗，还服务：

```txt
MCP server filtering
remote control
SDK headless mode
agent isolation
enterprise managed settings
audit replay
```

## 策略输入模型

先定义策略引擎的输入。

```ts
export type PolicyToolIdentity = {
  kind: 'builtin' | 'mcp'
  name: string
  canonicalName: string
  displayName: string
  mcp?: {
    serverName: string
    toolName: string
  }
}

export type PolicyRequest = {
  requestId: string
  sessionId: string
  toolUseId: string
  tool: PolicyToolIdentity
  input: Record<string, unknown>
  inputHash: string
  cwd: string
  permissionMode: PermissionMode
  source: 'repl' | 'headless' | 'remote' | 'sdk' | 'agent'
  now: number
}
```

几个字段必须稳定。

`canonicalName` 用于匹配规则。

内置工具：

```txt
Bash
Read
Edit
Write
Agent
```

MCP 工具：

```txt
mcp__server__tool
```

`inputHash` 用于连接策略判断、审批和执行。

策略引擎不应该直接相信远程返回的输入。

它应该要求：

```txt
approved.inputHash === current.inputHash
```

如果不一致，就必须重新进入审批。

## 策略输出模型

策略引擎输出不能只返回 `true` 或 `false`。

它必须解释“为什么”。

```ts
export type PolicyDecision =
  | {
      behavior: 'allow'
      reason: PolicyDecisionReason
      updatedInput?: Record<string, unknown>
      audit: PolicyAuditFields
    }
  | {
      behavior: 'deny'
      reason: PolicyDecisionReason
      message: string
      audit: PolicyAuditFields
    }
  | {
      behavior: 'ask'
      reason: PolicyDecisionReason
      message: string
      suggestions?: PermissionUpdate[]
      audit: PolicyAuditFields
    }

export type PolicyDecisionReason =
  | {
      type: 'rule'
      behavior: 'allow' | 'deny' | 'ask'
      rule: NormalizedPermissionRule
    }
  | {
      type: 'mode'
      mode: PermissionMode
    }
  | {
      type: 'tool'
      toolName: string
      detail: string
    }
  | {
      type: 'safetyCheck'
      detail: string
      classifierApprovable: boolean
    }
  | {
      type: 'managedPolicy'
      key: string
      detail: string
    }
  | {
      type: 'mcpPolicy'
      serverName: string
      detail: string
    }
  | {
      type: 'fallback'
      detail: string
    }
```

审计字段也要结构化：

```ts
export type PolicyAuditFields = {
  requestId: string
  sessionId: string
  toolUseId: string
  toolName: string
  canonicalToolName: string
  inputHash: string
  mode: PermissionMode
  behavior: 'allow' | 'deny' | 'ask'
  sourceChain: string[]
  matchedRule?: {
    source: PermissionRuleSource
    behavior: 'allow' | 'deny' | 'ask'
    value: string
  }
  policyVersion: string
}
```

`policyVersion` 可以先用本地 hash。

例如：

```txt
hash(JSON.stringify(policySnapshot))
```

后续如果接企业策略服务，可以换成服务端版本号。

## 规则 DSL 的最小集合

Mini 需要支持的规则 DSL 可以先定成四类。

第一类：全工具规则。

```txt
Bash
Read
Edit
mcp__github
```

含义：

```txt
匹配整个工具
不关心具体输入
```

第二类：工具内容规则。

```txt
Bash(git status:*)
Bash(bun run test:*)
Read(src/**)
Edit(courses/**)
Agent(Explore)
```

含义：

```txt
匹配具体工具输入中的关键内容
```

第三类：MCP 工具规则。

```txt
mcp__github
mcp__github__*
mcp__github__create_issue
```

含义：

```txt
mcp__github         匹配 github server 下全部工具
mcp__github__*      同上，显式 wildcard
mcp__github__tool   匹配某个具体工具
```

第四类：server 级 MCP 策略。

```json
{
  "allowedMcpServers": [
    { "serverName": "github" },
    { "serverUrl": "https://mcp.example.com/*" },
    { "serverCommand": ["bun", "run", "mcp:github"] }
  ],
  "deniedMcpServers": [
    { "serverName": "unknown-local" }
  ]
}
```

这类不是 tool permission rule，而是连接层 policy。

它决定 MCP server 能不能进入工具注册表。

## 规则解析

规则解析要做成纯函数。

```ts
export type ParsedRuleValue = {
  toolName: string
  ruleContent?: string
}

export function parseRuleValue(raw: string): ParsedRuleValue {
  const open = findFirstUnescaped(raw, '(')
  if (open < 0) return { toolName: normalizeToolName(raw) }

  const close = findLastUnescaped(raw, ')')
  if (close <= open || close !== raw.length - 1) {
    return { toolName: normalizeToolName(raw) }
  }

  const toolName = raw.slice(0, open)
  const content = raw.slice(open + 1, close)

  if (!toolName) return { toolName: normalizeToolName(raw) }
  if (content === '' || content === '*') {
    return { toolName: normalizeToolName(toolName) }
  }

  return {
    toolName: normalizeToolName(toolName),
    ruleContent: unescapeRuleContent(content),
  }
}
```

注意两个兼容点：

```txt
Tool()
Tool(*)
```

都应该归一成：

```txt
Tool
```

这能避免 UI 删除规则时出现“看起来一样但删不掉”的问题。

序列化也必须是纯函数：

```ts
export function stringifyRuleValue(rule: ParsedRuleValue): string {
  if (!rule.ruleContent) return rule.toolName
  return `${rule.toolName}(${escapeRuleContent(rule.ruleContent)})`
}
```

所有持久化、比较、去重都要走：

```txt
parse -> stringify
```

不要直接比较原始字符串。

## 规则验证

解析只负责容错，验证负责拒绝坏规则。

最小验证规则：

```txt
空字符串非法
括号必须匹配
工具名不能为空
内置工具名建议大写开头
MCP 规则不能带括号内容
Bash prefix 的 :* 只能出现在末尾
文件规则不能包含危险写入 glob
敏感工具不能 whole-tool allow
```

验证结果也要可解释：

```ts
export type RuleValidationResult =
  | { valid: true }
  | {
      valid: false
      error: string
      suggestion?: string
      examples?: string[]
    }
```

不要让坏规则使整个 settings 文件失效。

更接近官方体验的做法是：

```txt
过滤坏规则
保留其它有效设置
把错误展示给用户或写入 diagnostics
```

托管设置同样如此。

组织策略里某条规则写错，不应该让全部 managed settings 消失。

但如果是结构性错误，例如 `permissions` 不是对象，则可以拒绝整份策略。

## 来源模型

把来源做成显式结构。

```ts
export type PolicySourceKind =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'flagSettings'
  | 'policySettings'
  | 'cliArg'
  | 'command'
  | 'session'

export type PolicySource = {
  kind: PolicySourceKind
  displayName: string
  writable: boolean
  priority: number
}
```

推荐优先级：

```txt
userSettings     10
projectSettings  20
localSettings    30
flagSettings     40
policySettings   50
cliArg           60
command          70
session          80
```

但注意，这个优先级不代表 `allow` 一定能覆盖 `deny`。

行为优先级永远是：

```txt
deny > ask > allow
```

来源优先级只用于：

```txt
展示顺序
重复规则归并
同一行为内部冲突解释
settings 合并
审计字段
```

不要设计成：

```txt
高优先级 allow 覆盖低优先级 deny
```

这会让组织策略难以保证安全。

## 加载策略快照

策略引擎每次判断时不应该到处读 settings。

更好的做法是构造快照：

```ts
export type PolicySnapshot = {
  version: string
  createdAt: number
  rules: NormalizedPermissionRule[]
  settings: {
    allowManagedPermissionRulesOnly: boolean
    disableBypassPermissionsMode: boolean
    allowManagedMcpServersOnly: boolean
    defaultMode?: PermissionMode
  }
  mcpPolicy: {
    allowed?: McpServerPolicyEntry[]
    denied?: McpServerPolicyEntry[]
  }
}
```

加载逻辑：

```ts
export function buildPolicySnapshot(): PolicySnapshot {
  const managedOnly = shouldAllowManagedPermissionRulesOnly()
  const sources = managedOnly
    ? ['policySettings' as const]
    : getEnabledPolicySources()

  const rules = sources.flatMap(source => loadRulesForSource(source))
  const normalized = normalizeRules(rules)

  const settings = loadPolicySettings()
  const mcpPolicy = loadMcpPolicy(settings)

  return {
    version: hashPolicy({ normalized, settings, mcpPolicy }),
    createdAt: Date.now(),
    rules: normalized,
    settings,
    mcpPolicy,
  }
}
```

这里有一个关键开关：

```txt
allowManagedPermissionRulesOnly
```

当它为 true：

```txt
只读取 policySettings 里的 allow / deny / ask
忽略 user / project / local / flag / cliArg / session 规则
隐藏 UI 中的 always allow 选项
拒绝持久化新的普通权限规则
```

这不是 UI 细节，而是策略层保证。

远程审批返回 `updatedPermissions` 时也必须经过这个开关。

如果 managed-only 已启用，远程端不能把“总是允许”写入 local settings。

## 决策顺序

Mini 的核心函数可以叫：

```ts
export async function evaluatePolicy(
  request: PolicyRequest,
  snapshot: PolicySnapshot,
  tool: RuntimeTool,
  context: ToolUseContext,
): Promise<PolicyDecision> {
  const deny = matchRule(snapshot.rules, request, 'deny')
  if (deny) return denyDecision(request, snapshot, deny)

  const ask = matchRule(snapshot.rules, request, 'ask')
  if (ask && !canSandboxAutoAllow(request)) {
    return askDecision(request, snapshot, ask)
  }

  const toolResult = await runToolPermissionCheck(tool, request, context)

  if (toolResult.behavior === 'deny') {
    return toolDenyDecision(request, snapshot, toolResult)
  }

  if (toolRequiresUserInteraction(tool, toolResult)) {
    return toolAskDecision(request, snapshot, toolResult)
  }

  if (isToolSpecificAskRule(toolResult)) {
    return toolAskDecision(request, snapshot, toolResult)
  }

  if (isSafetyCheck(toolResult)) {
    return safetyDecision(request, snapshot, toolResult)
  }

  if (shouldBypass(request, snapshot)) {
    return modeAllowDecision(request, snapshot, toolResult)
  }

  const allow = matchRule(snapshot.rules, request, 'allow')
  if (allow) return allowDecision(request, snapshot, allow, toolResult)

  if (toolResult.behavior === 'allow') {
    return toolAllowDecision(request, snapshot, toolResult)
  }

  return unresolvedAskDecision(request, snapshot, toolResult)
}
```

几个点必须保持：

```txt
deny 在最前
ask 在 allow 前
tool-specific deny 比 mode 强
safetyCheck 比 bypass 强
bypass 只在前置安全检查之后生效
allow 不能覆盖 safetyCheck
passthrough 最终变 ask
```

`dontAsk` 和 `auto` 不建议放进 `evaluatePolicy` 的第一阶段。

它们更像后处理：

```txt
if ask and mode=dontAsk -> deny
if ask and mode=auto -> classifier
if ask and headless -> hook or deny
```

这样主策略仍然保持可解释。

## 工具名归一

工具匹配之前必须先得到 canonical name。

```ts
export function canonicalToolName(tool: RuntimeTool): string {
  if (tool.mcpInfo) {
    return `mcp__${normalizeMcpName(tool.mcpInfo.serverName)}__${normalizeMcpName(tool.mcpInfo.toolName)}`
  }
  return normalizeLegacyToolName(tool.name)
}
```

不要用 UI display name 做策略匹配。

错误示例：

```txt
github - create issue
```

正确匹配名：

```txt
mcp__github__create_issue
```

这能避免一个严重问题：

```txt
内置 Write 被 deny
MCP 也有一个名为 Write 的工具
```

如果只看 display name，MCP 工具会被误伤。

反过来，如果内置工具被 allow，也可能错误放行 MCP 工具。

所以 MCP 必须用 fully qualified name。

## MCP 工具规则匹配

MCP tool rule 的匹配逻辑：

```ts
export function matchMcpToolRule(
  ruleToolName: string,
  canonicalToolName: string,
): boolean {
  const rule = parseMcpName(ruleToolName)
  const tool = parseMcpName(canonicalToolName)
  if (!rule || !tool) return false

  if (rule.serverName !== tool.serverName) return false
  if (!rule.toolName) return true
  if (rule.toolName === '*') return true
  return rule.toolName === tool.toolName
}
```

对应关系：

```txt
mcp__github              -> github 下全部工具
mcp__github__*           -> github 下全部工具
mcp__github__create_pr   -> github/create_pr
mcp__linear__create_pr   -> 不匹配 github
```

MCP 规则不支持括号内容。

也就是说不要支持：

```txt
mcp__github__create_pr(owner=foo)
```

原因是 MCP 工具 schema 千差万别。

如果要做参数级策略，应该是后续章节的细粒度 tool input policy，而不是这一章的通用 DSL。

## Bash 规则匹配

Shell 规则至少支持三种模式：

```txt
exact
prefix
wildcard
```

示例：

```txt
Bash(git status)
Bash(git status:*)
Bash(git * --short)
```

解析：

```ts
export type ShellRule =
  | { type: 'exact'; command: string }
  | { type: 'prefix'; prefix: string }
  | { type: 'wildcard'; pattern: string }

export function parseShellRule(raw: string): ShellRule {
  if (raw.endsWith(':*')) {
    return { type: 'prefix', prefix: raw.slice(0, -2) }
  }
  if (hasUnescapedWildcard(raw)) {
    return { type: 'wildcard', pattern: raw }
  }
  return { type: 'exact', command: raw }
}
```

匹配顺序：

```txt
exact
prefix
wildcard
```

但在行为层面仍然是：

```txt
deny > ask > allow
```

所以一条 deny wildcard 应该挡住 allow exact：

```txt
deny:  Bash(git push:*)
allow: Bash(git push origin main)
```

最终应该是 deny。

除非未来引入更复杂的 policy language，明确支持 override，否则先不要做例外。

## 复合命令安全

Bash prefix rule 最容易出问题。

例如：

```txt
Bash(cd:*)
```

如果粗暴用 `startsWith`，下面也会被允许：

```txt
cd src && destructive-command
```

所以 Mini 的 Shell matcher 必须先拆分复合命令。

保守规则：

```txt
allow prefix 不匹配复合命令整体
deny prefix 可以检查每个子命令
ask prefix 可以检查每个子命令
```

也就是：

```txt
allow 要谨慎
deny 要尽量覆盖
ask 要尽量覆盖
```

这和官方现有逻辑一致：BashTool 会把 full command 和 subcommand 都做权限检查。

Mini 可以先实现简化版：

```ts
export function splitConservative(command: string): string[] {
  return command
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map(s => s.trim())
    .filter(Boolean)
}

export function matchShellRule(
  rule: ShellRule,
  command: string,
  behavior: 'allow' | 'deny' | 'ask',
): boolean {
  if (behavior === 'allow' && isCompound(command)) {
    return false
  }

  const candidates =
    behavior === 'allow' ? [command] : [command, ...splitConservative(command)]

  return candidates.some(candidate => matchShellRuleSingle(rule, candidate))
}
```

这不是完整 shell parser，但作为 Mini 的第一版，比直接 `startsWith` 安全得多。

## 文件规则匹配

文件规则看起来简单，实际很容易被 symlink 绕过。

策略层要明确：

```txt
匹配必须基于 resolved path
写入必须检查安全路径
deny 先于 allow
read 和 edit 分开
glob 只能用于读或规则匹配，不能用于直接写入目标
```

基础规则：

```txt
Read(src/**)
Edit(courses/**)
Write(tmp/**)
```

建议内部归一成：

```ts
export type FilePolicyInput = {
  operation: 'read' | 'edit' | 'write' | 'create'
  rawPath: string
  resolvedPath: string
  cwd: string
  pathVariants: string[]
}
```

`pathVariants` 用来覆盖：

```txt
原始路径
绝对路径
realpath
父目录 realpath + 文件名
```

原因是文件可能不存在。

不存在的目标无法直接 realpath，只能逐级找存在的父目录。

这类逻辑不应该散在每个工具里。

## 安全检查不属于普通规则

安全检查要比 allow rule 更强。

典型敏感路径：

```txt
.git/**
.claude/**
.vscode/**
shell startup files
credential files
```

如果出现：

```txt
allow: Edit(.claude/**)
```

策略引擎也不应该直接放行。

它应该返回：

```txt
ask with safetyCheck reason
```

原因是 allow rule 只是用户偏好，不等于安全边界解除。

`bypassPermissions` 同理。

正确语义：

```txt
bypassPermissions 跳过普通审批
不跳过 deny
不跳过 ask rule
不跳过 tool-specific deny
不跳过 safetyCheck
不跳过 requiresUserInteraction
```

这一条要写进测试。

## Permission Mode 与 Policy 的关系

策略层不要把 mode 当作普通规则。

mode 是后处理或默认策略。

常见 mode：

```txt
default
acceptEdits
bypassPermissions
dontAsk
plan
auto
```

推荐语义：

```txt
default: 未命中 allow 时询问
acceptEdits: 工作目录内安全编辑可自动允许
bypassPermissions: 前置安全检查通过后允许
dontAsk: 原本 ask 的请求转 deny
plan: 只允许计划相关工具，退出计划后再审批
auto: 原本 ask 的请求交给 classifier
```

策略引擎第一阶段只负责产生：

```txt
allow / deny / ask
```

然后 mode adapter 处理：

```ts
export async function applyModePolicy(
  decision: PolicyDecision,
  request: PolicyRequest,
  snapshot: PolicySnapshot,
): Promise<PolicyDecision> {
  if (decision.behavior !== 'ask') return decision

  if (request.permissionMode === 'dontAsk') {
    return denyFromMode(request, snapshot, 'dontAsk')
  }

  if (request.permissionMode === 'auto') {
    return runAutoClassifier(request, snapshot, decision)
  }

  return decision
}
```

这样审计里可以区分：

```txt
ask because rule
deny because dontAsk mode
allow because classifier
```

不要把它们都混成：

```txt
permission denied
```

## 托管设置

企业托管策略要解决两个问题。

第一：管理员设置不能被用户改。

第二：管理员设置的来源必须可解释。

Mini 可以先支持文件托管：

```txt
macOS: /Library/Application Support/ClaudeCode/managed-settings.json
Linux: /etc/claude-code/managed-settings.json
Windows: C:\Program Files\ClaudeCode\managed-settings.json
```

并支持 drop-in：

```txt
managed-settings.d/10-base.json
managed-settings.d/20-security.json
managed-settings.d/30-mcp.json
```

drop-in 合并规则：

```txt
managed-settings.json 作为 base
managed-settings.d/*.json 按文件名排序
后者覆盖前者
```

但 `policySettings` 与其它托管来源之间要 first-source-wins：

```txt
remote managed settings
admin MDM
managed file
HKCU fallback
```

一旦 remote 有效，就不再读后面的 policy 内容。

## 托管权限规则开关

这一章最关键的企业开关是：

```json
{
  "allowManagedPermissionRulesOnly": true
}
```

语义：

```txt
只接受 policySettings 里的 allow / deny / ask
忽略用户和项目的 permission rules
禁用 always allow UI
拒绝普通审批写入持久规则
远程 updatedPermissions 不能新增规则
```

策略层实现：

```ts
export function collectPermissionRules(
  sources: PolicySource[],
  managedOnly: boolean,
): NormalizedPermissionRule[] {
  const effectiveSources = managedOnly
    ? sources.filter(source => source.kind === 'policySettings')
    : sources

  return effectiveSources.flatMap(source => loadRules(source))
}
```

审批保存实现：

```ts
export function canPersistPermissionUpdate(
  update: PermissionUpdate,
  snapshot: PolicySnapshot,
): boolean {
  if (snapshot.settings.allowManagedPermissionRulesOnly) {
    return false
  }

  if (update.destination === 'policySettings') return false
  if (update.destination === 'flagSettings') return false

  return true
}
```

注意：`PermissionUpdateDestination` 本来就不应该包含 `policySettings`。

但远程输入和 SDK 输入仍要当作不可信数据验证。

## 禁用 bypass mode

另一个重要托管开关：

```json
{
  "permissions": {
    "disableBypassPermissionsMode": "disable"
  }
}
```

语义：

```txt
用户不能进入 bypassPermissions
已有 session 也要降级
远程端不能请求 bypassPermissions
plan mode 不能继承 bypass 可用性
```

策略层不只要隐藏 UI，也要在运行时检查：

```ts
export function normalizeRequestedMode(
  requested: PermissionMode,
  snapshot: PolicySnapshot,
): PermissionMode {
  if (
    requested === 'bypassPermissions' &&
    snapshot.settings.disableBypassPermissionsMode
  ) {
    return 'default'
  }
  return requested
}
```

远程控制尤其要注意。

客户端说：

```txt
permissionMode=bypassPermissions
```

不等于本地必须接受。

本地策略才是最终权威。

## MCP server policy

MCP 分两层。

第一层是 server 能不能被加载。

第二层是 server 下的 tool 能不能被调用。

server policy 来自：

```json
{
  "allowedMcpServers": [
    { "serverName": "github" },
    { "serverUrl": "https://mcp.company.com/*" },
    { "serverCommand": ["bun", "run", "mcp:internal"] }
  ],
  "deniedMcpServers": [
    { "serverName": "unknown" }
  ]
}
```

决策规则：

```txt
deniedMcpServers 优先
allowedMcpServers 不存在 -> 默认允许
allowedMcpServers 为空数组 -> 全部禁止
serverCommand entry 存在 -> stdio server 必须匹配 command
serverUrl entry 存在 -> remote server 必须匹配 url
否则用 serverName 匹配
```

实现：

```ts
export function evaluateMcpServerPolicy(
  serverName: string,
  config: McpServerConfig,
  snapshot: PolicySnapshot,
): McpServerPolicyDecision {
  const denied = matchMcpServerEntry(snapshot.mcpPolicy.denied, serverName, config)
  if (denied) {
    return { allowed: false, reason: { type: 'denied', entry: denied } }
  }

  const allowedList = snapshot.mcpPolicy.allowed
  if (!allowedList) {
    return { allowed: true, reason: { type: 'no-allowlist' } }
  }

  if (allowedList.length === 0) {
    return { allowed: false, reason: { type: 'empty-allowlist' } }
  }

  const allowed = matchMcpServerEntry(allowedList, serverName, config)
  if (allowed) {
    return { allowed: true, reason: { type: 'allowed', entry: allowed } }
  }

  return { allowed: false, reason: { type: 'not-in-allowlist' } }
}
```

如果 server 被挡掉，不应该进入 tool registry。

否则 UI 可能显示不存在的工具，模型也可能拿到不可用工具。

## allowManagedMcpServersOnly

托管 MCP allowlist 的关键开关：

```json
{
  "allowManagedMcpServersOnly": true
}
```

语义：

```txt
allowedMcpServers 只读取 policySettings
deniedMcpServers 仍可合并所有来源
用户可以为自己额外 deny
用户不能扩展 admin allowlist
```

这点看起来奇怪，但很合理。

管理员负责定义最大可用范围。

用户可以进一步收紧自己的范围。

用户不能放宽组织范围。

## 权限 UI 与策略层

UI 不应该自己判断权限。

UI 只消费策略结果。

Permission prompt 应该显示：

```txt
工具名
输入摘要
命中的规则
规则来源
当前模式
可选操作
```

例如：

```txt
Tool: Bash
Command: git push origin main
Decision: ask
Reason: matched ask rule
Rule: Bash(git push:*)
Source: enterprise managed settings
Mode: default
```

如果 `allowManagedPermissionRulesOnly=true`，UI 要隐藏：

```txt
Always allow this command
Always allow this tool
Save to local settings
Save to project settings
```

但这只是体验优化。

真正的拒绝必须在策略层。

## 远程审批中的策略快照

第 60 章的 approval request 需要扩展。

```ts
export type RemotePermissionRequest = {
  requestId: string
  toolUseId: string
  toolName: string
  inputPreview: unknown
  inputHash: string
  policy: {
    version: string
    behavior: 'ask'
    reason: PolicyDecisionReason
    matchedRule?: {
      source: string
      behavior: string
      value: string
    }
    managedOnly: boolean
    mode: PermissionMode
  }
}
```

远程端只负责展示。

远程端不能决定策略。

它只能返回：

```txt
allow requestId inputHash
deny requestId inputHash
```

本地收到后重新校验：

```ts
export function acceptRemoteDecision(
  response: RemotePermissionResponse,
  pending: PendingPermissionRequest,
): PermissionDecision {
  if (response.requestId !== pending.requestId) {
    return denyLateOrInvalidResponse(response)
  }

  if (response.inputHash !== pending.inputHash) {
    return denyHashMismatch(response)
  }

  if (response.policyVersion !== pending.policyVersion) {
    return requireReevaluation(response)
  }

  return response.behavior === 'allow'
    ? allowFromRemote(response)
    : denyFromRemote(response)
}
```

策略版本变了怎么办？

保守做法：

```txt
重新评估 policy
如果仍然 ask，再要求重新审批
如果变成 deny，直接 deny
如果变成 allow，可以自动继续，但要记录 policy_changed_allow
```

不要拿旧策略下的审批去执行新输入。

## 审计事件

第 60 章已经做了 approval ledger。

现在要把 policy decision 写进去。

事件：

```ts
export type PolicyAuditEvent = {
  type: 'policy_decision'
  requestId: string
  sessionId: string
  toolUseId: string
  toolName: string
  canonicalToolName: string
  inputHash: string
  behavior: 'allow' | 'deny' | 'ask'
  reasonType: string
  matchedRule?: {
    source: string
    behavior: string
    value: string
  }
  policyVersion: string
  mode: PermissionMode
  createdAt: number
}
```

必须在以下位置记录：

```txt
策略直接 allow
策略直接 deny
策略返回 ask
用户审批 allow
用户审批 deny
远程审批 allow
远程审批 deny
mode 后处理 deny
classifier allow / deny
```

这样回放时可以验证：

```txt
同一输入 hash
同一 policy version
同一 rule source
同一 behavior
```

如果策略版本不同，回放应该明确输出：

```txt
historical policy differs from current policy
```

而不是假装结果一致。

## 策略解释器

策略结果需要转成人能看懂的文案。

不要让 UI 到处拼字符串。

```ts
export function explainPolicyDecision(decision: PolicyDecision): string {
  switch (decision.reason.type) {
    case 'rule':
      return `${decision.reason.behavior} by ${decision.reason.rule.source}: ${decision.reason.rule.raw}`
    case 'mode':
      return `Permission mode ${decision.reason.mode} decided this request`
    case 'safetyCheck':
      return `Safety check requires review: ${decision.reason.detail}`
    case 'mcpPolicy':
      return `MCP policy for ${decision.reason.serverName}: ${decision.reason.detail}`
    case 'managedPolicy':
      return `Managed policy ${decision.reason.key}: ${decision.reason.detail}`
    case 'tool':
      return `${decision.reason.toolName}: ${decision.reason.detail}`
    case 'fallback':
      return decision.reason.detail
  }
}
```

审计用结构化字段，UI 用解释器。

不要在审计里只存最终字符串。

字符串会变，结构不能变。

## Shadowed Rule 检测

当用户添加规则时，要提示被遮蔽的规则。

例如：

```txt
deny:  Bash(git push:*)
allow: Bash(git push origin main)
```

`allow` 实际永远不会生效。

再比如：

```txt
ask:   Read(src/secrets/**)
allow: Read(src/**)
```

读取 `src/secrets/**` 应该仍然 ask。

规则检测可以输出：

```ts
export type ShadowedRuleWarning = {
  rule: NormalizedPermissionRule
  shadowedBy: NormalizedPermissionRule
  reason: 'deny-overrides' | 'ask-overrides' | 'broader-rule'
}
```

这不是运行时必需，但对 `/permissions` 很重要。

用户看到规则列表时应该知道哪些规则不会生效。

## 设置写入安全

所有自动写入都要过同一个函数。

```ts
export function applyPermissionUpdateSafely(
  context: ToolPermissionContext,
  update: PermissionUpdate,
  snapshot: PolicySnapshot,
): ToolPermissionContext {
  validatePermissionUpdate(update)

  if (!canPersistPermissionUpdate(update, snapshot)) {
    return context
  }

  return applyPermissionUpdate(context, update)
}
```

要拒绝：

```txt
写入 policySettings
写入 flagSettings
managed-only 下写入任何规则
非法 ruleContent
空规则
MCP rule 带括号内容
危险 whole-tool allow
```

远程审批返回的 `updatedPermissions` 同样如此。

不要因为它来自“审批按钮”就信任。

## 与 hooks 的关系

PermissionRequest hook 也是策略链的一部分，但它不是静态规则。

建议位置：

```txt
policy static rules
tool-specific checks
safety checks
mode checks
dynamic hooks
interactive ask
```

如果 headless 模式不能弹窗，可以允许 hook 做最后决策：

```txt
ask -> hook allow / deny -> otherwise deny
```

但 hook 不能覆盖：

```txt
deny rule
safetyCheck deny
managed policy deny
MCP server deny
```

否则组织策略会被本地 hook 绕过。

## 与 auto mode 的关系

auto mode classifier 是 `ask` 的替代审批者。

它不应该参与：

```txt
deny rule
managed deny
MCP deny
safetyCheck non-approvable
requiresUserInteraction
```

换句话说：

```txt
static policy says deny -> deny
static policy says allow -> allow
static policy says ask -> classifier may decide
```

classifier 输出也要变成策略审计事件：

```txt
reason.type = classifier
classifier = auto-mode
behavior = allow / deny
```

这样远程和本地审计可以统一。

## 最小测试清单

这一章要补的测试可以分成六组。

规则解析：

```txt
Tool -> whole tool
Tool(*) -> whole tool
Tool() -> whole tool
Tool(a\(b\)) -> content with parentheses
legacy tool name -> canonical tool name
```

行为优先级：

```txt
deny beats ask
deny beats allow
ask beats allow
allow only applies when deny and ask miss
```

来源策略：

```txt
policySettings rule is read-only
managed-only ignores user rules
managed-only rejects new persisted rules
flagSettings cannot be deleted
session rules are in-memory only
```

MCP：

```txt
mcp__server matches all tools in server
mcp__server__* matches all tools in server
mcp__server__tool matches one tool
builtin Write rule does not match MCP Write display name
deniedMcpServers wins over allowedMcpServers
empty allowedMcpServers blocks all non-sdk servers
```

安全顺序：

```txt
safetyCheck beats bypassPermissions
requiresUserInteraction beats bypassPermissions
tool-specific ask beats bypassPermissions
tool-specific deny beats bypassPermissions
```

远程审批：

```txt
request includes policyVersion
request includes matchedRule
response hash mismatch is rejected
policy version mismatch triggers reevaluation
updatedPermissions rejected under managed-only
```

## 示例测试

```ts
test('deny beats allow across sources', async () => {
  const snapshot = policySnapshot({
    rules: [
      rule('allow', 'localSettings', 'Bash(git push origin main)'),
      rule('deny', 'policySettings', 'Bash(git push:*)'),
    ],
  })

  const decision = await evaluatePolicy(
    bashRequest('git push origin main'),
    snapshot,
    BashTool,
    context(),
  )

  expect(decision.behavior).toBe('deny')
  expect(decision.reason.type).toBe('rule')
  expect(decision.audit.matchedRule?.source).toBe('policySettings')
})
```

```ts
test('managed-only ignores local allow rules', async () => {
  const snapshot = policySnapshot({
    settings: { allowManagedPermissionRulesOnly: true },
    rules: [
      rule('allow', 'localSettings', 'Bash(git status:*)'),
      rule('ask', 'policySettings', 'Bash(git status:*)'),
    ],
  })

  const decision = await evaluatePolicy(
    bashRequest('git status --short'),
    snapshot,
    BashTool,
    context(),
  )

  expect(decision.behavior).toBe('ask')
  expect(decision.audit.matchedRule?.source).toBe('policySettings')
})
```

```ts
test('builtin rule does not match mcp tool display name', async () => {
  const snapshot = policySnapshot({
    rules: [rule('deny', 'userSettings', 'Write')],
  })

  const decision = await evaluatePolicy(
    mcpRequest({
      serverName: 'docs',
      toolName: 'Write',
      displayName: 'docs - Write',
    }),
    snapshot,
    mcpTool(),
    context(),
  )

  expect(decision.behavior).toBe('ask')
  expect(decision.audit.canonicalToolName).toBe('mcp__docs__Write')
})
```

```ts
test('safety check beats bypass mode', async () => {
  const snapshot = policySnapshot({
    rules: [rule('allow', 'session', 'Edit(.claude/**)')],
  })

  const decision = await evaluatePolicy(
    editRequest('.claude/settings.json', {
      permissionMode: 'bypassPermissions',
    }),
    snapshot,
    EditTool,
    context(),
  )

  expect(decision.behavior).toBe('ask')
  expect(decision.reason.type).toBe('safetyCheck')
})
```

## CLI 调试命令

为了接近官方体验，可以加一个内部调试命令：

```txt
/policy explain Bash "git status --short"
```

输出：

```txt
Tool: Bash
Canonical: Bash
Mode: default
Decision: allow
Reason: matched allow rule
Rule: Bash(git status:*)
Source: local settings
Policy version: 8f6a4c2
```

再加一个 MCP 调试：

```txt
/policy mcp github
```

输出：

```txt
Server: github
Decision: allowed
Reason: matched allowedMcpServers by serverName
Source: enterprise managed settings
```

这些命令不需要暴露给普通用户，但开发 Mini 时非常有用。

## 迁移策略

不要一次性重写所有工具。

建议分三步。

第一步：只抽出纯函数。

```txt
parseRuleValue
stringifyRuleValue
canonicalToolName
matchToolRule
matchMcpToolRule
matchShellRule
```

第二步：增加 policy snapshot。

```txt
buildPolicySnapshot
collectPermissionRules
hashPolicy
explainPolicyDecision
```

第三步：把 `hasPermissionsToUseTool` 的前半段替换为 `evaluatePolicy`。

先保持旧函数签名不变：

```ts
export const hasPermissionsToUseTool: CanUseToolFn = async (
  tool,
  input,
  context,
  assistantMessage,
  toolUseID,
) => {
  const snapshot = buildPolicySnapshotFromAppState(context.getAppState())
  const request = buildPolicyRequest(tool, input, context, toolUseID)
  const decision = await evaluatePolicy(request, snapshot, tool, context)
  return applyModeAndPromptPolicy(decision, request, snapshot, context, assistantMessage)
}
```

这样 REPL、headless、remote、SDK 都不用立刻改。

## 常见错误

错误一：

```txt
把 policySettings 当成普通 settings 合并
```

后果：

```txt
低优先级托管来源可能污染高优先级来源
管理员无法解释最终策略
```

正确：

```txt
policySettings first-source-wins
```

错误二：

```txt
allow rule 覆盖 deny rule
```

正确：

```txt
deny always wins
```

错误三：

```txt
bypassPermissions 先于 safetyCheck
```

正确：

```txt
safetyCheck before bypassPermissions
```

错误四：

```txt
MCP display name 参与权限匹配
```

正确：

```txt
canonical mcp__server__tool 参与权限匹配
```

错误五：

```txt
远程审批能写 updatedPermissions
```

正确：

```txt
远程 updatedPermissions 只是请求
本地 policy engine 决定是否接受
```

错误六：

```txt
managed-only 只隐藏 UI，不改运行时
```

正确：

```txt
UI 和运行时都必须执行 managed-only
运行时是最终边界
```

错误七：

```txt
审计只记录 allow / deny
```

正确：

```txt
记录 behavior + reason + matchedRule + source + policyVersion + inputHash
```

## 本章完成后的能力

Mini 的权限系统现在从：

```txt
工具自己问权限
```

升级成：

```txt
统一 policy layer 决定权限
```

它具备：

```txt
rule DSL
rule validation
rule normalization
source-aware permission rules
managed-only permission mode
MCP server policy
MCP tool canonical matching
deny / ask / allow ordering
safetyCheck bypass immunity
policy snapshot
policy version
policy audit event
remote approval policy context
```

这让 Mini 更接近官方 Claude Code：

```txt
管理员能定义组织边界
用户能理解每次审批为什么出现
远程端只能审批，不能篡改策略
MCP 工具不会和内置工具混淆
安全路径不会被普通 allow 规则绕过
审计回放能解释当时的策略状态
```

## 和官方 Claude Code 的差距

这一章仍然没有覆盖所有官方细节。

仍然缺：

```txt
参数级 MCP tool input policy
组织策略服务端签名
策略差量下发
策略热更新冲突提示
策略模拟器 UI
跨设备 actor identity
remote push approval notification
policy audit export signature
tamper-evident audit chain
classifier policy budget
subcommand AST 级策略 DSL
PowerShell constrained-language policy
plugin marketplace enterprise policy
skill / agent / hook policy unification
```

但核心骨架已经建立：

```txt
权限不是弹窗
权限是策略决策
策略决策必须可解释
可解释决策才能审计
可审计决策才能安全回放
```

下一章可以继续补 **插件、技能、Agent 与 Hook 的统一策略治理**：把 tools 之外的扩展能力也纳入同一套 enterprise policy，让 Claude Code 的可扩展性不会绕过权限边界。
