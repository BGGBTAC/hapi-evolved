import { PLUGIN_VALIDATE_USAGE, validatePluginManifestFile } from '@/evolved/development/pluginValidate'

/**
 * `hapi evolved plugin …` (offline author tooling). Kept free of the command registry and the CLI configuration so
 * runCli dispatches here before loading the registry, without creating HAPI_HOME, logs or settings. `args` follow `evolved`.
 */
export function runEvolvedPluginCommand(args: readonly string[]): void {
    if (args[1] !== 'validate' || args.length > 3 || args.includes('--help')) { console.log(PLUGIN_VALIDATE_USAGE); if (!args.includes('--help')) process.exitCode = 1; return }
    const report = validatePluginManifestFile(args[2] ?? '.')
    console.log(JSON.stringify(report, null, 2))
    if (!report.ok) process.exitCode = 1
}
