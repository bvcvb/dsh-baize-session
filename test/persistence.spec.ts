/**
 * Unit tests for the version-tolerant persistence seam.
 *
 * The regression these pin down: dsh 0.1.7-alpha.1 removed
 * `sessionPersistence.inspect`, and calling the absent method threw a
 * **synchronous** TypeError that the old `.catch(() => undefined)` could not
 * intercept — so the panel answered HTTP 500 instead of degrading. Each case
 * below covers one half of the contract:
 *
 *   1. both published shapes read the same (rc.2 `inspect`, alpha.1 `open`),
 *   2. an unknown shape degrades to "unreadable" instead of throwing,
 *   3. `list` is called in the shape the detected stack expects.
 *
 * @module dsh-baize-session/persistence.spec
 */

import { describe, expect, it, vi } from 'vitest'
import {
  getPersistence,
  listStored,
  readStackOf,
  readStored,
  type PersistenceLike,
} from '../src/persistence.ts'

const events = [{ type: 'session/title', seq: 1, data: { title: '例子' } }]
const signal = new AbortController().signal

describe('readStackOf', () => {
  it('reports the rc.2 stack when inspect is present', () => {
    expect(readStackOf({ inspect: async () => undefined })).toBe('inspect')
  })

  it('reports the handle stack when only open is present', () => {
    expect(readStackOf({ open: async () => undefined })).toBe('handle')
  })

  it('reports none when the backend exposes neither, and for no backend at all', () => {
    expect(readStackOf({})).toBe('none')
    expect(readStackOf(undefined)).toBe('none')
  })
})

describe('readStored', () => {
  it('reads a stored session through the rc.2 inspect', async () => {
    const inspect = vi.fn(async () => ({ meta: { cwd: '/home/abc/one' }, events }))
    const out = await readStored({ inspect }, 'session-1', signal)
    expect(out).toEqual({ meta: { cwd: '/home/abc/one' }, events })
    expect(inspect).toHaveBeenCalledWith('session-1', signal)
  })

  it('reads a stored session through the alpha.1 handle and closes it', async () => {
    const read = vi.fn(async () => ({ events }))
    const close = vi.fn(async () => {})
    const open = vi.fn(async () => ({ header: { id: 'session-1', cwd: '/home/abc/two' }, read, close }))

    const out = await readStored({ open }, 'session-1', signal)

    expect(out).toEqual({ meta: { cwd: '/home/abc/two' }, events })
    expect(open).toHaveBeenCalledWith('session-1', 'read', { signal })
    expect(read).toHaveBeenCalledOnce()
    // A handle is single-owner state: every browse must give its channel back.
    expect(close).toHaveBeenCalledOnce()
  })

  it('closes the handle even when reading it fails', async () => {
    const close = vi.fn(async () => {})
    const open = vi.fn(async () => ({
      header: { id: 'session-1' },
      read: async () => { throw new Error('torn artifact') },
      close,
    }))

    await expect(readStored({ open }, 'session-1')).resolves.toBeUndefined()
    expect(close).toHaveBeenCalledOnce()
  })

  it('degrades instead of throwing when neither stack is available', async () => {
    // The exact shape of the reported bug: a context that answers *something*
    // for `sessionPersistence` but has no `inspect`. Must not reject.
    await expect(readStored({}, 'session-1')).resolves.toBeUndefined()
    await expect(readStored(undefined, 'session-1')).resolves.toBeUndefined()
  })

  it('degrades when the backend cannot find the session', async () => {
    const open = vi.fn(async () => { throw new Error('SessionPersistenceNotFoundError') })
    const inspect = vi.fn(async () => { throw new Error('SessionPersistenceNotFoundError') })
    await expect(readStored({ open }, 'missing')).resolves.toBeUndefined()
    await expect(readStored({ inspect }, 'missing')).resolves.toBeUndefined()
  })

  it('tolerates a backend that answers without events or header cwd', async () => {
    const inspect = vi.fn(async () => ({}))
    await expect(readStored({ inspect }, 'session-1')).resolves.toEqual({ meta: {}, events: [] })

    const open = vi.fn(async () => ({ read: async () => ({}) }))
    await expect(readStored({ open }, 'session-1')).resolves.toEqual({ meta: {}, events: [] })
  })
})

describe('listStored', () => {
  const rows = [{ id: 'session-a', cwd: '/home/abc/one', createdAt: 1789466302290, origin: 'subagent' }]

  it('normalizes rc.2 rows and passes the signal positionally', async () => {
    const list = vi.fn(async () => rows)
    const out = await listStored({ inspect: async () => undefined, list }, signal)
    expect(out).toEqual(rows)
    expect(list).toHaveBeenCalledWith(signal)
  })

  it('normalizes alpha.1 snapshots and passes an options object', async () => {
    const list = vi.fn(async () => rows.map(row => ({ header: row, revision: 'r1' })))
    const out = await listStored({ open: async () => undefined, list }, signal)
    expect(out).toEqual(rows)
    expect(list).toHaveBeenCalledWith({ signal })
  })

  it('drops rows without a usable id, and tolerates a non-array answer', async () => {
    const list = vi.fn(async () => [null, 'nope', { cwd: '/x' }, ...rows])
    await expect(listStored({ list })).resolves.toEqual(rows)
    const broken = vi.fn(async () => undefined as unknown as readonly unknown[])
    await expect(listStored({ list: broken })).resolves.toEqual([])
  })

  it('answers an empty list rather than throwing when the backend fails', async () => {
    const list = vi.fn(async () => { throw new Error('backend offline') })
    await expect(listStored({ list })).resolves.toEqual([])
    await expect(listStored({})).resolves.toEqual([])
    await expect(listStored(undefined)).resolves.toEqual([])
  })
})

describe('getPersistence', () => {
  it('reaches the service through ctx.get', () => {
    const service: PersistenceLike = { inspect: async () => undefined }
    const get = vi.fn(() => service)
    expect(getPersistence({ get })).toBe(service)
    expect(get).toHaveBeenCalledWith('sessionPersistence')
  })

  it('returns undefined when the context cannot answer', () => {
    expect(getPersistence({})).toBeUndefined()
    expect(getPersistence(undefined)).toBeUndefined()
  })
})
