import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/solid-router'
import { HydrationScript } from 'solid-js/web'
import { GRID_COLUMNS_BOOT } from '../lib/grid-columns'
import appStyles from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { name: 'color-scheme', content: 'dark' },
      { name: 'robots', content: 'noindex, nofollow' },
      // Portable default; the topbar brand comes from the configured
      // inventory, so the browser tab stays generic.
      { title: 'homelab · dashboard' },
      {
        name: 'description',
        content: 'Private operations dashboard for a homelab.',
      },
    ],
    links: [
      { rel: 'stylesheet', href: appStyles },
      { rel: 'icon', href: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="%230a0c0e"/><path d="M4.5 5.5h4a2.5 2.5 0 0 1 0 5h-4z" stroke="%235eead4" stroke-width="1.4" fill="none"/></svg>' },
    ],
  }),
  shellComponent: RootDocument,
})

function RootDocument(props: { children: import('solid-js').JSX.Element }) {
  return (
    <html lang="en">
      <head>
        <HydrationScript />
        {/* Before the stylesheet paints: a stored column count must not flash the default. */}
        <script innerHTML={GRID_COLUMNS_BOOT} />
        <HeadContent />
      </head>
      <body>
        {props.children}
        <Scripts />
      </body>
    </html>
  )
}
