# 02 - Plan View

## 当前章节目标

本章实现 Plan View。

Runtime 中已经有 `Plan`：

```ts
export type PlanItemStatus = "pending" | "in_progress" | "completed";

export type PlanItem = {
  content: string;
  activeForm: string;
  status: PlanItemStatus;
};

export type Plan = {
  sessionId: string;
  title: string;
  items: PlanItem[];
  createdAt: string;
  updatedAt: string;
};
```

V6 要把它变成用户可读的任务进度。

## AgentPlanView

```ts
export type AgentPlanView = {
  title: string;
  items: Array<{
    id: string;
    content: string;
    activeForm: string;
    status: "pending" | "in_progress" | "completed";
  }>;
  progress: {
    completed: number;
    total: number;
  };
  updatedAt: string;
};
```

## 转换函数

```ts
export function planToView(plan: Plan): AgentPlanView {
  const completed = plan.items.filter(item => item.status === "completed").length;

  return {
    title: plan.title,
    items: plan.items.map((item, index) => ({
      id: `${plan.sessionId}:${index}`,
      content: item.content,
      activeForm: item.activeForm,
      status: item.status,
    })),
    progress: {
      completed,
      total: plan.items.length,
    },
    updatedAt: plan.updatedAt,
  };
}
```

## PlanView

```tsx
export function PlanView({ plan }: { plan: AgentPlanView | null }) {
  if (!plan) {
    return <section className="plan-view empty">No active plan</section>;
  }

  return (
    <section className="plan-view">
      <header>
        <h2>{plan.title}</h2>
        <span>
          {plan.progress.completed}/{plan.progress.total}
        </span>
      </header>

      <ol>
        {plan.items.map(item => (
          <li key={item.id} className={`plan-item ${item.status}`}>
            <span>{renderPlanIcon(item.status)}</span>
            <div>
              <strong>
                {item.status === "in_progress" ? item.activeForm : item.content}
              </strong>
              <small>{item.status}</small>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
```

## 产品设计

Plan View 要展示当前状态，而不是只展示历史文本。

用户最关心：

- 当前正在做什么。
- 哪些已经完成。
- 哪些还没做。
- 计划有没有变化。

## 本章实操：PlanChangedEvent 驱动 PlanView

### 专属改动文件

```text
src/renderer/agent-workspace/types.ts
src/renderer/agent-workspace/planToView.ts
src/renderer/agent-workspace/runtimeEventToAgentAction.ts
src/renderer/agent-workspace/agentWorkspaceStore.ts
src/renderer/agent-workspace/fakeRuntimeEvents.ts
src/renderer/components/PlanView.tsx
src/renderer/components/AgentWorkspacePanel.tsx
```

### 实现步骤

1. 在 `types.ts` 补 `AgentPlanView` 和 `PlanChangedEvent`。
2. 实现 `planToView(plan)`，计算 `completed/total`，为每个 item 生成稳定 id。
3. 在 `runtimeEventToAgentAction.ts` 把 `plan_changed` 或 Runtime `update_plan` 事件转成 `{ type: "plan_updated", plan: planToView(plan) }`。
4. reducer 处理 `plan_updated`：写入 `state.plan`，如果存在 `in_progress` item，把 status 设为 `acting` 或保持当前更高优先级状态。
5. `PlanView` 渲染标题、进度、item 状态图标；空状态显示 `No active plan`。
6. 在 fake events 中加入两次 plan：第一次 3 个 pending/in_progress，第二次 1 个 completed，点击 replay 后 UI 能变化。

### 运行命令

在 Client 工程根目录执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

如果本章引入新依赖，安装命令必须写在本章正文中，并在运行前执行。

### 你应该看到

运行 Electron Client 后，点击 `Replay fake events`，Plan View 出现 3 条任务和 `0/3` 或 `1/3` 进度；再次 replay 更新事件后，完成项图标和进度会变化。

### 常见报错

- Plan item key 抖动导致 UI 重挂：使用 `sessionId:index` 或 Runtime 提供的 item id，不要用随机数。
- `activeForm` 为空：in_progress 时优先展示 `activeForm || content`。
- plan 进度显示 NaN：空 items 时 total 是 0，显示 `0/0` 或空态。

## 可运行验收

本章验收：

- fake plan event 能渲染 Plan View。
- completed 数和 total 正确。
- in_progress item 展示 active form。
- plan 更新不会污染 Tool Timeline 和 Runtime Timeline。

## 当前章节缺陷

本章只展示当前 plan，不展示 plan 变更历史。

## 下一章预告

下一章会实现 Tool Timeline：展示每次工具调用从开始到结果的完整生命周期。
