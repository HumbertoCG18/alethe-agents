import type { ILink } from '@xterm/xterm'

export type FileLinkKind = 'markdown' | 'image' | 'video' | 'text'

export type DetectedTerminalLink = {
  text: string
  target: string
  index: number
  displayLength: number
  kind: 'url' | 'path'

  fileKind?: FileLinkKind
  /** The path joined with the rows a TUI cut it across; see `wrappedPathCandidates`. */
  wrapped?: string[]
}

type TerminalBufferLine = {
  readonly isWrapped: boolean
  translateToString(trimRight?: boolean): string
}

type TerminalBuffer = {
  readonly length: number
  getLine(y: number): TerminalBufferLine | undefined
}

export type LogicalTerminalLine = {
  text: string
  startLine: number
}

const LINK_START_PATTERN =
  /https?:\/\/|(?<![@\w.-])(?:localhost(?::\d{1,5})?|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:app|ai|biz|br|ca|cloud|co|com|de|dev|edu|fr|gg|gov|info|io|jp|live|me|net|online|org|page|sh|site|tech|tools|tv|uk|xyz))(?::\d{1,5})?(?:\/[^\s<>"'`|]*)?|(?:[A-Za-z]:\\|\\\\)|(?<![\w])(?:~[\\/]|\/)(?=[A-Za-z0-9_.~])|(?<![@\w.-])(?:\.\.?[\\/])?(?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.(?:md|markdown|mdx|png|jpe?g|gif|webp|bmp|avif|ico|svg|txt|tsx?|jsx?|json|ya?ml|toml|csv|pdf|mp4|m4v|mov|avi|mkv|webm|mp3|wav|flac|m4a|zip|7z|rar|tar|gz|exe|msi|dll)(?=$|[\s),.;:\]}`])/gi
const URL_PROTOCOL_PATTERN = /^https?:\/\//i
const BARE_URL_PATTERN =
  /^(?:localhost(?::\d{1,5})?|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:app|ai|biz|br|ca|cloud|co|com|de|dev|edu|fr|gg|gov|info|io|jp|live|me|net|online|org|page|sh|site|tech|tools|tv|uk|xyz))(?::\d{1,5})?(?:\/[^\s<>"'`|]*)?/i

const LINE_COL_SUFFIX = /:\d+(?::\d+)?$/
const MARKDOWN_EXT_PATTERN = /\.(md|markdown|mdx)$/i
const IMAGE_EXT_PATTERN = /\.(png|jpe?g|gif|webp|bmp|avif|ico|svg)$/i
const VIDEO_EXT_PATTERN = /\.(mp4|m4v|mov|avi|mkv|webm|ogv)$/i
const FILE_EXT_PATTERN = /\.[A-Za-z0-9]{1,12}$/
const FILE_EXT_BOUNDARY_PATTERN =
  /\.(?:md|markdown|mdx|png|jpe?g|gif|webp|bmp|avif|ico|svg|txt|tsx?|jsx?|json|ya?ml|toml|csv|pdf|mp4|m4v|mov|avi|mkv|webm|mp3|wav|flac|m4a|zip|7z|rar|tar|gz|exe|msi|dll)(?=$|[\s),.;:])/i
const LINK_TRAILING_PUNCTUATION = /[\s),.;:]+$/

export function isVideoFilePath(path: string): boolean {
  return VIDEO_EXT_PATTERN.test(stripLineColumn(path.trim()))
}

export function isMarkdownFilePath(path: string): boolean {
  return MARKDOWN_EXT_PATTERN.test(stripLineColumn(path.trim()))
}

export function stripLineColumn(text: string): string {
  return text.replace(LINE_COL_SUFFIX, '')
}

export function classifyFileLink(text: string): FileLinkKind | undefined {
  const clean = stripLineColumn(text)
  if (MARKDOWN_EXT_PATTERN.test(clean)) return 'markdown'
  if (IMAGE_EXT_PATTERN.test(clean)) return 'image'
  if (VIDEO_EXT_PATTERN.test(clean)) return 'video'
  if (FILE_EXT_PATTERN.test(clean)) return 'text'
  return undefined
}
const HARD_LINK_DELIMITERS = new Set(['\t', '\r', '\n', '<', '>', '"', "'", '`', '|'])

function isLikelyAbsolutePath(text: string): boolean {
  if (!/^(?:~[\\/]|\/)/.test(text)) return true
  const clean = stripLineColumn(text)
  const withoutRoot = clean.startsWith('~') ? clean.slice(2) : clean.slice(1)
  return /[\\/]/.test(withoutRoot) || FILE_EXT_PATTERN.test(clean)
}

function isLikelyFilePath(text: string): boolean {
  return isLikelyAbsolutePath(text) || Boolean(classifyFileLink(text))
}

function joinPath(base: string, relative: string): string {
  const separator = base.includes('\\') ? '\\' : '/'
  const root = base.replace(/[\\/]+$/, '')
  return relative ? `${root}${separator}${relative.replace(/[\\/]/g, separator)}` : root
}

export function resolveTerminalFilePath(
  path: string,
  cwd?: string | null,
  home?: string | null,
): string {
  const clean = stripLineColumn(path.trim())
  // A `~` path belongs to the home folder, never to the terminal's. Until the home folder is
  // known it is kept as printed, since nothing downstream expands the tilde.
  if (/^~(?:[\\/]|$)/.test(clean)) return home ? joinPath(home, clean.slice(2)) : clean
  if (!cwd || /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(clean)) return clean
  return joinPath(cwd, clean.replace(/^\.([\\/])/, ''))
}

/** The printed path without line/column when it is relative, so it can also be looked up in the
 * project's other worktrees; null for absolute and home paths. */
export function relativeTerminalPath(path: string): string | null {
  const clean = stripLineColumn(path.trim())
  if (/^(?:[A-Za-z]:[\\/]|\\\\|~(?:[\\/]|$)|\/)/.test(clean)) return null
  return clean.replace(/^\.([\\/])/, '')
}

function normalizeUrlTarget(text: string): string {
  if (URL_PROTOCOL_PATTERN.test(text)) {
    return text.replace(URL_PROTOCOL_PATTERN, (protocol) => protocol.toLowerCase())
  }
  return `${/^localhost(?::|\/|$)/i.test(text) ? 'http' : 'https'}://${text}`
}

function findLinkEnd(line: string, start: number, isUrl: boolean): number {
  const opener = line[start - 1]
  const closer = opener === '(' ? ')' : opener === '[' ? ']' : undefined
  // The bracket caps the link, it does not define it. Returning its position outright
  // swallowed every space in between, so "(/a/b and /c/d)" came back as one link.
  const bracketEnd = closer && !isUrl ? line.indexOf(closer, start) : -1

  let end = start
  while (end < line.length) {
    if (bracketEnd !== -1 && end >= bracketEnd) break
    const char = line[end]
    if (HARD_LINK_DELIMITERS.has(char)) break
    if (isUrl && /\s/.test(char)) break
    if (char === ' ' && line[end + 1] === ' ') break
    if (char === ' ' && !isUrl) {
      const pathSoFar = line.slice(start, end)
      const endsAtDirectorySeparator =
        pathSoFar.endsWith('/') ||
        (/^(?:[A-Za-z]:\\|\\\\|~\\)/.test(pathSoFar) && pathSoFar.endsWith('\\'))
      if (endsAtDirectorySeparator) break

      // A space is only worth crossing to reach a file extension — that is what a path
      // with spaces looks like. With no extension ahead, the rest of the line is prose.
      const escaped = line[end - 1] === '\\'
      if (!escaped && !FILE_EXT_BOUNDARY_PATTERN.test(line.slice(end + 1))) break
    }

    // A second link after whitespace belongs to a separate match.
    if (char === ' ') {
      const remainder = line.slice(end + 1)
      if (/^(?:https?:\/\/|[A-Za-z]:\\|\\\\|~[\\/]|\/)/.test(remainder)) break
    }
    end += 1

    if (!isUrl && classifyFileLink(line.slice(start, end))) {
      const next = line[end]
      const lineColumnSuffix = next === ':' && /\d/.test(line[end + 1] ?? '')
      if (!next || (!lineColumnSuffix && /[\s),.;:]/.test(next))) break
    }
  }
  return end
}

export function detectTerminalLinks(line: string): DetectedTerminalLink[] {
  const links: DetectedTerminalLink[] = []
  LINK_START_PATTERN.lastIndex = 0

  for (const match of line.matchAll(LINK_START_PATTERN)) {
    const index = match.index ?? 0
    if (links.some((link) => index < link.index + link.displayLength)) continue

    const isUrl = URL_PROTOCOL_PATTERN.test(match[0]) || BARE_URL_PATTERN.test(match[0])
    const raw = line.slice(index, findLinkEnd(line, index, isUrl))
    const displayText = raw.replace(LINK_TRAILING_PUNCTUATION, '')
    if (!displayText) continue

    const kind = isUrl ? 'url' : 'path'
    const text = kind === 'url' ? displayText : displayText.replace(/\\ /g, ' ')
    if (kind === 'path' && !isLikelyFilePath(text)) continue
    links.push({
      text,
      target: kind === 'url' ? normalizeUrlTarget(text) : text,
      index,
      displayLength: displayText.length,
      kind,
      fileKind: kind === 'path' ? classifyFileLink(text) : undefined,
    })
  }
  return links
}

function isPathBoundary(char: string): boolean {
  return /\s/.test(char) || HARD_LINK_DELIMITERS.has(char)
}

/** The rows of a logical line and the two on each side of it, nearest first, as xterm prints them. */
export type TerminalLinkRows = {
  above: readonly string[]
  line: readonly string[]
  below: readonly string[]
}

/** Reads the rows of `logical` and around it from the buffer. A row's text skips the second cell of
 * a wide glyph, so joined the line's rows are exactly its text, whatever the width of its cells;
 * only its last row is trimmed, as in `getLogicalTerminalLine`. */
export function terminalRowsAround(
  buffer: TerminalBuffer,
  logical: LogicalTerminalLine,
): TerminalLinkRows {
  const row = (index: number, trimRight = true) =>
    buffer.getLine(index)?.translateToString(trimRight) ?? ''
  const first = logical.startLine - 1
  let next = first + 1
  while (next < buffer.length && buffer.getLine(next)?.isWrapped) next += 1
  return {
    above: [row(first - 1), row(first - 2)],
    line: Array.from({ length: next - first }, (_, i) => row(first + i, first + i === next - 1)),
    below: [row(next), row(next + 1)],
  }
}

/**
 * Claude Code wraps long lines itself, moving the cursor instead of letting the terminal wrap, so a
 * path cut at a row end goes on after the indentation of the next row, and xterm keeps the halves
 * apart, each its own link or none. Returns the clicked link, found in the text of `rows.line`,
 * joined with the leading token of the rows below when it ends its row, or with the trailing token
 * of the rows above when it opens its row; up to two rows each way, the farther only through a row
 * that is all path. How full the cut row is proves nothing, since a resize or a wide glyph changes
 * it, so these are only guesses for `locateTerminalPath` to check against the disk.
 */
export function wrappedPathCandidates(
  link: Pick<DetectedTerminalLink, 'text' | 'index' | 'displayLength' | 'kind'>,
  { above, line, below }: TerminalLinkRows,
): string[] {
  if (link.kind !== 'path' || !line.length) return []
  const rows = [...[...above].reverse(), ...line, ...below]
  // The row and column of an offset in the line's text.
  const at = (offset: number) => {
    let row = 0
    while (row < line.length - 1 && offset >= line[row].length) offset -= line[row++].length
    return { row: above.length + row, col: offset }
  }
  const first = at(link.index)
  const last = at(link.index + link.displayLength - 1)

  const candidates: string[] = []
  if (!rows[first.row].slice(0, first.col).trim()) {
    let head = ''
    for (let row = first.row - 1; row >= Math.max(0, first.row - 2); row -= 1) {
      const text = rows[row].trim()
      let start = text.length
      while (start > 0 && !isPathBoundary(text[start - 1])) start -= 1
      if (start === text.length) break
      head = text.slice(start) + head
      candidates.push(head + link.text)
      if (start > 0) break
    }
  }
  // Punctuation the link dropped at the row end may be the cut in the middle of the path.
  const rest = rows[last.row].slice(last.col + 1).trimEnd()
  if (/^[),.;:]*$/.test(rest)) {
    let tail = rest
    for (let row = last.row + 1; row <= last.row + 2 && row < rows.length; row += 1) {
      const text = rows[row].trim()
      let stop = 0
      while (stop < text.length && !isPathBoundary(text[stop])) stop += 1
      const token = text.slice(0, stop)
      if (!token.replace(LINK_TRAILING_PUNCTUATION, '')) break
      candidates.push((link.text + tail + token).replace(LINK_TRAILING_PUNCTUATION, ''))
      if (stop < text.length) break
      tail += token
    }
  }
  return candidates
}

/** Whether the path ends in one of the file extensions links are detected by; a dotted folder such
 * as `.claude` does not. */
function hasKnownFileExtension(path: string): boolean {
  const clean = stripLineColumn(path)
  return FILE_EXT_BOUNDARY_PATTERN.test(clean.slice(clean.lastIndexOf('.')))
}

/** Where a clicked path link is on disk, each path looked up through `find`, which also searches
 * the repository's other checkouts. A file link that exists wins, so the text around it never
 * redirects it. Otherwise the longest wrapped candidate that exists, since a row cut right after a
 * folder name leaves a link to the folder; when none exists, the path as printed. The kind comes
 * from the path found: a cut half printed without its extension has none. */
export async function locateTerminalPath(
  link: Pick<DetectedTerminalLink, 'target' | 'wrapped'>,
  cwd: string,
  home: string | null,
  find: (cwd: string, path: string) => Promise<string | null>,
): Promise<{ target: string; fileKind?: FileLinkKind }> {
  const lookup = (path: string) =>
    find(cwd, relativeTerminalPath(path) ?? resolveTerminalFilePath(path, cwd, home)).catch(
      () => null,
    )
  let found = await lookup(link.target)
  // The candidates are only looked up when needed: each missing one costs a `git worktree list`.
  if (!found || !hasKnownFileExtension(link.target)) {
    const wrapped = link.wrapped ?? []
    const located = await Promise.all(wrapped.map(lookup))
    // Known limit: prose joined to a missing path or a folder still wins when that join exists.
    let longest = found ? link.target.length : -1
    located.forEach((path, index) => {
      if (path && wrapped[index].length > longest) {
        found = path
        longest = wrapped[index].length
      }
    })
  }
  const target = found ?? resolveTerminalFilePath(link.target, cwd, home)
  return { target, fileKind: classifyFileLink(target) }
}

export function getLogicalTerminalLine(
  buffer: TerminalBuffer,
  bufferLineNumber: number,
): LogicalTerminalLine | null {
  let startIndex = bufferLineNumber - 1
  if (startIndex < 0 || startIndex >= buffer.length || !buffer.getLine(startIndex)) return null

  while (startIndex > 0 && buffer.getLine(startIndex)?.isWrapped) startIndex -= 1

  let endIndex = startIndex
  while (endIndex + 1 < buffer.length && buffer.getLine(endIndex + 1)?.isWrapped) endIndex += 1

  let text = ''
  for (let index = startIndex; index <= endIndex; index += 1) {
    text += buffer.getLine(index)?.translateToString(index === endIndex) ?? ''
  }

  return { text, startLine: startIndex + 1 }
}

export function terminalLinkRange(
  startLine: number,
  columns: number,
  link: Pick<DetectedTerminalLink, 'index' | 'displayLength'>,
) {
  const startOffset = link.index
  const endOffset = link.index + link.displayLength - 1
  return {
    start: { x: (startOffset % columns) + 1, y: startLine + Math.floor(startOffset / columns) },
    end: { x: (endOffset % columns) + 1, y: startLine + Math.floor(endOffset / columns) },
  }
}

/** Monta o `ILink` do xterm a partir de um link detectado, com o handler de menu. */
export function makeXtermLink(
  logicalLineStart: number,
  columns: number,
  link: DetectedTerminalLink,
  handlers: {
    openMenu: (event: MouseEvent, link: DetectedTerminalLink) => void
  },
): ILink {
  return {
    text: link.text,
    range: terminalLinkRange(logicalLineStart, columns, link),
    decorations: { pointerCursor: true, underline: true },
    activate: (event: MouseEvent) => handlers.openMenu(event, link),
  }
}
