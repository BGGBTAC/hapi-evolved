/**
 * Project-owned toolchain layout shared by the doctor and deploy/evolved/development/hapi-dev.ts.
 * Roots come from the shared contract (`{toolchainDir}` in pack recipes). Everything lives in the
 * project workspace; the runner's root filesystem stays read-only.
 */
import { createHash } from 'node:crypto'
import { DEVELOPMENT_ARTIFACTS_DIRECTORY, DEVELOPMENT_HELPER_BIN, DEVELOPMENT_TOOLCHAIN_DIRECTORY } from '@hapi/protocol/evolvedDevelopment'

export { DEVELOPMENT_ARTIFACTS_DIRECTORY, DEVELOPMENT_HELPER_BIN, DEVELOPMENT_TOOLCHAIN_DIRECTORY }
export const POSTGRES_PORT = 5432
/** sun_path holds 108 bytes including the terminating NUL. */
const MAX_SOCKET_PATH = 107

export function odooToolchain(major: 19 | 20) {
    const base = `${DEVELOPMENT_TOOLCHAIN_DIRECTORY}/odoo/${major}`
    return { base, source: `${base}/src`, record: `${base}/source.json`, venv: `${base}/venv`, data: `${base}/data` }
}

/**
 * Unix socket directory of the project cluster: `<toolchain>/postgresql/run` when the socket path fits,
 * otherwise a private, project-specific directory in the runner's own /tmp (container tmpfs).
 */
export function postgresSocketDirectory(projectRoot: string): string {
    const preferred = `${projectRoot}/${DEVELOPMENT_TOOLCHAIN_DIRECTORY}/postgresql/run`
    if (Buffer.byteLength(`${preferred}/.s.PGSQL.${POSTGRES_PORT}`) <= MAX_SOCKET_PATH) return preferred
    return `/tmp/hapi-pg-${createHash('sha256').update(projectRoot).digest('hex').slice(0, 16)}`
}

/** Relative paths are project-root relative; `*Absolute` values are absolute. */
export function toolchainPaths(projectRoot: string) {
    const postgres = `${DEVELOPMENT_TOOLCHAIN_DIRECTORY}/postgresql`
    return {
        toolchain: DEVELOPMENT_TOOLCHAIN_DIRECTORY,
        artifacts: DEVELOPMENT_ARTIFACTS_DIRECTORY,
        postgresBase: postgres,
        postgresData: `${postgres}/17/data`,
        postgresLog: `${postgres}/17/server.log`,
        postgresSocketAbsolute: postgresSocketDirectory(projectRoot),
        androidSdk: `${DEVELOPMENT_TOOLCHAIN_DIRECTORY}/android/sdk`,
        gradleHome: `${DEVELOPMENT_TOOLCHAIN_DIRECTORY}/android/gradle-home`,
        androidCli: `${DEVELOPMENT_TOOLCHAIN_DIRECTORY}/android/cli`,
        /** `swift/<version>/` plus `swift/current.json` naming the active version. */
        swift: `${DEVELOPMENT_TOOLCHAIN_DIRECTORY}/swift`,
        downloads: `${DEVELOPMENT_TOOLCHAIN_DIRECTORY}/downloads`,
    }
}
