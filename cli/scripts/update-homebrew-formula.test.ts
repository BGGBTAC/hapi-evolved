import { describe, expect, it } from 'vitest';
import { assertFormulaVersion, authenticatedTapUrl, generateFormula } from './update-homebrew-formula';

const shas = { darwinArm64: 'a', darwinX64: 'b', linuxArm64: 'c', linuxX64: 'd' };

describe('authenticatedTapUrl', () => {
    it('adds the CI token to the GitHub tap URL', () => {
        expect(authenticatedTapUrl('https://github.com/tiann/homebrew-tap.git', 'tok'))
            .toBe('https://x-access-token:tok@github.com/tiann/homebrew-tap.git');
    });

    it('leaves the URL alone without a token', () => {
        expect(authenticatedTapUrl('https://github.com/tiann/homebrew-tap.git', undefined))
            .toBe('https://github.com/tiann/homebrew-tap.git');
    });

    it('never attaches the token to another host that mentions github.com', () => {
        for (const tapRepo of [
            'https://example.test/?https://github.com/tiann/homebrew-tap.git',
            'https://github.com.example.test/tiann/homebrew-tap.git',
            'https://example.test/github.com/tiann/homebrew-tap.git',
            'http://github.com/tiann/homebrew-tap.git',
            'git@github.com:tiann/homebrew-tap.git',
        ]) {
            const url = authenticatedTapUrl(tapRepo, 'tok');
            expect(url).toBe(tapRepo);
            expect(url).not.toContain('tok');
        }
    });
});

describe('assertFormulaVersion', () => {
    it('accepts release versions', () => {
        for (const version of ['0.1.0', '1.2.3-beta.1', '1.2.3+build.5']) {
            expect(() => assertFormulaVersion(version)).not.toThrow();
        }
        expect(generateFormula('1.2.3', shas)).toContain('version "1.2.3"');
    });

    it('rejects versions that would escape the formula string or commit message', () => {
        for (const version of ['1.0"; system("id")#', '1.0#{`id`}', '1.0$(id)', '-1.0', '1.0 x', '']) {
            expect(() => assertFormulaVersion(version)).toThrow('Invalid version');
        }
    });
});
