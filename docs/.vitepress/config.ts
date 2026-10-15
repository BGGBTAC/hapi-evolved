import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'HAPI-eVolved',
  description: 'Self-hosted agent workspaces, protected credentials and persistent knowledge',
  base: '/docs/',

  head: [
    ['link', { rel: 'icon', href: '/docs/favicon.ico' }],
  ],

  themeConfig: {
    logo: '/logo.svg',

    nav: [
      { text: 'Evolved Quick Start', link: '/evolved/QUICKSTART' },
      { text: 'Source', link: 'https://github.com/BGGBTAC/hapi-evolved', target: '_blank' }
    ],

    sidebar: [
      {
        text: 'HAPI-eVolved preview',
        items: [
          { text: 'Quick start', link: '/evolved/QUICKSTART' },
          { text: 'GitHub connection', link: '/evolved/GITHUB' },
          { text: 'Browser provider login', link: '/evolved/PROVIDER_LOGIN' },
          { text: 'Specialists and plugins', link: '/evolved/EXTENSIONS' },
          { text: 'Privacy and data', link: '/evolved/DATA_HANDLING' },
          { text: 'Deployment (DE)', link: '/evolved/DEPLOYMENT' },
          { text: 'User guide (DE)', link: '/evolved/USER_GUIDE' },
          { text: 'Architecture (DE)', link: '/evolved/PROJECT' },
          { text: 'Validation (DE)', link: '/evolved/VALIDATION' }
        ]
      },
      {
        text: 'Upstream HAPI reference',
        items: [
          { text: 'Quick Start', link: '/guide/quick-start' },
          { text: 'Installation', link: '/guide/installation' },
          { text: 'Native Apps', link: '/guide/native-apps' },
          { text: 'PWA', link: '/guide/pwa' }
        ]
      },
      {
        text: 'Guide',
        items: [
          { text: 'How it Works', link: '/guide/how-it-works' },
          { text: 'Voice Assistant', link: '/guide/voice-assistant' },
          { text: 'Why HAPI', link: '/guide/why-hapi' },
          { text: 'FAQ', link: '/guide/faq' }
        ]
      },
      {
        text: 'Agents',
        items: [
          { text: 'Agents', link: '/guide/agents' },
          { text: 'Codex Usage & Limits', link: '/guide/codex-shared-sessions' }
        ]
      },
      {
        text: 'Advanced',
        items: [
          { text: 'Namespace', link: '/guide/namespace' },
          { text: 'Deployment', link: '/guide/deployment' },
          { text: 'Notifications', link: '/guide/notifications' }
        ]
      },
      {
        text: 'API',
        items: [
          { text: 'Native Companion Contract', link: '/api/native-companion-contract' },
          {
            text: 'Client contract',
            items: [
              { text: 'Overview', link: '/api/client-contract/' },
              { text: 'Auth', link: '/api/client-contract/auth' },
              { text: 'REST', link: '/api/client-contract/rest' },
              { text: 'SSE', link: '/api/client-contract/sse' },
              { text: 'Pagination', link: '/api/client-contract/pagination' },
              { text: 'Messages', link: '/api/client-contract/messages' },
              { text: 'Errors', link: '/api/client-contract/errors' }
            ]
          }
        ]
      }
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/BGGBTAC/hapi-evolved' }
    ],

    footer: {
      message: 'AGPL-3.0-only · <a href="/docs/evolved/DATA_HANDLING.html">Evolved data handling</a> · Includes upstream HAPI documentation.',
      copyright: 'Copyright © 2025-present'
    },

    search: {
      provider: 'local'
    }
  },

  vite: {
    server: {
      allowedHosts: true
    }
  }
})
