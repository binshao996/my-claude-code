# 第 40 章：插件签名与完整性校验

第三十九章把插件依赖和供应链策略补上了。

现在 Mini 已经能回答这些问题：

- 插件依赖谁。
- 能不能跨市场自动安装依赖。
- 这个市场源是否被策略允许。
- 这个插件是否被组织策略阻断。
- 插件下架后如何处理。

但还有一个更基础的问题没有解决：

```text
我安装的内容，和市场声明的内容，是不是同一个内容？
```

以及：

```text
这个内容，是否真的是可信发布者发布的？
```

这就是本章要做的插件完整性和签名校验。

完整性校验解决：

```text
内容有没有变化。
```

签名校验解决：

```text
内容是谁发布的。
```

两者不是一回事。

一个恶意市场也可以给恶意插件提供正确 hash。

所以 hash 只能证明：

```text
下载到的内容和声明一致。
```

签名才能证明：

```text
声明本身来自可信 key。
```

本章目标是让 Mini 的插件安装从：

```text
发现插件 -> 复制目录 -> 写 installed_plugins.json
```

升级成：

```text
发现插件 -> 校验市场 manifest -> 校验插件内容 hash -> 写 lockfile -> 写安装记录 -> 运行时复验
```

## 真实工程怎么做

真实工程里已经有不少完整性相关基础设施，但没有把它们包装成完整的“插件签名系统”。

相关代码主要在：

- `src/utils/plugins/pluginLoader.ts`：使用版本化缓存路径 `cache/{marketplace}/{plugin}/{version}`，支持 `source.sha` 指定提交，复制插件到版本目录，并避免启动时重复联网。
- `src/utils/plugins/pluginVersioning.ts`：计算插件版本，优先使用 manifest version，其次使用 marketplace version、提交 SHA 或其他可确定来源。
- `src/utils/plugins/cacheUtils.ts`：旧版本不是立即删除，而是标记 `.orphaned_at` 后延迟清理，避免当前会话仍在使用旧路径。
- `src/utils/plugins/zipCache.ts`：支持把插件目录转成 ZIP，原子写入，并在会话级临时目录解压；创建 ZIP 时会跳过 `.git` 并保留可执行位。
- `src/utils/plugins/zipCacheAdapters.ts`：把 marketplace JSON 同步到 ZIP cache，使短生命周期环境可以离线读取市场数据。
- `src/utils/plugins/mcpbHandler.ts`：对 MCPB/DXT 文件计算内容 hash，缓存提取目录，保存 metadata，并在本地文件修改后重新提取。
- `src/utils/plugins/validatePlugin.ts`：校验 manifest、路径穿越、插件组件路径、市场字段误用等作者侧问题。
- `src/utils/plugins/marketplaceManager.ts`：市场源策略在下载或读文件前执行，避免被策略禁止的来源先落盘。

这些设计给 Mini 的启发是：

```text
1. 缓存路径必须版本化。
2. 写缓存要尽量原子。
3. 下载或复制后的内容要能被重新校验。
4. 运行时不能只相信 installed_plugins.json。
5. 旧版本不能立刻删除。
6. 锁文件里不要写机器私有路径。
7. 内容 hash 和发布者签名要分开。
8. 签名校验应在安装和更新时执行，运行时至少复验 hash。
```

本章会给 Mini 增加一套更完整的模型。

## 本章目标

完成后，市场 manifest 可以声明插件完整性：

```json
{
  "name": "team",
  "owner": {
    "name": "Frontend Platform"
  },
  "metadata": {
    "version": "0.2.0"
  },
  "signing": {
    "keyId": "team-2026-01",
    "algorithm": "ed25519",
    "publicKey": "base64-public-key"
  },
  "plugins": [
    {
      "name": "review-pack",
      "version": "0.2.0",
      "source": "./plugins/review-pack",
      "integrity": {
        "algorithm": "sha256",
        "treeDigest": "sha256:abc123..."
      },
      "signature": {
        "keyId": "team-2026-01",
        "algorithm": "ed25519",
        "value": "base64-signature"
      }
    }
  ]
}
```

安装时 Mini 会：

```text
1. 读取 marketplace manifest。
2. 规范化 marketplace manifest，计算 manifestDigest。
3. 复制或下载插件到临时目录。
4. 计算插件 treeDigest。
5. 对比 marketplace entry 的 integrity.treeDigest。
6. 如果开启签名策略，验证 entry signature。
7. 复制到版本化缓存。
8. 写 `.mini/plugins.lock.json`。
9. 写 installed_plugins.json。
```

生成的项目锁文件：

```json
{
  "version": 1,
  "generatedAt": "2026-05-26T10:00:00.000Z",
  "marketplaces": {
    "team": {
      "manifestDigest": "sha256:marketplace-digest",
      "sourceDigest": "sha256:source-description-digest",
      "signingKeyId": "team-2026-01"
    }
  },
  "plugins": {
    "review-pack@team": {
      "version": "0.2.0",
      "marketplace": "team",
      "treeDigest": "sha256:plugin-tree-digest",
      "manifestDigest": "sha256:plugin-manifest-digest",
      "signatureKeyId": "team-2026-01"
    }
  }
}
```

注意锁文件里不写：

```text
installPath
本机绝对路径
headers
tokens
临时目录
```

锁文件应该可以提交到仓库。

本章要实现：

- 稳定 JSON 序列化。
- 文件 hash。
- 目录 tree hash。
- marketplace manifest digest。
- plugin manifest digest。
- plugin lockfile。
- install-time integrity 校验。
- update-time lockfile 更新。
- runtime cache hash 复验。
- 可选 Ed25519 签名验证。
- keyring 配置。
- 锁文件审计和 doctor。
- 相关测试。

## 推荐目录

新增：

```text
src/plugins/integrityTypes.ts
src/plugins/stableJson.ts
src/plugins/hashFile.ts
src/plugins/hashTree.ts
src/plugins/pluginLockfile.ts
src/plugins/pluginIntegrity.ts
src/plugins/pluginSignature.ts
src/plugins/pluginKeyring.ts
src/plugins/pluginIntegrityDoctor.ts

src/plugins/__tests__/
  stableJson.test.ts
  hashTree.test.ts
  pluginLockfile.test.ts
  pluginIntegrity.test.ts
  pluginSignature.test.ts
```

修改：

```text
src/plugins/marketplaceTypes.ts
src/plugins/marketplaceSchema.ts
src/plugins/pluginMarketplaceInstall.ts
src/plugins/pluginUpdate.ts
src/plugins/pluginLoader.ts
src/plugins/pluginCommand.ts
src/config/configTypes.ts
src/config/configSchema.ts
src/config/configMerge.ts
```

本章不要求你一次实现真正的发布平台。

但要把本地校验链路做扎实。

签名可以先支持：

```text
本地 keyring 中的 public key
```

发布工具和私钥管理可以放到后续。

## 完整性类型

新增 `src/plugins/integrityTypes.ts`：

```ts
export type HashAlgorithm = "sha256";

export type IntegrityDigest = `${HashAlgorithm}:${string}`;

export type PluginIntegrity = {
  algorithm: HashAlgorithm;
  treeDigest: IntegrityDigest;
  manifestDigest?: IntegrityDigest;
};

export type SignatureAlgorithm = "ed25519";

export type PluginSignature = {
  keyId: string;
  algorithm: SignatureAlgorithm;
  value: string;
};

export type MarketplaceSigningKey = {
  keyId: string;
  algorithm: SignatureAlgorithm;
  publicKey: string;
};

export type PluginLockfile = {
  version: 1;
  generatedAt: string;
  marketplaces: Record<string, MarketplaceLockEntry>;
  plugins: Record<string, PluginLockEntry>;
};

export type MarketplaceLockEntry = {
  manifestDigest: IntegrityDigest;
  sourceDigest: IntegrityDigest;
  signingKeyId?: string;
};

export type PluginLockEntry = {
  version: string;
  marketplace: string;
  treeDigest: IntegrityDigest;
  manifestDigest: IntegrityDigest;
  signatureKeyId?: string;
};
```

为什么 digest 用字符串而不是裸 hash？

因为这样后续可以扩展：

```text
sha256:...
sha512:...
```

校验时也能明确算法：

```ts
function assertSha256Digest(digest: string): void {
  if (!digest.startsWith("sha256:")) {
    throw new Error(`Unsupported digest algorithm: ${digest}`);
  }
}
```

第一版只支持 `sha256`。

不要提前支持太多算法。

## Marketplace 类型补充

修改 `src/plugins/marketplaceTypes.ts`：

```ts
import type { MarketplaceSigningKey, PluginIntegrity, PluginSignature } from "./integrityTypes";

export type MarketplaceManifest = {
  name: string;
  owner: MarketplaceOwner;
  metadata?: {
    version?: string;
    description?: string;
  };
  signing?: MarketplaceSigningKey;
  allowCrossMarketplaceDependenciesOn?: string[];
  forceRemoveDeletedPlugins?: boolean;
  plugins: MarketplacePluginEntry[];
};

export type MarketplacePluginEntry = {
  name: string;
  version?: string;
  description?: string;
  source: string | RemotePluginSource;
  tags?: string[];
  strict?: boolean;
  integrity?: PluginIntegrity;
  signature?: PluginSignature;
};
```

这里把签名 key 放在 marketplace 顶层：

```json
{
  "signing": {
    "keyId": "team-2026-01",
    "algorithm": "ed25519",
    "publicKey": "base64-public-key"
  }
}
```

插件 entry 里只放签名值：

```json
{
  "signature": {
    "keyId": "team-2026-01",
    "algorithm": "ed25519",
    "value": "base64-signature"
  }
}
```

这样一个市场可以用同一个 key 签多个插件。

后续支持 key rotation 时，可以让 `signingKeys` 变成数组。

第一版先单 key。

## Schema 补充

修改 `src/plugins/marketplaceSchema.ts`：

```ts
const digestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, "Expected sha256:<64 lowercase hex chars>");

const pluginIntegritySchema = z.object({
  algorithm: z.literal("sha256"),
  treeDigest: digestSchema,
  manifestDigest: digestSchema.optional(),
});

const signatureSchema = z.object({
  keyId: z.string().min(1).max(120),
  algorithm: z.literal("ed25519"),
  value: z.string().min(1),
});

const signingKeySchema = z.object({
  keyId: z.string().min(1).max(120),
  algorithm: z.literal("ed25519"),
  publicKey: z.string().min(1),
});

export const marketplacePluginEntrySchema = z.object({
  name: nameSchema,
  version: z.string().min(1).optional(),
  description: z.string().max(400).optional(),
  source: z.union([localPluginSourceSchema, remotePluginSourceSchema]),
  tags: z.array(z.string()).optional(),
  strict: z.boolean().optional().default(true),
  integrity: pluginIntegritySchema.optional(),
  signature: signatureSchema.optional(),
});

export const marketplaceManifestSchema = z.object({
  name: nameSchema,
  owner: ownerSchema,
  metadata: metadataSchema.optional(),
  signing: signingKeySchema.optional(),
  allowCrossMarketplaceDependenciesOn: z.array(nameSchema).optional(),
  forceRemoveDeletedPlugins: z.boolean().optional(),
  plugins: z.array(marketplacePluginEntrySchema),
});
```

digest 要求 lowercase hex。

不要接受任意字符串。

这样错误会尽早暴露。

## 稳定 JSON

签名和 digest 最怕不稳定序列化。

对象 key 顺序不同，普通 `JSON.stringify` 的结果可能不同。

新增 `src/plugins/stableJson.ts`：

```ts
export function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};

    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item === undefined) continue;
      sorted[key] = sortJsonValue(item);
    }

    return sorted;
  }

  return value;
}
```

注意：

```text
数组顺序不排序。
对象 key 排序。
undefined 删除。
```

因为 marketplace 的 plugins 数组顺序本身是发布者声明的一部分。

如果你排序数组，签名语义会变模糊。

## 文件 Hash

新增 `src/plugins/hashFile.ts`：

```ts
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);

  await new Promise<void>((resolve, reject) => {
    stream.on("data", chunk => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });

  return `sha256:${hash.digest("hex")}`;
}

export function hashBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function hashString(input: string): string {
  return `sha256:${createHash("sha256").update(input, "utf8").digest("hex")}`;
}
```

这里不用一次性 `readFile` 读取大文件。

插件可能包含二进制工具或大资源。

流式 hash 更稳。

## 目录 Tree Hash

目录 hash 需要稳定。

如果只是把所有文件内容拼起来，会有冲突风险。

例如：

```text
a: "bc"
ab: "c"
```

简单拼接都可能得到同样内容。

所以 tree hash 必须包含：

```text
相对路径
文件模式
文件 hash
```

新增 `src/plugins/hashTree.ts`：

```ts
import { createHash } from "node:crypto";
import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { hashFile } from "./hashFile";

export type TreeHashEntry = {
  path: string;
  mode: number;
  digest: string;
};

const IGNORED_ENTRIES = new Set([
  ".git",
  ".DS_Store",
  "node_modules",
  ".mini-plugin-cache",
]);

export async function hashTree(rootPath: string): Promise<{
  digest: string;
  entries: TreeHashEntry[];
}> {
  const entries = await collectTreeEntries(rootPath, "");
  entries.sort((a, b) => a.path.localeCompare(b.path));

  const hash = createHash("sha256");

  for (const entry of entries) {
    hash.update(`${entry.path}\0${entry.mode.toString(8)}\0${entry.digest}\n`, "utf8");
  }

  return {
    digest: `sha256:${hash.digest("hex")}`,
    entries,
  };
}

async function collectTreeEntries(rootPath: string, relativePath: string): Promise<TreeHashEntry[]> {
  const currentPath = relativePath ? join(rootPath, relativePath) : rootPath;
  const dirEntries = await readdir(currentPath, { withFileTypes: true });
  const result: TreeHashEntry[] = [];

  for (const entry of dirEntries) {
    if (IGNORED_ENTRIES.has(entry.name)) {
      continue;
    }

    const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    const childPath = join(rootPath, childRelativePath);
    const fileStat = await lstat(childPath);

    if (fileStat.isSymbolicLink()) {
      const targetStat = await stat(childPath);

      if (targetStat.isDirectory()) {
        continue;
      }
    }

    if (entry.isDirectory()) {
      result.push(...(await collectTreeEntries(rootPath, childRelativePath)));
      continue;
    }

    if (entry.isFile() || fileStat.isSymbolicLink()) {
      result.push({
        path: childRelativePath.replace(/\\/g, "/"),
        mode: fileStat.mode & 0o777,
        digest: await hashFile(childPath),
      });
    }
  }

  return result;
}
```

这里忽略了 `node_modules`。

如果你的插件确实需要携带依赖目录，不要用这个忽略规则。

本章建议插件以源码和脚本为主，依赖在安装阶段固定下来。

如果要支持二进制 bundle，应该显式打包并纳入 hash。

## Manifest Digest

新增 `src/plugins/pluginIntegrity.ts`：

```ts
import { join } from "node:path";
import { hashString } from "./hashFile";
import { hashTree } from "./hashTree";
import { stableJson } from "./stableJson";
import { readPluginManifest } from "./pluginManifest";
import type { MarketplaceManifest, MarketplacePluginEntry } from "./marketplaceTypes";

export async function computePluginManifestDigest(pluginRoot: string): Promise<string> {
  const manifest = await readPluginManifest(pluginRoot);
  return hashString(stableJson(manifest));
}

export async function computePluginTreeDigest(pluginRoot: string): Promise<string> {
  const tree = await hashTree(pluginRoot);
  return tree.digest;
}

export function computeMarketplaceManifestDigest(marketplace: MarketplaceManifest): string {
  const unsigned = stripMarketplaceRuntimeFields(marketplace);
  return hashString(stableJson(unsigned));
}

function stripMarketplaceRuntimeFields(marketplace: MarketplaceManifest): MarketplaceManifest {
  return marketplace;
}

export async function assertPluginIntegrity(params: {
  pluginId: string;
  pluginRoot: string;
  entry: MarketplacePluginEntry;
}): Promise<{
  treeDigest: string;
  manifestDigest: string;
}> {
  const treeDigest = await computePluginTreeDigest(params.pluginRoot);
  const manifestDigest = await computePluginManifestDigest(params.pluginRoot);

  if (params.entry.integrity?.treeDigest && params.entry.integrity.treeDigest !== treeDigest) {
    throw new Error(
      `Plugin integrity mismatch for ${params.pluginId}: expected ${params.entry.integrity.treeDigest}, got ${treeDigest}`,
    );
  }

  if (params.entry.integrity?.manifestDigest && params.entry.integrity.manifestDigest !== manifestDigest) {
    throw new Error(
      `Plugin manifest digest mismatch for ${params.pluginId}: expected ${params.entry.integrity.manifestDigest}, got ${manifestDigest}`,
    );
  }

  return {
    treeDigest,
    manifestDigest,
  };
}
```

`stripMarketplaceRuntimeFields` 现在不做事。

后续如果 marketplace 里加入：

```text
fetchedAt
cachePath
localDiagnostics
```

这些字段就不能参与签名和 digest。

所以预留这个函数。

## Lockfile 路径

锁文件应该在项目里：

```text
.mini/plugins.lock.json
```

新增 `src/plugins/pluginLockfile.ts`：

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PluginLockEntry, PluginLockfile, MarketplaceLockEntry } from "./integrityTypes";

const EMPTY_LOCKFILE: PluginLockfile = {
  version: 1,
  generatedAt: new Date(0).toISOString(),
  marketplaces: {},
  plugins: {},
};

type NodeError = Error & {
  code?: string;
};

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && (error as NodeError).code === "ENOENT";
}

export function getPluginLockfilePath(projectRoot: string): string {
  return join(projectRoot, ".mini", "plugins.lock.json");
}

export async function readPluginLockfile(projectRoot: string): Promise<PluginLockfile> {
  const file = getPluginLockfilePath(projectRoot);

  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as PluginLockfile;

    if (parsed.version !== 1) {
      throw new Error(`Unsupported plugin lockfile version: ${parsed.version}`);
    }

    return parsed;
  } catch (error) {
    if (isMissingFile(error)) {
      return EMPTY_LOCKFILE;
    }

    throw error;
  }
}

export async function writePluginLockfile(projectRoot: string, lockfile: PluginLockfile): Promise<void> {
  const file = getPluginLockfilePath(projectRoot);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(lockfile, null, 2)}\n`, "utf8");
}

export async function updatePluginLockfile(params: {
  projectRoot: string;
  marketplaceName: string;
  marketplace: MarketplaceLockEntry;
  pluginId: string;
  plugin: PluginLockEntry;
}): Promise<void> {
  const current = await readPluginLockfile(params.projectRoot);

  await writePluginLockfile(params.projectRoot, {
    version: 1,
    generatedAt: new Date().toISOString(),
    marketplaces: {
      ...current.marketplaces,
      [params.marketplaceName]: params.marketplace,
    },
    plugins: {
      ...current.plugins,
      [params.pluginId]: params.plugin,
    },
  });
}
```

项目锁文件用于：

```text
团队复现同一组插件内容。
CI 校验插件是否被改。
安装时检测市场 manifest 是否漂移。
离线运行时知道预期 digest。
```

installed plugins 文件仍然是本机状态：

```text
~/.claude-code-mini/plugins/installed_plugins.json
```

不要把两者合并。

## 安装时校验

第三十八章的安装流程是：

```text
findMarketplacePlugin -> cacheMarketplacePlugin -> write installed -> enable
```

本章改成：

```text
findMarketplacePlugin
  -> copy source to temp
  -> compute tree digest
  -> compare integrity
  -> verify signature
  -> copy to versioned cache
  -> write lockfile
  -> write installed
  -> enable
```

修改 `pluginMarketplaceInstall.ts`：

```ts
import { computeMarketplaceManifestDigest, assertPluginIntegrity } from "./pluginIntegrity";
import { updatePluginLockfile } from "./pluginLockfile";
import { verifyPluginSignatureIfRequired } from "./pluginSignature";
import { hashString } from "./hashFile";
import { stableJson } from "./stableJson";

export async function installPluginFromMarketplace(pluginId: string, scope: PluginScope): Promise<{
  pluginId: string;
  version: string;
  installPath: string;
}> {
  const parsed = requireFullPluginId(pluginId);
  const fullId = createPluginId(parsed.pluginName, parsed.marketplaceName);
  const info = await findMarketplacePlugin(fullId);

  if (!info) {
    throw new Error(`Plugin not found in marketplace: ${fullId}`);
  }

  const staged = await stageMarketplacePlugin({
    pluginId: fullId,
    marketplaceInstallLocation: info.installLocation,
    entry: info.entry,
  });

  const integrity = await assertPluginIntegrity({
    pluginId: fullId,
    pluginRoot: staged.path,
    entry: info.entry,
  });

  await verifyPluginSignatureIfRequired({
    marketplace: info.marketplace,
    entry: info.entry,
    pluginId: fullId,
    treeDigest: integrity.treeDigest,
    manifestDigest: integrity.manifestDigest,
  });

  const cached = await copyStagedPluginToVersionedCache({
    pluginId: fullId,
    stagedPath: staged.path,
    entry: info.entry,
  });

  await updatePluginLockfile({
    projectRoot: getCwd(),
    marketplaceName: info.marketplaceName,
    marketplace: {
      manifestDigest: computeMarketplaceManifestDigest(info.marketplace),
      sourceDigest: hashString(stableJson(info.marketplace.source ?? {})),
      signingKeyId: info.marketplace.signing?.keyId,
    },
    pluginId: fullId,
    plugin: {
      version: cached.version,
      marketplace: info.marketplaceName,
      treeDigest: integrity.treeDigest,
      manifestDigest: integrity.manifestDigest,
      signatureKeyId: info.entry.signature?.keyId,
    },
  });

  await writeInstalledAndEnable(fullId, cached, scope);

  return {
    pluginId: fullId,
    version: cached.version,
    installPath: cached.installPath,
  };
}
```

这里引入了两个新 helper：

```text
stageMarketplacePlugin
copyStagedPluginToVersionedCache
```

原因是完整性校验必须发生在最终缓存前。

如果你先写入最终缓存，再发现 hash 不匹配，就需要清理污染过的缓存目录。

更好的顺序是：

```text
temp -> verify -> final
```

## Stage 目录

新增到 `pluginCache.ts`：

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function withPluginStage<T>(
  fn: (stageDir: string) => Promise<T>,
): Promise<T> {
  const stageDir = await mkdtemp(join(tmpdir(), "mini-plugin-stage-"));

  try {
    return await fn(stageDir);
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
}
```

安装时：

```ts
return withPluginStage(async stageDir => {
  const staged = await copyPluginSourceToStage(source, stageDir);
  const integrity = await assertPluginIntegrity(...);
  return copyStagedPluginToVersionedCache(...);
});
```

stage 目录必须清理。

不要把未校验内容留在 Mini cache 下。

## 签名验证

新增 `src/plugins/pluginSignature.ts`：

```ts
import { createPublicKey, verify } from "node:crypto";
import type { MarketplaceManifest, MarketplacePluginEntry } from "./marketplaceTypes";
import { stableJson } from "./stableJson";

export type SignaturePayload = {
  pluginId: string;
  version?: string;
  treeDigest: string;
  manifestDigest: string;
};

export async function verifyPluginSignatureIfRequired(params: {
  marketplace: MarketplaceManifest;
  entry: MarketplacePluginEntry;
  pluginId: string;
  treeDigest: string;
  manifestDigest: string;
  required?: boolean;
}): Promise<void> {
  const required = params.required ?? false;

  if (!params.entry.signature) {
    if (required) {
      throw new Error(`Plugin signature is required but missing: ${params.pluginId}`);
    }

    return;
  }

  const signingKey = params.marketplace.signing;

  if (!signingKey) {
    throw new Error(`Plugin has signature but marketplace has no signing key: ${params.pluginId}`);
  }

  if (signingKey.keyId !== params.entry.signature.keyId) {
    throw new Error(`Plugin signature key mismatch for ${params.pluginId}`);
  }

  if (signingKey.algorithm !== "ed25519" || params.entry.signature.algorithm !== "ed25519") {
    throw new Error(`Unsupported signature algorithm for ${params.pluginId}`);
  }

  const payload: SignaturePayload = {
    pluginId: params.pluginId,
    version: params.entry.version,
    treeDigest: params.treeDigest,
    manifestDigest: params.manifestDigest,
  };

  const ok = verify(
    null,
    Buffer.from(stableJson(payload), "utf8"),
    createPublicKey({
      key: Buffer.from(signingKey.publicKey, "base64"),
      format: "der",
      type: "spki",
    }),
    Buffer.from(params.entry.signature.value, "base64"),
  );

  if (!ok) {
    throw new Error(`Invalid plugin signature: ${params.pluginId}`);
  }
}
```

签名 payload 必须稳定。

不要直接签整个 marketplace entry。

因为 entry 里可能包含：

```text
description
tags
display metadata
```

这些字段更新不应该让插件内容签名失效。

建议签：

```text
pluginId
version
treeDigest
manifestDigest
```

如果你希望描述和 tags 也不可篡改，可以把 marketplace manifest 本身也签掉。

第一版先做插件内容签名。

## Keyring

市场 manifest 自带 public key 可以用，但更接近生产的做法是本地有 keyring。

因为如果攻击者能替换 marketplace manifest，也能替换里面的 public key。

所以签名验证的信任根不应该完全来自 marketplace manifest。

新增 `src/plugins/pluginKeyring.ts`：

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MarketplaceSigningKey } from "./integrityTypes";

export type PluginKeyring = {
  version: 1;
  keys: Record<string, MarketplaceSigningKey>;
};

export function getPluginKeyringPath(projectRoot: string): string {
  return join(projectRoot, ".mini", "trusted-plugin-keys.json");
}

export async function readPluginKeyring(projectRoot: string): Promise<PluginKeyring> {
  try {
    const raw = await readFile(getPluginKeyringPath(projectRoot), "utf8");
    const parsed = JSON.parse(raw) as PluginKeyring;

    if (parsed.version !== 1 || typeof parsed.keys !== "object" || parsed.keys === null) {
      throw new Error("Invalid plugin keyring");
    }

    return parsed;
  } catch {
    return {
      version: 1,
      keys: {},
    };
  }
}

export async function getTrustedSigningKey(projectRoot: string, keyId: string): Promise<MarketplaceSigningKey | undefined> {
  const keyring = await readPluginKeyring(projectRoot);
  return keyring.keys[keyId];
}
```

项目里可以提交：

```json
{
  "version": 1,
  "keys": {
    "team-2026-01": {
      "keyId": "team-2026-01",
      "algorithm": "ed25519",
      "publicKey": "base64-public-key"
    }
  }
}
```

签名验证时优先使用 keyring：

```text
project keyring
  > user keyring
  > marketplace embedded key
```

如果策略要求强签名：

```json
{
  "pluginPolicy": {
    "requireSignatures": true
  }
}
```

那 marketplace embedded key 不应该自动被信任。

必须在 keyring 中出现。

## Policy 补充

在 `PluginPolicySettings` 里增加：

```ts
export type PluginPolicySettings = {
  blockedPlugins?: Record<string, boolean>;
  strictKnownMarketplaces?: MarketplaceSource[];
  blockedMarketplaces?: MarketplaceSource[];
  requireIntegrity?: boolean;
  requireSignatures?: boolean;
  trustedSigningKeys?: Record<string, MarketplaceSigningKey>;
  pluginTrustMessage?: string;
};
```

语义：

```text
requireIntegrity：
  marketplace entry 必须提供 integrity.treeDigest。

requireSignatures：
  marketplace entry 必须提供 signature，且 key 必须可信。
```

安装时：

```ts
if (settings.pluginPolicy?.requireIntegrity && !entry.integrity?.treeDigest) {
  throw new Error(`Plugin integrity metadata is required: ${pluginId}`);
}

await verifyPluginSignatureIfRequired({
  marketplace,
  entry,
  pluginId,
  treeDigest,
  manifestDigest,
  required: settings.pluginPolicy?.requireSignatures === true,
});
```

默认可以不强制签名。

但强制 integrity 很适合作为团队项目策略。

## Runtime 复验

安装时校验不够。

用户或外部进程可能修改缓存目录。

所以 loader 加载插件前要做轻量复验。

在 `pluginLoader.ts` 加：

```ts
import { readPluginLockfile } from "./pluginLockfile";
import { computePluginTreeDigest, computePluginManifestDigest } from "./pluginIntegrity";

async function verifyCachedPluginAgainstLock(params: {
  projectRoot: string;
  pluginId: string;
  pluginRoot: string;
}): Promise<void> {
  const lockfile = await readPluginLockfile(params.projectRoot);
  const expected = lockfile.plugins[params.pluginId];

  if (!expected) {
    return;
  }

  const treeDigest = await computePluginTreeDigest(params.pluginRoot);

  if (treeDigest !== expected.treeDigest) {
    throw new Error(`Cached plugin tree digest mismatch for ${params.pluginId}`);
  }

  const manifestDigest = await computePluginManifestDigest(params.pluginRoot);

  if (manifestDigest !== expected.manifestDigest) {
    throw new Error(`Cached plugin manifest digest mismatch for ${params.pluginId}`);
  }
}
```

然后在 `createLoadedPluginFromPath` 前调用：

```ts
await verifyCachedPluginAgainstLock({
  projectRoot: getCwd(),
  pluginId,
  pluginRoot: installation.installPath,
});
```

如果复验失败：

```text
不要加载插件。
加入 PluginLoadError。
提示用户重新安装或更新插件。
```

这样缓存被篡改后不会继续注册 hooks、commands 或 agents。

## Doctor 命令

新增 `src/plugins/pluginIntegrityDoctor.ts`：

```ts
import { readPluginLockfile } from "./pluginLockfile";
import { readInstalledPluginsV2 } from "./pluginInstallStoreV2";
import { computePluginTreeDigest, computePluginManifestDigest } from "./pluginIntegrity";

export type IntegrityDoctorResult = {
  ok: boolean;
  checked: number;
  failures: Array<{
    pluginId: string;
    reason: string;
  }>;
};

export async function runPluginIntegrityDoctor(projectRoot: string): Promise<IntegrityDoctorResult> {
  const lockfile = await readPluginLockfile(projectRoot);
  const installed = await readInstalledPluginsV2();
  const failures: IntegrityDoctorResult["failures"] = [];
  let checked = 0;

  for (const [pluginId, lockEntry] of Object.entries(lockfile.plugins)) {
    const installation = installed.plugins[pluginId]?.[0];

    if (!installation) {
      failures.push({
        pluginId,
        reason: "locked but not installed",
      });
      continue;
    }

    checked++;

    const treeDigest = await computePluginTreeDigest(installation.installPath);
    if (treeDigest !== lockEntry.treeDigest) {
      failures.push({
        pluginId,
        reason: `tree digest mismatch: expected ${lockEntry.treeDigest}, got ${treeDigest}`,
      });
      continue;
    }

    const manifestDigest = await computePluginManifestDigest(installation.installPath);
    if (manifestDigest !== lockEntry.manifestDigest) {
      failures.push({
        pluginId,
        reason: `manifest digest mismatch: expected ${lockEntry.manifestDigest}, got ${manifestDigest}`,
      });
    }
  }

  return {
    ok: failures.length === 0,
    checked,
    failures,
  };
}
```

CLI：

```bash
bun run src/cli.ts plugin doctor --integrity
```

输出示例：

```text
Checked 4 locked plugins.
Integrity OK.
```

失败时：

```text
Integrity failures:
  review-pack@team: tree digest mismatch
```

## 生成 Integrity Metadata

插件作者需要一个命令生成 `integrity` 字段。

新增：

```bash
bun run src/cli.ts plugin integrity generate examples/marketplaces/team/plugins/review-pack
```

输出：

```json
{
  "algorithm": "sha256",
  "treeDigest": "sha256:...",
  "manifestDigest": "sha256:..."
}
```

实现：

```ts
export async function generatePluginIntegrityCommand(pluginRoot: string): Promise<void> {
  const treeDigest = await computePluginTreeDigest(pluginRoot);
  const manifestDigest = await computePluginManifestDigest(pluginRoot);

  console.log(JSON.stringify({
    algorithm: "sha256",
    treeDigest,
    manifestDigest,
  }, null, 2));
}
```

不要让命令自动修改 marketplace JSON。

第一版让作者自己复制结果更安全。

后续可以做：

```bash
bun run src/cli.ts plugin integrity update-marketplace examples/marketplaces/team
```

但这需要更谨慎的 JSON 编辑。

## 生成签名

签名命令可以先设计，不一定立刻要求所有用户使用。

```bash
bun run src/cli.ts plugin signature verify review-pack@team
```

如果你要提供签名生成：

```bash
bun run src/cli.ts plugin signature sign examples/marketplaces/team/plugins/review-pack --key team-2026-01
```

不要把私钥放进项目配置。

第一版可以只支持从环境变量读取私钥路径：

```text
MINI_PLUGIN_SIGNING_KEY_PATH
```

如果没有，就报错：

```text
Set MINI_PLUGIN_SIGNING_KEY_PATH to sign plugins.
```

本章不建议实现复杂私钥管理。

但验证公钥必须能从 keyring 读。

## 更新时校验

更新流程也必须走同样链路。

不要只在安装时校验。

`updatePluginFromMarketplace`：

```text
1. 找到当前安装记录。
2. 重新 stage 新版本。
3. 计算 digest。
4. 校验 integrity。
5. 校验 signature。
6. 复制到新版本缓存。
7. 更新 installed_plugins.json。
8. 标记旧版本 orphan。
9. 更新 lockfile。
```

如果 digest 或 signature 失败：

```text
旧版本继续保留。
installed_plugins.json 不变。
lockfile 不变。
```

这就是非原地更新的价值。

失败不会污染当前版本。

## 离线安装

有了 lockfile 和缓存后，Mini 可以支持离线模式：

```bash
bun run src/cli.ts plugin install --locked
```

语义：

```text
只从本地缓存安装。
不读取远程 URL。
不刷新 marketplace。
必须满足 plugins.lock.json。
```

第一版可以先做 doctor：

```bash
bun run src/cli.ts plugin doctor --integrity
```

后续再做完整离线安装。

离线模式的核心规则是：

```text
lockfile 是期望。
installed_plugins.json 是本机状态。
cache 是物化内容。
```

三者必须对齐。

## 测试：Stable JSON

`src/plugins/__tests__/stableJson.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { stableJson } from "../stableJson";

describe("stableJson", () => {
  test("sorts object keys recursively", () => {
    expect(
      stableJson({
        b: 1,
        a: {
          d: 4,
          c: 3,
        },
      }),
    ).toBe('{"a":{"c":3,"d":4},"b":1}');
  });

  test("keeps array order", () => {
    expect(stableJson([{ b: 1, a: 2 }, { d: 3, c: 4 }])).toBe('[{"a":2,"b":1},{"c":4,"d":3}]');
  });
});
```

## 测试：Tree Hash

`src/plugins/__tests__/hashTree.test.ts`：

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { hashTree } from "../hashTree";

describe("hashTree", () => {
  test("is stable for same files", async () => {
    const root = join(import.meta.dir, `.tmp-tree-${Date.now()}`);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "b.txt"), "b");
    await writeFile(join(root, "a.txt"), "a");

    const first = await hashTree(root);
    const second = await hashTree(root);

    expect(first.digest).toBe(second.digest);
  });

  test("changes when file content changes", async () => {
    const root = join(import.meta.dir, `.tmp-tree-change-${Date.now()}`);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "a.txt"), "a");

    const first = await hashTree(root);
    await writeFile(join(root, "a.txt"), "b");
    const second = await hashTree(root);

    expect(first.digest).not.toBe(second.digest);
  });
});
```

## 测试：Integrity 校验

`src/plugins/__tests__/pluginIntegrity.test.ts`：

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { computePluginTreeDigest, assertPluginIntegrity } from "../pluginIntegrity";

async function createPlugin(root: string): Promise<void> {
  await mkdir(join(root, ".mini-plugin"), { recursive: true });
  await mkdir(join(root, "commands"), { recursive: true });
  await writeFile(
    join(root, ".mini-plugin", "plugin.json"),
    JSON.stringify({
      name: "review-pack",
      version: "0.1.0",
      commands: "./commands",
    }),
  );
  await writeFile(join(root, "commands", "review.md"), "Review changes");
}

describe("assertPluginIntegrity", () => {
  test("accepts matching tree digest", async () => {
    const root = join(import.meta.dir, `.tmp-plugin-${Date.now()}`);
    await createPlugin(root);
    const treeDigest = await computePluginTreeDigest(root);

    await expect(
      assertPluginIntegrity({
        pluginId: "review-pack@team",
        pluginRoot: root,
        entry: {
          name: "review-pack",
          version: "0.1.0",
          source: "./plugins/review-pack",
          integrity: {
            algorithm: "sha256",
            treeDigest,
          },
        },
      }),
    ).resolves.toBeDefined();
  });

  test("rejects mismatched tree digest", async () => {
    const root = join(import.meta.dir, `.tmp-plugin-bad-${Date.now()}`);
    await createPlugin(root);

    await expect(
      assertPluginIntegrity({
        pluginId: "review-pack@team",
        pluginRoot: root,
        entry: {
          name: "review-pack",
          version: "0.1.0",
          source: "./plugins/review-pack",
          integrity: {
            algorithm: "sha256",
            treeDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          },
        },
      }),
    ).rejects.toThrow();
  });
});
```

## 测试：Lockfile

`src/plugins/__tests__/pluginLockfile.test.ts`：

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { readPluginLockfile, updatePluginLockfile, getPluginLockfilePath } from "../pluginLockfile";

describe("plugin lockfile", () => {
  test("writes marketplace and plugin entries", async () => {
    const projectRoot = join(import.meta.dir, `.tmp-lock-${Date.now()}`);

    await updatePluginLockfile({
      projectRoot,
      marketplaceName: "team",
      marketplace: {
        manifestDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        sourceDigest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
        signingKeyId: "team-2026-01",
      },
      pluginId: "review-pack@team",
      plugin: {
        version: "0.1.0",
        marketplace: "team",
        treeDigest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
        manifestDigest: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
        signatureKeyId: "team-2026-01",
      },
    });

    const raw = await readFile(getPluginLockfilePath(projectRoot), "utf8");
    const lockfile = await readPluginLockfile(projectRoot);

    expect(raw).toContain("review-pack@team");
    expect(lockfile.plugins["review-pack@team"]?.version).toBe("0.1.0");
  });
});
```

## 测试：签名验证

`src/plugins/__tests__/pluginSignature.test.ts`：

```ts
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { stableJson } from "../stableJson";
import { verifyPluginSignatureIfRequired } from "../pluginSignature";

describe("verifyPluginSignatureIfRequired", () => {
  test("accepts a valid ed25519 signature", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const payload = {
      pluginId: "review-pack@team",
      version: "0.1.0",
      treeDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      manifestDigest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    };
    const signature = sign(null, Buffer.from(stableJson(payload), "utf8"), privateKey).toString("base64");

    await expect(
      verifyPluginSignatureIfRequired({
        marketplace: {
          name: "team",
          owner: {
            name: "Frontend Platform",
          },
          signing: {
            keyId: "team-2026-01",
            algorithm: "ed25519",
            publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
          },
          plugins: [],
        },
        entry: {
          name: "review-pack",
          version: "0.1.0",
          source: "./plugins/review-pack",
          signature: {
            keyId: "team-2026-01",
            algorithm: "ed25519",
            value: signature,
          },
        },
        pluginId: "review-pack@team",
        treeDigest: payload.treeDigest,
        manifestDigest: payload.manifestDigest,
        required: true,
      }),
    ).resolves.toBeUndefined();
  });
});
```

## 手动验收

生成插件完整性信息：

```bash
bun run src/cli.ts plugin integrity generate examples/marketplaces/team/plugins/review-pack
```

把输出复制到 marketplace entry：

```json
{
  "name": "review-pack",
  "version": "0.2.0",
  "source": "./plugins/review-pack",
  "integrity": {
    "algorithm": "sha256",
    "treeDigest": "sha256:...",
    "manifestDigest": "sha256:..."
  }
}
```

安装：

```bash
bun run src/cli.ts plugin marketplace update team
bun run src/cli.ts plugin install review-pack@team --scope project
```

确认生成锁文件：

```text
.mini/plugins.lock.json
```

然后手动改缓存里的命令文件：

```text
~/.claude-code-mini/plugins/cache/team/review-pack/0.2.0/commands/review.md
```

运行：

```bash
bun run src/cli.ts plugin doctor --integrity
```

期望失败：

```text
review-pack@team: tree digest mismatch
```

再运行：

```bash
bun run src/cli.ts plugin reload
```

期望：

```text
review-pack@team skipped because cached integrity check failed
```

## 常见坑

第一，把 hash 当成信任。

hash 只证明内容没变。

不证明内容可信。

第二，签整个 marketplace entry。

这会让 description、tags 这种展示字段变成签名敏感字段。

更稳的是签内容 digest 和必要元数据。

第三，锁文件写本机绝对路径。

锁文件应该可以提交到仓库。

本机路径只属于 installed plugins 状态。

第四，先写最终缓存再校验。

校验失败会污染缓存。

应该先 stage，再 verify，再写 final cache。

第五，更新失败后仍然改 installed_plugins.json。

完整性或签名失败时，当前版本必须保持不变。

第六，运行时只相信 lockfile，不复验缓存。

缓存目录可能被外部进程改过。

loader 应该在注册插件能力前复验 hash。

第七，强签名策略下信任 marketplace 里的 public key。

如果要求强签名，public key 应该来自 keyring 或策略配置。

marketplace 自带 key 只能作为弱模式 fallback。

第八，tree hash 不包含路径。

只 hash 文件内容会产生结构歧义。

必须把相对路径、文件模式和文件内容 hash 一起纳入。

## 小结

本章给 Mini 增加了插件完整性和签名校验。

现在 Mini 支持：

- 稳定 JSON。
- 文件 hash。
- 目录 tree hash。
- marketplace manifest digest。
- plugin manifest digest。
- 插件 integrity 字段。
- 插件签名字段。
- 项目级 plugins lockfile。
- 安装时完整性校验。
- 更新时完整性校验。
- 运行时缓存复验。
- keyring 和强签名策略。
- integrity doctor。

到这里，Mini 的插件系统已经从“可分发”升级到“可验证”。

下一章可以继续做 **认证、Provider 配置与密钥管理**：把 API key、baseUrl、model、OAuth、兼容 provider、DeepSeek Anthropic-compatible 配置和安全存储统一收敛起来。
