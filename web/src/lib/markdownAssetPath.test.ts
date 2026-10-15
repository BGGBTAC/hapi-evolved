import { describe, expect, it } from 'vitest'
import { resolveMarkdownAssetPath as resolve } from './markdownAssetPath'
describe('Markdown asset paths', () => {
    it('resolves document-relative siblings and parent paths inside workspace', () => {
        expect(resolve('/project/docs/notes.md', 'images/one.png', '/project')).toBe('/project/docs/images/one.png')
        expect(resolve('docs/notes.md', '../README.md', '/project')).toBe('/project/README.md')
        expect(resolve('/project/docs/notes.md', '/project/images/a.png', '/project')).toBe('/project/images/a.png')
    })
    it.each(['../../etc/passwd', '%2e%2e/%2e%2e/etc/passwd', '/etc/passwd', '//evil.test/a', 'https://evil.test/a', 'javascript:alert(1)', 'data:image/png;base64,a', 'file:///project/a', '%00a'])('rejects escape and non-file %s', value => {
        expect(resolve('/project/docs/notes.md', value, '/project')).toBeNull()
    })
})
