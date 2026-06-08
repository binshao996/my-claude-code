# 06 - 发布、升级与回滚

## 当前章节目标

本章像一个 feature PR：实现 Release Compatibility Matrix fixture 和升级 smoke check UI。完成后不需要真实 auto updater，也能看到 Client / Runtime / Plugin / Session / Audit 的兼容矩阵、不兼容原因和 rollback target。

## 本章改动路径

```text
src/enterprise/release/releaseTypes.ts
src/enterprise/release/releaseCompatibility.fixture.ts
src/enterprise/release/releaseCompatibilityService.ts
src/enterprise/release/releaseStore.ts
src/enterprise/release/ReleaseCompatibilityPanel.tsx
```

## 发布内容

- desktop app。
- runtime sidecar。
- plugin compatibility metadata。
- migration scripts。
- release notes。

## 升级策略

```text
download
  -> verify signature
  -> install
  -> migrate
  -> smoke check
  -> rollback if failed
```

升级不能破坏 sessions、workspace metadata、plugin settings 和 audit logs。发布流程要先验证矩阵，再进入灰度；失败时回滚到上一个 Client / Runtime / Plugin 组合。

## 类型骨架

`src/enterprise/release/releaseTypes.ts`

```ts
export type CompatibilityStatus = "compatible" | "warning" | "blocked";

export type ReleaseComponent =
  | "Client"
  | "Runtime"
  | "Plugin"
  | "Session"
  | "Audit";

export type CompatibilityMatrixRow = {
  component: ReleaseComponent;
  currentVersion: string;
  targetVersion: string;
  status: CompatibilityStatus;
  check: string;
  reason: string;
};

export type ReleaseManifest = {
  releaseId: string;
  clientVersion: string;
  runtimeVersion: string;
  pluginLockVersion: string;
  transcriptSchemaVersion: string;
  auditSchemaVersion: string;
  previousKnownGood: {
    clientVersion: string;
    runtimeVersion: string;
    pluginLockVersion: string;
  };
};

export type ReleaseCompatibilityViewModel = {
  releaseId: string;
  overallStatus: CompatibilityStatus;
  rows: CompatibilityMatrixRow[];
  rollbackTarget: string;
};
```

## Release Compatibility Matrix Fixture

`src/enterprise/release/releaseCompatibility.fixture.ts`

```ts
import type { ReleaseManifest } from "./releaseTypes";

export const releaseManifestFixture: ReleaseManifest = {
  releaseId: "v10.0.0-enterprise-fixture",
  clientVersion: "10.0.0",
  runtimeVersion: "10.0.0",
  pluginLockVersion: "2026.06.03",
  transcriptSchemaVersion: "3",
  auditSchemaVersion: "2",
  previousKnownGood: {
    clientVersion: "9.7.2",
    runtimeVersion: "9.7.1",
    pluginLockVersion: "2026.05.20",
  },
};

export const releaseCompatibilityFixture = [
  {
    component: "Client",
    currentVersion: "9.7.2",
    targetVersion: "10.0.0",
    status: "compatible",
    check: "settings migration",
    reason: "Settings schema migration has fixture coverage.",
  },
  {
    component: "Runtime",
    currentVersion: "9.7.1",
    targetVersion: "10.0.0",
    status: "warning",
    check: "event schema adapter",
    reason: "Runtime event schema changed. Adapter smoke test is required.",
  },
  {
    component: "Plugin",
    currentVersion: "2026.05.20",
    targetVersion: "2026.06.03",
    status: "blocked",
    check: "manifest/tool schema + lockfile",
    reason: "workspace.local-helper uses a blocked source and must be disabled.",
  },
  {
    component: "Session",
    currentVersion: "schema-2",
    targetVersion: "schema-3",
    status: "warning",
    check: "transcript resume smoke test",
    reason: "Transcript schema changed. Resume fixture must pass before rollout.",
  },
  {
    component: "Audit",
    currentVersion: "schema-2",
    targetVersion: "schema-2",
    status: "compatible",
    check: "redaction contract",
    reason: "Redaction contract unchanged and diagnostics fixture passes.",
  },
] as const;
```

## Service 骨架

`src/enterprise/release/releaseCompatibilityService.ts`

```ts
import {
  releaseCompatibilityFixture,
  releaseManifestFixture,
} from "./releaseCompatibility.fixture";
import type {
  CompatibilityStatus,
  ReleaseCompatibilityViewModel,
} from "./releaseTypes";

const statusRank: Record<CompatibilityStatus, number> = {
  compatible: 0,
  warning: 1,
  blocked: 2,
};

export function buildReleaseCompatibilityMatrix(): ReleaseCompatibilityViewModel {
  const rows = releaseCompatibilityFixture.map((row) => ({ ...row }));
  const overallStatus = rows.reduce<CompatibilityStatus>(
    (current, row) =>
      statusRank[row.status] > statusRank[current] ? row.status : current,
    "compatible",
  );

  const previous = releaseManifestFixture.previousKnownGood;

  return {
    releaseId: releaseManifestFixture.releaseId,
    overallStatus,
    rows,
    rollbackTarget:
      `Client ${previous.clientVersion} / Runtime ${previous.runtimeVersion}` +
      ` / Plugin lock ${previous.pluginLockVersion}`,
  };
}
```

## Store 骨架

`src/enterprise/release/releaseStore.ts`

```ts
import { buildReleaseCompatibilityMatrix } from "./releaseCompatibilityService";
import type { ReleaseCompatibilityViewModel } from "./releaseTypes";

export type ReleaseState = {
  compatibility: ReleaseCompatibilityViewModel;
  selectedComponent: string | null;
};

export function createReleaseStore(): ReleaseState {
  return {
    compatibility: buildReleaseCompatibilityMatrix(),
    selectedComponent: "Plugin",
  };
}
```

## UI 骨架

`src/enterprise/release/ReleaseCompatibilityPanel.tsx`

```tsx
import { createReleaseStore } from "./releaseStore";

const state = createReleaseStore();

export function ReleaseCompatibilityPanel() {
  const matrix = state.compatibility;

  return (
    <section className="release-compatibility-panel">
      <header>
        <h2>Release Compatibility</h2>
        <span className={`release-status status-${matrix.overallStatus}`}>
          release matrix: {matrix.overallStatus}
        </span>
      </header>

      <table>
        <thead>
          <tr>
            <th>Component</th>
            <th>Current</th>
            <th>Target</th>
            <th>Status</th>
            <th>Check</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {matrix.rows.map((row) => (
            <tr key={row.component} data-status={row.status}>
              <td>{row.component}</td>
              <td>{row.currentVersion}</td>
              <td>{row.targetVersion}</td>
              <td>{row.status}</td>
              <td>{row.check}</td>
              <td>{row.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <aside className="rollback-target">
        <h3>Rollback target</h3>
        <p>{matrix.rollbackTarget}</p>
      </aside>
    </section>
  );
}
```

## 本章交付

- Release compatibility matrix 显示 Client / Runtime / Plugin / Session / Audit。
- 不兼容 plugin 被禁用并写入 reason。
- transcript schema 变化会触发 resume smoke test。
- redaction contract 失败会阻止发布。
- rollback plan 显示上一个可用版本组合和迁移回退状态。

## Smoke Check

执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

用 `releaseManifestFixture` 验证可见 UI：

- Release 面板顶部显示 `release matrix: blocked`。
- Matrix 有 Client、Runtime、Plugin、Session、Audit 五行。
- Plugin 行显示 `blocked`，reason 为 `workspace.local-helper uses a blocked source and must be disabled.`。
- Runtime 行显示 `warning`，并提示 event schema adapter smoke test。
- Session 行显示 `warning`，并提示 transcript resume smoke test。
- Audit 行显示 `compatible`，并显示 redaction contract 通过。
- Rollback target 显示 `Client 9.7.2 / Runtime 9.7.1 / Plugin lock 2026.05.20`。
- Settings policy source badge、Permission deny reason、Audit rows、Diagnostics download mock、Performance budget status 都仍可打开查看。

## 当前章节缺陷

本章不实现具体 auto updater。

## 下一章预告

下一章会收束企业级架构闭环，并给出源码阅读路线。
