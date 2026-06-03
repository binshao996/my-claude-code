# 05 - 性能与韧性

## 当前章节目标

本章像一个 feature PR：实现 Performance Dashboard fixture，让大项目、长会话、Runtime 断开、插件 panel 异常这些风险有可见状态。完成后不需要真实压测平台，也能在 UI 中看到 performance budget status、降级原因和恢复动作。

## 本章改动路径

```text
src/enterprise/performance/performanceTypes.ts
src/enterprise/performance/performanceBudget.fixture.ts
src/enterprise/performance/performanceBudgetService.ts
src/enterprise/performance/performanceStore.ts
src/enterprise/performance/PerformanceDashboard.tsx
```

## 性能风险

| 模块 | 风险 | 策略 | 可见 UI |
| --- | --- | --- | --- |
| File Tree | 大项目扫描卡顿 | ignore、max nodes、lazy load | lazy loading / ignored count |
| Editor | 大文件卡顿 | size limit、readonly mode | readonly mode reason |
| Terminal | 输出过大 | ring buffer | truncated marker |
| Chat | 长会话 | compaction、virtual list | rendered window size |
| Agent Workspace | event 过多 | timeline windowing | visible range |
| Plugin Panel | panel 异常 | isolate plugin | disabled panel reason |
| Runtime | sidecar 断开 | preserve state | resume / diagnostics action |

## 类型骨架

`src/enterprise/performance/performanceTypes.ts`

```ts
export type BudgetStatus = "pass" | "degraded" | "failed";

export type PerformanceBudgetItem = {
  id: string;
  label: string;
  metric: string;
  budget: string;
  actual: string;
  status: BudgetStatus;
  userVisibleResult: string;
  recoveryAction: "none" | "readonly" | "truncate" | "window" | "disable_plugin" | "resume";
};

export type PerformanceDashboardViewModel = {
  overallStatus: BudgetStatus;
  items: PerformanceBudgetItem[];
};
```

## Performance Dashboard Fixture

`src/enterprise/performance/performanceBudget.fixture.ts`

```ts
import type { PerformanceBudgetItem } from "./performanceTypes";

export const performanceBudgetFixture: PerformanceBudgetItem[] = [
  {
    id: "file-tree-100k",
    label: "File Tree",
    metric: "workspace files",
    budget: "<= 10k visible nodes",
    actual: "100k files, 8k visible, 92k ignored",
    status: "degraded",
    userVisibleResult: "Lazy loading enabled. 92k ignored by enterprise file budget.",
    recoveryAction: "window",
  },
  {
    id: "editor-10mb",
    label: "Editor",
    metric: "file size",
    budget: "<= 5MB editable",
    actual: "10MB",
    status: "degraded",
    userVisibleResult: "Readonly mode enabled because file exceeds editable size limit.",
    recoveryAction: "readonly",
  },
  {
    id: "terminal-ring-buffer",
    label: "Terminal",
    metric: "terminal output",
    budget: "<= 5k buffered lines",
    actual: "25k lines, 5k retained",
    status: "degraded",
    userVisibleResult: "Terminal output truncated. Older lines are available only in diagnostics summary.",
    recoveryAction: "truncate",
  },
  {
    id: "plugin-panel-crash",
    label: "Plugin Panel",
    metric: "panel health",
    budget: "0 uncaught panel errors",
    actual: "1 fixture panel error",
    status: "failed",
    userVisibleResult: "workspace.local-helper panel disabled. Core Shell remains usable.",
    recoveryAction: "disable_plugin",
  },
  {
    id: "runtime-disconnect",
    label: "Runtime",
    metric: "sidecar connection",
    budget: "connected",
    actual: "disconnected fixture event",
    status: "failed",
    userVisibleResult: "Chat transcript preserved. Resume and diagnostics actions are visible.",
    recoveryAction: "resume",
  },
];
```

## Service 骨架

`src/enterprise/performance/performanceBudgetService.ts`

```ts
import { performanceBudgetFixture } from "./performanceBudget.fixture";
import type {
  BudgetStatus,
  PerformanceDashboardViewModel,
} from "./performanceTypes";

const statusRank: Record<BudgetStatus, number> = {
  pass: 0,
  degraded: 1,
  failed: 2,
};

export function buildPerformanceDashboard(): PerformanceDashboardViewModel {
  const overallStatus = performanceBudgetFixture.reduce<BudgetStatus>(
    (current, item) =>
      statusRank[item.status] > statusRank[current] ? item.status : current,
    "pass",
  );

  return {
    overallStatus,
    items: performanceBudgetFixture,
  };
}
```

## Store 骨架

`src/enterprise/performance/performanceStore.ts`

```ts
import { buildPerformanceDashboard } from "./performanceBudgetService";
import type { PerformanceDashboardViewModel } from "./performanceTypes";

export type PerformanceState = {
  dashboard: PerformanceDashboardViewModel;
  selectedBudgetId: string | null;
};

export function createPerformanceStore(): PerformanceState {
  return {
    dashboard: buildPerformanceDashboard(),
    selectedBudgetId: "runtime-disconnect",
  };
}
```

## UI 骨架

`src/enterprise/performance/PerformanceDashboard.tsx`

```tsx
import { createPerformanceStore } from "./performanceStore";

const state = createPerformanceStore();

export function PerformanceDashboard() {
  return (
    <section className="performance-dashboard">
      <header>
        <h2>Performance & Resilience</h2>
        <span className={`budget-status status-${state.dashboard.overallStatus}`}>
          performance budget status: {state.dashboard.overallStatus}
        </span>
      </header>

      <div className="budget-list">
        {state.dashboard.items.map((item) => (
          <article key={item.id} className={`budget-card status-${item.status}`}>
            <header>
              <strong>{item.label}</strong>
              <span>{item.status}</span>
            </header>
            <dl>
              <dt>metric</dt>
              <dd>{item.metric}</dd>
              <dt>budget</dt>
              <dd>{item.budget}</dd>
              <dt>actual</dt>
              <dd>{item.actual}</dd>
              <dt>visible result</dt>
              <dd>{item.userVisibleResult}</dd>
              <dt>recovery</dt>
              <dd>{item.recoveryAction}</dd>
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}
```

## 恢复策略

```text
Runtime failure
  -> preserve transcript
  -> keep UI state
  -> show resume
  -> show diagnostics download mock
```

```text
Plugin failure
  -> isolate plugin
  -> disable panel
  -> keep core app running
  -> write audit row
```

## 本章交付

- Performance Dashboard 显示整体 budget status。
- 每个预算项都有 budget、actual、status、user visible result、recovery action。
- 大项目 File Tree 显示 lazy loading / ignored count。
- 大文件 Editor 显示 readonly mode reason。
- Terminal 大输出显示 truncated marker。
- Plugin panel 异常显示 disabled panel reason。
- Runtime 断开保留 UI state，并提供 Resume 或 Diagnostics。

## Smoke Check

执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

用 fixture 阈值模拟验证可见 UI：

- Performance 面板顶部显示 `performance budget status: failed` 或 `degraded`。
- File Tree 卡片显示 `100k files, 8k visible, 92k ignored` 和 lazy loading 说明。
- Editor 卡片显示 `Readonly mode enabled because file exceeds editable size limit.`。
- Terminal 卡片显示 truncated marker 和 retained line count。
- Plugin Panel 卡片显示 `workspace.local-helper panel disabled`，核心 Shell 仍可切换。
- Runtime 卡片显示 transcript preserved、Resume action、Diagnostics action。
- Audit 面板能看到 plugin panel disabled 或 runtime disconnect 对应 audit rows。
- Settings policy source badge、Permission deny reason、Diagnostics download mock、Release matrix 仍可打开查看。

## 当前章节缺陷

本章不做完整 chaos testing，也不实现真实 SLO 监控。

## 下一章预告

下一章会处理发布、升级与回滚。
