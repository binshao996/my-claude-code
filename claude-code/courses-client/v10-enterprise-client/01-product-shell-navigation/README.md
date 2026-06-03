# 01 - 产品壳与导航

## 当前章节目标

本章像一个 feature PR：把 V2-V9 的 Workspace、Editor、Terminal、Agent、Diff、Session、Plugin 组织进稳定的 ProductShell。完成本章后，即使 Settings、Permission、Audit、Performance、Release 还没有真实后端，也能通过 fixture 在首屏看到企业治理入口。

## 本章改动路径

```text
src/product-shell/ProductShell.tsx
src/product-shell/productShellStore.ts
src/product-shell/navigation.fixture.ts
src/product-shell/ProductShellSmoke.tsx
```

这些文件只负责产品壳和导航状态，不写入 session transcript。

## Shell 结构

```text
ProductShell
  ActivityBar
  WorkspaceSidebar
  MainEditorArea
  RightAgentWorkspace
  BottomTerminalPanel
  EnterpriseOverlayHost
  StatusBar
```

企业级 AI IDE 不是营销页面。第一屏应该直接进入工作区：

- 左侧：Workspace / File Tree / Session / Plugin。
- 中间：Editor。
- 右侧：Chat / Agent Workspace / Diff。
- 底部：Terminal / Problems。
- 浮层：Settings / Permission / Audit / Diagnostics / Performance / Release。

## Store 骨架

`src/product-shell/productShellStore.ts`

```ts
export type EnterpriseOverlay =
  | "settings"
  | "permission"
  | "audit"
  | "diagnostics"
  | "performance"
  | "release"
  | null;

export type ProductShellState = {
  activeWorkspaceId: string | null;
  activeSidebar: "files" | "sessions" | "plugins";
  rightPanel: "chat" | "agent" | "diff";
  bottomPanel: "terminal" | "problems" | null;
  overlay: EnterpriseOverlay;
};

export const initialProductShellState: ProductShellState = {
  activeWorkspaceId: "fixture-workspace",
  activeSidebar: "files",
  rightPanel: "chat",
  bottomPanel: "terminal",
  overlay: null,
};

export type ProductShellAction =
  | { type: "openSidebar"; sidebar: ProductShellState["activeSidebar"] }
  | { type: "openRightPanel"; panel: ProductShellState["rightPanel"] }
  | { type: "toggleBottomPanel"; panel: Exclude<ProductShellState["bottomPanel"], null> }
  | { type: "openOverlay"; overlay: Exclude<EnterpriseOverlay, null> }
  | { type: "closeOverlay" };

export function productShellReducer(
  state: ProductShellState,
  action: ProductShellAction,
): ProductShellState {
  switch (action.type) {
    case "openSidebar":
      return { ...state, activeSidebar: action.sidebar };
    case "openRightPanel":
      return { ...state, rightPanel: action.panel };
    case "toggleBottomPanel":
      return {
        ...state,
        bottomPanel: state.bottomPanel === action.panel ? null : action.panel,
      };
    case "openOverlay":
      return { ...state, overlay: action.overlay };
    case "closeOverlay":
      return { ...state, overlay: null };
  }
}
```

## Navigation Fixture

`src/product-shell/navigation.fixture.ts`

```ts
export const navigationFixture = {
  workspace: { id: "fixture-workspace", name: "enterprise-demo" },
  files: ["src/App.tsx", "src/enterprise/settings/mergePolicy.ts"],
  sessions: ["session-main", "session-release-smoke"],
  plugins: [
    { id: "official.diff-tools", source: "official", status: "enabled" },
    { id: "workspace.local-helper", source: "workspace", status: "policy_denied" },
  ],
  enterpriseBadges: {
    policySource: "enterprise",
    denyReason: "Workspace plugin source is blocked by enterprise policy.",
    auditRows: 3,
    diagnosticsDownload: "mock-ready",
    performanceBudgetStatus: "degraded",
    releaseMatrixStatus: "blocked",
  },
} as const;
```

本章没有真实企业后端时，`navigationFixture.enterpriseBadges` 用来给浮层入口提供可见状态：policy source badge、deny reason、audit rows、diagnostics download mock、performance budget status、release matrix。

## UI 骨架

`src/product-shell/ProductShell.tsx`

```tsx
import { navigationFixture } from "./navigation.fixture";
import {
  initialProductShellState,
  productShellReducer,
  type EnterpriseOverlay,
} from "./productShellStore";

const overlayLabels: Record<Exclude<EnterpriseOverlay, null>, string> = {
  settings: "Settings",
  permission: "Permission",
  audit: "Audit",
  diagnostics: "Diagnostics",
  performance: "Performance",
  release: "Release",
};

export function ProductShell() {
  const [state, dispatch] = useReducer(
    productShellReducer,
    initialProductShellState,
  );

  return (
    <div className="product-shell" data-workspace-id={state.activeWorkspaceId}>
      <nav className="activity-bar">
        {(["files", "sessions", "plugins"] as const).map((sidebar) => (
          <button
            key={sidebar}
            aria-pressed={state.activeSidebar === sidebar}
            onClick={() => dispatch({ type: "openSidebar", sidebar })}
          >
            {sidebar}
          </button>
        ))}
      </nav>

      <aside className="workspace-sidebar">
        <h2>{navigationFixture.workspace.name}</h2>
        <SidebarFixtureView activeSidebar={state.activeSidebar} />
      </aside>

      <main className="main-editor-area">
        <EditorFixture filePath="src/App.tsx" />
      </main>

      <section className="right-agent-workspace">
        <PanelTabs
          active={state.rightPanel}
          tabs={["chat", "agent", "diff"]}
          onSelect={(panel) => dispatch({ type: "openRightPanel", panel })}
        />
        <RightPanelFixture panel={state.rightPanel} />
      </section>

      {state.bottomPanel ? (
        <section className="bottom-terminal-panel">
          <PanelTabs
            active={state.bottomPanel}
            tabs={["terminal", "problems"]}
            onSelect={(panel) => dispatch({ type: "toggleBottomPanel", panel })}
          />
          <TerminalFixture />
        </section>
      ) : null}

      <footer className="status-bar">
        {(Object.keys(overlayLabels) as Array<Exclude<EnterpriseOverlay, null>>).map(
          (overlay) => (
            <button
              key={overlay}
              onClick={() => dispatch({ type: "openOverlay", overlay })}
            >
              {overlayLabels[overlay]}
            </button>
          ),
        )}
      </footer>

      <EnterpriseOverlayHost
        overlay={state.overlay}
        badges={navigationFixture.enterpriseBadges}
        onClose={() => dispatch({ type: "closeOverlay" })}
      />
    </div>
  );
}
```

## 本章交付

- `ProductShellState` 可以切换 sidebar、right panel、bottom panel 和 enterprise overlay。
- 切换导航不丢 editor、terminal、agent workspace 的本地状态。
- Enterprise overlay 用 fixture 显示每个治理模块的可见状态。
- Shell UI state 可以持久化到 UI state，但不能写进 Session transcript。

## Smoke Check

执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

启动后验证可见 UI：

- 默认进入 ProductShell workspace 首屏，不是介绍页。
- ActivityBar 切换 files、sessions、plugins 不丢失 editor 内容。
- 右侧 chat、agent、diff 切换时各自状态保留。
- Terminal panel 可收起，收起不杀掉 Runtime session。
- StatusBar 能打开 Settings、Permission、Audit、Diagnostics、Performance、Release 浮层。
- Settings 浮层能看到 `enterprise` policy source badge。
- Permission 浮层能看到 workspace plugin 的 deny reason。
- Audit 浮层能看到至少 3 条 audit rows。
- Diagnostics 浮层能看到 download mock ready 状态。
- Performance 浮层能看到 `degraded` performance budget status。
- Release 浮层能看到 blocked release matrix 摘要。

## 当前章节缺陷

本章只做产品组织，不处理企业策略的真实合并算法。

## 下一章预告

下一章会实现 Settings 与 Policy，把个人设置、项目设置和企业托管策略分层。
