# 07 - 企业级架构闭环

## 当前章节目标

本章像一个 feature PR：实现 closure checklist UI，用可见清单判断 Client 是否形成企业级闭环。完成后不新增页面文档，只在现有 ProductShell 里挂一个 Closure 面板，逐项显示 Workspace、Editor、Terminal、Agent、Diff、Session、Plugin、Policy、Audit、Release 是否具备 policy、audit 和 recovery 覆盖。

## 本章改动路径

```text
src/enterprise/closure/closureTypes.ts
src/enterprise/closure/closureChecklist.fixture.ts
src/enterprise/closure/closureChecklistService.ts
src/enterprise/closure/closureStore.ts
src/enterprise/closure/ClosureChecklistPanel.tsx
```

## 闭环标准

```text
Workspace
  -> Editor
  -> Terminal
  -> Agent
  -> Diff
  -> Session
  -> Plugin
  -> Policy
  -> Audit
  -> Release
```

如果一个模块不能被审计、不能被策略约束、不能在失败后恢复，它就还不是企业级能力。

## 类型骨架

`src/enterprise/closure/closureTypes.ts`

```ts
export type ClosureStatus = "covered" | "partial" | "missing";

export type ClosureChecklistItem = {
  id: string;
  module: string;
  policy: ClosureStatus;
  audit: ClosureStatus;
  recovery: ClosureStatus;
  visibleProof: string;
  nextAction: string;
};

export type ClosureChecklistViewModel = {
  overallStatus: ClosureStatus;
  items: ClosureChecklistItem[];
};
```

## Closure Checklist Fixture

`src/enterprise/closure/closureChecklist.fixture.ts`

```ts
import type { ClosureChecklistItem } from "./closureTypes";

export const closureChecklistFixture: ClosureChecklistItem[] = [
  {
    id: "workspace",
    module: "Workspace",
    policy: "covered",
    audit: "covered",
    recovery: "covered",
    visibleProof: "Workspace scope is shown in ProductShell and diagnostics bundle.",
    nextAction: "Keep workspace id attached to every enterprise event.",
  },
  {
    id: "editor",
    module: "Editor",
    policy: "covered",
    audit: "partial",
    recovery: "covered",
    visibleProof: "Large file readonly mode appears in Performance Dashboard.",
    nextAction: "Add audit row for readonly downgrade reason.",
  },
  {
    id: "terminal",
    module: "Terminal",
    policy: "covered",
    audit: "covered",
    recovery: "partial",
    visibleProof: "Terminal command permission and ring buffer truncation are visible.",
    nextAction: "Add resume proof for interrupted terminal task.",
  },
  {
    id: "agent",
    module: "Agent",
    policy: "covered",
    audit: "covered",
    recovery: "covered",
    visibleProof: "Tool event and permission decision appear in Audit rows.",
    nextAction: "Keep plan timeline linked to session id.",
  },
  {
    id: "diff",
    module: "Diff",
    policy: "covered",
    audit: "covered",
    recovery: "covered",
    visibleProof: "Patch accepted / rejected event appears in audit fixture.",
    nextAction: "Keep reject reason visible in timeline.",
  },
  {
    id: "session",
    module: "Session",
    policy: "partial",
    audit: "covered",
    recovery: "covered",
    visibleProof: "Release matrix requires transcript resume smoke test.",
    nextAction: "Add policy rule for cross-workspace resume.",
  },
  {
    id: "plugin",
    module: "Plugin",
    policy: "covered",
    audit: "covered",
    recovery: "covered",
    visibleProof: "workspace.local-helper is denied by policy and logged in audit.",
    nextAction: "Keep supply-chain checks tied to release matrix.",
  },
  {
    id: "policy",
    module: "Policy",
    policy: "covered",
    audit: "covered",
    recovery: "partial",
    visibleProof: "Settings rows show source badge, locked state and reason.",
    nextAction: "Add offline policy cache refresh state.",
  },
  {
    id: "audit",
    module: "Audit",
    policy: "covered",
    audit: "covered",
    recovery: "covered",
    visibleProof: "Diagnostics download mock contains redacted audit summary.",
    nextAction: "Keep blocked secret patterns in diagnostics tests.",
  },
  {
    id: "release",
    module: "Release",
    policy: "covered",
    audit: "partial",
    recovery: "covered",
    visibleProof: "Release matrix shows blocked plugin and rollback target.",
    nextAction: "Add audit row for release compatibility check result.",
  },
];
```

## Service 骨架

`src/enterprise/closure/closureChecklistService.ts`

```ts
import { closureChecklistFixture } from "./closureChecklist.fixture";
import type {
  ClosureChecklistViewModel,
  ClosureStatus,
} from "./closureTypes";

const statusRank: Record<ClosureStatus, number> = {
  covered: 0,
  partial: 1,
  missing: 2,
};

export function buildClosureChecklist(): ClosureChecklistViewModel {
  const statuses = closureChecklistFixture.flatMap((item) => [
    item.policy,
    item.audit,
    item.recovery,
  ]);

  const overallStatus = statuses.reduce<ClosureStatus>(
    (current, status) =>
      statusRank[status] > statusRank[current] ? status : current,
    "covered",
  );

  return {
    overallStatus,
    items: closureChecklistFixture,
  };
}
```

## Store 骨架

`src/enterprise/closure/closureStore.ts`

```ts
import { buildClosureChecklist } from "./closureChecklistService";
import type { ClosureChecklistViewModel } from "./closureTypes";

export type ClosureState = {
  checklist: ClosureChecklistViewModel;
  selectedModule: string | null;
};

export function createClosureStore(): ClosureState {
  return {
    checklist: buildClosureChecklist(),
    selectedModule: "Policy",
  };
}
```

## UI 骨架

`src/enterprise/closure/ClosureChecklistPanel.tsx`

```tsx
import { createClosureStore } from "./closureStore";

const state = createClosureStore();

export function ClosureChecklistPanel() {
  const checklist = state.checklist;

  return (
    <section className="closure-checklist-panel">
      <header>
        <h2>Enterprise Closure Checklist</h2>
        <span className={`closure-status status-${checklist.overallStatus}`}>
          closure status: {checklist.overallStatus}
        </span>
      </header>

      <table>
        <thead>
          <tr>
            <th>Module</th>
            <th>Policy</th>
            <th>Audit</th>
            <th>Recovery</th>
            <th>Visible proof</th>
            <th>Next action</th>
          </tr>
        </thead>
        <tbody>
          {checklist.items.map((item) => (
            <tr key={item.id}>
              <td>{item.module}</td>
              <td>{item.policy}</td>
              <td>{item.audit}</td>
              <td>{item.recovery}</td>
              <td>{item.visibleProof}</td>
              <td>{item.nextAction}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
```

## 最终交付

- [Claude Code Client 全景架构图](../../claude-code-client-architecture-map.md)
- [Claude Code Client 源码阅读路线图](../../claude-code-client-source-reading-roadmap.md)

本章不新增文档，只把闭环检查变成 UI 和 fixture。

## Closure checklist

- Workspace：所有文件、session、plugin 都有 workspace scope。
- Editor：写入、refresh、dirty buffer 都有失败边界。
- Terminal：输出预算和权限决策可解释。
- Agent：tool event、plan、diff decision 可进入 timeline。
- Diff：Accept / Reject 可审计、可恢复。
- Session：Resume / Continue 按项目隔离。
- Plugin：manifest、registry、tool、panel、supply chain 可被 policy 约束。
- Policy：能解释来源、锁定和拒绝原因。
- Audit：记录决策，不记录 secrets。
- Release：兼容矩阵和回滚路径明确。

## Smoke Check

执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

最后跑一条端到端人工检查，验证可见 UI：

- Closure 面板顶部显示 `closure status: partial`。
- Checklist table 有 Workspace、Editor、Terminal、Agent、Diff、Session、Plugin、Policy、Audit、Release 十行。
- Policy 行 visible proof 显示 Settings rows 有 policy source badge、locked state 和 reason。
- Plugin 行 visible proof 显示 `workspace.local-helper` 被策略拒绝，并能在 Permission 面板看到 deny reason。
- Audit 行 visible proof 显示 audit rows 和 diagnostics download mock。
- Performance 面板显示 performance budget status，并能解释 readonly、truncated、disabled plugin、runtime resume。
- Release 行 visible proof 显示 release matrix 和 rollback target。
- 打开 workspace，执行一次 fake Agent 修改，审查并 Accept/Reject diff 后，session timeline 能看到 message、tool、diff decision。
- enterprise policy 禁止一个插件来源后，Marketplace、Registry、Permission、Audit 都能解释原因。
- 导出 diagnostics mock 后确认不含 secrets。

## 当前章节缺陷

本章完成的是教学闭环，不等于生产闭环。

生产版还需要远程策略服务、fleet management、集中审计平台、真实插件市场和长期兼容性测试。

## 下一步预告

教程主线到 V10 收束。后续可以回补或深化：

- V9 Marketplace / supply chain。
- Remote session。
- Background task。
- Multi-agent。
- Enterprise admin console。
