import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { privateFile } from '../../hub/src/evolved/store'
import { createVaultSigningKey } from '../../hub/src/evolved/vault'

const directory = resolve(process.argv[2] ?? join(homedir(), '.local/share/hapi-evolved'))
mkdirSync(directory, { recursive: true, mode: 0o700 })
const state = realpathSync(directory), rel = relative(realpathSync(process.cwd()), state)
if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('Operator state must be outside the source workspace')
for (const name of ['hub', 'vault', 'memory', 'codegraph', 'neo4j', 'neo4j-logs', 'workspaces', 'managed-workspaces', 'credentials', 'credentials/hub', 'credentials/vault', 'credentials/memory', 'credentials/codegraph', 'credentials/neo4j']) mkdirSync(join(state, name), { recursive: true, mode: 0o700 })
const hubKeys = join(state, 'credentials/hub'), vaultKeys = join(state, 'credentials/vault')
const { publicKey } = createVaultSigningKey(join(hubKeys, 'vault-signing.pem'))
privateFile(join(vaultKeys, 'hub-public.pem'), publicKey)
privateFile(join(vaultKeys, 'master.key'), randomBytes(32))
const serviceToken = privateFile(join(hubKeys, 'service.token'), randomBytes(32).toString('base64url'))
privateFile(join(state, 'credentials/memory/service.token'), serviceToken)
privateFile(join(state, 'credentials/codegraph/service.token'), serviceToken)
serviceToken.fill(0)
const neoPassword = privateFile(join(state, 'credentials/memory/neo4j.password'), randomBytes(32).toString('base64url'))
privateFile(join(state, 'credentials/neo4j/auth'), `neo4j/${neoPassword.toString('utf8').trim()}`)
neoPassword.fill(0)
// Empty means paused: no provider or budget is activated by provisioning.
privateFile(join(state, 'credentials/memory/provider.key'), '')
privateFile(join(vaultKeys, 'actions.json'), '[]\n')
const configuration = `EVOLVED_STATE_DIR=${state}\nEVOLVED_UID=${process.getuid?.() ?? 1000}\nEVOLVED_GID=${process.getgid?.() ?? 1000}\nEVOLVED_ORIGIN=http://localhost:3006\nEVOLVED_LISTEN_PORT=3006\n`
try { writeFileSync(join(state, 'compose.env'), configuration, { flag: 'wx', mode: 0o600 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
console.log(`Operator directories initialized: ${state}`)
console.log(`Configuration: ${join(state, 'compose.env')}`)
console.log('No credentials were printed. Set the final private HTTPS origin before enrolling a passkey.')
