import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'HAPI-eVolved',
  description: 'HAPI-eVolved: an independent HAPI fork for self-hosted agents, protected credentials and persistent knowledge',
  base: '/docs/',

  head: [
    ['link', { rel: 'icon', href: '/docs/evolved-icon.svg' }],
  ],

  themeConfig: {
    logo: { src: '/evolved-mark.svg', alt: 'HAPI-eVolved' },

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
        text: 'Evolved guides',
        items: [
          { text: 'Getting started', link: '/guide/quick-start' },
          { text: 'Why HAPI-eVolved?', link: '/guide/why-hapi' },
          { text: 'How it works', link: '/guide/how-it-works' },
          { text: 'PWA', link: '/guide/pwa' },
          { text: 'FAQ', link: '/guide/faq' }
        ]
      },
      {
        text: 'Upstream HAPI reference',
        items: [
          { text: 'Installation', link: '/guide/installation' },
          { text: 'Native apps', link: '/guide/native-apps' },
          { text: 'Voice assistant', link: '/guide/voice-assistant' }
        ]
      },
      {
        text: 'Upstream agent reference',
        items: [
          { text: 'Agents', link: '/guide/agents' },
          { text: 'Codex Usage & Limits', link: '/guide/codex-shared-sessions' }
        ]
      },
      {
        text: 'Upstream advanced reference',
        items: [
          { text: 'Namespace', link: '/guide/namespace' },
          { text: 'Deployment', link: '/guide/deployment' },
          { text: 'Notifications', link: '/guide/notifications' }
        ]
      },
      {
        text: 'Shared API reference',
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
      message: 'Independent fork of <a href="https://github.com/tiann/hapi">tiann/hapi</a> · <a href="https://github.com/BGGBTAC/hapi-evolved/blob/main/NOTICE">AGPL-3.0-only and attribution</a> · <a href="/docs/evolved/DATA_HANDLING.html">Data handling</a>',
      copyright: 'HAPI and HAPI-eVolved contributors. Original notices retained.'
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
