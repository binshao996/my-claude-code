# 02 - Settings 与 Policy

## 当前章节目标

本章像一个 feature PR：实现 Settings / Policy 分层、可解释合并结果，以及没有真实企业后端时也能跑出来的 Settings UI。完成后用户应该能在页面上看到当前值、来源层级、锁定状态、policy source badge 和被拒绝原因。

## 本章改动路径

```text
src/enterprise/settings/settingsTypes.ts
src/enterprise/settings/settingsPolicy.fixture.ts
src/enterprise/settings/mergeSettingsPolicy.ts
src/enterprise/settings/settingsStore.ts
src/enterprise/settings/SettingsPolicyPanel.tsx
```

## 设置来源

```text
default settings
  < user settings
  < project settings
  < enterprise managed policy
```

企业策略优先级最高，用户不能覆盖。合并算法要能解释每个最终值来自哪里，而不是只返回最终配置对象。

## 类型骨架

`src/enterprise/settings/settingsTypes.ts`

```ts
export type PolicySource = "default" | "user" | "project" | "enterprise";

export type ClientSettings = {
  editor: {
    fontSize: number;
    theme: "dark" | "light";
  };
  terminal: {
    defaultProfile: string | null;
  };
  agent: {
    defaultPermissionMode: "read_only" | "workspace_write";
    dangerousMode: boolean;
  };
  plugins: {
    allowedSources: Array<"official" | "workspace" | "private-registry">;
  };
};

export type EnterprisePolicy = {
  managedSettings: Partial<ClientSettings>;
  allowedTools: string[];
  deniedTools: string[];
  allowedPluginSources: ClientSettings["plugins"]["allowedSources"];
  requireApprovalForCommands: boolean;
  disableDangerousMode: boolean;
  disabledPlugins: string[];
  reasonByPath: Record<string, string>;
};

export type PolicyResolution<T> = {
  path: string;
  value: T;
  source: PolicySource;
  locked: boolean;
  reason: string;
};

export type SettingsPolicyViewModel = {
  rows: Array<PolicyResolution<string | number | boolean | string[] | null>>;
  deniedPlugins: Array<{
    pluginId: string;
    source: string;
    reason: string;
  }>;
};
```

## Settings / Policy Merge Fixture

`src/enterprise/settings/settingsPolicy.fixture.ts`

```ts
import type { ClientSettings, EnterprisePolicy } from "./settingsTypes";

export const defaultSettingsFixture: ClientSettings = {
  editor: { fontSize: 14, theme: "dark" },
  terminal: { defaultProfile: "zsh" },
  agent: { defaultPermissionMode: "read_only", dangerousMode: false },
  plugins: { allowedSources: ["official", "workspace", "private-registry"] },
};

export const userSettingsFixture: Partial<ClientSettings> = {
  editor: { fontSize: 16, theme: "dark" },
  agent: { dangerousMode: true, defaultPermissionMode: "workspace_write" },
};

export const projectSettingsFixture: Partial<ClientSettings> = {
  terminal: { defaultProfile: "bash" },
  plugins: { allowedSources: ["official", "workspace"] },
};

export const enterprisePolicyFixture: EnterprisePolicy = {
  managedSettings: {
    agent: { dangerousMode: false, defaultPermissionMode: "read_only" },
    plugins: { allowedSources: ["official"] },
  },
  allowedTools: ["read_file", "grep", "list_files"],
  deniedTools: ["run_shell", "write_file"],
  allowedPluginSources: ["official"],
  requireApprovalForCommands: true,
  disableDangerousMode: true,
  disabledPlugins: ["workspace.local-helper"],
  reasonByPath: {
    "agent.dangerousMode": "Dangerous mode is disabled by enterprise policy.",
    "plugins.allowedSources": "Only official plugins are allowed on managed workspaces.",
  },
};
```

这个 fixture 要让 UI 立刻出现冲突：用户想开启 dangerous mode，项目允许 workspace 插件，但 enterprise policy 锁回只读和 official source。

## Service 骨架

`src/enterprise/settings/mergeSettingsPolicy.ts`

```ts
import type {
  ClientSettings,
  EnterprisePolicy,
  PolicyResolution,
  SettingsPolicyViewModel,
} from "./settingsTypes";

type Layer = {
  source: PolicyResolution<unknown>["source"];
  settings: Partial<ClientSettings>;
};

const settingPaths = [
  "editor.fontSize",
  "editor.theme",
  "terminal.defaultProfile",
  "agent.defaultPermissionMode",
  "agent.dangerousMode",
  "plugins.allowedSources",
] as const;

function readPath(source: Partial<ClientSettings>, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (!value || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[key];
  }, source);
}

export function mergeSettingsPolicy(params: {
  defaults: ClientSettings;
  user: Partial<ClientSettings>;
  project: Partial<ClientSettings>;
  enterprise: EnterprisePolicy;
}): SettingsPolicyViewModel {
  const layers: Layer[] = [
    { source: "default", settings: params.defaults },
    { source: "user", settings: params.user },
    { source: "project", settings: params.project },
    { source: "enterprise", settings: params.enterprise.managedSettings },
  ];

  const rows = settingPaths.map((path) => {
    const winner = layers.reduce<PolicyResolution<unknown>>(
      (current, layer) => {
        const value = readPath(layer.settings, path);
        if (value === undefined) return current;
        return {
          path,
          value,
          source: layer.source,
          locked: layer.source === "enterprise",
          reason:
            params.enterprise.reasonByPath[path] ??
            `Resolved from ${layer.source} settings.`,
        };
      },
      {
        path,
        value: null,
        source: "default",
        locked: false,
        reason: "No value configured.",
      },
    );

    return winner as PolicyResolution<string | number | boolean | string[] | null>;
  });

  return {
    rows,
    deniedPlugins: params.enterprise.disabledPlugins.map((pluginId) => ({
      pluginId,
      source: "workspace",
      reason: "Workspace plugin source is blocked by enterprise policy.",
    })),
  };
}
```

## Store 骨架

`src/enterprise/settings/settingsStore.ts`

```ts
import {
  defaultSettingsFixture,
  enterprisePolicyFixture,
  projectSettingsFixture,
  userSettingsFixture,
} from "./settingsPolicy.fixture";
import { mergeSettingsPolicy } from "./mergeSettingsPolicy";

export function createSettingsPolicyStore() {
  let viewModel = mergeSettingsPolicy({
    defaults: defaultSettingsFixture,
    user: userSettingsFixture,
    project: projectSettingsFixture,
    enterprise: enterprisePolicyFixture,
  });

  return {
    getSnapshot() {
      return viewModel;
    },
    updateUserSetting(path: string, value: unknown) {
      const locked = viewModel.rows.find((row) => row.path === path)?.locked;
      if (locked) {
        return {
          accepted: false,
          reason: enterprisePolicyFixture.reasonByPath[path],
        };
      }

      viewModel = mergeSettingsPolicy({
        defaults: defaultSettingsFixture,
        user: { ...userSettingsFixture, [path]: value },
        project: projectSettingsFixture,
        enterprise: enterprisePolicyFixture,
      });

      return { accepted: true, reason: "Updated user settings." };
    },
  };
}
```

真实实现里 `updateUserSetting` 要用结构化 patch 写入设置文件。教学骨架先用 fixture 保证 UI 能显示 rejected result。

## UI 骨架

`src/enterprise/settings/SettingsPolicyPanel.tsx`

```tsx
import { createSettingsPolicyStore } from "./settingsStore";

const store = createSettingsPolicyStore();

export function SettingsPolicyPanel() {
  const snapshot = store.getSnapshot();

  return (
    <section className="settings-policy-panel">
      <header>
        <h2>Settings & Policy</h2>
        <span className="badge badge-enterprise">policy source: enterprise</span>
      </header>

      <table>
        <thead>
          <tr>
            <th>Setting</th>
            <th>Value</th>
            <th>Source</th>
            <th>State</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {snapshot.rows.map((row) => (
            <tr key={row.path} data-locked={row.locked}>
              <td>{row.path}</td>
              <td>{String(row.value)}</td>
              <td>
                <span className={`source-badge source-${row.source}`}>
                  {row.source}
                </span>
              </td>
              <td>{row.locked ? "locked" : "editable"}</td>
              <td>{row.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Policy denied plugins</h3>
      <ul>
        {snapshot.deniedPlugins.map((plugin) => (
          <li key={plugin.pluginId}>
            <strong>{plugin.pluginId}</strong>
            <span className="source-badge source-enterprise">enterprise</span>
            <span>{plugin.reason}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

## 本章交付

- `default -> user -> project -> enterprise` 合并链。
- 每个最终值都有 `PolicyResolution<T>`。
- UI 显示当前值、来源、locked、reason。
- 用户修改被 enterprise policy 拒绝时返回明确 reason。
- 插件 source 被策略拒绝时能显示 denied plugin row。

## Smoke Check

执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

准备 `enterprisePolicyFixture` 后验证可见 UI：

- Settings 面板顶部显示 `policy source: enterprise` badge。
- `agent.dangerousMode` 行显示 value 为 `false`、source 为 `enterprise`、state 为 `locked`。
- `plugins.allowedSources` 行显示只允许 `official`，reason 为 `Only official plugins are allowed on managed workspaces.`。
- `workspace.local-helper` 出现在 Policy denied plugins 区域。
- 尝试修改 locked setting 时 UI 显示拒绝原因，不写入 user settings。
- Audit / Diagnostics / Performance / Release 入口仍保留上一章的 mock 状态：audit rows、diagnostics download mock、performance budget status、release matrix 摘要都能打开查看。
- policy resolution 不输出 secrets 或完整 `.env` 值。

## 当前章节缺陷

本章不实现远程策略下发，也不实现离线策略缓存刷新。

## 下一章预告

下一章会实现权限治理，把工具、命令、插件和 Diff 决策纳入统一权限模型。
