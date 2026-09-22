/**
 * Loop 0 unit tests for the pure collection/render helpers (`src/core.ts`).
 * Locks in: which event types are collectable, seq extraction, and the exact
 * injection block (grouping by source, the trailing current-project notice).
 *
 * @module dsh-baize-session/core.spec
 */

import { describe, expect, it } from 'vitest'
import {
  formatBasket,
  listMessages,
  loggedSessionTitle,
  messageIdOf,
  readMessageEvent,
  renderInjection,
  sessionDisplayName,
  totalChars,
  type CollectedItem,
} from '../src/core.ts'

/*
 * Fixtures mirror the REAL logged shapes, verbatim from a session file:
 *   user/message      {"data":{"content":[…],"source":{…},"role":"user","id":…},"surfaceOp":"append"}
 *   assistant/message {"data":{"turn":1,"step":1,"message":{"role":…,"content":[…],"id":…},"usage":{…}}}
 * The assistant reply nests its message one level deeper — fixtures that flatten
 * it (as an earlier version of this file did) pass while the real product drops
 * every assistant reply, so keep these faithful.
 */
function userMessage(seq: number, text: string, id = `user-${seq}`) {
  return {
    type: 'user/message',
    seq,
    time: 1789466302290,
    data: {
      content: [{ type: 'text', text }],
      source: { kind: 'user', rpcId: 'rpc-1' },
      role: 'user',
      id,
    },
    surfaceOp: 'append',
  }
}
function assistantMessage(seq: number, text: string, id = `asst-${seq}`) {
  return {
    type: 'assistant/message',
    seq,
    time: 1789466304145,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' },
        id,
      },
      usage: { inputTokens: 9827, outputTokens: 149 },
    },
    sourceEventSeqs: [15, 16, 17],
  }
}

/** Plugin/harness injection — logged as user/message, but nobody typed it. */
function contextMessage(seq: number, text: string, id = `ctx-${seq}`) {
  return {
    type: 'user/message',
    seq,
    time: 1789466302290,
    data: {
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-context', form: 'snapshot' },
      role: 'user',
      id,
    },
    surfaceOp: 'append',
  }
}
/** A tool result: its own event type, text nested inside the tool-result block. */
function toolResult(seq: number, text: string) {
  return {
    type: 'tool/result',
    seq,
    time: 1789466304145,
    data: {
      turn: 1,
      step: 1,
      message: {
        source: { kind: 'tool', callId: 'call_00_q5YR7jkaUi3SyXvo6bVx9924' },
        content: [{
          type: 'tool-result',
          toolCallId: 'call_00_q5YR7jkaUi3SyXvo6bVx9924',
          content: [{ type: 'text', text }],
        }],
      },
    },
    surfaceOp: 'append',
  }
}

function item(partial: Partial<CollectedItem> & Pick<CollectedItem, 'seq' | 'role' | 'text'>): CollectedItem {
  return { sessionId: 'session-aaaa1111', cwd: '/home/abc/work/plugin', ...partial }
}

describe('readMessageEvent', () => {
  it('reads the two surface message types', () => {
    expect(readMessageEvent(userMessage(1, '你好'))).toEqual({ role: 'user', text: '你好' })
    expect(readMessageEvent(assistantMessage(2, '在的'))).toEqual({ role: 'assistant', text: '在的' })
  })

  it('finds the assistant text nested under data.message (regression)', () => {
    // exact shape from a real session log
    const real = {
      type: 'assistant/message',
      seq: 167,
      time: 1789466304145,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '你好！我是运行在 DSH Harness 中的编码助手。' }],
          source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' },
          id: '67b211fc-90b8-48ec-b1f6-c1b1e0fdcbd5',
        },
        usage: { inputTokens: 9827, outputTokens: 149 },
      },
    }
    expect(readMessageEvent(real)).toEqual({ role: 'assistant', text: '你好！我是运行在 DSH Harness 中的编码助手。' })
  })

  it('ignores non-message and non-text events', () => {
    expect(readMessageEvent({ type: 'tool/call', seq: 3, data: {} })).toBeNull()
    expect(readMessageEvent({ type: 'assistant/message', seq: 4, data: { message: { content: [{ type: 'reasoning', text: 'x' }] } } })).toBeNull()
    expect(readMessageEvent(null)).toBeNull()
    expect(readMessageEvent('nope')).toBeNull()
  })

  it('joins only text blocks out of a mixed content array', () => {
    const event = assistantMessage(5, '答案')
    event.data.message.content = [
      { type: 'reasoning', text: '思考' },
      { type: 'text', text: '答案' },
      { type: 'text', text: '补充' },
    ] as never
    expect(readMessageEvent(event)).toEqual({ role: 'assistant', text: '答案\n补充' })
  })
})

describe('role classification', () => {
  it('separates a human prompt from injected context (same event type)', () => {
    // Real session on this machine: {user: 4, plugin: 10} under `user/message`.
    expect(readMessageEvent(userMessage(1, '测试'))).toEqual({ role: 'user', text: '测试' })
    expect(readMessageEvent(contextMessage(8, 'Current runtime context. This snapshot supersedes…')))
      .toEqual({ role: 'context', text: 'Current runtime context. This snapshot supersedes…' })
  })

  it('reads a tool result, whose text sits inside the tool-result block', () => {
    const real = {
      type: 'tool/result',
      seq: 42,
      time: 1789466304145,
      data: {
        turn: 1,
        step: 1,
        message: {
          source: { kind: 'tool', callId: 'call_00_q5YR7jkaUi3SyXvo6bVx9924' },
          content: [{
            type: 'tool-result',
            toolCallId: 'call_00_q5YR7jkaUi3SyXvo6bVx9924',
            content: [{ type: 'text', text: 'Error: sandbox mode "workspace-write" is requested but no backend is usable' }],
            isError: true,
          }],
        },
        error: { name: 'HarnessError', code: 'SANDBOX_UNAVAILABLE' },
      },
    }
    expect(readMessageEvent(real)).toEqual({
      role: 'tool',
      text: 'Error: sandbox mode "workspace-write" is requested but no backend is usable',
    })
  })

  it('keeps assistant replies apart from both', () => {
    expect(readMessageEvent(assistantMessage(167, '好的'))).toEqual({ role: 'assistant', text: '好的' })
  })

  it('a tool result carries no messageId (it has no message identity)', () => {
    expect(messageIdOf(toolResult(5, 'x'))).toBeUndefined()
  })
})

describe('messageIdOf', () => {
  it('returns the same id the client projection calls messageId', () => {
    // dsh-client-ui-conversation/lib/client.js:7711 → event.data.message.id
    // dsh-client-ui-conversation/lib/client.js:8626 → event.data.id
    expect(messageIdOf(assistantMessage(2, '在的', 'asst-xyz'))).toBe('asst-xyz')
    expect(messageIdOf(userMessage(1, '你好', 'user-xyz'))).toBe('user-xyz')
  })

  it('returns undefined when the event carries no id', () => {
    expect(messageIdOf({ type: 'user/message', seq: 1, data: { content: [] } })).toBeUndefined()
    expect(messageIdOf(null)).toBeUndefined()
  })
})

describe('session names', () => {
  /** Shape of a real `session/title` event payload. */
  const titleEvent = (seq: number, title: string) => ({
    type: 'session/title',
    seq,
    time: 1789466302290,
    data: { title, messageSeqs: [7], source: { kind: 'provider', provider: 'session-title-llm' } },
  })

  it('folds the latest logged title', () => {
    expect(loggedSessionTitle([titleEvent(3, '问候与自我介绍')])).toBe('问候与自我介绍')
    expect(loggedSessionTitle([titleEvent(3, '旧名'), userMessage(5, 'x'), titleEvent(9, '新名')])).toBe('新名')
  })

  it('ignores blank titles and logs without any', () => {
    expect(loggedSessionTitle([titleEvent(3, '   ')])).toBeUndefined()
    expect(loggedSessionTitle([userMessage(1, '你好')])).toBeUndefined()
  })

  it('prefers a real title over the message fallback', () => {
    expect(sessionDisplayName([titleEvent(3, '测试对话'), userMessage(5, '测试')])).toBe('测试对话')
  })

  it('falls back to the opening line for a session that has no title yet', () => {
    // A session with real conversation but no generated title yet.
    expect(sessionDisplayName([userMessage(0, '帮我看看这个迁移插件怎么用')])).toBe('帮我看看这个迁移插件怎么用')
    const long = '这是一个很长的开场白，需要被截断到二十四个字符以内才行'
    expect(sessionDisplayName([userMessage(0, long)])).toBe('这是一个很长的开场白，需要被截断到二十四个字符以…')
    expect(sessionDisplayName([userMessage(0, '短')])).toBe('短')
  })

  it('never presents this plugin\'s own injection block as a name', () => {
    // Landing sites are seeded with the rendered block and nothing else, so the
    // picker shows no name rather than the same boilerplate on every row.
    const injected = userMessage(0, renderInjection([item({ seq: 1, role: 'user', text: 'x' })], '/tmp/x'))
    expect(sessionDisplayName([injected])).toBe('')
    // When the conversation did continue, the first real message names it.
    expect(sessionDisplayName([injected, userMessage(2, '继续改布局')])).toBe('继续改布局')
  })

  it('returns an empty name when there is nothing to show', () => {
    expect(sessionDisplayName([])).toBe('')
  })
})

describe('listMessages', () => {
  it('lists collectable messages in order with trimmed previews', () => {
    const events = [
      { type: 'turn/start', seq: 0, data: {} },
      userMessage(1, '第一行\n第二行'),
      { type: 'tool/call', seq: 2, data: {} },
      assistantMessage(3, 'x'.repeat(80)),
    ]
    const list = listMessages(events)
    expect(list.map(m => m.seq)).toEqual([1, 3])
    expect(list[0].preview).toBe('第一行')
    expect(list[1].preview.endsWith('…')).toBe(true)
    expect(list[1].preview.length).toBeLessThanOrEqual(61)
  })

  it('skips events without a numeric seq', () => {
    expect(listMessages([{ type: 'user/message', data: { content: [{ type: 'text', text: 'x' }] } }])).toEqual([])
  })
})

describe('renderInjection', () => {
  const items: CollectedItem[] = [
    item({ seq: 1, role: 'user', text: '插件要不要隔离测试？' }),
    item({ seq: 2, role: 'assistant', text: '要，先装到 current 验。' }),
    item({ sessionId: 'session-bbbb2222', cwd: '/home/abc/work/led', seq: 9, role: 'user', text: '固件怎么更新？' }),
  ]

  it('groups by source session and labels roles', () => {
    const text = renderInjection(items, '/home/abc/work/new')
    expect(text).toContain('【来自会话 session- / 工作区 /home/abc/work/plugin】')
    expect(text).toContain('【来自会话 session- / 工作区 /home/abc/work/led】')
    expect(text).toContain('user: 插件要不要隔离测试？')
    expect(text).toContain('assistant: 要，先装到 current 验。')
    // The led group must come after the plugin group (collection order preserved).
    expect(text.indexOf('/home/abc/work/plugin')).toBeLessThan(text.indexOf('/home/abc/work/led'))
  })

  it('ends with the current-workspace notice (the whole point of content rewriting)', () => {
    const text = renderInjection(items, '/home/abc/work/new')
    expect(text.trimEnd().endsWith('当前工作区是 /home/abc/work/new。请在此基础上继续。')).toBe(true)
  })

  it('tolerates a source with no cwd', () => {
    expect(renderInjection([item({ seq: 1, role: 'user', text: 'x', cwd: '' })], '/tmp/x')).toContain('工作区 (未知)')
  })
})

describe('formatting helpers', () => {
  it('reports an empty basket', () => {
    expect(formatBasket([])).toBe('篮子为空。')
  })

  it('counts distinct sources', () => {
    const text = formatBasket([
      item({ seq: 1, role: 'user', text: 'a' }),
      item({ sessionId: 'session-bbbb2222', seq: 2, role: 'user', text: 'b' }),
    ])
    expect(text).toContain('2 段（来自 2 个会话）')
  })

  it('signs each item with its own role', () => {
    const text = renderInjection([
      item({ seq: 1, role: 'user', text: 'a' }),
      item({ seq: 2, role: 'assistant', text: 'b' }),
      item({ seq: 3, role: 'context', text: 'c' }),
      item({ seq: 4, role: 'tool', text: 'd' }),
    ], '/tmp/x')
    for (const role of ['user', 'assistant', 'context', 'tool']) expect(text).toContain(`${role}: `)
  })

  it('sums characters', () => {
    expect(totalChars([item({ seq: 1, role: 'user', text: 'abc' }), item({ seq: 2, role: 'user', text: 'de' })])).toBe(5)
  })
})
