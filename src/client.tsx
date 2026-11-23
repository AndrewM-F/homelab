import { hydrate } from 'solid-js/web'
import { StartClient, hydrateStart } from '@tanstack/solid-start/client'

/**
 * Cloudflare injects a hidden anchor as the first child of <body> on every
 * proxied zone in this account:
 *
 *   <a href="/cdn-cgi/content?id=…" aria-hidden="true" style="display:none"></a>
 *
 * Solid hydrates by matching nodes positionally against the server markup, so
 * that extra node shifts the tree by one and hydration gives up silently: the
 * page renders and then ignores every click. Drop leading body elements that
 * the server did not produce, then hydrate as normal.
 *
 * Server-rendered roots always carry Solid's `data-hk` marker, which is what
 * makes this safe: anything without it did not come from us.
 */
function stripInjectedNodes(): void {
  const body = document.body
  const rendered = body.querySelector('[data-hk]')
  if (!rendered) return

  while (body.firstElementChild && !body.firstElementChild.hasAttribute('data-hk')) {
    body.firstElementChild.remove()
  }
}

stripInjectedNodes()

hydrateStart().then((router) => {
  hydrate(() => <StartClient router={router} />, document)
})
