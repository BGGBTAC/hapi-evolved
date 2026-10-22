import { expect, inject, test } from 'vitest'
import { statSync } from 'node:fs'
import type {} from './hubTestConfig'

test('worker credentials belong to its isolated hub context', async () => {
    const config = inject('hapiTestConfig')
    expect(process.env.HAPI_HOME).toBe(config.tmpHome)
    expect(process.env.CLI_API_TOKEN).toBe(config.token)
    expect(process.env.HAPI_API_URL).toBe(`http://127.0.0.1:${config.port}`)
    if (process.platform !== 'win32') expect(statSync(config.tmpHome).mode & 0o777).toBe(0o700)
    const response = await fetch(`${process.env.HAPI_API_URL}/health`, { signal: AbortSignal.timeout(1000) })
    expect(response.ok).toBe(true)
})
