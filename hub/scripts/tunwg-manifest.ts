/**
 * Pinned tunwg release artifacts.
 *
 * Source: official tiann/tunwg GitHub release v26.08.03+122a6d0
 * (release id 364551754, tag commit 122a6d0e43585bed8782ceb893394104b6640589,
 * published 2026-08-04T00:03:37Z by github-actions[bot]).
 * Release metadata: https://api.github.com/repos/tiann/tunwg/releases/tags/v26.08.03%2B122a6d0
 * Digests are the GitHub-computed asset `digest` values from that metadata.
 * The LICENSE digest matches the committed shared/tools/tunwg/LICENSE
 * (git blob abbafa36be293dc9e69414d4366537391c7834bf at the tag commit).
 *
 * To update: pick a new official release, copy each asset's `digest` and `size`
 * from the GitHub release API, and keep the platform keys unchanged.
 */

export type PinnedArtifact = {
    /** File name written into shared/tools/tunwg/ */
    fileName: string
    url: string
    /** Lowercase hex SHA-256 */
    sha256: string
    /** Exact size in bytes */
    size: number
    executable: boolean
}

export const TUNWG_RELEASE_TAG = 'v26.08.03+122a6d0'
export const TUNWG_RELEASE_COMMIT = '122a6d0e43585bed8782ceb893394104b6640589'

const RELEASE_DOWNLOAD_BASE = 'https://github.com/tiann/tunwg/releases/download/v26.08.03%2B122a6d0'

export const TUNWG_ARTIFACTS: Record<string, PinnedArtifact> = {
    'x64-linux': {
        fileName: 'tunwg-x64-linux',
        url: `${RELEASE_DOWNLOAD_BASE}/tunwg`,
        sha256: 'c1a7e08d956d9ee1087b8bf3b651d5dc32aee80eee1052c11218189fd5635768',
        size: 11444386,
        executable: true
    },
    'arm64-linux': {
        fileName: 'tunwg-arm64-linux',
        url: `${RELEASE_DOWNLOAD_BASE}/tunwg-arm64`,
        sha256: 'd2d29afda075e26bb70140184b5ee6c8a8cf56b18f1fe56db3c002d7dbe5eef9',
        size: 10682530,
        executable: true
    },
    'x64-darwin': {
        fileName: 'tunwg-x64-darwin',
        url: `${RELEASE_DOWNLOAD_BASE}/tunwg-darwin`,
        sha256: '5b354c7d071cf7c5346f446fbbec8f4fe218278c6d1d9c6dca217dcdd0b96c22',
        size: 11693072,
        executable: true
    },
    'arm64-darwin': {
        fileName: 'tunwg-arm64-darwin',
        url: `${RELEASE_DOWNLOAD_BASE}/tunwg-darwin-arm64`,
        sha256: '4ff96e3ff7271a1bb940c8e7e071900d2135b483baab387d4f8ba8dc2ddd333a',
        size: 10921970,
        executable: true
    },
    'x64-win32': {
        fileName: 'tunwg-x64-win32.exe',
        url: `${RELEASE_DOWNLOAD_BASE}/tunwg.exe`,
        sha256: 'abb6538ee38a23353fe5e5a4ba74a9d597ef1ebacdbf147df2e19325ccb8c7e8',
        size: 11791872,
        executable: false
    }
}

export const TUNWG_LICENSE: PinnedArtifact = {
    fileName: 'LICENSE',
    url: `https://raw.githubusercontent.com/tiann/tunwg/${TUNWG_RELEASE_COMMIT}/LICENSE`,
    sha256: 'd8ac11fb1304443975a04293266bc30227d0dbf01a44f9d51d9ece096aadbe36',
    size: 1067,
    executable: false
}
