import { defineConfig } from 'vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import { tanstackStart } from '@tanstack/solid-start/plugin/vite'
import solid from 'vite-plugin-solid'

export default defineConfig({
  server: { port: 3000 },
  plugins: [
    // Bind the Cloudflare plugin to the SSR environment so the Worker is built
    // from TanStack Start's server bundle and `cloudflare:workers` resolves.
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
    tanstackStart(),
    // Solid's Vite plugin must come after TanStack Start's.
    solid({ ssr: true }),
  ],
})
