# 04 - Observability 与 Audit

## 当前章节目标

本章像一个 feature PR：实现本地 Audit Trail 和 Diagnostics Bundle mock。完成后不需要真实 observability 平台，也能用 fixture 看到 audit rows，点击 diagnostics download mock，并验证包内只包含 redacted summary。

## 本章改动路径

```text
src/enterprise/observability/auditTypes.ts
src/enterprise/observability/auditDiagnostics.fixture.ts
src/enterprise/observability/auditStore.ts
src/enterprise/observability/diagnosticsService.ts
src/enterprise/observability/AuditDiagnosticsPanel.tsx
```

## Audit 类型

`src/enterprise/observability/auditTypes.ts`

```ts
export type AuditEvent =
  | {
      id: string;
      type: "tool_call";
      toolName: string;
      sessionId: string;
      workspaceId: string;
      source: "runtime";
      redactedInputSummary: string;
      timestamp: string;
    }
  | {
      id: string;
      type: "permission_decision";
      behavior: "allow" | "ask" | "deny";
      sessionId: string;
      workspaceId: string;
      source: "enterprise" | "session" | "user";
      reason: string;
      timestamp: string;
    }
  | {
      id: string;
      type: "patch_decision";
      diffId: string;
      decision: "accepted" | "rejected";
      sessionId: string;
      workspaceId: string;
      source: "user";
      reason: string;
      timestamp: string;
    }
  | {
      id: string;
      type: "plugin_policy_denied";
      pluginId: string;
      sessionId: string;
      workspaceId: string;
      source: "enterprise";
      reason: string;
      timestamp: string;
    };

export type DiagnosticsBundle = {
  fileName: string;
  appVersion: string;
  workspaceId: string;
  sessionId: string;
  generatedAt: string;
  redactedLogs: string[];
  auditSummary: Array<Pick<AuditEvent, "id" | "type" | "timestamp">>;
  policySummary: {
    source: "enterprise";
    lockedSettings: string[];
    deniedPlugins: string[];
  };
};
```

## Audit / Diagnostics Fixture

`src/enterprise/observability/auditDiagnostics.fixture.ts`

```ts
import type { AuditEvent, DiagnosticsBundle } from "./auditTypes";

export const auditEventsFixture: AuditEvent[] = [
  {
    id: "audit-tool-1",
    type: "tool_call",
    toolName: "read_file",
    sessionId: "session-main",
    workspaceId: "fixture-workspace",
    source: "runtime",
    redactedInputSummary: "path=<workspace-file>",
    timestamp: "2026-06-03T10:00:00.000Z",
  },
  {
    id: "audit-permission-1",
    type: "permission_decision",
    behavior: "deny",
    sessionId: "session-main",
    workspaceId: "fixture-workspace",
    source: "enterprise",
    reason: "Workspace plugin source is blocked by enterprise policy.",
    timestamp: "2026-06-03T10:01:00.000Z",
  },
  {
    id: "audit-plugin-1",
    type: "plugin_policy_denied",
    pluginId: "workspace.local-helper",
    sessionId: "session-main",
    workspaceId: "fixture-workspace",
    source: "enterprise",
    reason: "Only official plugins are allowed on managed workspaces.",
    timestamp: "2026-06-03T10:02:00.000Z",
  },
  {
    id: "audit-patch-1",
    type: "patch_decision",
    diffId: "diff-123",
    decision: "accepted",
    sessionId: "session-main",
    workspaceId: "fixture-workspace",
    source: "user",
    reason: "User accepted reviewed diff.",
    timestamp: "2026-06-03T10:03:00.000Z",
  },
];

export const diagnosticsBundleFixture: DiagnosticsBundle = {
  fileName: "diagnostics-fixture-workspace-session-main.zip",
  appVersion: "10.0.0-fixture",
  workspaceId: "fixture-workspace",
  sessionId: "session-main",
  generatedAt: "2026-06-03T10:04:00.000Z",
  redactedLogs: [
    "runtime connected",
    "tool read_file input path=<workspace-file>",
    "permission denied reason=<enterprise-policy>",
    "terminal output=<redacted>",
  ],
  auditSummary: auditEventsFixture.map(({ id, type, timestamp }) => ({
    id,
    type,
    timestamp,
  })),
  policySummary: {
    source: "enterprise",
    lockedSettings: ["agent.dangerousMode", "plugins.allowedSources"],
    deniedPlugins: ["workspace.local-helper"],
  },
};
```

## Store 骨架

`src/enterprise/observability/auditStore.ts`

```ts
import { auditEventsFixture } from "./auditDiagnostics.fixture";
import type { AuditEvent } from "./auditTypes";

export type AuditState = {
  events: AuditEvent[];
  selectedType: AuditEvent["type"] | "all";
};

export function createAuditStore(): AuditState {
  return {
    events: auditEventsFixture,
    selectedType: "all",
  };
}

export function selectAuditRows(state: AuditState) {
  if (state.selectedType === "all") return state.events;
  return state.events.filter((event) => event.type === state.selectedType);
}
```

## Diagnostics Service 骨架

`src/enterprise/observability/diagnosticsService.ts`

```ts
import { diagnosticsBundleFixture } from "./auditDiagnostics.fixture";
import type { DiagnosticsBundle } from "./auditTypes";

const blockedPatterns = [/BEGIN PRIVATE KEY/, /API_KEY=/, /TOKEN=/, /\.env=/];

export function buildDiagnosticsBundle(): DiagnosticsBundle {
  const serialized = JSON.stringify(diagnosticsBundleFixture);
  const leaked = blockedPatterns.some((pattern) => pattern.test(serialized));

  if (leaked) {
    throw new Error("Diagnostics bundle contains unredacted secret-like content.");
  }

  return diagnosticsBundleFixture;
}

export function createDiagnosticsDownloadMock() {
  const bundle = buildDiagnosticsBundle();

  return {
    fileName: bundle.fileName,
    status: "mock-ready" as const,
    sizeLabel: "fixture bundle",
    preview: {
      auditRows: bundle.auditSummary.length,
      redactedLogs: bundle.redactedLogs.length,
      policySource: bundle.policySummary.source,
    },
  };
}
```

## UI 骨架

`src/enterprise/observability/AuditDiagnosticsPanel.tsx`

```tsx
import { createAuditStore, selectAuditRows } from "./auditStore";
import { createDiagnosticsDownloadMock } from "./diagnosticsService";

const auditState = createAuditStore();
const diagnostics = createDiagnosticsDownloadMock();

export function AuditDiagnosticsPanel() {
  const rows = selectAuditRows(auditState);

  return (
    <section className="audit-diagnostics-panel">
      <header>
        <h2>Audit & Diagnostics</h2>
        <span className="source-badge source-enterprise">policy source: enterprise</span>
      </header>

      <div className="diagnostics-download">
        <button type="button">Download diagnostics mock</button>
        <span>{diagnostics.status}</span>
        <span>{diagnostics.fileName}</span>
      </div>

      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Type</th>
            <th>Source</th>
            <th>Reason / Summary</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((event) => (
            <tr key={event.id}>
              <td>{event.timestamp}</td>
              <td>{event.type}</td>
              <td>{"source" in event ? event.source : "runtime"}</td>
              <td>
                {"reason" in event
                  ? event.reason
                  : event.redactedInputSummary}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
```

## 设计原则

- 记录决策，不记录 secrets。
- 记录来源，不记录完整文件内容。
- 记录工具输入摘要，不记录未脱敏 terminal output。
- 记录插件来源和版本，不记录插件私有配置。
- 诊断包生成失败时只提示错误，不上传或写出半成品。

## 本章交付

- Audit 事件覆盖 tool call、permission decision、patch decision、plugin policy denied。
- Diagnostics bundle 包含 app version、workspace metadata、session id、redacted logs、tool timeline summary、policy summary。
- Diagnostics bundle 不包含 secrets、`.env` 值、private keys、未脱敏 terminal output。
- UI 能显示 audit rows 和 diagnostics download mock。

## Smoke Check

执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

触发 fixture 后验证可见 UI：

- Audit 面板顶部显示 `policy source: enterprise` badge。
- Audit table 至少有 4 条 audit rows：tool_call、permission_decision、plugin_policy_denied、patch_decision。
- permission_decision 行显示 deny reason：`Workspace plugin source is blocked by enterprise policy.`。
- plugin_policy_denied 行显示 enterprise source 和 denied plugin id。
- Diagnostics 区域显示 `Download diagnostics mock` 按钮、`mock-ready` 状态和文件名。
- Diagnostics preview 显示 audit row count、redacted log count、policy source。
- 搜索 diagnostics preview 和 redacted logs，看不到 `.env`、private key、token、未脱敏 terminal output。
- ProductShell 仍可打开 Settings policy source badge、Permission deny reason、Performance budget status 和 Release matrix。

## 当前章节缺陷

本章只定义本地诊断包，不做云端 observability 平台。

## 下一章预告

下一章会处理性能与韧性：大项目、长会话、失败恢复和降级策略。
