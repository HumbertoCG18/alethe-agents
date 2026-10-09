import { readRepositoryFileBase64 } from '../../lib/tauri'
import { ScopedMedia } from '../ScopedMedia'
import styles from './ImagePreview.module.css'

/** Media types not named `image/<extension>`. */
const IMAGE_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
}

/** An image named by repository text, from the file the checked read opened: a `data:` URL. */
async function repositoryImage(scope: string, path: string): Promise<string> {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  const data = await readRepositoryFileBase64(scope, path)
  return `data:${IMAGE_TYPES[extension] ?? `image/${extension}`};base64,${data}`
}

/** `scope`, `onReopen`: see `ScopedMedia`. */
export function ImagePreview({
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
    <ScopedMedia path={path} scope={scope} load={repositoryImage} onReopen={onReopen}>
      {(src) => (
        <img className={`${styles.image} ${className ?? ''}`} src={src} alt="" draggable={false} />
      )}
    </ScopedMedia>
  )
}
