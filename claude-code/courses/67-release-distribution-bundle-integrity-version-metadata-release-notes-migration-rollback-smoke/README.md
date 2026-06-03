# 第 67 章：发布与分发链路：Build 产物完整性、Bundle 校验、版本元信息、Release Notes、安装迁移、Rollback Safe Pin 与跨平台 Smoke Test

第 66 章补了 `doctor`、`status`、`env` 和 `health runner`。

这解决的是“用户机器上的 Claude Code 为什么坏了”。

本章继续往后走：当我们真的要把 Claude Code 发给用户时，怎么保证发布链路可靠？

一个接近官方 Claude Code 的 CLI，发布链路至少要回答：

- 构建产物是否完整？
- chunk 引用是否断裂？
- 运行时入口是否能启动？
- 版本号是否来自唯一源头？
- feature flag 是否按 build/dev 规则注入？
- 原生二进制是否按平台分发？
- 下载的二进制是否校验过？
- 更新是否能原子切换？
- 旧版本是否能安全保留和清理？
- release notes 是否能按版本展示？
- 出问题时是否能 rollback？
- 每个平台是否有 smoke test？

当前仓库里已经有这些相关实现：

- `build.ts`
- `scripts/defines.ts`
- `scripts/check-bundle-integrity.ts`
- `scripts/smoke-test-commands.ts`
- `scripts/post-build.ts`
- `scripts/vite-plugin-feature-flags.ts`
- `scripts/vite-plugin-import-meta-require.ts`
- `src/utils/nativeInstaller/installer.ts`
- `src/utils/nativeInstaller/download.ts`
- `src/utils/nativeInstaller/packageManagers.ts`
- `src/utils/nativeInstaller/pidLock.ts`
- `src/utils/autoUpdater.ts`
- `src/utils/releaseNotes.ts`
- `src/utils/semver.ts`
- `src/cli/rollback.ts`
- `docs/auto-updater.md`

本章会把这些能力整理成一条完整的发布分发流水线。

---

## 67.1 发布链路全景

发布不是一个 `build` 命令。

发布是一条流水线：

```text
source
  -> version metadata
  -> macro defines
  -> feature flags
  -> bundle
  -> post-process
  -> vendor assets
  -> integrity scan
  -> smoke tests
  -> artifact manifest
  -> upload
  -> release notes
  -> update channel pointer
  -> installer migration
  -> rollback plan
```

每一步都要有明确输入、输出和失败策略。

如果只做到“本地能构建”，还不够接近官方体验。官方级 CLI 要做到“坏了也能知道坏在哪，发错也能拉回来”。

---

## 67.2 当前 Bun Build 流程

当前 `build.ts` 的核心流程是：

```text
1. 删除 dist/
2. 收集默认 feature flags 和 FEATURE_* 环境变量
3. Bun.build()
4. 后处理 import.meta.require
5. 后处理 globalThis.Bun 解构
6. 复制 native addon 和 vendor binary
7. 生成 cli-bun.js 和 cli-node.js
8. 设置入口可执行权限
```

核心配置：

```ts
await Bun.build({
  entrypoints: ["src/entrypoints/cli.tsx"],
  outdir: "dist",
  target: "bun",
  splitting: true,
  sourcemap: "linked",
  define: {
    ...getMacroDefines(),
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  features,
});
```

这里有几个重要设计点：

- `splitting: true` 会生成多个 chunk。
- `target: "bun"` 说明主构建面向 Bun。
- `define` 把 `MACRO.*` 编译进产物。
- `NODE_ENV=production` 用于减少 React dev 负担。
- feature flags 在构建时参与 dead code elimination。

这不是普通转译，而是发布产物生成。

---

## 67.3 Build 输出结构

当前构建输出最少应该包含：

```text
dist/
  cli.js
  chunk-*.js
  cli-bun.js
  cli-node.js
  vendor/
    audio-capture/
    ripgrep/
```

`cli.js` 是核心 bundle。

`chunk-*.js` 是 code splitting 的产物。

`cli-bun.js` 是 Bun shebang 入口：

```ts
#!/usr/bin/env bun
import "./cli.js";
```

`cli-node.js` 是兼容入口：

```ts
#!/usr/bin/env node
import "./cli.js";
```

虽然主运行时是 Bun，但产物后处理保留了第二运行时兼容路径。发布校验要分别确认：

- Bun 入口能启动。
- 兼容入口不会在 import 阶段崩溃。
- vendor 文件在 dist 内存在。
- chunk 引用没有断链。

---

## 67.4 版本元信息的唯一来源

版本号不能散落在代码里。

当前仓库通过 `scripts/defines.ts` 从 `package.json` 读取版本：

```ts
export function getMacroDefines(): Record<string, string> {
  return {
    "MACRO.VERSION": JSON.stringify(pkg.version),
    "MACRO.BUILD_TIME": JSON.stringify(new Date().toISOString()),
    "MACRO.FEEDBACK_CHANNEL": JSON.stringify(""),
    "MACRO.ISSUES_EXPLAINER": JSON.stringify(""),
    "MACRO.NATIVE_PACKAGE_URL": JSON.stringify(""),
    "MACRO.PACKAGE_URL": JSON.stringify(""),
    "MACRO.VERSION_CHANGELOG": JSON.stringify(""),
  };
}
```

这个模式是对的：

- `package.json` 是版本源头。
- `MACRO.VERSION` 是运行时展示源头。
- build time 由构建时生成。
- changelog 可以按构建类型注入。
- 包地址和 native 地址可以按发行渠道注入。

不要在 UI、更新器、release notes、diagnostics 里重复写版本常量。

---

## 67.5 Build Manifest

建议发布链路新增一个 build manifest。

```ts
export type BuildManifest = {
  version: string;
  buildTime: string;
  gitSha?: string;
  target: "bun";
  entrypoints: {
    bun: string;
    compatibility: string;
  };
  features: string[];
  files: Array<{
    path: string;
    size: number;
    sha256: string;
  }>;
};
```

输出到：

```text
dist/build-manifest.json
```

生成函数：

```ts
import { createHash } from "crypto";

export async function hashFile(path: string): Promise<string> {
  const file = Bun.file(path);
  const bytes = await file.arrayBuffer();
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

export async function createBuildManifest(input: {
  version: string;
  buildTime: string;
  features: string[];
  files: string[];
}): Promise<BuildManifest> {
  return {
    version: input.version,
    buildTime: input.buildTime,
    target: "bun",
    entrypoints: {
      bun: "cli-bun.js",
      compatibility: "cli-node.js",
    },
    features: input.features,
    files: await Promise.all(
      input.files.map(async path => ({
        path,
        size: await Bun.file(path).size,
        sha256: await hashFile(path),
      })),
    ),
  };
}
```

manifest 的作用：

- 发布时知道发了哪些文件。
- 安装器能校验文件。
- 用户 issue 可以附上 manifest 摘要。
- rollback 可以定位精确版本。

---

## 67.6 Feature Flags 的发布语义

当前 `DEFAULT_BUILD_FEATURES` 在 `scripts/defines.ts` 里集中维护，构建时再合并 `FEATURE_*` 环境变量。

发布语义建议固定：

```text
default build features
  -> 进入正式产物

FEATURE_X=1
  -> 临时开启额外功能，只用于实验构建或内部构建

runtime settings
  -> 控制用户可见行为，不替代 build flag
```

重要约束：

- feature flag 列表必须在 release manifest 中记录。
- 构建产物必须能回答“这个功能是否被编译进来了”。
- 不要在发布后靠环境变量启用没有编译进产物的功能。
- `feature()` 只能放在编译器能理解的位置。

示例 manifest 片段：

```json
{
  "features": [
    "BRIDGE_MODE",
    "DAEMON",
    "BG_SESSIONS",
    "ACP"
  ]
}
```

这能让 doctor/health 在排查时知道“功能缺失”到底是构建问题还是运行配置问题。

---

## 67.7 Bundle 后处理

当前 `build.ts` 做了两类后处理。

第一类：兼容 `import.meta.require`。

```ts
const compatRequire =
  'var __require = typeof import.meta.require === "function" ? import.meta.require : (await import("module")).createRequire(import.meta.url);';
```

第二类：避免非 Bun 运行时在 import 阶段因为 `globalThis.Bun` 解构崩溃。

```ts
const safeBunDestructure =
  'var {$1} = typeof globalThis.Bun !== "undefined" ? globalThis.Bun : {};';
```

发布时要把这两类 patch 计入日志：

```text
patched 3 files for import.meta.require
patched 1 file for Bun destructure
```

如果 patch 数突然变成 0 或暴涨，都值得检查。

---

## 67.8 Vendor Assets

当前构建后会复制：

```text
vendor/audio-capture -> dist/vendor/audio-capture
src/utils/vendor/ripgrep -> dist/vendor/ripgrep
```

这类资源不能只靠 TypeScript import 检查。

需要单独校验：

```ts
export type VendorAssetCheck = {
  path: string;
  required: boolean;
  expectedExecutable?: boolean;
};

export const REQUIRED_VENDOR_ASSETS: VendorAssetCheck[] = [
  {
    path: "dist/vendor/audio-capture",
    required: true,
  },
  {
    path: "dist/vendor/ripgrep",
    required: true,
  },
];
```

检查函数：

```ts
export async function checkVendorAssets(): Promise<string[]> {
  const missing: string[] = [];

  for (const asset of REQUIRED_VENDOR_ASSETS) {
    const exists = await Bun.file(asset.path).exists();
    if (!exists) {
      missing.push(asset.path);
    }
  }

  return missing;
}
```

如果 vendor 缺失，CLI 可能启动成功，但某些工具到运行时才坏。发布前必须提前发现。

---

## 67.9 Bundle Integrity 扫描

当前 `scripts/check-bundle-integrity.ts` 已经做了很关键的检查：

- 静态 chunk 引用是否断链。
- `__require()` 是否引用了运行时找不到的第三方模块。
- 动态 `import()` 是否引用了未打包模块。
- `nodeRequire()` 是否绕过 bundle。
- Bun 专用模块是否出现在兼容运行时路径。

它会扫描 `dist/*.js`，输出 error/warning，并用退出码表示结果。

核心 finding：

```ts
export type BundleFinding = {
  type:
    | "broken-chunk-ref"
    | "third-party-require"
    | "third-party-import"
    | "third-party-node-require"
    | "bun-runtime-only";
  severity: "error" | "warning";
  file: string;
  line: number;
  module: string;
  snippet: string;
};
```

建议把脚本演进成可复用库：

```text
scripts/check-bundle-integrity.ts
  -> CLI wrapper

src/release/bundleIntegrity.ts
  -> scanBundle(distDir): BundleIntegrityReport
```

这样 release gate、health full profile 和 CI 都能复用同一套扫描逻辑。

---

## 67.10 Bundle Integrity 的退出策略

建议：

```text
error
  -> fail release

warning
  -> fail strict release, pass local check

no finding
  -> pass
```

命令：

```bash
bun run build
bun run check:bundle
```

如果 `check:bundle` 失败，不应该继续发布。

chunk 断链属于硬错误；动态加载未打包模块也属于硬错误；Bun-only 模块出现在兼容路径可以先 warning，但如果承诺兼容入口，也应在 release gate 里升级为 error。

---

## 67.11 Smoke Test 分层

Smoke test 不等于完整测试。

它只确认“产物能启动，核心命令能加载，关键入口不崩”。

建议分三层：

```text
source smoke
  -> 直接加载 src 命令模块

dist smoke
  -> 运行 dist 入口

installer smoke
  -> 安装后运行真实 launcher
```

当前 `scripts/smoke-test-commands.ts` 属于 source smoke：

- import command module。
- 检查 name/type/isHidden/isEnabled/load。
- 对 local command 进行轻量 call。
- 对 local-jsx command 只检查 load。

这很适合在开发阶段快速发现命令注册问题。

---

## 67.12 Dist Smoke Test

发布前还需要 dist smoke。

最小命令：

```bash
bun run build
bun dist/cli-bun.js --version
```

建议脚本：

```ts
export type DistSmokeResult = {
  name: string;
  command: string[];
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
};

export async function runDistSmoke(): Promise<DistSmokeResult[]> {
  const checks = [
    {
      name: "bun-entry-version",
      command: ["bun", "dist/cli-bun.js", "--version"],
    },
  ];

  const results: DistSmokeResult[] = [];

  for (const check of checks) {
    const proc = Bun.spawn(check.command, {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    results.push({
      name: check.name,
      command: check.command,
      ok: code === 0 && stdout.trim().length > 0,
      code,
      stdout,
      stderr,
    });
  }

  return results;
}
```

后续如果要验证兼容入口，可以放到跨运行时 release gate，而不是默认本地 smoke。

---

## 67.13 跨平台 Smoke Matrix

原生分发必须按平台验证。

平台维度：

```text
macOS arm64
macOS x64
Linux x64 glibc
Linux arm64 glibc
Linux x64 musl
Windows x64
Windows arm64
```

每个平台至少检查：

- 二进制存在。
- 二进制可执行。
- `--version` 输出正确。
- `--help` 不崩溃。
- vendor 搜索工具可用。
- 配置目录可创建。
- 更新锁目录可创建。

Smoke manifest：

```ts
export type PlatformSmokeReport = {
  platform: string;
  arch: string;
  version: string;
  checks: Array<{
    id: string;
    ok: boolean;
    detail?: string;
  }>;
};
```

跨平台 smoke 不一定在本机跑，适合 CI matrix 或 release worker。

---

## 67.14 原生安装目录结构

当前 native installer 使用 XDG 风格目录：

```text
data/
  claude/
    versions/

cache/
  claude/
    staging/

state/
  claude/
    locks/

user-bin/
  claude
```

语义：

- `versions/`：长期保留的版本化二进制。
- `staging/`：下载和解包暂存，可清理。
- `locks/`：版本锁，避免删除正在运行的二进制。
- `user-bin/claude`：指向当前版本的 launcher。

发布系统要保证安装器和 doctor 对这套目录有相同理解。

---

## 67.15 平台解析

当前 `getPlatform()` 会根据 OS 和 arch 生成平台名，并检测 musl：

```ts
export function getPlatform(): string {
  const os = env.platform;
  const arch =
    process.arch === "x64"
      ? "x64"
      : process.arch === "arm64"
        ? "arm64"
        : null;

  if (!arch) {
    throw new Error(`Unsupported architecture: ${process.arch}`);
  }

  if (os === "linux" && envDynamic.isMuslEnvironment()) {
    return `linux-${arch}-musl`;
  }

  return `${os}-${arch}`;
}
```

发布产物 manifest 必须使用同样的平台 key。

否则 installer 读取 manifest 时会出现：

```text
Platform linux-x64-musl not found in manifest for version X
```

平台命名是发布链路和安装链路的契约。

---

## 67.16 原生下载 Manifest

当前二进制下载路径使用：

```text
{baseUrl}/{version}/manifest.json
{baseUrl}/{version}/{platform}/{binaryName}
```

manifest 中每个平台需要 checksum：

```json
{
  "version": "2.4.4",
  "platforms": {
    "darwin-arm64": {
      "checksum": "..."
    },
    "linux-x64": {
      "checksum": "..."
    }
  }
}
```

建议扩展为：

```json
{
  "version": "2.4.4",
  "buildTime": "2026-05-27T00:00:00.000Z",
  "channel": "latest",
  "platforms": {
    "darwin-arm64": {
      "binary": "claude",
      "size": 123456789,
      "sha256": "..."
    }
  }
}
```

字段名要稳定。安装器只依赖少数字段，其他字段可以给 doctor 和 release UI 使用。

---

## 67.17 下载校验与重试

当前 `downloadAndVerifyBinary()` 已经包含：

- 5 分钟总 timeout。
- 60 秒 stall 检测。
- stall retry，最多 3 次。
- SHA256 checksum 校验。
- 写入文件后设置可执行权限。

流程：

```text
fetch manifest
  -> choose platform
  -> fetch binary
  -> compute sha256
  -> compare checksum
  -> write staging file
  -> chmod executable
```

这条链路很关键：不要先把下载结果激活，再做校验。

必须在 staging 里完成校验，确认无误后再进入安装路径。

---

## 67.18 原子安装

当前安装时会：

```text
staging binary
  -> copy to temp file next to final install path
  -> chmod
  -> rename to final install path
```

这样可以避免跨文件系统 rename 的 `EXDEV` 问题，也能保证最终路径要么是旧文件，要么是新文件。

抽象：

```ts
export async function atomicInstallBinary(
  stagedBinaryPath: string,
  installPath: string,
): Promise<void> {
  const temp = `${installPath}.tmp.${process.pid}.${Date.now()}`;

  try {
    await Bun.write(temp, Bun.file(stagedBinaryPath));
    await chmodExecutable(temp);
    await rename(temp, installPath);
  } catch (error) {
    await removeIfExists(temp);
    throw error;
  }
}
```

发布安装器的核心原则：不要让用户留下半个二进制。

---

## 67.19 Launcher 切换

非 Windows 平台使用 symlink：

```text
~/.local/bin/claude -> versions/2.4.4
```

切换时用临时 symlink 再原子 rename：

```text
claude.tmp.pid.time -> versions/2.4.4
rename claude.tmp.pid.time to claude
```

Windows 平台不能可靠使用 symlink，因此使用复制和旧文件重命名策略：

```text
claude.exe -> claude.exe.old.timestamp
copy new claude.exe
if copy fails -> restore old executable
```

这就是跨平台 installer 需要分支的原因。

---

## 67.20 Version Retention

当前 native installer 保留最近 2 个版本：

```ts
export const VERSION_RETENTION_COUNT = 2;
```

清理策略：

- 清理 1 小时以上的 staging 目录。
- 清理孤儿临时安装文件。
- 清理 Windows 旧可执行文件。
- 保护当前进程正在运行的版本。
- 保护当前 launcher 指向的版本。
- 保护被 lock 持有的版本。
- 对可删除版本只保留最近 N 个。

这个策略支持 rollback 和并发运行。

不要在更新成功后立刻删除所有旧版本。用户可能有多个终端正在运行旧版本。

---

## 67.21 Version Locks

版本锁用于避免删除正在运行的二进制。

当前实现支持：

- PID-based lock。
- mtime-based lock。
- process lifetime lock。
- stale lock cleanup。

锁语义：

```text
update lock
  -> 防止两个安装事务同时写同一版本

version lock
  -> 防止清理掉正在运行的版本
```

两者不要混淆。

release gate 可以检查：

```ts
export type LockHealth = {
  activeVersionLocks: number;
  staleVersionLocks: number;
  updateLockHeld: boolean;
};
```

如果 stale lock 很多，doctor 可以提示清理；release 不应依赖用户机器上的 lock 状态。

---

## 67.22 安装迁移

从旧安装形态迁移到 native installer 时要处理：

- 旧 launcher。
- 旧 shell alias。
- 旧全局安装目录。
- config 中的 install method。
- legacy auto updater。

当前 `installLatest()` 成功后会设置：

```ts
saveGlobalConfig(current => ({
  ...current,
  installMethod: "native",
  autoUpdates: false,
  autoUpdatesProtectedForNative: true,
}));
```

语义：

- 当前安装方式切换到 native。
- 禁用旧 JS updater，避免它删除 native symlink。
- 标记这是保护性禁用，不是用户主动偏好。

迁移不是简单“安装新文件”。它要防止旧更新器继续干预新安装。

---

## 67.23 安装后检查

安装结束后必须检查：

- launcher 是否存在。
- launcher 是否可执行。
- launcher 是否指向有效二进制。
- bin 目录是否在 PATH。
- shell alias 是否覆盖 launcher。
- `--version` 是否输出目标版本。

可以定义：

```ts
export type InstallVerification = {
  executablePath: string;
  expectedVersion: string;
  checks: Array<{
    id: string;
    ok: boolean;
    detail?: string;
  }>;
};
```

安装命令不应该只显示“下载完成”。它应该确认用户下一次打开终端能跑到新版本。

---

## 67.24 Release Notes 流程

当前 `releaseNotes.ts` 的流程：

```text
startup
  -> load cached changelog into memory
  -> if version changed or cache empty, background fetch changelog
  -> parse markdown headings
  -> compare last seen version
  -> show up to 5 recent notes
```

关键点：

- 非交互模式跳过。
- essential traffic only 时跳过网络。
- changelog 缓存到 config home 下的 cache 文件。
- 内存 cache 供 React render 同步读取。
- 内部构建可使用 `MACRO.VERSION_CHANGELOG` 注入。

这套设计避免了 UI 首屏因为 release notes 网络请求阻塞。

---

## 67.25 Changelog 解析

当前解析逻辑按 markdown 二级标题拆分：

```md
## 2.4.4 - 2026-05-27

- Fix something
- Improve something
```

转成：

```ts
Record<string, string[]>
```

实现要注意：

- 空内容返回空对象。
- 异常返回空对象。
- 只取 bullet。
- 版本比较使用 semver。
- 展示数量要限制。

建议 release notes 不要展示完整 changelog，只展示最多几条高价值内容。

---

## 67.26 Release Notes Seen State

release notes 需要记录用户上次看到的版本。

类型：

```ts
export type ReleaseNotesState = {
  lastSeenVersion?: string;
  changelogLastFetched?: number;
};
```

流程：

```text
currentVersion > lastSeenVersion
  -> show recent notes
  -> user dismisses
  -> save lastSeenVersion = currentVersion
```

如果 fetch 失败，不要阻止 CLI 启动。release notes 是非关键路径。

---

## 67.27 Semver 策略

当前 `src/utils/semver.ts` 会优先使用 `Bun.semver`，再 fallback 到兼容库。

发布链路建议统一通过本地 semver helper：

```ts
import { gt, gte, lt, lte, satisfies } from "src/utils/semver";
```

不要在不同模块里自己实现版本比较。

版本比较场景：

- min version gate。
- max version kill switch。
- update available。
- release notes。
- stable/latest channel 切换。
- rollback target 验证。

版本字符串可以带 build metadata 或预发布信息，因此比较函数要统一。

---

## 67.28 Channel Pointer

更新频道可以简单建模：

```text
latest -> 2.4.4
stable -> 2.4.2
safe   -> 2.4.1
```

`latest` 用于快速分发。

`stable` 用于保守用户。

`safe` 用于事故回滚。

类型：

```ts
export type ReleaseChannelPointers = {
  latest: string;
  stable: string;
  safe?: string;
  updatedAt: string;
};
```

安装器读取 channel pointer 后，再读取对应版本 manifest。

不要让 installer 猜测“最新版本”。发布系统必须明确写入 channel 指针。

---

## 67.29 Max Version Kill Switch

当前更新器支持 server-side max version。

语义：

```text
available latest = 2.4.5
max allowed = 2.4.4
current = 2.4.3

installer should update to 2.4.4, not 2.4.5
```

如果 current 已经大于等于 max allowed：

```text
skip update
show known issue message when appropriate
```

max version 是事故控制工具，不是常规发布频道。

发布系统要支持快速设置和快速撤销。

---

## 67.30 Rollback Safe Pin

`rollback --safe` 的目标是：

```text
不要求用户知道哪个版本安全，由服务端 pin 告诉 CLI。
```

当前 `src/cli/rollback.ts` 还是 stub 风格：

- `--list` 只提示需要 release registry。
- `--safe` 只提示需要 release API。
- 指定 target 时走旧安装路径。

接近官方体验时，应改成：

```text
rollback --safe
  -> fetch safe pointer
  -> verify target version exists
  -> download manifest
  -> verify checksum
  -> install target
  -> switch launcher
  -> run smoke
  -> report success
```

类型：

```ts
export type RollbackPlan = {
  currentVersion: string;
  targetVersion: string;
  reason: "safe-pin" | "explicit-target" | "previous-version";
  dryRun: boolean;
};
```

rollback 必须走同一套 native installer 安装和校验链路，不应该绕过校验。

---

## 67.31 Rollback Dry Run

`--dry-run` 应输出计划，不做修改。

```text
Rollback plan
Current: 2.4.4
Target: 2.4.2
Reason: safe-pin

Would:
- Fetch manifest for 2.4.2
- Verify platform checksum
- Install version binary
- Switch launcher
- Keep current version locked
- Run smoke test
```

dry run 要避免下载大文件。最多检查 metadata 可达性。

---

## 67.32 Rollback 安全约束

rollback 不能破坏当前可用版本。

约束：

- 安装 target 到版本目录，不直接覆盖当前二进制。
- target 校验通过后再切 launcher。
- launcher 切换失败时保留当前 launcher。
- 旧版本清理不能删除当前运行版本。
- rollback 后 smoke 失败，应提示如何切回。

伪流程：

```ts
export async function executeRollback(plan: RollbackPlan): Promise<void> {
  const manifest = await fetchReleaseManifest(plan.targetVersion);
  verifyPlatformAvailable(manifest);
  const staged = await downloadAndVerify(plan.targetVersion, manifest);
  const installed = await installToVersionStore(staged, plan.targetVersion);
  await switchLauncherAtomically(installed);
  await runPostInstallSmoke(plan.targetVersion);
}
```

---

## 67.33 Release Artifact Manifest

每个版本都应该发布 artifact manifest。

```ts
export type ReleaseArtifactManifest = {
  version: string;
  buildTime: string;
  gitSha: string;
  channel?: "latest" | "stable";
  cli: {
    bundleSha256: string;
    manifestSha256: string;
  };
  platforms: Record<
    string,
    {
      binaryName: string;
      size: number;
      sha256: string;
      smoke: "passed" | "failed" | "skipped";
    }
  >;
  releaseNotes: string[];
};
```

这个 manifest 可以同时服务：

- installer。
- release UI。
- doctor。
- rollback。
- support issue 排查。

---

## 67.34 Bundle 与 Native Artifact 的关系

有两种产物：

```text
JS bundle artifact
  -> dist/cli.js + chunks + vendor

native binary artifact
  -> platform-specific executable
```

native binary 可以内嵌或包装 JS bundle，也可以是独立打包产物。

发布校验要分别做：

- bundle integrity。
- native binary checksum。
- native binary smoke。
- installer manifest coherence。

不要只校验二进制 checksum。二进制是最后产物，但 bundle 断链会在更早阶段暴露。

---

## 67.35 Production Test

当前 `package.json` 已经有：

```text
test:production
test:production:offline
test:production:verbose
test:production:bun
```

第 67 章建议把 production test 纳入 release gate。

默认 release gate：

```bash
bun run typecheck
bun run build
bun run check:bundle
bun run test:production:offline
```

如果 production test 需要网络，必须有 offline 模式。发布前的基础门槛不应该因为网络抖动失败。

---

## 67.36 Release Gate 脚本

建议新增：

```text
scripts/release-gate.ts
```

职责：

```text
1. 检查工作区状态
2. 读取版本元信息
3. 跑 typecheck
4. 跑 build
5. 跑 bundle integrity
6. 跑 production offline test
7. 跑 dist smoke
8. 生成 release gate report
```

命令：

```bash
bun run scripts/release-gate.ts
```

report 类型：

```ts
export type ReleaseGateReport = {
  version: string;
  startedAt: string;
  finishedAt: string;
  checks: Array<{
    id: string;
    ok: boolean;
    durationMs: number;
    detail?: string;
  }>;
};
```

---

## 67.37 Release Gate 的命令封装

复用第 66 章的 command runner。

```ts
const RELEASE_CHECKS = [
  ["bun", "run", "typecheck"],
  ["bun", "run", "build"],
  ["bun", "run", "check:bundle"],
  ["bun", "run", "test:production:offline"],
  ["bun", "dist/cli-bun.js", "--version"],
] as const;
```

串行执行：

```ts
for (const command of RELEASE_CHECKS) {
  const result = await runCheckCommand([...command], 180_000);
  if (result.code !== 0) {
    fail(result);
    break;
  }
}
```

release gate 要尽早失败。前置检查失败时，不要继续跑昂贵步骤。

---

## 67.38 构建产物一致性检查

除了 bundle integrity，还应检查 dist 文件集合：

```ts
export type DistLayoutCheck = {
  requiredFiles: string[];
  requiredDirectories: string[];
};

export const DIST_LAYOUT: DistLayoutCheck = {
  requiredFiles: [
    "dist/cli.js",
    "dist/cli-bun.js",
    "dist/cli-node.js",
  ],
  requiredDirectories: [
    "dist/vendor/audio-capture",
    "dist/vendor/ripgrep",
  ],
};
```

检查：

```ts
export async function checkDistLayout(): Promise<string[]> {
  const missing: string[] = [];

  for (const file of DIST_LAYOUT.requiredFiles) {
    if (!(await Bun.file(file).exists())) {
      missing.push(file);
    }
  }

  for (const dir of DIST_LAYOUT.requiredDirectories) {
    if (!(await pathExists(dir))) {
      missing.push(dir);
    }
  }

  return missing;
}
```

layout 检查比运行 smoke 更快，可以紧跟 build 后执行。

---

## 67.39 Sourcemap 策略

当前 build 使用：

```ts
sourcemap: "linked"
```

发布时要决定 sourcemap 是否上传、是否随包分发。

建议：

- 本地 dist 保留 sourcemap。
- 公开分发可以不包含 sourcemap，或者只上传到私有错误分析系统。
- release manifest 记录 sourcemap 是否存在。
- 如果保留 sourcemap，确保不包含 secret。

sourcemap 是排障利器，但也可能暴露源码结构。需要明确策略。

---

## 67.40 安装包与二进制包的分发差异

仓库里同时存在：

- source/dev 运行。
- JS bundle。
- native installer。
- package-manager 检测。

不同分发方式的升级策略不同：

```text
native
  -> CLI 自己下载和切换版本

package-managed
  -> CLI 只提醒，不自动安装

development
  -> 不自动更新

unknown
  -> doctor 给建议，不擅自修改
```

发布文档要清楚告诉用户当前安装方式如何升级。`/doctor` 和 `/status` 要能展示一致结论。

---

## 67.41 Package Manager 检测

`src/utils/nativeInstaller/packageManagers.ts` 会检测：

- homebrew
- winget
- pacman
- deb
- rpm
- apk
- mise
- asdf

检测方式包括：

- 当前 executable path。
- OS release family。
- 系统数据库文件归属查询。

这用于决定：

- 是否由系统包管理器控制更新。
- `/doctor` 展示哪个 package manager。
- 自动更新器是否只显示提示。

发布链路要确保系统包版本和 native channel 指针不要互相打架。

---

## 67.42 Release Notes 与 Channel 的一致性

如果 stable 频道落后 latest，release notes 不能只按 latest 展示。

用户从 `2.4.1` 更新到 stable `2.4.3`，应该看到 `2.4.2` 到 `2.4.3` 的 notes，而不是 `2.4.4` 的 latest notes。

所以 release notes 应按当前实际版本比较，而不是按 channel 名称比较。

```ts
export function selectReleaseNotesForUpgrade(input: {
  previousVersion: string | null;
  currentVersion: string;
  changelog: string;
}): string[] {
  return getRecentReleaseNotes(
    input.currentVersion,
    input.previousVersion,
    input.changelog,
  );
}
```

---

## 67.43 事故发布策略

当发现坏版本时，发布系统需要三个动作：

```text
1. 设置 max version，阻止继续升级到坏版本。
2. 设置 safe version，给 rollback --safe 使用。
3. 发布修复版本，更新 latest 或 stable 指针。
```

客户端行为：

- 已低于 max：最多更新到 max。
- 已高于 max：显示 known issue 或 rollback 建议。
- 用户执行 safe rollback：安装 safe 指针版本。

这比“请用户手动找一个旧版本”可靠得多。

---

## 67.44 Release Telemetry

发布链路需要最小可观测性。

事件类型：

- version check success/failure。
- binary manifest fetch failure。
- binary download attempt/success/failure。
- checksum mismatch。
- native update complete。
- native update lock failed。
- version cleanup。
- rollback start/success/failure。
- smoke test failure。

不要记录：

- 用户完整路径中的敏感片段。
- 环境变量值。
- 认证 header。
- 私有仓库 URL 的凭据。

发布可观测性服务的是稳定性，不是收集用户隐私。

---

## 67.45 Release Report

每次发布应生成一份 release report。

```ts
export type ReleaseReport = {
  version: string;
  gitSha: string;
  buildTime: string;
  gate: ReleaseGateReport;
  buildManifest: BuildManifest;
  artifactManifest: ReleaseArtifactManifest;
  uploaded: Array<{
    path: string;
    url: string;
    sha256: string;
  }>;
};
```

保存位置：

```text
dist/release-report.json
```

这份 report 是发布审计材料。之后用户反馈“2.4.4 坏了”，维护者可以直接找到该版本构建时通过了哪些 gate。

---

## 67.46 发布前检查清单

发布前最少检查：

```bash
bun run typecheck
bun run build
bun run check:bundle
bun run test:production:offline
bun dist/cli-bun.js --version
```

如果改动涉及 installer：

```bash
bun test src/utils/nativeInstaller
bun run typecheck
```

如果改动涉及 release notes：

```bash
bun test src/utils/__tests__/releaseNotes.test.ts
bun run typecheck
```

如果改动涉及 version compare：

```bash
bun test src/utils/__tests__/semver.test.ts
bun run typecheck
```

---

## 67.47 常见发布事故

### Chunk 断链

构建产物里某个 chunk 被引用，但文件不存在。

应由 bundle integrity 阻止发布。

### Vendor 缺失

CLI 启动正常，但搜索、音频、图像等能力在运行时失败。

应由 dist layout 和 vendor 检查发现。

### 版本号漂移

UI 显示版本、update channel、artifact manifest 不一致。

应以 `package.json -> MACRO.VERSION -> manifest` 为唯一链路。

### 校验缺失

下载的二进制未做 checksum 校验就激活。

这是严重发布风险。

### 更新并发

两个进程同时更新，导致 staging 或 launcher 损坏。

需要 update lock 和 atomic switch。

### 清理过度

更新后删除了仍在运行的旧版本。

需要 version lifetime lock。

### Rollback 绕过校验

回滚路径如果不走同一套 manifest/checksum/atomic switch，就会成为最薄弱环节。

---

## 67.48 测试：Manifest Hash

```ts
import { describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { hashBytes } from "../release/hash";

describe("hashBytes", () => {
  test("returns sha256 hex", () => {
    const bytes = new TextEncoder().encode("hello");
    const expected = createHash("sha256").update(bytes).digest("hex");

    expect(hashBytes(bytes)).toBe(expected);
  });
});
```

运行：

```bash
bun test src/release/hash.test.ts
```

---

## 67.49 测试：Dist Layout

```ts
import { describe, expect, test } from "bun:test";
import { checkDistLayoutWith } from "../release/distLayout";

describe("checkDistLayoutWith", () => {
  test("reports missing required files", async () => {
    const missing = await checkDistLayoutWith({
      fileExists: async path => path !== "dist/cli.js",
      dirExists: async () => true,
    });

    expect(missing).toContain("dist/cli.js");
  });
});
```

运行：

```bash
bun test src/release/distLayout.test.ts
```

---

## 67.50 测试：Release Notes

```ts
import { describe, expect, test } from "bun:test";
import { getRecentReleaseNotes } from "../releaseNotes";

describe("getRecentReleaseNotes", () => {
  test("returns notes newer than previous version", () => {
    const changelog = [
      "## 2.4.4",
      "",
      "- New item",
      "",
      "## 2.4.3",
      "",
      "- Old item",
    ].join("\n");

    expect(getRecentReleaseNotes("2.4.4", "2.4.3", changelog)).toEqual([
      "New item",
    ]);
  });
});
```

运行：

```bash
bun test src/utils/__tests__/releaseNotes.test.ts
```

---

## 67.51 测试：Rollback Plan

```ts
import { describe, expect, test } from "bun:test";
import { createRollbackPlan } from "../release/rollbackPlan";

describe("createRollbackPlan", () => {
  test("uses safe pin when requested", () => {
    const plan = createRollbackPlan({
      currentVersion: "2.4.4",
      safeVersion: "2.4.2",
      safe: true,
      dryRun: true,
    });

    expect(plan).toEqual({
      currentVersion: "2.4.4",
      targetVersion: "2.4.2",
      reason: "safe-pin",
      dryRun: true,
    });
  });
});
```

运行：

```bash
bun test src/release/rollbackPlan.test.ts
```

---

## 67.52 接近官方 Claude Code 的验收标准

做到这一章后，发布分发层应该满足：

- `bun run build` 能生成完整 dist。
- dist 中有 Bun 入口、兼容入口、chunk 和 vendor assets。
- build 注入 `MACRO.VERSION`、`MACRO.BUILD_TIME` 和 feature flags。
- build 后处理能修复 `import.meta.require` 和 Bun global 解构风险。
- bundle integrity 能发现 chunk 断链和未打包模块。
- release gate 能串行跑 typecheck、build、bundle check、production offline test 和 dist smoke。
- build manifest 记录文件 hash、大小、版本、build time 和 feature flags。
- release artifact manifest 记录各平台 binary hash。
- native installer 按 platform manifest 下载。
- 下载完成后先校验 checksum，再安装。
- 安装采用 staging、atomic move 和 atomic launcher switch。
- Windows 路径有 restore old executable 的失败兜底。
- version retention 不删除当前运行版本和锁定版本。
- release notes 能按版本差异展示。
- channel pointer 支持 latest、stable 和 safe。
- max version kill switch 能阻止坏版本继续扩散。
- rollback safe pin 走同一套校验和安装链路。
- 跨平台 smoke 至少覆盖 `--version`、`--help` 和 vendor 可用性。

这就是从“能构建”到“能发布”的差别。

---

## 67.53 本章小结

本章补上了 Claude Code 的发布与分发链路。

核心设计是：

- 以 `package.json` 版本为唯一源头，通过 `MACRO.VERSION` 注入运行时。
- 用 Bun build 生成 split bundle，并做产物兼容后处理。
- 用 bundle integrity 扫描阻止断链和未打包依赖进入发布。
- 用 build manifest 和 artifact manifest 固化版本、hash、feature flags 和平台产物。
- 用 native installer 的 staging、checksum、atomic install、launcher switch 和 version lock 保证更新安全。
- 用 release notes cache 在不阻塞 UI 的前提下展示版本变化。
- 用 max version 和 safe pin 支持事故控制与 rollback。
- 用 smoke matrix 保证跨平台产物真的能启动。

到这里，教程已经覆盖了从 Agent 核心能力到发布可靠性的主要骨架。

下一章建议继续补：生产级可观测性与支持链路，包括本地日志打包、错误边界、诊断包导出、用户反馈、issue 模板、隐私红线、支持侧复现脚本和最小可共享上下文。
