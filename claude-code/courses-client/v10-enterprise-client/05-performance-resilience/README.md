# 05 - 性能与韧性

## 当前章节目标

本章定义企业级性能和恢复策略。

## 性能风险

| 模块 | 风险 | 策略 |
| --- | --- | --- |
| File Tree | 大项目扫描卡顿 | ignore、max nodes、lazy load |
| Editor | 大文件卡顿 | size limit、readonly mode |
| Terminal | 输出过大 | ring buffer |
| Chat | 长会话 | compaction、virtual list |
| Agent Workspace | event 过多 | timeline windowing |

## 企业级性能预算

| 场景 | 教学版预算 | 生产版验收方向 |
| --- | --- | --- |
| 打开 100k 文件仓库 | lazy scan 可用 | 首屏不阻塞 |
| 10MB 文件 | readonly mode | 明确提示和降级 |
| 1 小时会话 | timeline windowing | 虚拟列表和增量加载 |
| 插件 panel 异常 | disable panel | 不影响核心 Shell |
| Runtime 断开 | preserve state | 可恢复或可诊断 |

## 恢复策略

```text
Runtime failure
  -> preserve transcript
  -> keep UI state
  -> allow resume
```

```text
Plugin failure
  -> isolate plugin
  -> disable panel
  -> keep core app running
```

## 本章交付

本章交付性能预算和降级策略。

每个预算都要有用户可见结果：

- 大项目 File Tree：显示 lazy loading / ignored count。
- 大文件 Editor：进入 readonly mode，并提示原因。
- 长 Session Timeline：windowing 或虚拟列表。
- Terminal 大输出：ring buffer 截断提示。
- Plugin panel 异常：禁用 panel，不影响核心 Shell。
- Runtime 断开：保留 UI state，提供 Resume 或 Diagnostics。

## Smoke Check

执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

用人工阈值模拟验证：

- 文件数超过阈值时 File Tree 不阻塞首屏。
- 打开超过 size limit 的文件显示 readonly 降级提示。
- Timeline 超过窗口大小时滚动仍流畅，只渲染可见范围。
- Terminal 输出超过 ring buffer 后显示截断标记。
- 关闭 Runtime 后 Chat 不清空，用户能导出 diagnostics 或 resume。

## 当前章节缺陷

本章不做完整 chaos testing，也不实现真实 SLO 监控。

## 下一章预告

下一章会处理发布、升级与回滚。
