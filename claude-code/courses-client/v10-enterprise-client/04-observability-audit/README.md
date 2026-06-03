# 04 - Observability 与 Audit

## 当前章节目标

本章实现可观测和审计边界。

## Audit 事件

```ts
export type AuditEvent =
  | { type: "tool_call"; toolName: string; sessionId: string; timestamp: string }
  | { type: "permission_decision"; behavior: string; reason: string; timestamp: string }
  | { type: "patch_decision"; diffId: string; decision: string; timestamp: string }
  | { type: "plugin_loaded"; pluginId: string; timestamp: string };
```

## Audit 设计原则

- 记录决策，不记录 secrets。
- 记录来源，不记录完整文件内容。
- 记录工具输入摘要，不记录未脱敏 terminal output。
- 记录插件来源和版本，不记录插件私有配置。
- 记录失败原因，方便支持团队复现边界条件。

## 诊断包

诊断包应包含：

- app version。
- workspace metadata。
- session id。
- redacted logs。
- tool timeline summary。
- policy summary。

不能包含：

- secrets。
- `.env` 值。
- private keys。
- 未脱敏 terminal output。

## 本章交付

本章交付 Audit Trail 和 Diagnostics Bundle。

Audit 事件需要覆盖：

- tool call。
- permission decision。
- patch decision。
- plugin load / disable / policy denied。
- release compatibility check。

Diagnostics bundle 只能包含 redacted logs、summary、policy resolution 和版本信息。

## Smoke Check

执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

触发一次 tool、一次 permission、一次 plugin policy denied 后导出 diagnostics：

- Audit Trail 能按时间看到三类事件。
- 事件里有 sessionId / workspaceId / source / reason。
- `.env` 值、private key、token、未脱敏 terminal output 不出现在包内。
- redaction 后仍能解释失败原因。
- 诊断包生成失败时只提示错误，不上传或写出半成品。

## 当前章节缺陷

本章只定义本地诊断包，不做云端 observability 平台。

## 下一章预告

下一章会处理性能与韧性：大项目、长会话、失败恢复和降级策略。
