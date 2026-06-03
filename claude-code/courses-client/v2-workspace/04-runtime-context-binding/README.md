# 04 - Runtime Context 绑定

## 当前章节目标

本章把 Workspace 和 Runtime 绑定起来。

完成后：

- 当前 Workspace 会驱动 RuntimeClient 创建。
- Runtime 的 `cwd` 来自 `workspace.rootPath`。
- `SessionStore` 按项目隔离。
- `MemoryStore` 按项目读取。
- Chat Client 可以显示当前项目上下文。

## 为什么不能复用旧 Runtime

当用户从项目 A 切到项目 B 时，如果继续复用旧 Runtime，会出现严重问题：

- Agent 仍然在项目 A 的 cwd 下执行工具。
- Session transcript 写到项目 A。
- Memory 读取项目 A 的 `CLAUDE.md`。
- 工具权限和 readFileState 混用。

所以 V2 使用简单但清晰的策略：

```text
workspace changed
  -> dispose old runtime
  -> create new RuntimeClient for workspace
  -> reset chat state
```

这不是最高性能方案，但最适合教学，也最不容易出错。

## RuntimeFactory

```ts
export async function createRuntimeClientForWorkspace(
  workspace: Workspace,
): Promise<RuntimeClient> {
  return createRuntimeClient({
    cwd: workspace.rootPath,
    workspaceId: workspace.id,
  });
}
```

如果沿用 V0 的 `createRuntimeClient(cwd)`，也应该在 V2 包一层：

```ts
export async function createRuntimeClientForWorkspace(
  workspace: Workspace,
): Promise<RuntimeClient> {
  return createRuntimeClient(workspace.rootPath);
}
```

这样后续要给 Runtime 注入 workspace metadata 时，不需要改 UI。

## RuntimeScope

```ts
export type RuntimeScope = {
  workspaceId: string;
  cwd: string;
  runtime: RuntimeClient;
};
```

`RuntimeScope` 是 UI 和 Runtime 之间的当前绑定关系。

```ts
export async function createRuntimeScope(
  workspace: Workspace,
): Promise<RuntimeScope> {
  return {
    workspaceId: workspace.id,
    cwd: workspace.rootPath,
    runtime: await createRuntimeClientForWorkspace(workspace),
  };
}
```

## React 绑定

```tsx
export function RuntimeProvider({ children }: { children: React.ReactNode }) {
  const workspace = useWorkspaceSelector(selectCurrentWorkspace);
  const [scope, setScope] = useState<RuntimeScope | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      if (!workspace) {
        setScope(null);
        return;
      }

      const nextScope = await createRuntimeScope(workspace);
      if (!cancelled) {
        setScope(nextScope);
      }
    }

    void boot();

    return () => {
      cancelled = true;
    };
  }, [workspace?.id]);

  return (
    <RuntimeContext.Provider value={scope}>
      {children}
    </RuntimeContext.Provider>
  );
}
```

生产实现要在 cleanup 中 dispose 旧 runtime。V2 教学版先保留 `cancelled`，避免异步返回后写入过期状态。

## Chat 提交时校验 Workspace

```ts
export async function submitWorkspacePrompt(
  scope: RuntimeScope | null,
  text: string,
) {
  if (!scope) {
    throw new Error("Open a workspace before starting chat.");
  }

  for await (const event of scope.runtime.send({ text })) {
    // 复用 V1 runtimeEventToChatAction
  }
}
```

不要允许无 Workspace 的 Chat 提交。否则 Agent 的 cwd 会不明确，后续工具调用风险很高。

## 与 claude-code-mini 的对应关系

当前 Runtime 中已经有这些项目级入口：

```text
new SessionStore(options.cwd)
new ChatSession(..., { cwd: options.cwd })
new MemoryStore(options.cwd)
ToolContext.cwd
ChatSession.buildRuntimeContext()
```

V2 的工作不是重写它们，而是保证这些 `cwd` 全部来自同一个 `Workspace.rootPath`。

## 调试验证

验证步骤：

1. 打开项目 A。
2. 提交 prompt：`输出当前工作目录`。
3. 确认 Runtime 上下文是项目 A。
4. 切换项目 B。
5. 再提交同样 prompt。
6. 确认 Runtime 上下文变成项目 B。

还要确认：

- 项目切换后旧 ChatState 被清理或归档。
- transcript path 随项目变化。
- memory context 不串项目。

## 本章实操标准

### 本章效果

完成本章后，当前 Workspace 会成为 Runtime 的唯一 cwd 来源：

```text
WorkspaceStore.current
  -> RuntimeProvider
  -> createRuntimeClientForWorkspace(workspace)
  -> RuntimeScope { workspaceId, cwd, runtime }
  -> Chat submit
  -> Runtime event cwd/session/memory
```

用户切换项目后，Chat 和 Runtime 都切到新项目，Header 展示的 root path 与 Runtime cwd 一致。

### 改动文件

本章改动文件：

```text
src/main/runtime/createRuntimeClientForWorkspace.ts
src/renderer/runtime/RuntimeProvider.tsx
src/renderer/runtime/RuntimeContext.ts
src/renderer/chat/submitWorkspacePrompt.ts
src/renderer/components/WorkspaceShell.tsx
src/renderer/components/ChatScreen.tsx
src/renderer/chat/chatStore.ts
```

如果 V0/V1 已经有 `createRuntimeClient(cwd)`，本章只包一层 `createRuntimeClientForWorkspace(workspace)`，不要改 Runtime 内部实现。

### 实现步骤

1. 在 main/runtime 或共享 runtime 入口新增 `createRuntimeClientForWorkspace(workspace)`，把 `workspace.rootPath` 传给旧 Runtime factory。
2. 定义 `RuntimeScope { workspaceId, cwd, runtime }`，UI 不再单独传 `cwd`。
3. 在 `RuntimeProvider` 订阅 `selectCurrentWorkspace()`；workspace id 变化时 dispose 旧 Runtime、创建新 RuntimeScope。
4. workspace 为空时 `RuntimeContext` 返回 `null`，Chat submit 必须拒绝提交并提示先打开 workspace。
5. workspace 变化后 reset 或归档 V1 `ChatState`，避免项目 A 的消息留在项目 B。
6. `ChatScreen` header 继续显示 WorkspaceHeader 的 root path，同时 chat header/session event 的 cwd 要与 scope.cwd 一致。

### 运行命令

在 Client 工程根目录执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

如果本章引入新依赖，安装命令必须写在本章正文中，并在运行前执行。

### 你应该看到

手动验证步骤：

1. 打开项目 A，确认 `WorkspaceHeader.rootPath` 是 A。
2. 提交 `输出当前工作目录`。
3. assistant 或 Runtime event 日志里的 cwd 是 A。
4. 切换到项目 B，Header 变成 B，旧 chat state 被清空或切走。
5. 再提交同样 prompt，Runtime cwd 是 B。
6. 关闭应用再打开，从 recent 进入 B，Runtime 仍然以 B 为 cwd。

还要验证没有打开 workspace 时，PromptComposer 不能提交，或提交时显示 `Open a workspace before starting chat.`。

### 常见报错

- 切换项目后工具仍在旧目录执行：确认 RuntimeProvider 的 effect 依赖是 `workspace?.id`，并且旧 runtime 已 dispose。
- Header 是 B 但 Runtime cwd 是 A：Chat submit 不能缓存旧 runtime，要从 `RuntimeContext` 读取当前 scope。
- 没有 workspace 也能发 prompt：`submitWorkspacePrompt()` 必须显式检查 `scope`。
- 旧项目消息留在新项目：workspace id 变化时 reset V1 chat store，或按 workspace id 分桶保存。
- session/memory 串项目：确认 SessionStore、MemoryStore、ToolContext 的 cwd 都来自 `workspace.rootPath`。

## 可运行验收

本章完成后执行 V2 完整 smoke check：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

最终页面必须能打开项目、显示 workspace header、持久化 recent list，并让 Runtime cwd 与当前 workspace root 保持一致。

## 当前章节缺陷

本章采用切换项目即重建 Runtime 的策略。

后续生产实现可以优化为：

- Runtime pool。
- 多 Workspace 并行。
- 切换时保留每项目 ChatState。
- 后台预热最近项目 Runtime。

但这些优化必须建立在 Workspace 边界清晰之后。

## 下一版本预告

V3 会实现 File Tree。

V2 已经让 Client 知道当前项目是谁。V3 会让用户看到项目里有什么：

```text
Workspace.rootPath
  -> directory scan
  -> ignore rules
  -> file tree state
  -> open file intent
```

到 V3，Chat Client 会第一次和项目文件结构产生可视化联动。
