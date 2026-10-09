import { convertFileSrc } from '@tauri-apps/api/core'

import { checkRepositoryFile } from '../../lib/tauri'
import { ScopedMedia } from '../ScopedMedia'
import styles from './VideoPreview.module.css'

/**
 * A video named by repository text gets its path only once the file is checked inside the
 * checkouts, on open and on restore.
 * ponytail: check, then load: the asset protocol opens the path again for every range it serves and
 * cannot be bound to the checked handle, so a link swapped in after the check is not caught. Upgrade
 * path: stream the video through a scoped protocol that serves from the checked handle.
 */
async function checkedVideo(scope: string, path: string): Promise<string> {
  await checkRepositoryFile(scope, path)
  return convertFileSrc(path)
}

/** `scope`, `onReopen`: see `ScopedMedia`. */
export function VideoPreview({
  path,
  scope,
  onReopen,
  className,
}: {
  path: string
  scope: string | null | undefined
  onReopen?: () => void
  className?: string
}) {
  return (
    <ScopedMedia path={path} scope={scope} load={checkedVideo} onReopen={onReopen}>
      {(src) => (
        <video
          className={`${styles.video} ${className ?? ''}`}
          controls
          preload="metadata"
          src={src}
        >
          <track kind="captions" />
        </video>
      )}
    </ScopedMedia>
  )
}
