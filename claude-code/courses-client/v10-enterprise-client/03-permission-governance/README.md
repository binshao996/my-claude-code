# 03 - 权限治理

## 当前章节目标

本章像一个 feature PR：把单个权限弹窗升级为统一 Permission Governance。完成后即使没有真实 Runtime，也能用 fake permission decisions 在 UI 里看到 allow / ask / deny、deny reason、source、scope，并把结果送入 redacted audit event。

## 本章改动路径

```text
src/enterprise/permissions/permissionTypes.ts
src/enterprise/permissions/permissionDecisions.fixture.ts
src/enterprise/permissions/permissionGovernor.ts
src/enterprise/permissions/permissionStore.ts
src/enterprise/permissions/PermissionGovernancePanel.tsx
```

## 权限对象

`src/enterprise/permissions/permissionTypes.ts`

```ts
export type PermissionSubject =
  | { type: "tool"; name: string }
  | { type: "command"; command: string }
  | { type: "plugin"; pluginId: string; capability: "tool" | "command" | "panel" }
  | { type: "patch"; diffId: string }
  | { type: "dangerous_mode"; workspaceId: string };

export type PermissionBehavior = "allow" | "ask" | "deny";

export type PermissionDecision = {
  id: string;
  subject: PermissionSubject;
  behavior: PermissionBehavior;
  source: "enterprise" | "project" | "session" | "user";
  scope: "workspace" | "session" | "one_time";
  reason: string;
  audit: {
    redactedSummary: string;
    timestamp: string;
  };
};
```

权限治理的重点不是弹窗数量，而是每次决策都能说明来源、原因和影响范围。

## Fake Decisions Fixture

`src/enterprise/permissions/permissionDecisions.fixture.ts`

```ts
import type { PermissionDecision, PermissionSubject } from "./permissionTypes";

export const fakePermissionSubjects: PermissionSubject[] = [
  { type: "tool", name: "read_file" },
  { type: "tool", name: "write_file" },
  { type: "command", command: "rm -rf ./dist" },
  { type: "plugin", pluginId: "workspace.local-helper", capability: "tool" },
  { type: "patch", diffId: "diff-123" },
  { type: "dangerous_mode", workspaceId: "fixture-workspace" },
];

export const fakePermissionDecisions: PermissionDecision[] = [
  {
    id: "decision-read-file",
    subject: { type: "tool", name: "read_file" },
    behavior: "allow",
    source: "enterprise",
    scope: "workspace",
    reason: "Read-only tools are allowed by enterprise policy.",
    audit: {
      redactedSummary: "tool=read_file path=<workspace-file>",
      timestamp: "2026-06-03T10:00:00.000Z",
    },
  },
  {
    id: "decision-write-file",
    subject: { type: "tool", name: "write_file" },
    behavior: "ask",
    source: "session",
    scope: "one_time",
    reason: "Write requires explicit approval for this session.",
    audit: {
      redactedSummary: "tool=write_file path=<workspace-file>",
      timestamp: "2026-06-03T10:01:00.000Z",
    },
  },
  {
    id: "decision-plugin-deny",
    subject: { type: "plugin", pluginId: "workspace.local-helper", capability: "tool" },
    behavior: "deny",
    source: "enterprise",
    scope: "workspace",
    reason: "Workspace plugin source is blocked by enterprise policy.",
    audit: {
      redactedSummary: "plugin=workspace.local-helper capability=tool",
      timestamp: "2026-06-03T10:02:00.000Z",
    },
  },
  {
    id: "decision-dangerous-mode",
    subject: { type: "dangerous_mode", workspaceId: "fixture-workspace" },
    behavior: "deny",
    source: "enterprise",
    scope: "workspace",
    reason: "Dangerous mode is disabled by enterprise policy.",
    audit: {
      redactedSummary: "dangerous_mode workspace=fixture-workspace",
      timestamp: "2026-06-03T10:03:00.000Z",
    },
  },
];
```

## Service 骨架

`src/enterprise/permissions/permissionGovernor.ts`

```ts
import { fakePermissionDecisions } from "./permissionDecisions.fixture";
import type { PermissionDecision, PermissionSubject } from "./permissionTypes";

function subjectKey(subject: PermissionSubject): string {
  switch (subject.type) {
    case "tool":
      return `tool:${subject.name}`;
    case "command":
      return `command:${subject.command}`;
    case "plugin":
      return `plugin:${subject.pluginId}:${subject.capability}`;
    case "patch":
      return `patch:${subject.diffId}`;
    case "dangerous_mode":
      return `dangerous_mode:${subject.workspaceId}`;
  }
}

function decisionKey(decision: PermissionDecision): string {
  return subjectKey(decision.subject);
}

export function decidePermission(subject: PermissionSubject): PermissionDecision {
  const matched = fakePermissionDecisions.find(
    (decision) => decisionKey(decision) === subjectKey(subject),
  );

  if (matched) return matched;

  return {
    id: `decision-${subject.type}-default`,
    subject,
    behavior: "ask",
    source: "session",
    scope: "one_time",
    reason: "No enterprise rule matched. Ask user for one-time approval.",
    audit: {
      redactedSummary: `${subject.type}=<redacted>`,
      timestamp: new Date().toISOString(),
    },
  };
}
```

## Store 骨架

`src/enterprise/permissions/permissionStore.ts`

```ts
import { fakePermissionSubjects } from "./permissionDecisions.fixture";
import { decidePermission } from "./permissionGovernor";
import type { PermissionDecision } from "./permissionTypes";

export type PermissionGovernanceState = {
  decisions: PermissionDecision[];
  selectedDecisionId: string | null;
};

export function createPermissionGovernanceStore(): PermissionGovernanceState {
  return {
    decisions: fakePermissionSubjects.map(decidePermission),
    selectedDecisionId: "decision-plugin-deny",
  };
}
```

## UI 骨架

`src/enterprise/permissions/PermissionGovernancePanel.tsx`

```tsx
import { createPermissionGovernanceStore } from "./permissionStore";

const state = createPermissionGovernanceStore();

function subjectLabel(decision: (typeof state.decisions)[number]) {
  const subject = decision.subject;
  if (subject.type === "tool") return `tool: ${subject.name}`;
  if (subject.type === "command") return `command: ${subject.command}`;
  if (subject.type === "plugin") return `plugin: ${subject.pluginId}`;
  if (subject.type === "patch") return `patch: ${subject.diffId}`;
  return `dangerous mode: ${subject.workspaceId}`;
}

export function PermissionGovernancePanel() {
  return (
    <section className="permission-governance-panel">
      <header>
        <h2>Permission Governance</h2>
        <span className="source-badge source-enterprise">policy source: enterprise</span>
      </header>

      <div className="decision-grid">
        {state.decisions.map((decision) => (
          <article
            key={decision.id}
            className={`decision-card decision-${decision.behavior}`}
          >
            <header>
              <strong>{subjectLabel(decision)}</strong>
              <span>{decision.behavior}</span>
            </header>
            <p>{decision.reason}</p>
            <dl>
              <dt>source</dt>
              <dd>{decision.source}</dd>
              <dt>scope</dt>
              <dd>{decision.scope}</dd>
              <dt>audit</dt>
              <dd>{decision.audit.redactedSummary}</dd>
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}
```

## 权限矩阵

| 对象 | 默认行为 | 可升级条件 | 必须审计 |
| --- | --- | --- | --- |
| 读文件 | ask | workspace trusted | 是 |
| 写文件 | ask | explicit approval | 是 |
| 执行 shell | ask | enterprise allowlist | 是 |
| 插件 tool | deny-by-default | signed plugin + policy allow | 是 |
| 应用 patch | ask | user accepts diff | 是 |
| dangerous mode | deny-by-default | enterprise policy + explicit session mode | 是 |

## 本章交付

- 所有危险动作先变成 `PermissionSubject`。
- 决策结果包含 `behavior`、`reason`、`source`、`scope`。
- `deny` 决策不展示用户覆盖按钮。
- `ask` 决策展示一次性审批入口。
- 每个决策都有 redacted audit summary。

## Smoke Check

执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

逐项验证可见 UI：

- Permission 面板顶部显示 `policy source: enterprise` badge。
- `read_file` 卡片显示 `allow`，reason 为 `Read-only tools are allowed by enterprise policy.`。
- `write_file` 卡片显示 `ask`，并显示 one-time scope。
- `workspace.local-helper` 卡片显示 `deny` 和 deny reason：`Workspace plugin source is blocked by enterprise policy.`。
- `dangerous_mode` 卡片显示 `deny`，且没有用户覆盖按钮。
- 每张卡片都显示 redacted audit summary，不包含 secrets、token、完整命令输出。
- ProductShell 仍可打开 Audit rows、Diagnostics download mock、Performance budget status 和 Release matrix 浮层。

## 当前章节缺陷

本章不做远程审批队列，也不实现集中策略下发服务。

## 下一章预告

下一章会实现 Observability 与 Audit，让企业用户知道发生了什么。
