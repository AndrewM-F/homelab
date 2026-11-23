import { Show, type JSX } from 'solid-js'
import { logoFor } from '../lib/logos'

interface Props {
  /** Logo key from `src/lib/logos.ts`. */
  icon?: string
  /** Name used for the accessible label and the monogram fallback. */
  name: string
  size?: 'md' | 'lg' | 'rail'
}

/** A square logo tile; falls back to a monogram when no mark exists. */
export function Logo(props: Props): JSX.Element {
  const url = () => logoFor(props.icon)
  const letter = () => props.name.trim().charAt(0).toUpperCase() || '?'

  return (
    <span class={`logo logo-${props.size ?? 'md'}`} aria-hidden="true">
      <Show when={url()} fallback={<span class="logo-mono">{letter()}</span>}>
        <img src={url()} alt="" loading="lazy" decoding="async" />
      </Show>
    </span>
  )
}
