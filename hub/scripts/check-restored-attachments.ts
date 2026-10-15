import { checkAttachmentIntegrity } from '../src/store/attachmentIntegrity'

const [databasePath, attachmentRoot, ...extra] = process.argv.slice(2)
if (!databasePath || !attachmentRoot || extra.length) {
    console.error('Usage (Hub and all writers stopped): bun hub/scripts/check-restored-attachments.ts /absolute/hapi.db /absolute/attachments')
    process.exitCode = 2
} else {
    try {
        const report = await checkAttachmentIntegrity(databasePath, attachmentRoot)
        console.log(JSON.stringify(report, null, 2))
        process.exitCode = report.ok ? 0 : 1
    } catch (error) {
        console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
        process.exitCode = 2
    }
}
