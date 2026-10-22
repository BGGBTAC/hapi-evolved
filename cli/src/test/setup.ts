import { inject } from 'vitest'
import type {} from './hubTestConfig'

// Inject only this Vitest project's isolated hub credentials before CLI imports.
const config = inject('hapiTestConfig')
if (!config) throw new Error('[test setup] Missing isolated hub context from globalSetup')

process.env.HAPI_API_URL = `http://127.0.0.1:${config.port}`
process.env.CLI_API_TOKEN = config.token
process.env.HAPI_HOME = config.tmpHome
process.env.HAPI_BUN_EXEC = config.bunExec
// The runner agent-availability preflight must see an installable Claude CLI
// even on machines (CI) without one; globalSetup provides a stub binary.
if (config.stubClaudePath) process.env.HAPI_CLAUDE_PATH = config.stubClaudePath
// The stress test starts 20 real CLI children. On slower/loaded machines their
// session webhooks can take longer than the production control-client default.
process.env.HAPI_RUNNER_HTTP_TIMEOUT ??= '60000'
// Keep heartbeat short so the version-mismatch test doesn't need to wait 60s
process.env.HAPI_RUNNER_HEARTBEAT_INTERVAL ??= '30000'
