# dsh-baize-session

**[English](README.md) | 简体中文**

![npm version](https://img.shields.io/npm/v/dsh-baize-session)
![license](https://img.shields.io/npm/l/dsh-baize-session)

> English: *`dsh-baize-session` (Baize) is a dsh plugin that moves context between conversations: pick messages out of the conversation you are in, then carry them into another one.*

[dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) 的**会话间上下文搬运**插件：在你正待着的会话里挑出若干条消息，把它们带到另一个会话——已存在的，或另一个工作区里全新开的。

名字取自**白泽**——传说中通晓万物的神兽。[`dsh-baize-rules`](https://www.npmjs.com/package/dsh-baize-rules) 注入的是*要求*，这个插件搬运的是*上下文*。

- 挑中的消息会被**改写成文本**，合成一条 `user/message`，来源标记为 `source.kind='plugin'`、`plugin='baize-session'`——而不是重放事件。任意挑选的历史无法重放：会话存储要求 seed 必须从 seq 0 连续，一段不完整的历史不是合法前缀。
- 注入块的结尾是 `当前工作区是 <路径>。请在此基础上继续。`——明确告诉模型这段引用的历史来自别的目录，全程不做任何路径改写。
- **没有选中内容就不写入**：篮子为空时直接拒绝，绝不会注入一个空壳。

![dsh web UI 里的「整理」标签页——目标工作区与目标对话两个下拉、显示已选条数与 token 估算的操作条，以及带 USER / ASSISTANT / CONTEXT / TOOL 徽章的消息表格](https://raw.githubusercontent.com/bvcvb/dsh-baize-session/HEAD/assets/001-tidy-panel.png)

---

## 功能

| 功能 | 说明 |
|---|---|
| **就在当前会话里挑** | 「整理」标签页把本会话的消息列成勾选表格。点行看完整正文，点复选框才选中 |
| **随处收集** | 每条助手回复旁有 `＋` 按钮，不离开聊天流就能收进来。篮子按会话独立存放 |
| **两种落点** | 在选定工作区里**新建对话**（内容作为该会话的 seed），或**追加**到当前已打开的会话 |
| **天然跨工作区** | 新建会话时以目标工作区为 `cwd`，因此它落在那个工作区的会话目录下——跨工作区搬运不需要任何路径改写 |
| **用名字而不是 id** | 目标对话下拉显示会话自己的标题（日志里的 `session/title`），没有标题时退回首行正文；原始 id 放在 tooltip 里 |
| **只列真实对话** | 从没跑过 turn 的会话（侧边栏里那行「新建会话」占位）与已归档会话都会被过滤——与官方侧边栏的 `sessionVisible` 规则一致 |
| **按来源标注角色** | `user` / `assistant` / `context` / `tool`，配色取自官方「轨迹」视图的 kind tag。`context` 这一档很关键：人类输入和系统注入在 dsh 里是**同一个** `user/message` 事件类型 |
| **Token 预算** | 写入前先估算；超过 `maxInjectTokens` 会带着实测数字拒绝，而不是悄悄截断 |
| **一套运行时，两个入口** | 面板与 `/baize-session` 命令驱动同一个 `RelocationRuntime`，两者不可能出现分歧 |
| **自己不留任何文件** | 篮子只在内存里；涉及的持久化状态（会话、工作区、归档集合）全部属于 dsh |

---

## 安装

> dsh 插件通过 npm 分发，用 `dsh plugin` 装进某个 profile。

```bash
# 从 npm 装进 web profile（请使用实际已发布的版本号）
dsh plugin --profile web add dsh-baize-session@0.1.0
pm2 restart dsh          # 用 pm2 托管 dsh 时执行
dsh --profile web
```

peer 依赖（`@deepseek-ai/*`）由 dsh profile 提供；若有缺失，pnpm 会依照 profile 目录下的 `peerDependencies` 解析。插件同时声明了 `dsh.bundle`（通过 `cordis.patch.yml` 把自己挂进插件树）与 `dsh.client`（浏览器端），两半都靠它才会加载。

### 卸载

```bash
dsh plugin --profile web remove dsh-baize-session
pm2 restart dsh          # 用 pm2 托管 dsh 时执行
```

如果 profile 的 `dsh.profile.bundles` 里还残留这一行，从
`$DSH_HOME/profiles/web/package.json` 里删掉它再重启一次。除此之外不会留下任何东西：本插件不写自己的数据（见[数据位置](#数据位置)）。

### 不打扰正在运行的 dsh 试装

装进一个**单独的 profile**，当前运行的 dsh 完全不受影响：

```bash
dsh plugin --profile smoke add dsh-baize-session@0.1.0
dsh --profile smoke --dump-config   # 只组装并打印配置，不启动 dsh
```

### 本地开发（link）

还没发布、或想吃到源码改动时：

```jsonc
// $DSH_HOME/profiles/web/package.json
"dependencies": {
  "dsh-baize-session": "link:/home/abc/work/plugin/dsh-baize-session"
}
```

然后在 profile 目录里 `pnpm install`，并把 `dsh-baize-session` 加进 `dsh.profile.bundles`。

---

## 快速上手

打开任意会话，点聊天视图旁边的 **整理** 标签页。

```
① 目标工作区  [ /home/abc/work/plugin        ▾ ]
② 目标对话    [ 新建对话                     ▾ ]
─────────────────────────────────────────────────────────────
   已选 0 段                              [ 清空 ] [ 迁移 ]
─────────────────────────────────────────────────────────────
   12  USER         消息正文的第一行……                         ← 点行看全文
   13  CONTEXT      Current runtime context. This snapshot…
   14  ASSISTANT    回复正文的第一行……
```

1. 选工作区（当前工作区默认选中并排在最前；末项可以手填绝对路径）。
2. 选目标对话——`新建对话`，或该工作区下的任意真实对话。
3. 勾选要带走的条目。点行只是看全文，**不会**选中它。
4. 点**迁移**。

同样的操作也可以纯键盘完成：

```bash
/baize-session                     # 等同 info：本会话 id、工作区、消息与篮子计数
/baize-session take 12 14          # 按 seq 收集（从当前会话）
/baize-session list                # 按工作区分组列出所有真实对话
/baize-session to /home/abc/work/led   # 在那里新建一个会话并写入篮子
/baize-session add session-1a2b…   # 或追加到一个已打开的会话
/baize-session drop                # 清空篮子
```

---

## 命令

| 子命令 | 语法 | 用途 |
|---|---|---|
| **info** | `/baize-session [info\|status]` | 显示本会话 id、工作区、消息/篮子计数，以及最近 `listLimit` 条消息及其 seq |
| **take** | `/baize-session take <seq…>` | 按 seq 从当前会话收集消息 |
| **list** | `/baize-session list` | 按工作区分组列出真实对话（名称 + id）；空会话与已归档只在末尾以计数提示，不列出 |
| **drop** | `/baize-session [drop\|clear]` | 清空篮子 |
| **to** | `/baize-session [to\|move] <绝对路径>` | 在该工作区新建会话，并把篮子写入作为开场上下文 |
| **add** | `/baize-session [add\|append] <会话id>` | 把篮子追加进一个已存在的会话——该会话必须处于打开（在内存中）状态 |

---

## 面板（「整理」标签页）

标签页注册在 `conversation.view` 槽位（id `baize-session-tidy`，order 40）——纯增量，不替换任何官方组件。`＋` 按钮注册在 `conversation.chat.assistant-actions`（id `baize-session-collect`，order 20）。

| 操作 | 结果 |
|---|---|
| 点消息行 | 展开/收起该条的**完整正文**（表格里只显示首行） |
| 点复选框 | 选中/取消选中该条；详情保持原样 |
| 点目标下拉 | 自绘浮层（原生 `<select>` 与 dsw 主题不搭）；点外部或按 Esc 关闭 |
| 工作区下拉末项 | `手填绝对路径…` 展开一个输入框，用于尚未登记的工作区 |

消息行按来源打标：

| 徽章 | 含义 | 配色来源（官方「轨迹」视图） |
|---|---|---|
| `USER` | 人类输入（`source.kind === 'user'`） | `.user` —— `state-business-primary` / `state-business-tertiary` |
| `ASSISTANT` | 模型回复 | `.assistantVioletBright` |
| `CONTEXT` | 由插件或 harness 注入——运行时快照、`<system-reminder>`、记忆库注入，以及本插件自己写入的整理块 | `.contextGreen` |
| `TOOL` | 工具结果（`tool/result` 事件） | `.toolAmber` |

`user/message` **不等于**"用户说过这句话"：dsh 把人类输入与注入的上下文记成同一个事件类型，只靠 `data.source.kind` 区分。抽样一个真实会话，其分布是 `{user: 4, plugin: 10}`——那次对话里大部分内容根本没人打过字，这正是要给两者分别打标的原因。

![点开的消息行：完整正文展开在该行下方，带来源徽章、#seq 与字数；真正用于选中它的是行上的复选框](https://raw.githubusercontent.com/bvcvb/dsh-baize-session/HEAD/assets/002-message-detail.png)

---

## 注入的内容

每次迁移写入一条 `user/message`，用 `createUserMessage()` 构造，并以 surface 事件必需的标记 `{ surfaceOp: 'append' }` 发布：

```text
以下是本会话开始前，我（用户）从其它会话整理过来的上下文，供你参考：

【来自会话 06094031 / 工作区 /home/abc/work/plugin】
user: token 预算是在哪强制的？
assistant: 在 relocate.ts 里，写入之前——它是抛错而不是截断。

---
当前工作区是 /home/abc/work/led。请在此基础上继续。
```

- 每条都保留**来源标注**（`user:` / `assistant:` / `context:` / `tool:`），让接收方模型能分清哪些是提问、哪些是注入。
- 内容按来源会话分组，并保持收集顺序。
- 目标是已存在的会话时，这段内容作为普通消息追加；目标是新会话时，**同一条消息**成为该会话的 seed。之所以用 seed，是因为 dsh 按 checkpoint 落盘：一个没人说过话的全新会话，走 `append` 是永远落不到磁盘的。
- 新会话随后会被挂到它所属的工作区（`workspace.attachSession`），这正是它能出现在侧边栏的原因。

---

## 哪些会列、哪些不会

目标列表的过滤规则与官方侧边栏（`dsh-client-ui-workspace` 的 `sessionVisible`）一致：

| 情况 | 行为 | 原因 |
|---|---|---|
| 从没跑过 turn 的会话（`blank`） | **不列出** | 侧边栏把它渲染成工作区里那行临时「新建会话」占位，标签固定、真实标题永不显示。这里的 `新建对话` 就是那行占位的等价物 |
| 已归档会话（注册表全局归档集合） | **不列出** | 归档是 dsh 维护的全局集合（`$DSH_HOME/storages/workspace.json`），侧边栏会隐藏成员。读取是尽力而为：取不到归档集合时不做任何隐藏 |
| 日志读不出来的会话 | 列出（保守视为非 blank） | 与官方规则一致："unavailable or oversized artifacts conservatively report false" |
| 作为**追加**目标的未打开会话 | 拒绝：`目标会话不在内存中，无法追加（先在侧边栏打开它）。` | 追加需要活的会话；先从侧边栏打开它 |
| 作为**内容来源**的未打开会话 | 允许 | 用 `persistence.inspect()` 读回日志——这个读法既不提交恢复也不发布，浏览不会扰动该会话 |
| 没有任何真实对话的工作区 | 仍列出（不显示数量） | 这正是"在这里新建一个对话"的场景。工作区列表本身来自 `ctx.workspaceRegistry.list()`，绝不从会话的 `cwd` 推导 |
| 有真实对话但没有工作区记录的目录 | 列出并标注 `未分组` | 侧边栏把这类会话收在「未分组」分组里；不这么做，这些对话在选择器里就彻底找不到了 |
| 你正待着的这个会话 | 不作为目标提供 | 往自己身上迁移没有意义 |

**一个值得知道的连带效果：** 刚迁进 `新建对话` 的那个新会话，它自己就是 `blank`，所以暂时不会出现在目标列表里。从侧边栏打开它、说一句话，dsh 会为它生成标题，它就变成正常目标了。侧边栏的行为也是如此，不是本插件的限制。

---

## 配置（`Config`）

| 字段 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `maxInjectTokens` | `number`，**必填** | `8000`，由本包的 `cordis.patch.yml` 设置 | 估算超过这么多 token 就拒绝写入。拒绝信息里带上实测大小，所以"选太多"是可见的，而不是被悄悄裁掉 |
| `listLimit` | `number`，可选 | `15`，代码内默认（patch 并未设置） | `/baize-session info` 列出最近多少条消息 |

包里实际发布的 patch 就是下面这样——要覆盖 `listLimit`，加在同一个 `config` 块里即可：

```yaml
# cordis.patch.yml
- insert:
    - id: baize-session
      name: 'dsh-baize-session'
      config:
        maxInjectTokens: 8000
```

---

## HTTP API

浏览器端无法读取或创建会话，因此面板与宿主 web 服务器上的 `/baize-session.api` 通信。它委托给命令所用的同一个运行时。

| 请求 | Body / 查询 | 返回 |
|---|---|---|
| `GET /baize-session.api` | `?sessionId=<id>`（必填），`&source=<id>` 可列出另一个会话的消息 | `PanelState`：`{ sessionId, cwd, messages, basket, projects, sessions, maxInjectTokens }` |
| `POST /baize-session.api` | `{ sessionId, op: 'take', seqs?, messageIds?, sourceId? }` | `{ ok, added, missing, state }` |
| | `{ sessionId, op: 'untake', seq?, messageId?, sourceId? }` | `{ ok, removed, state }` |
| | `{ sessionId, op: 'drop' }` | `{ ok, state }` |
| | `{ sessionId, op: 'estimate', target }` | `{ ok, tokens }` |
| | `{ sessionId, op: 'relocate', target }` | `{ ok, sessionId, mode, tokens, sources, state }` |

`target` 为 `{ kind: 'new', cwd }` 或 `{ kind: 'existing', sessionId }`。用户能自行处理的拒绝
（相对路径、空篮子、追加目标未打开、超出预算）以 `400` 返回，消息可直接展示给用户；其余为 `500`。

---

## 数据位置

**本插件不存任何自己的数据。** 篮子只活在进程内存里，重启即空——这正是"为这一次搬运而选"的应有范围。

它接触的一切都属于 dsh：

| 路径 | 内容 |
|---|---|
| `$DSH_HOME/sessions/<转义后的 cwd>/<会话 id>/session.jsonl.zstd` | 会话本体（多帧 zstd）；仅在会话已关闭时读回 |
| `$DSH_HOME/storages/workspace.json` | 工作区记录与注册表全局的会话归档集合 |

---

## 模块结构

```
src/core.ts       纯逻辑：事件读取与角色分类 user/assistant/context/tool、消息列表、renderInjection、会话命名
src/relocate.ts   运行时：篮子、面板状态、take/untake/drop/estimate/relocate、工作区与持久化访问
src/api.ts        宿主 HTTP API：/baize-session.api 的 GET 状态 + POST 操作分发
src/index.ts      apply：createRelocation + /baize-session 命令 + API 挂载（inject: commands/sessions/tokenMeter/webServer/sessionPersistence）
lib/client.js     浏览器端，手写产物：「整理」标签页 + 「＋」槽位，window.__ModuleLoader__.load({ id, factory })
test/core.spec.ts        纯函数的单元测试（fixture 照抄真机日志形状）
test/client.smoke.mjs    用 react-test-renderer 跑真实客户端产物并断言其行为
cordis.patch.yml  挂载元数据（插入 baize-session 插件行与默认配置）
```

**对外入口**（见 `package.json` 的 `exports`）：`.`（index）、`./client`、`./src/*`、`./package.json`。

---

## 开发与即时反馈

```bash
pnpm test            # vitest 单元测试，随后跑客户端冒烟测试
pnpm test:client     # 只跑客户端冒烟测试（node test/client.smoke.mjs）
pnpm test:watch      # 保存即重跑单元测试
pnpm build           # tsc -p tsconfig.build.json → lib/
pnpm typecheck       # tsc --noEmit
```

| 改的是 | 位置 | 怎么看到效果 |
|---|---|---|
| 宿主（`src/*.ts`） | 经 `pnpm build` 产出 `lib/*.js` | 构建后**重启** dsh（宿主加载的是 `lib/`） |
| 浏览器（`lib/client.js`） | 手写，无构建步骤 | **刷新页面**即可——产物从磁盘按内容哈希版本号直接提供 |

`lib/client.js` 是手写的：官方的 `clientBundle` tsdown 预设没有发布，所以 dsh 仓库之外的插件要自己写
`window.__ModuleLoader__.load({ id, factory })` 这层壳，只把种子模块（`react`、ui-primitives）留作外部依赖。它没有任何类型检查或打包环节，因此 `test/client.smoke.mjs` 会带着打桩后的宿主 API 用 `react-test-renderer` 加载真实产物，断言面板的版式、交互顺序、角色徽章与它的 CSS 规则。

---

## 发布

```bash
# 1. 升级 package.json 里的版本号，并同步两个 README 的安装示例
# 2. 本地验证
pnpm build && pnpm typecheck && pnpm test
# 3. 提交、打标签、推送
git add -A && git commit -m "release: vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin main && git push origin vX.Y.Z
# 4. 发布——真正出货的一步
npm publish --access public
```

> **凭据。** `npm publish` 使用你自己的 npm 凭据（`~/.npmrc` 或环境变量）。绝不要提交 token，也不要把它粘进 README 或 CI 日志。

---

## 许可

[MIT](./LICENSE)
