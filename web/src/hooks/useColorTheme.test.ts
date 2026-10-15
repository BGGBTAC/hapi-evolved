import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
    applyColorTheme,
    getColorThemeStorageKey,
    getStoredColorTheme,
    parseColorTheme,
    useColorTheme,
    colorContrast,
    registerPluginColorThemes,
    getColorThemeOptions,
    getPluginThemeMode,
} from './useColorTheme'

const THEME_VARS = ['--app-bg', '--app-fg', '--app-link', '--app-button', '--app-secondary-bg', '--app-chat-user-chip-bg']

describe('useColorTheme', () => {
    beforeEach(() => {
        localStorage.clear()
        registerPluginColorThemes([])
        document.documentElement.removeAttribute('data-color-theme')
        document.documentElement.setAttribute('data-theme', 'light')
        for (const name of THEME_VARS) document.documentElement.style.removeProperty(name)
    })

    it('parses invalid or missing stored values as default', () => {
        expect(parseColorTheme(null)).toBe('default')
        expect(parseColorTheme('unknown')).toBe('default')
        expect(parseColorTheme('notion')).toBe('notion')
    })

    it('reads the stored color theme preference', () => {
        localStorage.setItem(getColorThemeStorageKey(), 'rose-pine')
        expect(getStoredColorTheme()).toBe('rose-pine')
    })

    it('applies a preset palette to the document css variables', () => {
        applyColorTheme('one', 'light')
        expect(document.documentElement).toHaveAttribute('data-color-theme', 'one')
        expect(document.documentElement.style.getPropertyValue('--app-bg')).toBe('#fbfbff')
        expect(document.documentElement.style.getPropertyValue('--app-link')).toBe('#526fff')
    })

    it('removes palette css variables when reset to default', () => {
        applyColorTheme('one', 'dark')
        applyColorTheme('default', 'dark')

        expect(document.documentElement).toHaveAttribute('data-color-theme', 'default')
        expect(document.documentElement.style.getPropertyValue('--app-bg')).toBe('')
        expect(document.documentElement.style.getPropertyValue('--app-link')).toBe('')
    })

    it('persists non-default selections and removes the key for default', () => {
        const { result } = renderHook(() => useColorTheme())

        act(() => result.current.setColorTheme('night-owl'))
        expect(localStorage.getItem(getColorThemeStorageKey())).toBe('night-owl')
        expect(document.documentElement.style.getPropertyValue('--app-bg')).toBe('#fbfdff')

        act(() => result.current.setColorTheme('default'))
        expect(localStorage.getItem(getColorThemeStorageKey())).toBeNull()
        expect(document.documentElement.style.getPropertyValue('--app-bg')).toBe('')
    })

    it('uses the current dark scheme when applying from the hook', () => {
        document.documentElement.setAttribute('data-theme', 'dark')
        const { result } = renderHook(() => useColorTheme())

        act(() => result.current.setColorTheme('notion'))
        expect(document.documentElement.style.getPropertyValue('--app-bg')).toBe('#191919')
        expect(document.documentElement.style.getPropertyValue('--app-fg')).toBe('#d9d9d8')
    })

    it('uses dark palette contrast values for OLED', () => {
        applyColorTheme('one', 'oled')

        expect(document.documentElement.style.getPropertyValue('--app-bg')).toBe('#1f2433')
        expect(document.documentElement.style.getPropertyValue('--app-chat-user-chip-bg')).toBe('rgba(123, 140, 255, 0.24)')
    })

    it.each(['evolved-ocean', 'evolved-iris', 'evolved-sand'] as const)('%s keeps text, links and buttons readable in both modes', theme => {
        for (const scheme of ['light', 'dark'] as const) {
            applyColorTheme(theme, scheme)
            const color = (key: string) => document.documentElement.style.getPropertyValue(`--app-${key}`)
            for (const surface of ['bg', 'secondary-bg', 'dialog-bg', 'code-bg', 'tool-card-hover-bg']) {
                for (const foreground of ['fg', 'hint', 'link']) expect(colorContrast(color(foreground), color(surface)), `${scheme} ${foreground}/${surface}`).toBeGreaterThanOrEqual(4.5)
            }
            expect(colorContrast(color('button'), color('button-text'))).toBeGreaterThanOrEqual(4.5)
        }
    })

    const plugin = { id: 'plugin:installation:mint', name: 'Mint', mode: 'light', colors: { background: '#ffffff', surface: '#f0f5f2', text: '#14221b', muted: '#485b50', accent: '#145c3c', accentText: '#ffffff', border: '#819c8b' } }
    it('restores a stored plugin only when its authorized catalog arrives and removes it on logout', () => {
        localStorage.setItem(getColorThemeStorageKey(), plugin.id)
        expect(getStoredColorTheme()).toBe('default')
        const { result } = renderHook(() => useColorTheme())
        act(() => registerPluginColorThemes([plugin]))
        expect(result.current.colorTheme).toBe(plugin.id)
        expect(getPluginThemeMode(result.current.colorTheme)).toBe('light')
        expect(document.documentElement.style.getPropertyValue('--app-bg')).toBe('#ffffff')
        act(() => registerPluginColorThemes([]))
        expect(result.current.colorTheme).toBe('default')
        expect(document.documentElement.style.getPropertyValue('--app-link')).toBe('')
        expect(localStorage.getItem(getColorThemeStorageKey())).toBe(plugin.id)
    })
    it('rejects unsafe palette values, invalid namespaces and insufficient contrast', () => {
        registerPluginColorThemes([
            { ...plugin, id: 'unscoped' },
            { ...plugin, colors: { ...plugin.colors, background: 'url(https://example.invalid)' } },
            { ...plugin, colors: { ...plugin.colors, muted: '#cccccc' } },
            { ...plugin, colors: { ...plugin.colors, accentText: '#155d3d' } },
        ])
        expect(getColorThemeOptions().some(option => option.value.startsWith('plugin:'))).toBe(false)
    })
    it('never mixes a light-only plugin with dark semantic defaults', () => {
        registerPluginColorThemes([plugin])
        applyColorTheme('plugin:installation:mint', 'dark')
        expect(document.documentElement.style.getPropertyValue('--app-bg')).toBe('')
    })
})
