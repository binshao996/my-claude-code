# Claude Code Client

这是 `courses-client/` 教程对应的可运行企业级 AI Coding Agent Client 切片。

它先用 fake Runtime Adapter 跑通产品链路，避免模型 key、Electron 原生模块、PTY、企业后端还没接入时看不到效果。后续接真实 Electron main / preload / Runtime IPC 时，保留当前 `RuntimeAdapter -> RuntimeEvent -> ClientState` 边界即可。

## 运行

当前机器的 `pnpm` 被 Node 14 限制拦住，因此默认命令使用 Bun：

```bash
bun install
bun run dev
bun run typecheck
bun run test
bun run build
```

启动后打开：

```text
http://127.0.0.1:5174/
```

如果本机 Node 升级到 `>=16.14`，也可以用 `pnpm` 执行同名脚本。

## 教程章节映射

| 章节 | 当前可见效果 |
| --- | --- |
| V0 | fake Runtime 事件流、session started、turn started |
| V1 | streaming chat、message composer、code block 渲染 |
| V2 | workspace 项目卡片、cwd/trust 状态 |
| V3 | file tree、搜索、open file intent |
| V4 | editor tabs、dirty state、save buffer |
| V5 | terminal command input、实时输出 fixture |
| V6 | plan view、tool timeline、permission queue |
| V7 | diff viewer、accept/reject patch |
| V8 | session list、switch/resume 状态 |
| V9 | plugin manifest、enable/disable、capability tags |
| V10 | policy rules、audit stream、release compatibility |

## 核心文件

- `src/domain.ts`：Client/Runtime 共享语义类型。
- `src/runtime/fakeRuntime.ts`：无模型 key 也能跑的 Runtime Adapter。
- `src/store/clientStore.ts`：RuntimeEvent reducer 和 UI action reducer。
- `src/App.tsx`：企业客户端主界面。
- `src/test/smoke.ts`：事件流 smoke check。
