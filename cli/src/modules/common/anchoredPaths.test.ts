import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { constants } from 'fs'
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { descriptorPath, openContainedDirectory, openContainedParent } from './anchoredPaths'

describe.skipIf(process.platform !== 'linux')('descriptor-anchored project paths', () => {
    let base: string
    let project: string
    let safe: string
    let outside: string

    beforeEach(async () => {
        base = await mkdtemp(join(tmpdir(), 'hapi-anchored-path-'))
        project = join(base, 'project')
        safe = join(project, 'safe')
        outside = join(base, 'outside')
        await mkdir(safe, { recursive: true })
        await mkdir(outside)
        await writeFile(join(safe, 'document.txt'), 'inside')
        await writeFile(join(outside, 'document.txt'), 'outside')
    })

    afterEach(async () => {
        await rm(base, { recursive: true, force: true })
    })

    async function swapAncestor() {
        await rename(safe, join(project, 'safe-original'))
        await symlink(outside, safe)
    }

    it('rejects an ancestor changed to an outside symlink before anchoring', async () => {
        const previouslyValidated = join(safe, 'document.txt')
        await swapAncestor()
        await expect(openContainedParent(previouslyValidated, project)).rejects.toThrow()
        await expect(openContainedDirectory(safe, project)).rejects.toThrow()
        expect(await readFile(join(outside, 'document.txt'), 'utf8')).toBe('outside')
    })

    it('keeps file and directory I/O on the original inode after a swap', async () => {
        const anchoredFile = await openContainedParent(join(safe, 'document.txt'), project)
        const anchoredDir = await openContainedDirectory(safe, project)
        try {
            await swapAncestor()

            const file = await open(anchoredFile.path, constants.O_RDWR | constants.O_NOFOLLOW)
            try {
                expect(await file.readFile({ encoding: 'utf8' })).toBe('inside')
                await file.truncate(0)
                await file.write('updated', 0, 'utf8')
            } finally {
                await file.close()
            }

            expect(await readdir(descriptorPath(anchoredDir))).toEqual(['document.txt'])
            expect(await readFile(join(outside, 'document.txt'), 'utf8')).toBe('outside')
            expect(await readFile(join(project, 'safe-original', 'document.txt'), 'utf8')).toBe('updated')
        } finally {
            await anchoredFile.close()
            await anchoredDir.close()
        }
    })
})
