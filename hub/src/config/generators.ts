import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, link, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { updateSettings, type Settings, type SettingsUpdateOutcome } from './settings'

export type GetOrCreateResult<T> = {
    value: T
    created: boolean
}

export type SettingsValueReadResult<T> = {
    value: T
    writeBack?: boolean
}

export async function getOrCreateSettingsValue<T>(options: {
    settingsFile: string
    readValue: (settings: Settings) => SettingsValueReadResult<T> | null
    writeValue: (settings: Settings, value: T) => void
    generate: () => T
}): Promise<GetOrCreateResult<T>> {
    return updateSettings(options.settingsFile, (settings): SettingsUpdateOutcome<GetOrCreateResult<T>> => {
        const existing = options.readValue(settings)
        if (existing) {
            return {
                settings,
                result: { value: existing.value, created: false },
                write: Boolean(existing.writeBack),
            }
        }

        const generated = options.generate()
        options.writeValue(settings, generated)
        return {
            settings,
            result: { value: generated, created: true },
        }
    })
}

export async function getOrCreateJsonFile<T>(options: {
    filePath: string
    readValue: (raw: string) => T
    writeValue: (value: T) => string
    generate: () => T
    fileMode?: number
    dirMode?: number
}): Promise<GetOrCreateResult<T>> {
    const fileMode = options.fileMode ?? 0o600
    const dirMode = options.dirMode ?? 0o700

    if (existsSync(options.filePath)) {
        await chmod(options.filePath, fileMode).catch(() => {})
        const raw = await readFile(options.filePath, 'utf8')
        return { value: options.readValue(raw), created: false }
    }

    const generated = options.generate()
    const dir = dirname(options.filePath)
    if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true, mode: dirMode })
    }

    // Publish complete content without replacing a file another starter created after
    // the existence check: link() fails with EEXIST instead of clobbering it.
    const temporary = join(dir, `.${basename(options.filePath)}.${randomUUID()}.tmp`)
    try {
        await writeFile(temporary, options.writeValue(generated), { mode: fileMode, flag: 'wx' })
        await chmod(temporary, fileMode).catch(() => {})
        try {
            await link(temporary, options.filePath)
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
            const raw = await readFile(options.filePath, 'utf8')
            return { value: options.readValue(raw), created: false }
        }
    } finally {
        await rm(temporary, { force: true })
    }
    return { value: generated, created: true }
}
