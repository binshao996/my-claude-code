# 04 - 文件搜索

## 当前章节目标

本章实现文件名搜索。

完成后，用户可以输入关键词，从当前 Workspace 的已加载文件树中快速定位文件。

## 为什么 V3 只做文件名搜索

全文搜索是另一类问题，需要：

- 读取文件内容。
- 遵守二进制文件和大文件限制。
- 处理 ignore 规则。
- 处理性能和取消。
- 展示匹配行。

这些更接近 V5/V6 之后的能力。V3 先做文件名搜索，用来支撑“快速打开文件”。

## SearchIndex

```ts
export type FileSearchItem = {
  id: string;
  name: string;
  relativePath: string;
  node: FileTreeNode;
};

export function buildFileSearchIndex(root: FileTreeNode): FileSearchItem[] {
  const items: FileSearchItem[] = [];

  function visit(node: FileTreeNode) {
    if (node.type === "file") {
      items.push({
        id: node.id,
        name: node.name,
        relativePath: node.relativePath,
        node,
      });
    }

    for (const child of node.children ?? []) {
      visit(child);
    }
  }

  visit(root);
  return items;
}
```

## 简单匹配

```ts
export function searchFiles(
  items: FileSearchItem[],
  query: string,
): FileSearchItem[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];

  return items
    .filter(item =>
      item.name.toLowerCase().includes(normalized) ||
      item.relativePath.toLowerCase().includes(normalized),
    )
    .slice(0, 50);
}
```

教学版先用 `includes`。生产实现可以升级为 fuzzy search，但不要一开始就把算法复杂度引入教程。

## SearchBox

```tsx
export function FileSearchBox({
  items,
  onOpen,
}: {
  items: FileSearchItem[];
  onOpen(item: FileSearchItem): void;
}) {
  const [query, setQuery] = useState("");
  const results = useMemo(() => searchFiles(items, query), [items, query]);

  return (
    <section className="file-search">
      <input
        value={query}
        placeholder="Search files"
        onChange={event => setQuery(event.target.value)}
      />

      {results.length > 0 ? (
        <div className="file-search-results">
          {results.map(item => (
            <button key={item.id} type="button" onClick={() => onOpen(item)}>
              <strong>{item.name}</strong>
              <span>{item.relativePath}</span>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
```

## 搜索结果和树状态联动

点击搜索结果时，应该：

- 选中对应节点。
- 展开它的父目录。
- 发出 `OpenFileIntent`。

V3 可以先只做打开意图。展开父目录可以放到增强里。

## 调试验证

构造文件：

```text
src/main.ts
src/components/App.tsx
package.json
bun.lock
```

搜索：

- `main` 命中 `src/main.ts`
- `app` 命中 `src/components/App.tsx`
- `json` 命中 `package.json`
- 空字符串不返回结果

## 本章实操标准

### 本章效果

完成本章后，用户能基于已加载文件树做文件名搜索：

```text
FileTreeState.root
  -> buildFileSearchIndex()
  -> searchFiles(query)
  -> FileSearchBox
  -> select_node / OpenFileIntent 下一章
```

搜索只面向文件名和相对路径，不做全文搜索。

### 改动文件

本章改动文件：

```text
src/renderer/file-tree/searchFiles.ts
src/renderer/file-tree/selectors.ts
src/renderer/components/FileSearchBox.tsx
src/renderer/components/FileTreePanel.tsx
src/renderer/file-tree/searchFiles.test.ts
```

本章不新增 main IPC；搜索基于 renderer 已持有的 `FileTreeState.root`。

### 实现步骤

1. 在 `searchFiles.ts` 定义 `FileSearchItem`。
2. 实现 `buildFileSearchIndex(root)`，只把 `type === "file"` 的节点放进索引。
3. 实现 `searchFiles(items, query)`，对 `name` 和 `relativePath` 做大小写不敏感 includes，空 query 返回空数组。
4. 在 `selectors.ts` 增加 `selectFileSearchItems(state)`，root 为空时返回空数组。
5. 在 `FileSearchBox.tsx` 维护 query，用 `useMemo` 计算结果，最多展示 50 条。
6. 把 `FileSearchBox` 放到 `FileTreePanel` 顶部；点击结果先选中对应 node，打开 intent 下一章接。
7. 用单测覆盖 name 命中、relativePath 命中、空 query、只索引 file 不索引 directory。

### 运行命令

在 Client 工程根目录执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

如果本章引入新依赖，安装命令必须写在本章正文中，并在运行前执行。

### 你应该看到

运行 `pnpm dev` 后，在已打开 workspace 中验证：

- 文件树顶部出现搜索输入框。
- 输入 `package` 命中 `package.json`。
- 输入 `main` 命中 `src/main.ts` 或类似文件。
- 输入目录名时不会把目录本身作为结果，除非某个文件路径包含该目录名。
- 清空输入后搜索结果消失，文件树仍保持原展开/选中状态。
- 搜索结果显示文件名和相对路径，不显示绝对路径。

### 常见报错

- 搜索不到未展开目录里的文件：索引应基于 `root` 全量已加载节点，不是 `selectVisibleFileNodes()`。
- 搜索结果包含目录：`buildFileSearchIndex()` 只收集 file。
- 空 query 展示全部文件：V3 空 query 应返回空数组，避免弹出巨大列表。
- 输入卡顿：结果限制到 50 条，并用 `useMemo` 缓存 index/results。
- 点击搜索结果不选中树节点：先 dispatch `select_node`，展开父目录可后续增强。

## 可运行验收

本章完成后执行：

```bash
pnpm test src/renderer/file-tree/searchFiles.test.ts
pnpm dev
pnpm typecheck
```

验收重点是：搜索框能基于已加载树定位文件，并且不绕过 ignore 规则重新扫描磁盘。

## 当前章节缺陷

本章只搜索已加载节点。如果目录未扫描到，搜索也找不到。

生产实现可以使用后台索引或按需扩展扫描。

## 下一章预告

下一章会实现打开文件意图：无论用户从文件树点击，还是从搜索结果点击，都统一转成 V4 Editor 能消费的 `OpenFileIntent`。
