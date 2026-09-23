# dsh-baize-session

**[English](README.md) | 简体中文**

![npm version](https://img.shields.io/npm/v/dsh-baize-session)
![license](https://img.shields.io/npm/l/dsh-baize-session)

> English: *`dsh-baize-session` (Baize) is a dsh plugin that moves context between conversations, and manages the conversations of a workspace (archive / restore / delete / relocate).*

[dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) 插件，围绕对话做两件事：

- **在对话之间搬运上下文**——在你正待着的会话里挑出若干条消息，带到另一个会话：已存在的，或另一个工作区里全新开的。
- **管理工作区里的对话**——在一个标签页里列出全部（含已归档），归档、还原、真正删除，以及迁移到其他工作区。

名字取自**白泽**——传说中通晓万物的神兽。[`dsh-baize-rules`](https://www.npmjs.com/package/dsh-baize-rules) 注入的是*要求*，这个插件搬运的是*上下文*。

![dsh web UI 里的「整理」标签页——目标工作区与目标对话两个下拉、显示已选条数与 token 估算的操作条，以及带 USER / ASSISTANT / CONTEXT / TOOL 徽章的消息表格](https://raw.githubusercontent.com/bvcvb/dsh-baize-session/HEAD/assets/001-tidy-panel.png)

- 挑中的消息会被**改写成文本**，合成一条 `user/message`，来源标记为 `source.kind='plugin'`、`plugin='baize-session'`——而不是重放事件。任意挑选的历史无法重放：会话存储要求 seed 必须从 seq 0 连续，一段不完整的历史不是合法前缀。
- 注入块的结尾是 `当前工作区是 <路径>。请在此基础上继续。`——明确告诉模型这段引用的历史来自别的目录，全程不做任何路径改写。
- **没有选中内容就不写入**：篮子为空时直接拒绝，绝不会注入一个空壳。
- 所有破坏性操作都有**闸门**：会话必须先归档才能删除，而归档的会话**根本不能迁移**。

---

## 功能

| 功能 | 说明 |
|---|---|
| **就在当前会话里挑** | 「整理」面板把本会话的消息列成勾选表格。点行看完整正文，点复选框才选中 |
| **随处收集** | 每条助手回复旁有 `＋` 按钮，不离开聊天流就能收进来。篮子按会话独立存放 |
| **两种落点** | 在选定工作区里**新建对话**（内容作为该会话的 seed），或**追加**到当前已打开的会话 |
| **天然跨工作区** | 新建会话时以目标工作区为 `cwd`，因此它落在那个工作区的会话目录下——跨工作区搬运不需要任何路径改写 |
| **用名字而不是 id** | 选择器显示会话自己的标题（日志里的 `session/title`），没有标题时退回首行正文；原始 id 放在该行的详情里 |
| **按来源标注角色** | `user` / `assistant` / `context` / `tool`，配色取自官方「轨迹」视图的 kind tag。`context` 这一档很关键：人类输入和系统注入在 dsh 里是**同一个** `user/message` 事件类型 |
| **Token 预算** | 写入前先估算；超过 `maxInjectTokens` 会带着实测数字拒绝，而不是悄悄截断 |
| **工作区管理** | 「工作区」面板列出当前工作区的全部对话（含已归档），每行可归档 / 还原 / 迁移 / 删除，另有多选批量操作 |
| **打开中的对话也能迁移** | 还在内存里的会话可以迁移：先 flush，再在协调器的每-id 锁内改写工件，并让后续写入指向新位置 |
| **只把真实对话作为目标** | 「整理」面板的目标选择器会过滤掉空会话与已归档会话——与官方侧边栏的 `sessionVisible` 规则一致 |
| **一套运行时，两个入口** | 面板与 `/baize-session` 命令驱动同一套运行时，两者不可能出现分歧 |
| **自己不留任何数据文件** | 插件不在磁盘上保存自己的状态；它改动的东西（会话工件、工作区注册表）都属于 dsh |

---

## 安装

> dsh 插件通过 npm 分发，用 `dsh plugin` 装进某个 profile。

```bash
# 从 npm 装进 web profile（请使用实际已发布的版本号）
dsh plugin --profile web add dsh-baize-session@0.1.1
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
dsh plugin --profile smoke add dsh-baize-session@0.1.1
dsh --profile smoke --dump-config   # 只组装并打印配置，不启动 dsh
```

### 本地开发（link）

```jsonc
// $DSH_HOME/profiles/web/package.json
"dependencies": {
  "dsh-baize-session": "link:/home/abc/work/plugin/dsh-baize-session"
}
```

然后在 profile 目录里 `pnpm install`，并把 `dsh-baize-session` 加进 `dsh.profile.bundles`。

---

## 快速上手

打开任意会话，点聊天视图旁边的 **整理** 标签页。这一个标签页里有两个面板，用标题行上的子标签切换：

```
[对话] [轨迹] [规则] [整理]          ← 顶层标签栏（本插件只占「整理」）
──────────────────────────────────
 整理 | 工作区                       ← 两个面板
```

### 整理 —— 把消息搬进另一个对话

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

### 工作区 —— 管理这个工作区里的对话

![「工作区」面板：顶部是工作区路径与「全部 / 未归档 / 已归档」筛选及各自条数，下面是批量操作条，表格行上并列显示类型徽章与状态徽章，行尾是该行的归档与迁移按钮](https://raw.githubusercontent.com/bvcvb/dsh-baize-session/HEAD/assets/003-workspace-panel.png)

```
工作区：/home/abc/current/test        [ 全部 7 ] [ 未归档 6 ] [ 已归档 1 ]
─────────────────────────────────────────────────────────────────────────────
已选 0 个                              [ 归档 ] [ 还原 ] [ 迁移 ] [ 删除 ]
─────────────────────────────────────────────────────────────────────────────
☑ 问候与自我介绍     已对话  未打开   09-15 17:58 · 24 条消息   [ 归档 ] [ 迁移 ]
☑ 测试              已对话  进行中   09-20 12:42 · 31 条消息   [ 归档 ] [ 迁移 ]
☐ 已归档的对话       已对话  已归档   09-20 12:42 · 6 条消息    [ 还原 ] [ 删除 ]
```

| 操作 | 位置 | 规则 |
|---|---|---|
| **归档** | 行内按钮，或批量条 | 任意对话，打开或关闭的都可以 |
| **还原** | 行内按钮，或批量条 | 仅限已归档的对话 |
| **迁移**到其他工作区 | 行内按钮，或批量条 | **不能是已归档的**；打开中的对话也可以迁移 |
| **删除**（连同磁盘日志一起删） | 行内按钮，或批量条 | **仅限已归档**，且需要二次点击确认 |

点击某一行（按钮与复选框以外的任意位置）会展开它的详情行：完整 session id、创建时间、消息数、工作区路径，以及当前是否打开。

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
| **list** | `/baize-session list` | 按工作区分组列出真实对话（空会话与已归档只在末尾以计数提示，不列出），带名称与 id |
| **drop** | `/baize-session [drop\|clear]` | 清空篮子 |
| **to** | `/baize-session [to\|move] <绝对路径>` | 在该工作区新建会话，并把篮子写入作为开场上下文 |
| **add** | `/baize-session [add\|append] <会话id>` | 把篮子追加进一个已存在的会话——该会话必须处于打开（在内存中）状态 |

---

## 对话的类型与状态

「工作区」面板每一行都带**两个彼此独立的徽章**，因为它们回答的是不同问题：

| 列 | 取值 | 回答的问题 | 判据 |
|---|---|---|---|
| **类型** | `空对话` / `已对话` / `子代理` | 这里面有对话了吗？ | `blank`——从没记录过 `turn/start` |
| **状态** | `进行中` / `已打开` / `未打开` / `已归档` | 它现在在哪？ | 挂着 agent / 在内存里 / 已落盘 / 在归档集合里 |

它们不是互相替代的关系。**空对话也可能处于进行中**——会话一被创建 agent 就挂上了，而第一条 prompt 还没发；有内容的对话也可能处于未打开。把两者折进一个徽章，说清了一件事就丢掉了另一件。

状态列里 `已归档` 优先于其它值（侧边栏隐藏会话的依据就是它）；类型列里 `子代理` 优先（子代理会话不能迁移）。

---

## 面板

两个面板都在本插件占用的**同一个** `conversation.view` 标签页里（id `baize-session-tidy`，order 40）——纯增量，不替换任何官方组件。`＋` 按钮注册在 `conversation.chat.assistant-actions`（id `baize-session-collect`，order 20）。

共同行为：

| 操作 | 结果 |
|---|---|
| 点一行 | 展开/收起该行的**完整正文**（整理）或**详情行**（工作区）。两者都不会选中它 |
| 点复选框 | 选中/取消选中；详情保持原样 |
| 操作条 | 常驻，两个面板共用同一套 `.baize-bar`。未选中任何内容时，按钮是**禁用而不是隐藏** |
| 下拉 | 自绘浮层（原生 `<select>` 与 dsw 主题不搭）；点外部或按 Esc 关闭 |

「整理」面板的特点：内容列表始终是当前对话；消息表格随窗口高度伸缩（没有固定高度）。

「工作区」面板的特点：标题+筛选行与子标签行都是 32px，因此没有任何一行比邻居低；类型列与状态列各固定 76px、时间列固定 150px，所以它们纵向对齐，不会随标签长短漂移。

![点开的消息行：完整正文展开在该行下方，带来源徽章、#seq 与字数；真正用于选中它的是行上的复选框](https://raw.githubusercontent.com/bvcvb/dsh-baize-session/HEAD/assets/002-message-detail.png)

消息行按来源打标：

| 徽章 | 含义 | 配色来源（官方「轨迹」视图） |
|---|---|---|
| `USER` | 人类输入（`source.kind === 'user'`） | `.user` —— `state-business-primary` / `state-business-tertiary` |
| `ASSISTANT` | 模型回复 | `.assistantVioletBright` |
| `CONTEXT` | 由插件或 harness 注入——运行时快照、`<system-reminder>`、记忆库注入，以及本插件自己写入的整理块 | `.contextGreen` |
| `TOOL` | 工具结果（`tool/result` 事件） | `.toolAmber` |

`user/message` **不等于**"用户说过这句话"：dsh 把人类输入与注入的上下文记成同一个事件类型，只靠 `data.source.kind` 区分。抽样一个真实会话，其分布是 `{user: 4, plugin: 10}`——那次对话里大部分内容根本没人打过字，这正是要给两者分别打标的原因。

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

两个面板的过滤规则**故意不同**：

| | 整理 —— 目标选择器 | 工作区 —— 表格 |
|---|---|---|
| 空会话（从没跑过 turn） | **隐藏** | 列出，类型 `空对话` |
| 已归档 | **隐藏** | 列出，状态 `已归档`（除非你用筛选排除） |
| 子代理子会话 | 隐藏 | 列出，类型 `子代理` |
| 其它 | 列出，显示名字 | 列出，显示名字 |

「整理」的选择器回答的是"这段内容能落到哪"，所以只给出合理的目标；「工作区」的表格回答的是"这里有什么"，所以全部列出并允许你操作。两者取自同一份会话列表，因此不可能互相矛盾。

---

## 操作会拒绝的情况

| 操作 | 何时被拒 | 提示 |
|---|---|---|
| 迁移进已有会话 | 目标不在内存里（未打开） | `目标会话不在内存中，无法追加（先在侧边栏打开它）。` |
| 迁移 | 篮子为空，或估算超过 `maxInjectTokens` | 拒绝信息里带实测大小 |
| 迁移 | 目标路径是相对路径 | `目标路径必须是绝对路径：…` |
| 归档 / 还原 | 当前 dsh 的注册表没有暴露写入接口（版本过旧） | `当前 dsh 版本未暴露…接口` |
| **删除** | 会话**不是已归档** | `只能删除已归档的对话：请先归档，再删除。` |
| **删除** | 请求缺少 `confirm: true` | `删除需要显式确认（confirm: true）。` |
| **迁移** | 会话**已归档** | `已归档的对话不能迁移：请先还原它。` |
| **迁移** | 会话是子代理子会话 | `子代理会话不支持跨工作区迁移。` |
| **迁移** | 定位不到持久化工件 | `当前持久化后端不支持定位会话工件，无法跨工作区迁移。` |
| **迁移** | 没有任何已知信息能把后续写入指向新工件 | `当前运行时既不暴露 live 写入器、也不暴露持久化写入状态…` |

迁移的实际步骤（顺序不能乱）——会话通过 `cwd` 归属于某个工作区，而注册表拒绝把「存储 cwd 与工作区路径不一致」的会话挂上去，所以**先改工件、后换记账**：

1. 若会话**打开中**，先把缓冲事件 flush 到当前工件。
2. 在持久化协调器的每-id 锁内（后端提供锁时）读取工件，**只**改写头行的 `cwd`（保留 `version`），写到该 cwd 推导出的路径——经临时文件 + 原子重命名，原始文件先"停靠"起来，以便失败时能把字节放回去。
3. 同步搬走内存里的指针：live 写入状态（`meta.cwd`）、内存中的 session header、注册表的 header/path 索引——若记账交换失败，它们一起回滚。
4. 从旧工作区 detach，attach 到新工作区，然后删掉已清空的旧目录。
5. 任一步失败，原始字节回到原始路径。这一点比听起来更重要：dsh 启动时会校验"会话位置必须与 header 的 `cwd` 一致"，不一致会让它拒绝启动整棵插件树。

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

浏览器端无法读取会话、创建会话，也无法触碰工作区注册表，因此面板与宿主 web 服务器上的 `/baize-session.api` 通信。它委托给命令所用的同一套运行时。

| 请求 | Body / 查询 | 返回 |
|---|---|---|
| `GET /baize-session.api` | `?sessionId=<id>`（必填）；`&source=<id>` 列出另一个会话的消息；`&view=workspace` 改为返回工作区面板 | `PanelState`：`{ sessionId, cwd, messages, basket, projects, sessions, maxInjectTokens }`；带 `view=workspace` 时返回 `WorkspacePanel`：`{ workspace?, workspaces, sessions }` |
| `POST /baize-session.api` | `{ sessionId, op: 'take', seqs?, messageIds?, sourceId? }` | `{ ok, added, missing, state }` |
| | `{ sessionId, op: 'untake', seq?, messageId?, sourceId? }` | `{ ok, removed, state }` |
| | `{ sessionId, op: 'drop' }` | `{ ok, state }` |
| | `{ sessionId, op: 'estimate', target }` | `{ ok, tokens }` |
| | `{ sessionId, op: 'relocate', target }` | `{ ok, sessionId, mode, tokens, sources, state }` |
| | `{ sessionId, op: 'archive' \| 'restore', targetId \| targetIds }` | `{ ok, results, panel }` |
| | `{ sessionId, op: 'deleteSession', targetIds, confirm: true }` | `{ ok, results, panel }` |
| | `{ sessionId, op: 'moveSession', targetIds, toWorkspaceId }` | `{ ok, results, panel }` |

- `target` 为 `{ kind: 'new', cwd }` 或 `{ kind: 'existing', sessionId }`。
- 工作区相关的 op 里，`targetId`（单行）与 `targetIds`（多选）可以互换。
- 批量结果**逐条回报**（`results: [{ id, ok, error? }]`），所以一条被拒不会中断其余；信封上的 `ok: false` 表示每一条都失败了。每个工作区 op 都连着返回刷新后的面板，因此界面每个动作只需一次往返。
- 用户能自行处理的拒绝（相对路径、空篮子、追加目标未打开、超出预算、未归档、缺少确认、迁移已归档）以 `400` 返回，消息可直接展示给用户；其余为 `500`。

---

## 数据位置

**本插件不保存自己的任何状态**——没有配置文件、没有缓存、没有索引。篮子只活在进程内存里，重启即空；这正是"为这一次搬运而选"的应有范围。

它**改动**的东西属于 dsh：

| 路径 | 读取 | 写入 |
|---|---|---|
| `$DSH_HOME/sessions/<转义后的 cwd>/<会话 id>/session.jsonl.zstd` | 会话日志——已关闭的用 `inspect` 读回，既不提交恢复也不发布 | 仅由**迁移**（改写 header 的 `cwd` 并移动文件）与**删除**（移除）写入 |
| `$DSH_HOME/storages/workspace.json` | 工作区记录、注册表全局的会话归档集合 | 仅由**归档** / **还原** / **迁移**写入 |

其它位置一律不碰，卸载后也不留残留。

---

## 模块结构

```
src/core.ts       纯逻辑：事件读取与作者分类、消息列表、renderInjection、会话命名、工件编码/改写辅助
src/relocate.ts   搬运运行时：篮子、面板状态、take/untake/drop/estimate/relocate、工作区与持久化访问
src/workspace.ts  工作区运行时：对话列表、归档/还原、删除（agent 收尾、live store detach、工件移除）、跨工作区迁移（改写 header、原子换名、记账交换）
src/api.ts        宿主 HTTP API：/baize-session.api 的 GET 状态（两个面板）+ POST 操作分发
src/index.ts      apply：两套运行时 + /baize-session 命令 + API 挂载（inject: commands/sessions/tokenMeter/webServer/sessionPersistence）
lib/client.js     浏览器端，手写产物：「整理」视图及其两个面板 + 「＋」槽位，window.__ModuleLoader__.load({ id, factory })
test/core.spec.ts        纯函数的单元测试（fixture 照抄真机日志形状）
test/workspace.spec.ts   迁移所依赖的工件编解码测试（zstd 帧布局、头行改写、往返一致）
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
`window.__ModuleLoader__.load({ id, factory })` 这层壳，只把种子模块（`react`、ui-primitives）留作外部依赖。它没有任何类型检查或打包环节，因此 `test/client.smoke.mjs` 会带着打桩后的宿主 API 用 `react-test-renderer` 加载真实产物，断言两个面板的版式、交互顺序、徽章与它们的 CSS 规则。

> **破坏性路径怎么测**：删除与迁移会改写持久状态，因此它们只在**专门造的测试对话**上演练，且必须在隔离的 dsh 实例里——绝不拿任何人在意的会话试。迁移的验证方式还包括：迁移后继续往该会话写入，确认消息落在新路径。

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
