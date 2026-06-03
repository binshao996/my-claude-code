# Client Runtime Skeleton

这个示例是 V0-V10 教学代码片段的承接骨架。它不接真实 Claude Code Runtime，不发网络请求，也不引入任何依赖，只演示 Client 侧最重要的几条边界：

```text
Workspace
  -> RuntimeClient
  -> FakeRuntimeAdapter
  -> RuntimeEvent Stream
  -> ClientEventState
  -> SessionStore
```

## 文件结构

```text
src/
  index.ts           # 可运行入口，串起一次伪 Agent 会话
  runtime-client.ts  # Client 依赖的 RuntimeClient / RuntimeAdapter 边界
  event-state.ts     # RuntimeEvent -> ClientEventState 的事件状态流
  workspace.ts       # 工作区模型和 Runtime 上下文绑定
  session-store.ts   # 轻量内存会话存储
```

## 运行方式

在仓库根目录执行：

```bash
bun run courses-client/examples/client-runtime-skeleton/src/index.ts
```

如果只想阅读，建议顺序是：

1. `src/runtime-client.ts`
2. `src/event-state.ts`
3. `src/workspace.ts`
4. `src/session-store.ts`
5. `src/index.ts`

## 设计约束

- Runtime 只通过 `RuntimeAdapter` 注入，Client 不直接依赖 Runtime 内部类。
- 事件流使用 `AsyncGenerator` 表达，方便替换成本地进程、sidecar worker 或远程 Runtime。
- 状态更新集中在 reducer 中，UI 只消费 `ClientEventState`。
- 会话存储先用内存实现，后续 V8 可替换为 transcript、SQLite 或远程存储。
