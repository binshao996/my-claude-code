# Claude Code Client 源码阅读路线图

## 先读什么

1. `src/entrypoints/cli.tsx`
2. `src/main.tsx`
3. `src/query.ts`
4. `src/QueryEngine.ts`
5. `src/screens/REPL.tsx`

先理解 Runtime 如何启动、如何进入 Agent Loop、如何处理流式响应。

## 再读什么

1. `src/services/api/claude.ts`
2. `src/Tool.ts`
3. `src/tools.ts`
4. `packages/builtin-tools/src/tools/`
5. `src/context.ts`
6. `src/utils/claudemd.ts`

这一组负责模型请求、工具注册、上下文和记忆。

## Client 侧重点

1. `src/components/`
2. `src/components/permissions/`
3. `src/components/design-system/`
4. `src/state/AppState.tsx`
5. `src/state/AppStateStore.ts`
6. `packages/@ant/ink/`

这里对应终端 UI。桌面 Client 教程不是照搬 Ink UI，而是把这些产品语义迁移到 Desktop / Workspace / Editor / Terminal。

## 插件与企业能力

1. `src/plugins/`
2. `src/plugins/builtinPlugins.ts`
3. `src/state/AppStateStore.ts`
4. `src/remote/`
5. `packages/remote-control-server/`

这些模块对应 V9 / V10 的扩展、远程、权限和企业治理方向。

## 哪些可以后看

- Voice。
- Computer Use。
- Remote Control 高级协议。
- Marketplace supply chain。
- Daemon / background task。

这些能力重要，但不影响 Client 主线理解。

## Runtime 与 Client 边界

```text
Runtime:
  Agent Loop
  Tool Calling
  Context
  Permission
  Session transcript

Client:
  Workspace
  Editor
  Terminal
  Agent Workspace
  Diff Review
  Plugin UI
  Enterprise Shell
```

读源码时不要把两者混在一起。教程的核心价值就是把 Runtime 能力产品化为 Client 能力。

