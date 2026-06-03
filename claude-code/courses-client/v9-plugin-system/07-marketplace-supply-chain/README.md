# 07 - Marketplace & Supply Chain

## 当前章节目标

本章把插件从本地扩展升级为可治理生态。

V9 前 6 章已经完成 manifest、registry、commands、tools、panels 和生命周期。生产级 Client 还需要回答另一个问题：插件从哪里来，是否可信，安装后是否可追溯。

## Marketplace 边界

Marketplace 不是一个简单的插件列表。它至少要包含：

```ts
export type MarketplacePlugin = {
  id: string;
  name: string;
  version: string;
  publisher: string;
  source: "official" | "workspace" | "private-registry";
  compatibility: {
    clientVersion: string;
    runtimeVersion: string;
  };
  capabilities: PluginCapability[];
  signature?: PluginSignature;
};

export type PluginSignature = {
  status: "verified" | "missing" | "invalid";
  signer?: string;
  digest?: string;
};

export type PluginCapability =
  | { type: "command"; id: string }
  | { type: "tool"; name: string; permission: "ask" | "deny-by-default" }
  | { type: "context"; maxTokens: number }
  | { type: "panel"; placement: "sidebar" | "agent-workspace" | "bottom-panel" };
```

Client 展示 Marketplace 时，不只展示插件名称，还要展示 capabilities、来源、版本和企业策略结果。

## 安装流程

```text
Discover
  -> Policy Check
  -> Download
  -> Signature Verify
  -> Manifest Validate
  -> Lockfile Write
  -> Registry Reload
  -> Audit Event
```

这里的关键点是：安装插件不能绕过 `PluginRegistry`，也不能绕过 V10 的 Policy / Audit。

## Lockfile

lockfile 用来固定插件来源和版本，避免同名插件或隐式升级改变行为。

```ts
export type PluginLockfile = {
  version: 1;
  plugins: Array<{
    id: string;
    version: string;
    source: string;
    integrity: string;
    installedAt: string;
    approvedBy?: string;
  }>;
};
```

生产版 Client 在启动时应比较：

- manifest 声明。
- lockfile 记录。
- 实际插件文件 hash。
- 企业策略允许的版本范围。

任意一项不一致，都应该进入禁用或重新审批流程。

## 供应链审计

插件系统至少要产生这些 audit event：

```ts
export type PluginSupplyChainAuditEvent =
  | { type: "plugin_discovered"; pluginId: string; source: string; timestamp: string }
  | { type: "plugin_install_requested"; pluginId: string; version: string; timestamp: string }
  | { type: "plugin_signature_verified"; pluginId: string; signer: string; timestamp: string }
  | { type: "plugin_policy_denied"; pluginId: string; reason: string; timestamp: string }
  | { type: "plugin_lockfile_changed"; pluginId: string; version: string; timestamp: string };
```

审计事件只记录必要元数据，不记录插件配置中的 secrets。

## 企业策略

企业策略应能控制：

- 允许哪些插件来源。
- 是否必须签名。
- 是否允许 workspace 本地插件。
- 插件是否可以注册 tool。
- 插件 context token 上限。
- 插件 panel 是否允许加载远程资源。

```ts
export type PluginEnterprisePolicy = {
  allowedSources: Array<"official" | "workspace" | "private-registry">;
  requireSignature: boolean;
  allowLocalWorkspacePlugins: boolean;
  maxContextTokensPerPlugin: number;
  allowRemotePanelAssets: boolean;
};
```

## Local Marketplace Fixture

本章必须提供本地 marketplace fixture，不依赖真实远程市场：

```ts
export const fakeMarketplaceCatalog: MarketplacePlugin[] = [
  {
    id: "official.workspace-helper",
    name: "Workspace Helper",
    version: "0.1.0",
    publisher: "Claude Code",
    source: "official",
    compatibility: {
      clientVersion: "^9.0.0",
      runtimeVersion: "^2.1.0",
    },
    capabilities: [
      { type: "command", id: "summarize" },
      { type: "tool", name: "readWorkspaceNote", permission: "ask" },
      { type: "panel", placement: "sidebar" },
    ],
    signature: {
      status: "verified",
      signer: "Claude Code Marketplace",
      digest: "sha256:fixture-official",
    },
  },
  {
    id: "workspace.unsigned-helper",
    name: "Unsigned Workspace Helper",
    version: "0.1.0",
    publisher: "Local Workspace",
    source: "workspace",
    compatibility: {
      clientVersion: "^9.0.0",
      runtimeVersion: "^2.1.0",
    },
    capabilities: [{ type: "tool", name: "localShellBridge", permission: "deny-by-default" }],
  },
];

export const fakeMarketplacePolicy: PluginEnterprisePolicy = {
  allowedSources: ["official", "private-registry"],
  requireSignature: true,
  allowLocalWorkspacePlugins: false,
  maxContextTokensPerPlugin: 500,
  allowRemotePanelAssets: false,
};
```

```ts
export type MarketplacePolicyVerdict =
  | { status: "allowed"; badge: "signed"; reason: null }
  | { status: "denied"; badge: "unsigned"; reason: string }
  | { status: "requires-approval"; badge: "review"; reason: string };

export function evaluateMarketplacePlugin(
  plugin: MarketplacePlugin,
  policy: PluginEnterprisePolicy,
): MarketplacePolicyVerdict {
  if (!policy.allowedSources.includes(plugin.source)) {
    return {
      status: "denied",
      badge: plugin.signature ? "signed" : "unsigned",
      reason: `Source ${plugin.source} is not allowed by policy.`,
    };
  }

  if (policy.requireSignature && plugin.signature?.status !== "verified") {
    return {
      status: "denied",
      badge: "unsigned",
      reason: "Signature is required by policy.",
    };
  }

  return { status: "allowed", badge: "signed", reason: null };
}
```

## Marketplace UI Skeleton

```tsx
export function MarketplaceList({
  catalog,
  policy,
}: {
  catalog: MarketplacePlugin[];
  policy: PluginEnterprisePolicy;
}) {
  return (
    <section className="marketplace-list">
      <h2>Marketplace</h2>
      {catalog.map(plugin => {
        const verdict = evaluateMarketplacePlugin(plugin, policy);

        return (
          <article key={plugin.id}>
            <strong>{plugin.name}</strong>
            <span>{plugin.version}</span>
            <span>{plugin.source}</span>
            <SignatureBadge badge={verdict.badge} />
            {verdict.reason ? <p role="alert">{verdict.reason}</p> : null}
            <button type="button" disabled={verdict.status === "denied"}>
              Install
            </button>
          </article>
        );
      })}
    </section>
  );
}
```

## 本章交付

本章交付 Marketplace / Supply Chain 的可治理切片，不要求真实远程市场。

必须能展示并记录：

- plugin source：official / workspace / private-registry。
- signature 状态：verified / missing / invalid。
- lockfile integrity。
- policy verdict：allowed / denied / requires approval。
- audit event：discovered、install requested、signature verified、policy denied、lockfile changed。

## Smoke Check

执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

用一个官方插件和一个 workspace 本地插件验证：

- Marketplace 列表显示来源、版本、capabilities、compatibility。
- 官方 fixture 显示 signed badge，workspace unsigned fixture 显示 deny reason。
- `requireSignature=true` 时未签名插件不能安装。
- workspace 插件显示 `Source workspace is not allowed by policy.` 或 `Signature is required by policy.`。
- 安装成功后写入 lockfile，并触发 registry reload。
- 篡改插件 hash 后启动时进入 disabled 或 requires approval。
- audit event 不记录 secrets、token、插件私有配置。

## 当前章节缺陷

本章只建立 marketplace 和供应链治理模型，不实现真实远程插件市场、证书体系和隔离运行时。

## 下一版本预告

V10 会把插件策略接入 Settings / Policy、Permission Governance 和 Audit，形成企业级 Client 闭环。
