# 02 - Manifest 模型

## 当前章节目标

本章定义 Client 侧 Plugin Manifest。

## Runtime Manifest

```ts
export type PluginManifest = {
  name: string;
  version?: string;
  description?: string;
  commands?: Record<string, PluginCommandManifest>;
  tools?: Record<string, PluginToolManifest>;
  context?: string[];
};
```

## Client 扩展

```ts
export type ClientPluginManifest = PluginManifest & {
  panels?: Record<string, PluginPanelManifest>;
  permissions?: PluginPermissionManifest;
};

export type PluginPanelManifest = {
  title: string;
  entry: string;
  placement: "sidebar" | "agent-workspace" | "bottom-panel";
};

export type PluginPermissionManifest = {
  filesystem?: "none" | "workspace-read" | "workspace-write";
  shell?: "none" | "ask";
  network?: "none" | "ask";
};
```

## Manifest 校验

```ts
export function validatePluginManifest(input: unknown): ClientPluginManifest {
  const manifest = clientPluginManifestSchema.parse(input);

  if (!/^[a-zA-Z0-9._-]+$/.test(manifest.name)) {
    throw new Error("Invalid plugin name.");
  }

  return manifest;
}
```

## 版本兼容与能力声明

插件 manifest 需要声明自己依赖的 Client / Runtime 版本，以及会新增哪些能力。

```ts
export type PluginCompatibility = {
  client: string;
  runtime: string;
};

export type PluginCapabilitySummary = {
  commands: string[];
  tools: string[];
  panels: string[];
  contextTokens: number;
};
```

这些字段不只是展示信息。它们会进入 Policy 判断：不兼容版本禁止启用，高风险能力默认需要审批。

## Manifest 与 lockfile

manifest 描述插件想要什么，lockfile 固定当前实际安装了什么。

```text
manifest
  -> validate
  -> policy check
  -> lockfile
  -> registry reload
```

不要只信任 manifest 文件名或本地目录名。

## Plugin Manifest Fixture

本章必须提供合法和非法 manifest fixture，后续章节复用合法 fixture 注册 commands、tools 和 panels。

```ts
export const fakeValidPluginManifest: ClientPluginManifest = {
  name: "workspace-helper",
  version: "0.1.0",
  description: "Workspace scoped commands, tools, and panels.",
  compatibility: {
    client: "^9.0.0",
    runtime: "^2.1.0",
  },
  commands: {
    summarize: {
      description: "Summarize the current workspace task",
      argumentHint: "[topic]",
    },
  },
  tools: {
    readWorkspaceNote: {
      description: "Read a note inside the active workspace",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  context: ["Current workspace conventions, capped at 400 tokens."],
  panels: {
    notes: {
      title: "Workspace Notes",
      entry: "panel.html",
      placement: "sidebar",
    },
  },
  permissions: {
    filesystem: "workspace-read",
    shell: "none",
    network: "none",
  },
};

export const fakeInvalidPluginManifest = {
  ...fakeValidPluginManifest,
  name: "../escape",
};
```

```ts
export function summarizePluginCapabilities(
  manifest: ClientPluginManifest,
): PluginCapabilitySummary {
  return {
    commands: Object.keys(manifest.commands ?? {}),
    tools: Object.keys(manifest.tools ?? {}),
    panels: Object.keys(manifest.panels ?? {}),
    contextTokens: estimateContextTokens(manifest.context ?? []),
  };
}
```

UI skeleton：

```tsx
export function ManifestPreview({ manifest }: { manifest: ClientPluginManifest }) {
  const capabilities = summarizePluginCapabilities(manifest);

  return (
    <section className="manifest-preview">
      <h2>{manifest.name}</h2>
      <p>{manifest.version}</p>
      <PluginCapabilityBadges capabilities={capabilities} />
      <PluginPermissionBadges permissions={manifest.permissions} />
    </section>
  );
}
```

## 本章交付

本章交付 manifest schema 和 validation。

schema 必须校验：

- `name` 只允许 `[a-zA-Z0-9._-]`。
- `commands`、`tools`、`panels` 的 key 不能重复占用同一 namespace。
- `permissions` 必须显式声明，缺省按最小权限处理。
- `compatibility.client` / `compatibility.runtime` 不匹配时进入 disabled/error。
- capability summary 可被 UI 和 Policy 读取。

## Smoke Check

执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

用一个合法 manifest 和一个非法 manifest 验证：

- 合法 manifest 在 Plugin Manager 中显示 name、version、capabilities、permissions。
- 合法 fixture 显示 command `summarize`、tool `readWorkspaceNote`、panel `notes`。
- 非法 name 报 `Invalid plugin name.`。
- 声明 workspace-write 或 shell ask 时 UI 标记高风险能力。
- context token 数进入 capability summary。
- 不兼容版本不能进入 enabled 状态。

## 当前章节缺陷

本章只定义 manifest，不实现加载。

## 下一章预告

下一章会实现 Plugin Registry：加载、启用、禁用和 reload。
