/**
 * Unit tests for the workspace-administration helpers.
 *
 * The two pure functions here are the ones that touch a session artifact's
 * bytes during a cross-workspace move, so they get tested against the real
 * physical layouts dsh writes: plain JSONL, and concatenated zstd frames whose
 * FIRST frame must be exactly the header line (`assertZstdHeaderFrame` /
 * `readFirstZstdLine` on the reading side).
 *
 * @module dsh-baize-session/workspace.spec
 */

import { describe, expect, it } from 'vitest'
import { zstdDecompressSync } from 'node:zlib'
import { WorkspaceError, encodeArtifact, rewriteHeaderCwd } from '../src/workspace.ts'

/** Shape of a real v2 session header line. */
const header = { version: 2, id: 'session-abc', createdAt: 1789466302290, cwd: '/home/abc/one', seedLength: 1 }
const headerLine = JSON.stringify(header)
const body = '{"type":"session/title","seq":1,"time":2,"data":{"title":"x"}}\n{"type":"turn/start","seq":2}\n'

/** Split concatenated zstd frames the way dsh's reader does. */
function frames(buffer: Buffer): Buffer[] {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts: number[] = []
  for (let i = buffer.indexOf(magic); i !== -1; i = buffer.indexOf(magic, i + 4)) starts.push(i)
  return starts.map((start, index) => buffer.subarray(start, index + 1 < starts.length ? starts[index + 1] : buffer.length))
}

describe('rewriteHeaderCwd', () => {
  it('changes only the header line and carries the rest over byte for byte', () => {
    const raw = `${headerLine}\n${body}`
    const out = rewriteHeaderCwd(raw, '/home/abc/two')
    expect(JSON.parse(out.headerLine)).toEqual({ ...header, cwd: '/home/abc/two' })
    expect(out.rest).toBe(body)
    // `version` is what dsh stamps the on-disk format with: rewriting a v2
    // header to a lower generation makes it refuse the session on next start.
    expect(out.header.version).toBe(2)
  })

  it('handles an artifact whose body is empty', () => {
    const out = rewriteHeaderCwd(`${headerLine}\n`, '/tmp/x')
    expect(out.rest).toBe('')
  })

  it('refuses an artifact with no header line', () => {
    expect(() => rewriteHeaderCwd('{"seq":1}', '/tmp/x')).toThrow(WorkspaceError)
  })

  it('refuses an unparseable header', () => {
    expect(() => rewriteHeaderCwd('not json\nrest', '/tmp/x')).toThrow(/头行无法解析/)
  })
})

describe('encodeArtifact', () => {
  it('writes plain JSONL as two lines for a non-zstd backend', () => {
    const out = encodeArtifact(headerLine, body, false)
    expect(out.toString('utf8')).toBe(`${headerLine}\n${body}`)
  })

  it('writes exactly two zstd frames, the first being the header line alone', () => {
    const out = encodeArtifact(headerLine, body, true)
    const parts = frames(out)
    expect(parts).toHaveLength(2)
    // The reader requires frame #1 to decompress to the header line *only*.
    expect(zstdDecompressSync(parts[0]).toString('utf8')).toBe(`${headerLine}\n`)
    expect(zstdDecompressSync(parts[1]).toString('utf8')).toBe(body)
  })

  it('emits a single frame when there is no body', () => {
    const parts = frames(encodeArtifact(headerLine, '', true))
    expect(parts).toHaveLength(1)
    expect(zstdDecompressSync(parts[0]).toString('utf8')).toBe(`${headerLine}\n`)
  })

  it('round-trips a rewritten header through the same encoding', () => {
    const rewritten = rewriteHeaderCwd(`${headerLine}\n${body}`, '/home/abc/two')
    const parts = frames(encodeArtifact(rewritten.headerLine, rewritten.rest, true))
    const text = parts.map(part => zstdDecompressSync(part).toString('utf8')).join('')
    const [line, ...rest] = text.split('\n')
    expect(JSON.parse(line).cwd).toBe('/home/abc/two')
    expect(rest.join('\n')).toBe(body)
  })
})
