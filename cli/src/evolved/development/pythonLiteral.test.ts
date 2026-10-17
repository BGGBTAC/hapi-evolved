import { describe, expect, it } from 'vitest'
import { dictGet, isDict, parsePythonLiteral, PythonLiteralError, sequence } from './pythonLiteral'

describe('Python literal parser (ast.literal_eval subset)', () => {
    it('parses real-world manifest syntax', () => {
        const value = parsePythonLiteral(`# -*- coding: utf-8 -*-
# Part of a module.
{
    'name': "Sale " 'Extension',          # implicit concatenation
    "version": '20.0.1.0.0',
    'summary': """Multi
line""",
    'depends': ['sale', "stock",],
    'data': (
        'security/ir.model.access.csv',
        'views/sale_views.xml',
    ),
    'installable': True,
    'application': False,
    'auto_install': ['sale', 'stock'],
    'external_dependencies': {'python': ['requests'], 'bin': []},
    'sequence': -10,
    'ratio': 1.5e3,
    'hex': 0x1F,
    'none': None,
    'raw': r'\\d+\\n',
    'escaped': 'tab\\tunicode\\u00e9',
    'license': 'LGPL-3',
    'license': 'OPL-1',
}
`)
        expect(isDict(value)).toBe(true)
        if (!isDict(value)) return
        expect(dictGet(value, 'name')).toBe('Sale Extension')
        expect(dictGet(value, 'summary')).toBe('Multi\nline')
        expect(dictGet(value, 'depends')).toEqual(['sale', 'stock'])
        expect(sequence(dictGet(value, 'data'))).toEqual(['security/ir.model.access.csv', 'views/sale_views.xml'])
        expect(dictGet(value, 'installable')).toBe(true)
        expect(dictGet(value, 'sequence')).toBe(-10)
        expect(dictGet(value, 'ratio')).toBe(1500)
        expect(dictGet(value, 'hex')).toBe(31)
        expect(dictGet(value, 'none')).toBeNull()
        expect(dictGet(value, 'raw')).toBe('\\d+\\n')
        expect(dictGet(value, 'escaped')).toBe('tab\tunicodeé')
        // Python dict semantics: the last duplicate wins.
        expect(dictGet(value, 'license')).toBe('OPL-1')
    })

    it.each([
        ['call', `{'name': __import__('os').system('touch /tmp/pwned')}`],
        ['open', `{'name': open('/etc/passwd').read()}`],
        ['name', `{'depends': base_depends}`],
        ['attribute', `{'x': os.environ}`],
        ['lambda', `{'x': lambda: 1}`],
        ['comprehension', `{'x': [a for a in range(3)]}`],
        ['operator', `{'x': 1 + 2}`],
        ['concatenated lists', `{'x': ['a'] + ['b']}`],
        ['f-string', `{'x': f'{1}'}`],
        ['bytes', `{'x': b'raw'}`],
        ['unpack', `{**other}`],
        ['set', `{'a', 'b'}`],
        ['walrus', `{'x': (y := 1)}`],
        ['statement', `x = {'name': 'a'}`],
        ['two expressions', `{'a': 1}\n{'b': 2}`],
        ['unterminated', `{'name': 'a`],
        ['unterminated triple', `{'name': '''a`],
        ['complex', `{'x': 1j}`],
        ['unhashable key', `{['a']: 1}`],
        ['named unicode escape', `{'x': '\\N{BULLET}'}`],
        ['missing comma', `{'a': 1 'b': 2}`],
        ['leading zero', `{'sequence': 01}`],
        ['double underscore', `{'sequence': 1__2}`],
        ['trailing underscore', `{'sequence': 1_}`],
        ['empty hex', `{'sequence': 0x_}`],
        ['octal-looking', `{'sequence': 007}`],
        ['two dots', `{'sequence': 1.2.3}`],
        ['subscript', `{'a': [1][0]}`],
    ])('rejects %s without evaluating anything', (_, source) => {
        expect(() => parsePythonLiteral(source)).toThrow(PythonLiteralError)
    })

    it('accepts valid Python numbers exactly like the tokenizer', () => {
        for (const [source, value] of [['0', 0], ['00', 0], ['0_0', 0], ['1_000', 1000], ['.5', 0.5], ['5.', 5], ['1e3', 1000], ['1_0.0_1', 10.01], ['0x1F', 31], ['0b1_0', 2], ['0o17', 15], ['-1', -1]] as const) {
            expect(parsePythonLiteral(source)).toBe(value)
        }
    })

    it('bounds nesting depth and element count', () => {
        expect(() => parsePythonLiteral(`${'['.repeat(40)}${']'.repeat(40)}`)).toThrow(/nested too deeply/)
        expect(() => parsePythonLiteral(`[${'1,'.repeat(20_001)}]`)).toThrow(/too many elements/)
        expect(parsePythonLiteral(`${'['.repeat(30)}${']'.repeat(30)}`)).toBeTruthy()
    })

    it('reports only a position, never echoing source content', () => {
        try { parsePythonLiteral(`{'token': SECRET_TOKEN_VALUE_1234567890}`); expect.unreachable() }
        catch (error) {
            expect(error).toBeInstanceOf(PythonLiteralError)
            expect((error as Error).message.length).toBeLessThan(80)
            expect((error as PythonLiteralError).offset).toBeGreaterThan(0)
        }
    })

    it('handles tuples, empty containers, BOM and line continuations', () => {
        expect(parsePythonLiteral('﻿()')).toEqual({ kind: 'tuple', items: [] })
        expect(parsePythonLiteral('("a",)')).toEqual({ kind: 'tuple', items: ['a'] })
        expect(parsePythonLiteral('("a")')).toBe('a')
        expect(parsePythonLiteral('{}')).toEqual({ kind: 'dict', entries: [] })
        expect(parsePythonLiteral("'a' \\\n 'b'")).toBe('ab')
        expect(parsePythonLiteral('"""a"b"""')).toBe('a"b')
    })
})
