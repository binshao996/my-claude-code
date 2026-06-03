# 03 - Markdown 与代码块

## 当前章节目标

本章实现技术回答的基础渲染能力：

- 段落、列表、引用。
- Inline code。
- Fenced code block。
- 代码块语言标签。
- Copy 按钮。

## 为什么不能只渲染纯文本

AI Coding Agent 的回答大多包含代码、路径、命令和 diff 解释。纯文本会让用户难以扫描。

V1 至少要把这些内容分层显示：

```text
解释文字
命令
代码片段
文件路径
错误信息
```

## MarkdownView

教学版可以先用成熟 Markdown 解析库，例如 `react-markdown`。不要手写 Markdown parser。

```tsx
import ReactMarkdown from "react-markdown";

type MarkdownViewProps = {
  content: string;
};

export function MarkdownView({ content }: MarkdownViewProps) {
  return (
    <ReactMarkdown
      components={{
        code(props) {
          const { inline, className, children } = props;
          const match = /language-(\w+)/.exec(className ?? "");

          if (inline) {
            return <code className="inline-code">{children}</code>;
          }

          return (
            <CodeBlock
              language={match?.[1] ?? "text"}
              code={String(children).replace(/\n$/, "")}
            />
          );
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
```

生产实现需要更严格的安全策略。默认不要允许原始 HTML，避免模型输出 HTML 注入 UI。

## CodeBlock

```tsx
type CodeBlockProps = {
  language: string;
  code: string;
};

export function CodeBlock({ language, code }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <figure className="code-block">
      <figcaption>
        <span>{language}</span>
        <button type="button" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </figcaption>
      <pre>
        <code>{code}</code>
      </pre>
    </figure>
  );
}
```

V1 暂时不做语法高亮也可以。真正的高亮可以放在后续增强里，例如接入 Shiki 或 Monaco tokenization。

## 样式

```css
.inline-code {
  padding: 1px 5px;
  border-radius: 4px;
  background: #2a2521;
  color: #ffd6c2;
}

.code-block {
  margin: 12px 0;
  overflow: hidden;
  border: 1px solid #3a332d;
  border-radius: 8px;
  background: #151515;
}

.code-block figcaption {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid #3a332d;
  color: #b8ada5;
  font-size: 12px;
}

.code-block pre {
  margin: 0;
  overflow-x: auto;
  padding: 12px;
}

.code-block code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 13px;
}
```

## 流式 Markdown 的 Tradeoff

流式内容可能出现半截 Markdown：

```text
```ts
export fu
```

如果每个 delta 都完整 parse，会出现代码块短暂跳动。

V1 可以接受这种轻微抖动，因为目标是教学清晰。生产实现可以优化：

- 对 `text_delta` 做 16ms 到 50ms batching。
- 检测 fenced code block 未闭合时使用临时渲染。
- 对大段内容做局部 memo。
- 长会话使用虚拟列表。

## Copy 的企业级注意点

Copy 按钮看似简单，但企业场景要考虑：

- 不要复制隐藏文本。
- 不要复制工具内部 metadata。
- 不要自动执行命令。
- 不要把 secrets 写入日志。
- 复制失败时给出明确反馈。

V1 只实现基础复制，后续企业版本再加入更完整的安全策略。

## 调试验证

用这些内容测试：

````md
请检查：

- `package.json`
- `src/main.ts`

运行：

```bash
bun run typecheck
```

示例：

```ts
export function add(a: number, b: number) {
  return a + b;
}
```
````

预期：

- 列表正常显示。
- inline code 有视觉区分。
- 两个 code block 都有语言标签。
- Copy 只复制代码内容。

## 本章实操标准

### 本章效果

完成本章后，`MessageBubble` 不再直接显示纯文本，而是通过 `MarkdownView` 渲染 assistant 内容：

```text
ChatState.messages
  -> MessageBubble
  -> MarkdownView
  -> CodeBlock
```

用户能在 streaming 回答里看到列表、inline code 和 fenced code block；代码块能复制纯代码内容。

### 改动文件

本章改动文件：

```text
src/renderer/components/MarkdownView.tsx
src/renderer/components/CodeBlock.tsx
src/renderer/components/MessageBubble.tsx
src/renderer/styles/chat.css
```

如果项目尚未安装 Markdown 渲染库，先执行：

```bash
pnpm add react-markdown
```

不要手写 Markdown parser，也不要允许模型输出的原始 HTML 直接进入 DOM。

### 实现步骤

1. 在 `MarkdownView.tsx` 接入 `react-markdown`，覆盖 `code` renderer。
2. inline code 渲染为 `<code className="inline-code">`。
3. fenced code block 提取 `language-*` className，交给 `CodeBlock`，没有语言时显示 `text`。
4. 在 `CodeBlock.tsx` 实现 Copy 按钮，只复制 `code` 字符串，不复制 caption、按钮文本或隐藏内容。
5. 在 `MessageBubble.tsx` 确认 user / assistant 都走 `MarkdownView`，避免 assistant 和 user 渲染逻辑分叉。
6. 在 CSS 里给 `.code-block pre` 设置横向滚动，避免长命令撑破消息气泡。

### 运行命令

在 Client 工程根目录执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

如果本章引入新依赖，安装命令必须写在本章正文中，并在运行前执行。

### 你应该看到

用下面 prompt 验证：

```text
请用 Markdown 回答：列出 3 个检查项，并给出一个 bash 命令和一个 TypeScript 函数示例。
```

预期效果：

- `-` 或编号列表显示为列表，不是挤在一行。
- `package.json` 这类 inline code 有独立样式。
- `bash` 和 `ts` 两个 code block 都显示语言标签。
- 点击 Copy 后按钮短暂变为 `Copied`，剪贴板内容只有代码本体。
- streaming 中半截 Markdown 可以短暂抖动，但最终 `done` 后结构正确。

### 常见报错

- `react-markdown` 找不到：确认已经在 Client 工程根目录执行 `pnpm add react-markdown`，并提交 lockfile 变化。
- code block 被当成 inline code：确认 renderer 能从 `className` 里匹配 `language-xxx`，并正确判断 `inline`。
- Copy 失败：确认 Electron/浏览器环境允许 `navigator.clipboard.writeText`，失败时至少在 UI 显示错误或保持按钮可用。
- 长代码撑破布局：确认 `.code-block pre` 有 `overflow-x: auto`。
- 模型输出 HTML 被执行：不要启用 raw HTML 插件；V1 默认只渲染 Markdown AST。

## 可运行验收

本章完成后执行：

```bash
pnpm dev
pnpm typecheck
pnpm test
```

验收时至少复制一次代码块，并确认复制内容不包含语言标签或按钮文字。
- 如果本章涉及路径、权限、终端、插件或 patch，必须验证越界和失败场景。

## 当前章节缺陷

V1 的 Markdown 还不能和项目文件联动。

例如模型输出 `src/main.ts`，现在只是文本。V3 File Tree 和 V4 Editor 会让这些路径变成可点击、可定位、可打开的项目实体。

## 下一章预告

下一章会实现 Tool Activity，把工具调用从 assistant 文本中拆出来独立展示。
