/**
 * Client-half smoke test.
 *
 * `lib/client.js` is hand-authored (the official `clientBundle` tsdown preset is
 * not published, so a plugin outside the dsh repository writes the
 * `__ModuleLoader__.load({id, factory})` shell itself). Nothing type-checks or
 * bundles it — a typo is a blank tab in the browser and nowhere else. This runs
 * the real bundle against `react-test-renderer` with a stub for the host API and
 * asserts the panel's shape and behaviour, including the interaction order the
 * page is built around: ① source conversation → ② target project →
 * ③ target conversation → ④ relocate.
 *
 * Run: `node test/client.smoke.mjs` (needs the devDependencies installed).
 */

import fs from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const bundle = path.join(here, '..', 'lib', 'client.js')

const React = require('react')
const TestRenderer = require('react-test-renderer')
const act = TestRenderer.act

// --- Load the bundle the way the browser loader does. ---
let definition = null
const win = {
  __ModuleLoader__: { load(d) { definition = d } },
  addEventListener() {},
  removeEventListener() {},
}
const bundleSource = fs.readFileSync(bundle, 'utf8')
const css = (bundleSource.match(/const CSS = \[([\s\S]*?)\]\.join/) || ['', ''])[1]
/** Read one rule's declarations out of the bundle's CSS array. */
const cssRule = (sel) => (css.match(new RegExp("'" + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}')) || ['', ''])[1]
/** Read one rule's declarations out of the bundle's CSS array. */
new Function('window', bundleSource)(win)
const mod = definition.factory((name) =>
  name === 'react' ? React
    : name === '@deepseek-ai/dsh-client-ui-primitives' ? {}
      : require(name))

// --- Register against a minimal ctx, exactly like the real client. ---
const registrations = []
const dictionaries = {}
mod.apply({
  effect(fn) { const r = fn(); if (r && typeof r.next === 'function') r.next() },
  locale: {
    register(ns, dict) { Object.assign(dictionaries, dict) },
    bind() { return (key) => (dictionaries.zh && dictionaries.zh[key]) || key },
  },
  slots: {
    inject(name, cb) { cb() },
    register(meta, render) { registrations.push({ ...meta, render }); return () => {} },
  },
})

const view = registrations.find(r => r.name === 'conversation.view')
const actions = registrations.find(r => r.name === 'conversation.chat.assistant-actions')

// --- Host API stub. ---
const state = {
  sessionId: 'sess-1',
  cwd: '/home/abc/work/plugin',
  messages: [
    { seq: 12, role: 'user', text: '帮我改一下 X', preview: '帮我改一下 X' },
    { seq: 13, role: 'context', text: 'Current runtime context. This snapshot supersedes…', preview: 'Current runtime context. This snapshot…' },
    { seq: 14, role: 'assistant', text: '好的，X 的问题是…', preview: '好的，X 的问题是…' },
    { seq: 15, role: 'tool', text: 'Error: sandbox mode is not usable', preview: 'Error: sandbox mode is not usable' },
  ],
  basket: [{ sessionId: 'sess-1', seq: 14, messageId: 'm14', role: 'assistant', text: '好的' }],
  projects: [
    { path: '/home/abc/work/plugin', sessions: 2, isCurrent: true },
    { path: '/home/abc/work/led', sessions: 1, isCurrent: false },
    { path: '/home/abc/work/test5', sessions: 0, isCurrent: false },
    { path: '/home/abc/work/gone', sessions: 3, isCurrent: false, ungrouped: true },
  ],
  sessions: [
    { id: 'sess-1', cwd: '/home/abc/work/plugin', messages: 2, live: true, isCurrent: true, name: '整理插件开发', createdAt: 1789466302290, blank: false, archived: false },
    { id: 'sess-2', cwd: '/home/abc/work/led', messages: 5, live: true, isCurrent: false, name: '固件升级', createdAt: 1789466302290, blank: false, archived: false },
    { id: 'sess-9', cwd: '/home/abc/work/plugin', messages: 4, live: false, isCurrent: false, name: '测试对话', createdAt: 1789466302290, blank: false, archived: false },
    // 空会话（没跑过 turn）：官方侧边栏把它当"新建会话"占位行，不给名字
    { id: 'sess-blank', cwd: '/home/abc/work/plugin', messages: 1, live: false, isCurrent: false, name: '', createdAt: 1789466302290, blank: true, archived: false },
    // 已归档：官方侧边栏隐藏
    { id: 'sess-arch', cwd: '/home/abc/work/plugin', messages: 6, live: false, isCurrent: false, name: '早已归档的对话', createdAt: 1789466302290, blank: false, archived: true },
  ],
  maxInjectTokens: 8000,
}
let relocated = null
const ops = []
const wsPanel = {
  workspace: { id: 'ws-1', path: '/home/abc/work/plugin', title: 'plugin' },
  workspaces: [
    { id: 'ws-1', path: '/home/abc/work/plugin', title: 'plugin' },
    { id: 'ws-2', path: '/home/abc/work/led', title: 'led' },
  ],
  sessions: [
    { id: 'sess-1', cwd: '/home/abc/work/plugin', messages: 2, live: true, isCurrent: false, name: '整理插件开发', createdAt: 1789466302290, blank: false, archived: false, running: true, subagent: false, isPanel: true },
    { id: 'sess-blank', cwd: '/home/abc/work/plugin', messages: 0, live: false, isCurrent: false, name: '', createdAt: 1789466302290, blank: true, archived: false, running: true, subagent: false, isPanel: false },
    { id: 'sess-cold', cwd: '/home/abc/work/plugin', messages: 9, live: false, isCurrent: false, name: '冷会话', createdAt: 1789466302290, blank: false, archived: false, running: false, subagent: false, isPanel: false },
    { id: 'sess-arch', cwd: '/home/abc/work/plugin', messages: 6, live: false, isCurrent: false, name: '已归档的对话', createdAt: 1789466302290, blank: false, archived: true, running: false, subagent: false, isPanel: false },
  ],
}
globalThis.fetch = async (url, opts) => {
  if (typeof url === 'string' && url.includes('view=workspace')) {
    return { ok: true, status: 200, json: async () => wsPanel }
  }
  if (opts && opts.method === 'POST') {
    const body = JSON.parse(opts.body)
    ops.push(body.op)
    if (body.op === 'estimate') return { ok: true, status: 200, json: async () => ({ ok: true, tokens: 1234 }) }
    if (Array.isArray(body.targetIds)) {
      return { ok: true, status: 200, json: async () => ({ ok: true, results: body.targetIds.map((id) => ({ id, ok: true })), panel: wsPanel }) }
    }
    if (body.op === 'relocate') {
      relocated = body.target
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, sessionId: 'session-new', tokens: 1234, mode: body.target.kind, state }),
      }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, state }) }
  }
  return { ok: true, status: 200, json: async () => state }
}

// --- Assertions. ---
const results = []
const check = (name, ok, extra = '') => {
  results.push([name, !!ok])
  console.log((ok ? '✓ ' : '✗ ') + name + (extra ? '  ' + extra : ''))
}
const textOf = (node) => node == null ? ''
  : typeof node === 'string' ? node
    : Array.isArray(node) ? node.map(textOf).join(' ')
      : node.children ? textOf(node.children) : ''
const byClass = (root, cls) => root.root.findAll(
  n => n.props && typeof n.props.className === 'string' && n.props.className.split(' ').includes(cls))
const items = (root) => root.root.findAll(
  n => n.props && typeof n.props.className === 'string' && n.props.className.startsWith('baize-dditem'))

if (view === undefined || actions === undefined) {
  console.error('✗ 未注册 conversation.view / conversation.chat.assistant-actions')
  process.exit(1)
}

console.log('注册项:', registrations.map(r => `${r.name}#${r.id}`).join('  |  '))
check('整理页 label 为 整理', view.label() === '整理', JSON.stringify(view.label()))

let root
await act(async () => { root = TestRenderer.create(React.createElement(view.render, { sessionId: 'sess-1' })) })

// ① 顺序
const labels = byClass(root, 'baize-label').map(n => textOf(n.children).trim()).filter(Boolean)
check('① 只有 目标工作区 → 目标对话 两个下拉（内容默认就是当前对话）',
  JSON.stringify(labels) === JSON.stringify(['目标工作区', '目标对话']), JSON.stringify(labels))

// 下拉菜单而非平铺
check('折叠时不含工作区选项（不是平铺列表）', !textOf(root.toJSON()).includes('/home/abc/work/led'))
const ddButtons = () => byClass(root, 'baize-ddbtn')
check('两个选择器都是下拉按钮', ddButtons().length === 2, '实际 ' + ddButtons().length)
check('没有来源对话选择器', !textOf(root.toJSON()).includes('来源对话'))

// ② 目标对话
await act(async () => { ddButtons()[1].props.onClick() })
check('点击后弹出下拉面板', byClass(root, 'baize-ddmenu').length >= 1)
const convText = items(root).map(n => textOf(n.children))
check('目标对话下拉含 新建对话', convText.some(s => s.includes('新建对话')), JSON.stringify(convText))
check('会话用名字显示，不显示 session id',
  convText.some(s => s.includes('测试对话')) && !convText.some(s => s.includes('sess-9')), JSON.stringify(convText))
check('未打开的会话被标注「未打开」',
  convText.some(s => s.includes('测试对话') && s.includes('未打开')), JSON.stringify(convText))
check('同名会话可凭时间区分', convText.some(s => /\d{2}-\d{2} \d{2}:\d{2}/.test(s)), JSON.stringify(convText))
check('当前会话不出现在目标对话选项里', !convText.some(s => s.includes('整理插件开发')), JSON.stringify(convText))
// 只显示真实对话：空会话与已归档都被过滤（对齐官方 sessionVisible）
check('空会话（没跑过 turn）不列出（不再出现无标题行）', !convText.some(s => s.includes('[无标题]')), JSON.stringify(convText))
check('已归档的会话不列出', !convText.some(s => s.includes('早已归档的对话')), JSON.stringify(convText))
await act(async () => { ddButtons()[1].props.onClick() })

// ① 工作区下拉：内容来自工作区注册表（未分组项标注、空工作区不显示数量）
await act(async () => { ddButtons()[0].props.onClick() })
const wsText = items(root).map(n => textOf(n.children))
check('工作区下拉列出注册表里的工作区',
  wsText.some(s => s.includes('/home/abc/work/led')), JSON.stringify(wsText))
check('没有真实对话的工作区不显示数量',
  wsText.some(s => s.includes('/home/abc/work/test5') && !/\d+ 个会话/.test(s)), JSON.stringify(wsText))
check('不在任何工作区里的目录标注「未分组」',
  wsText.some(s => s.includes('/home/abc/work/gone') && s.includes('未分组')), JSON.stringify(wsText))
await act(async () => { ddButtons()[0].props.onClick() })

// ① 工作区：手填路径默认隐藏
const pathInputs = () => root.root.findAll(n => n.type === 'input' && n.props.placeholder === '手填绝对路径…')
check('默认不显示手填路径输入框', pathInputs().length === 0)
await act(async () => { ddButtons()[0].props.onClick() })
const customItem = items(root).find(n => textOf(n.children).includes('手填绝对路径…'))
check('工作区下拉含 手填绝对路径…', !!customItem)
await act(async () => { customItem.props.onClick() })
check('选中后出现手填路径输入框', pathInputs().length === 1)
await act(async () => { ddButtons()[0].props.onClick() })
await act(async () => {
  items(root).find(n => textOf(n.children).includes('/home/abc/work/plugin')).props.onClick()
})
check('切回工作区后手填输入框收起', pathInputs().length === 0)

// 版式：工具条必须夹在「目标对话」下拉与消息表格之间
const layout = root.root.findAll((n) => {
  const c = n.props && n.props.className;
  if (typeof c !== 'string') return false;
  return ['baize-ddbtn', 'baize-bar', 'baize-list'].some(k => c.split(' ').includes(k));
}).map(n => ['baize-ddbtn', 'baize-bar', 'baize-list'].find(k => n.props.className.split(' ').includes(k)));
check('版式顺序 = 工作区下拉 → 目标对话下拉 → 工具条 → 消息表格',
  layout.join(' > ') === 'baize-ddbtn > baize-ddbtn > baize-bar > baize-list', layout.join(' > '))

// 角色徽章：四种来源各有颜色，不再出现「我/你」
const badges = () => root.root.findAll(n => n.props && typeof n.props.className === 'string'
  && n.props.className.split(' ').includes('baize-role'))
const badgeText = badges().map(n => textOf(n.children))
const badgeClass = badges().map(n => n.props.className)
check('角色标注为 user/assistant/context/tool（不再是我/你）',
  JSON.stringify(badgeText) === JSON.stringify(['user', 'context', 'assistant', 'tool']), JSON.stringify(badgeText))
check('每个角色带自己的颜色类',
  badgeClass.every((c, i) => c.includes('baize-role-' + badgeText[i])), JSON.stringify(badgeClass))
check('角色徽章与详情头里不出现「我/你」',
  !badgeText.some(x => x === '我' || x === '你'))

// 内容：复选框列表
const boxes = root.root.findAll(n => n.props && n.props.type === 'checkbox')
check('消息列表是复选框列表', boxes.length === 4, '实际 ' + boxes.length)
const all = textOf(root.toJSON())
check('篮子统计（已选 N 段 · 来自 M 个会话）', all.includes('已选') && all.includes('段'))
check('显示 token 估算', all.includes('1234'))
await act(async () => { boxes[0].props.onChange() })
check('勾选触发 take', ops.includes('take'), JSON.stringify(ops))

// ④ 迁移
await act(async () => {
  root.root.findAll(n => n.type === 'button' && textOf(n.children).trim() === '迁移')[0].props.onClick()
})
check('迁移发送的目标是新建到当前工作区',
  relocated && relocated.kind === 'new' && relocated.cwd === '/home/abc/work/plugin', JSON.stringify(relocated))

// 助手消息旁的 ＋
let collected
await act(async () => {
  collected = TestRenderer.create(React.createElement(actions.render, { messageId: 'm14', sessionId: 'sess-1' }))
})
check('＋ 按钮显示已收集态', textOf(collected.toJSON()).includes('✓'), JSON.stringify(textOf(collected.toJSON())))
let fresh
await act(async () => {
  fresh = TestRenderer.create(React.createElement(actions.render, { messageId: 'm99', sessionId: 'sess-1' }))
})
check('＋ 按钮显示未收集态', textOf(fresh.toJSON()).includes('＋'))

// 版式约束（CSS 无法在 react-test-renderer 里做布局计算，只能锁住规则本身）
check('页面是撑满的 flex 列（跟随官方 .viewArea）',
  /display:flex/.test(cssRule('.baize-page')) && /flex:1 1 auto/.test(cssRule('.baize-page')) && /min-height:0/.test(cssRule('.baize-page')),
  cssRule('.baize-page').slice(0, 80))
check('表格吃掉剩余高度且自适应（不再固定 44vh）',
  /flex:1 1 auto/.test(cssRule('.baize-list')) && /overflow:auto/.test(cssRule('.baize-list')) && !/max-height/.test(cssRule('.baize-list')),
  cssRule('.baize-list').slice(0, 80))
check('选择器与操作条不参与伸缩', /flex:none/.test(cssRule('.baize-field')) && /flex:none/.test(cssRule('.baize-bar')))

// 消息行：点行=看详情，点复选框=选择（两者互不干扰）
const rows = () => root.root.findAll(n => n.props && typeof n.props.className === 'string' && n.props.className.split(' ').includes('baize-row'))
const detailBody = () => root.root.findAll(n => n.props && n.props.className === 'baize-detailbody')
const takes = () => ops.filter(o => o === 'take').length
check('没有「详情」按钮了', root.root.findAll(n => n.props && n.props.className === 'baize-detailbtn').length === 0)
check('默认不展开详情', detailBody().length === 0)

const before = takes()
await act(async () => { rows()[0].props.onClick() })
const bodies = detailBody()
check('点行展开完整文本（不是截断的 preview）',
  bodies.length === 1 && textOf(bodies[0].children).includes('帮我改一下 X'), JSON.stringify(bodies.map(b => textOf(b.children))))
check('点行不会勾选', takes() === before, 'take ' + before + ' → ' + takes())

const box = rows()[0].props.children[0]
await act(async () => { box.props.onClick({ stopPropagation() {} }); box.props.onChange() })
check('点复选框才勾选', takes() === before + 1, 'take ' + before + ' → ' + takes())
check('勾选不会收起已展开的详情', detailBody().length === 1)

await act(async () => { rows()[0].props.onClick() })
check('再点一次行收起', detailBody().length === 0)


// 角色配色必须全部来自官方主题变量（不许自创颜色/hue）
const roleRules = [...css.matchAll(/\.(baize-role[a-z-]*)\{([^}]*)\}/g)].map(m => [m[1], m[2]])
const roleVars = [...new Set(roleRules.flatMap(([, body]) => body.match(/--dsw-[a-z0-9-]+|--ds-[a-z0-9-]+/g) || []))]
// 允许 color-mix(in srgb, …)（官方自己也这么写），但不允许任何硬编码色值
const hardcoded = (body) => /#|rgb|hsl/i.test(body.replace(/color-mix\(in srgb,/g, 'color-mix('))
check('角色配色只用官方主题变量，没有硬编码色值',
  roleVars.length >= 6 && roleRules.every(([, body]) => !hardcoded(body)),
  roleVars.join(' '))
check('四类角色各有独立规则',
  ['baize-role-user', 'baize-role-assistant', 'baize-role-context', 'baize-role-tool']
    .every(cls => roleRules.some(([c]) => c === cls)))
// 四色必须逐条等于官方轨迹视图那套（dsh-client-ui-trajectory 的 kind tag）
const ruleOf = (cls) => (roleRules.find(([c]) => c === cls) || ['', ''])[1]
check('user 用官方 business 蓝',
  /--dsw-alias-state-business-primary/.test(ruleOf('baize-role-user'))
  && /--dsw-alias-state-business-tertiary/.test(ruleOf('baize-role-user')))
check('context 用官方 contextGreen（success 68% 混 label-secondary）',
  /state-success-primary\) 68%,\s*var\(--dsw-alias-label-secondary\)/.test(ruleOf('baize-role-context'))
  && /--dsw-alias-state-success-tertiary/.test(ruleOf('baize-role-context')))
check('assistant 用官方 assistantVioletBright（brand 混 error-secondary）',
  /--dsw-alias-brand-primary-new-colorprimary-new-color\) 60%/.test(ruleOf('baize-role-assistant'))
  && /--dsw-alias-state-error-secondary/.test(ruleOf('baize-role-assistant')))
check('tool 用官方 toolAmber（warn-label / warn-tertiary）',
  /--dsw-alias-state-warn-label/.test(ruleOf('baize-role-tool'))
  && /--dsw-alias-state-warn-tertiary/.test(ruleOf('baize-role-tool')))
check('徽章尺寸照抄官方 kindTag（19px / 10px / 650 / 4px 圆角 / 大写）',
  /height:19px/.test(ruleOf('baize-role')) && /font-size:10px/.test(ruleOf('baize-role'))
  && /font-weight:650/.test(ruleOf('baize-role')) && /border-radius:4px/.test(ruleOf('baize-role'))
  && /text-transform:uppercase/.test(ruleOf('baize-role')))

// ── 工作区标签页 ─────────────────────────────────────────────────────────
const views = registrations.filter(r => r.name === 'conversation.view')
check('只注册一个顶层标签页（整理，order 40）',
  views.length === 1 && views[0].label() === '整理' && views[0].order === 40,
  JSON.stringify(views.map(v => [v.label(), v.order])))

// 工作区是「整理」页面内部的子标签，不是顶层标签
const tabBtns = () => root.root.findAll(n => n.type === 'button'
  && typeof n.props.className === 'string' && n.props.className.split(' ').includes('baize-tab'))
check('「整理」页内有 整理 / 工作区 两个子标签',
  tabBtns().length === 2 && textOf(tabBtns()[0].children) === '整理' && textOf(tabBtns()[1].children) === '工作区',
  JSON.stringify(tabBtns().map(x => textOf(x.children))))
check('默认停在「整理」子标签', tabBtns()[0].props['aria-selected'] === true)

await act(async () => { tabBtns()[1].props.onClick() })
check('切到「工作区」子标签', tabBtns()[1].props['aria-selected'] === true)

const wsPageText = () => textOf(root.toJSON())
const wsRows = () => root.root.findAll(n => n.props && typeof n.props.className === 'string'
  && n.props.className.split(' ').includes('baize-row'))
// Row-level buttons only: the always-present action bar has buttons with the
// same labels, so match inside a `.baize-ops` cell.
const btnOf = (label) => root.root.findAll(n => n.type === 'button'
  && textOf(n.children).trim().startsWith(label)
  && n.parent !== null && String(n.parent.props.className || '').includes('baize-ops'))
const click = async (node) => act(async () => { node.props.onClick({ stopPropagation() {} }) })

// session id 不在行里，只在展开的详情中
const sidCells = () => root.root.findAll(n => n.props && typeof n.props.className === 'string'
  && n.props.className.split(' ').includes('baize-sid'))
check('行里不显示 session id', sidCells().length === 0)

const detailMeta = () => root.root.findAll(n => n.props && typeof n.props.className === 'string'
  && n.props.className.split(' ').includes('baize-detailmeta')).map(n => textOf(n.children))
check('默认没有详情', detailMeta().length === 0)
await act(async () => { wsRows()[0].props.onClick() })
check('展开详情后显示完整 session id',
  detailMeta().some((x) => x.includes('sess-')), JSON.stringify(detailMeta()))
await act(async () => { wsRows()[0].props.onClick() })
check('再点收起，id 也随之隐藏', detailMeta().length === 0)

// ── 多选 + 批量操作 ─────────────────────────────────────────────────────
const rowBoxes = () => root.root.findAll(n => n.props && n.props.type === 'checkbox')
check('工作区表格每行都有复选框（与整理页一致）', rowBoxes().length === 4, '实际 ' + rowBoxes().length)
const bulkBar = () => root.root.findAll(n => n.props && typeof n.props.className === 'string'
  && n.props.className.split(' ').includes('baize-bar'))
const bulkBtns = () => (bulkBar()[0] ? bulkBar()[0].findAll(n => n.type === 'button') : [])
check('工具条常驻（与整理页一致，不是选中才出现）', bulkBar().length === 1)
check('未选中时按钮全部禁用而非隐藏（归档/还原/迁移/删除，无清空）',
  bulkBtns().length === 4 && bulkBtns().every((b) => b.props.disabled === true)
  && !bulkBtns().some((b) => textOf(b.children).includes('清空')),
  JSON.stringify(bulkBtns().map((b) => [textOf(b.children), b.props.disabled])))

await act(async () => { rowBoxes()[0].props.onClick({ stopPropagation() {} }); rowBoxes()[0].props.onChange() })
check('勾选后计数更新且按钮可用',
  /已选\s+1\s+个/.test(wsPageText()) && bulkBtns().every((b) => b.props.disabled !== true),
  JSON.stringify(bulkBtns().map((b) => b.props.disabled)))
const bulkBefore = ops.length
await click(bulkBtns().find((b) => textOf(b.children).trim() === '归档'))
check('批量归档一次请求带 targetIds 数组',
  ops.length === bulkBefore + 1 && ops[ops.length - 1] === 'archive', JSON.stringify(ops.slice(bulkBefore)))
check('批量执行后回到未选中（按钮再次禁用）',
  /已选\s+0\s+个/.test(wsPageText()) && bulkBtns().every((b) => b.props.disabled === true))

// 头部三行等高（标题行、标题+筛选行、整理页选择行）
check('标题行与筛选行等高 32px',
  /height:32px/.test(cssRule('.baize-head')) && /height:32px/.test(cssRule('.baize-headline')),
  cssRule('.baize-head'))

// 复位：清掉选中，便于后面的断言

check('列出当前工作区的会话，含已归档', wsRows().length === 4 && wsPageText().includes('已归档的对话'))
// 每行两个独立列：类型 + 状态
const rowsBadges = () => root.root.findAll(n => n.props && typeof n.props.className === 'string'
  && n.props.className.split(' ').includes('baize-row')).map((row) => {
  const tags = row.findAll((n) => n.props && typeof n.props.className === 'string'
    && n.props.className.split(' ').includes('baize-tag'))
    .map((n) => ({ cls: n.props.className, txt: textOf(n.children) }))
  const pick = (k) => (tags.find((x) => x.cls.includes(k)) || {}).txt
  return { name: textOf(row.children), kind: pick('baize-kind'), state: pick('baize-state') }
})
const rb = rowsBadges()
check('每行都有两个独立列：类型 + 状态',
  rb.length === 4 && rb.every((r) => r.kind && r.state),
  JSON.stringify(rb.map((r) => [r.name.slice(0, 8), r.kind, r.state])))
check('空对话 + 进行中（agent 已挂上但还没有对话）',
  rb.some((r) => r.name.includes('[无标题]') && r.kind === '空对话' && r.state === '进行中'),
  JSON.stringify(rb.map((r) => [r.name.slice(0, 8), r.kind, r.state])))
check('已对话 + 进行中',
  rb.some((r) => r.name.includes('整理插件开发') && r.kind === '已对话' && r.state === '进行中'))
check('已对话 + 未打开（冷会话）',
  rb.some((r) => r.name.includes('冷会话') && r.kind === '已对话' && r.state === '未打开'))
check('已对话 + 已归档',
  rb.some((r) => r.name.includes('已归档的对话') && r.kind === '已对话' && r.state === '已归档'))
check('已归档行有「还原」', btnOf('还原').length === 1)
check('每个未归档行都有「归档」', btnOf('归档').length === 3, '实际 ' + btnOf('归档').length)
check('只有已归档的行才有「删除」', btnOf('删除').length === 1, JSON.stringify(btnOf('删除').map(b => textOf(b.children))))
check('筛选按钮带计数（全部/未归档/已归档）',
  wsPageText().includes('全部 4') && wsPageText().includes('未归档 3') && wsPageText().includes('已归档 1'), wsPageText().slice(0, 120))

// 两个面板的表格必须长得一样：徽章同规格、辅助文字同字号、主文本同类
const rowTags = () => root.root.findAll(n => n.props && typeof n.props.className === 'string'
  && n.props.className.split(' ').includes('baize-tag'))
check('工作区状态徽章复用整理页角色徽章的规格（同时带 baize-role）',
  rowTags().length > 0 && rowTags().every(n => n.props.className.split(' ').includes('baize-role')),
  JSON.stringify(rowTags().map(n => n.props.className)))
check('表格辅助文字统一 11px（时间列 = seq 列）',
  /font-size:11px/.test(cssRule('.baize-when')) && /font-size:11px/.test(cssRule('.baize-seq')),
  cssRule('.baize-when'))
check('类型列与状态列各自固定宽度（两列纵向对齐）',
  /width:76px/.test(cssRule('.baize-kind')) && /width:76px/.test(cssRule('.baize-state')),
  cssRule('.baize-kind') + ' | ' + cssRule('.baize-state'))
check('类型与状态各自独立配色（互不共用色）',
  /state-success-primary/.test(cssRule('.baize-kind-chat'))
  && /state-business-primary/.test(cssRule('.baize-state-running'))
  && cssRule('.baize-kind-chat') !== cssRule('.baize-state-running'),
  cssRule('.baize-kind-chat') + ' ≠ ' + cssRule('.baize-state-running'))
check('时间+条数列固定宽度（数字变化不再推动其它列）',
  /width:150px/.test(cssRule('.baize-when')) && /nowrap/.test(cssRule('.baize-when'))
  && /tabular-nums/.test(cssRule('.baize-when')), cssRule('.baize-when'))
check('状态徽章不自带尺寸，尺寸只来自 .baize-role',
  !/font-size|min-width|height:/.test(cssRule('.baize-tag')), cssRule('.baize-tag'))
check('两个面板的主文本共用 .baize-text（13px）',
  /font-size:13px/.test(cssRule('.baize-text')))

// 删除必须点两次，且第二次才带 confirm 发请求
const postsBefore = ops.length
await click(btnOf('删除')[0])
check('第一次点删除只进入确认态，不发请求',
  ops.length === postsBefore && !!btnOf('确认删除').length, JSON.stringify(ops.slice(postsBefore)))
check('确认态出现不可恢复提示', wsPageText().includes('不可恢复'))
const delPost = ops.length
await click(btnOf('确认删除')[0])
check('第二次点才发出 deleteSession(confirm: true)',
  ops.length === delPost + 1 && ops[ops.length - 1] === 'deleteSession', JSON.stringify(ops.slice(delPost)))

// 迁移：展开目标工作区列表，排除会话自身所在的工作区
await click(btnOf('迁移')[0])
const moveBtns = () => root.root.findAll(n => n.type === 'button' && textOf(n.children).trim() === '迁移'
  && n.parent !== null && String(n.parent.props.className || '').includes('baize-ops'))
check('已归档行直接不显示「迁移」按钮，其它行显示且可用',
  moveBtns().length === 3 && moveBtns().every((b) => b.props.disabled !== true),
  '迁移按钮 ' + moveBtns().length + ' 个（4 行中归档那行没有）')
check('「迁移」列出其它工作区（排除会话自身所在的工作区）',
  wsPageText().includes('/home/abc/work/led'),
  wsPageText().includes('/home/abc/work/led') ? 'led 在列表中' : '未列出 led')

const failed = results.filter(r => !r[1])
console.log(failed.length === 0
  ? `\n全部通过 (${results.length})`
  : `\n失败 ${failed.length}: ${failed.map(r => r[0]).join(' / ')}`)
process.exitCode = failed.length === 0 ? 0 : 1
