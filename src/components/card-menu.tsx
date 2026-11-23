import { For, Show, createSignal, onCleanup, onMount, type JSX } from 'solid-js'
import { ArrowOut, CheckIcon, CopyIcon, MoreIcon } from './icons'

export interface MenuItem {
  /** Left-hand name, e.g. "Tailnet". */
  label: string
  /** Monospace value shown beside the label. */
  value?: string
  /** Clipboard payload; defaults to `value`. */
  copy?: string
  /** Setting this makes the item open a URL. */
  href?: string
  /** Setting this makes the item run a command. */
  onSelect?: () => void
}

interface Props {
  items: MenuItem[]
  /** Accessible name, e.g. "Jellyfin options". */
  label: string
}

/**
 * Copies through the Clipboard API when it is available, falling back to a
 * hidden textarea. `navigator.clipboard` is undefined outside a secure context,
 * which includes a dashboard opened over plain HTTP on a tailnet address.
 *
 * The write is raced against a short timeout: a browser that is waiting on a
 * permission decision leaves the promise pending indefinitely, and a menu that
 * silently does nothing is worse than the legacy path.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => window.setTimeout(() => reject(new Error('clipboard timeout')), ms)),
  ])
}

async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await withTimeout(navigator.clipboard.writeText(value), 600)
      return true
    }
  } catch {
    // fall through to the legacy path
  }

  try {
    const area = document.createElement('textarea')
    area.value = value
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand('copy')
    area.remove()
    return copied
  } catch {
    return false
  }
}

/**
 * Per-card overflow menu. Copy actions stay open and confirm in place, so
 * grabbing both addresses is two clicks rather than two round trips.
 */
export function CardMenu(props: Props): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const [copied, setCopied] = createSignal<string | null>(null)
  const [failed, setFailed] = createSignal<string | null>(null)
  let wrap: HTMLDivElement | undefined
  let trigger: HTMLButtonElement | undefined

  const close = () => {
    setOpen(false)
    setCopied(null)
    setFailed(null)
  }

  onMount(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!open()) return
      if (wrap && !wrap.contains(event.target as Node)) close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !open()) return
      close()
      trigger?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    onCleanup(() => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    })
  })

  const isCopy = (item: MenuItem) => Boolean(item.copy ?? item.value)

  const activate = async (item: MenuItem) => {
    if (item.onSelect) {
      item.onSelect()
      close()
      return
    }
    if (item.href) {
      window.open(item.href, '_blank', 'noreferrer,noopener')
      close()
      return
    }
    const payload = item.copy ?? item.value
    if (!payload) return

    if (await copyText(payload)) {
      setCopied(item.label)
      setFailed(null)
      window.setTimeout(() => setCopied((current) => (current === item.label ? null : current)), 1400)
    } else {
      setFailed(item.label)
      window.setTimeout(() => setFailed((current) => (current === item.label ? null : current)), 2000)
    }
  }

  const trailing = (item: MenuItem): JSX.Element => {
    if (copied() === item.label) return <CheckIcon />
    if (item.href) return <ArrowOut />
    if (isCopy(item)) return <CopyIcon />
    return <></>
  }

  return (
    <Show when={props.items.length > 0}>
      <div class="card-menu" ref={wrap}>
        <button
          ref={trigger}
          type="button"
          class="menu-trigger"
          classList={{ 'is-open': open() }}
          aria-haspopup="menu"
          aria-expanded={open()}
          aria-label={props.label}
          title={props.label}
          onClick={() => (open() ? close() : setOpen(true))}
        >
          <MoreIcon />
        </button>

        <Show when={open()}>
          <div class="menu" role="menu" aria-label={props.label}>
            <For each={props.items}>
              {(item) => (
                <button
                  type="button"
                  role="menuitem"
                  class="menu-item"
                  classList={{ 'is-copy': isCopy(item), 'is-link': Boolean(item.href) }}
                  onClick={() => void activate(item)}
                >
                  <span class="menu-item-label">
                    {copied() === item.label
                      ? 'copied'
                      : failed() === item.label
                        ? 'blocked'
                        : item.label}
                  </span>
                  <Show when={item.value}>
                    <span class="menu-item-value" title={item.copy ?? item.value}>
                      {item.value}
                    </span>
                  </Show>
                  <span class="menu-item-icon">{trailing(item)}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  )
}
