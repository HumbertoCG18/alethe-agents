import { invoke } from '@tauri-apps/api/core'

export type MarkdownGeneration = {
  path: string
  content: string
  agent: string
  model: string
  style: string
  language: string
  question: string | null
}

export async function generateMarkdown(
  request: MarkdownGeneration,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new Error('Summary request cancelled')
  const requestId = crypto.randomUUID()
  const cancel = () => {
    void invoke('markdown_cancel', { requestId }).catch(() => {})
  }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    return await invoke('markdown_generate', { ...request, requestId })
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}

/** `scope`, the checkout of a document named by repository text, holds the reader to its rule. */
export function openMarkdownReader(path: string, scope?: string | null): Promise<void> {
  return invoke('open_markdown_reader', { path, scope: scope ?? null })
}
