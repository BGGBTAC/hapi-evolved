import { useCallback, useEffect, useState } from 'react'
import type { ThemeColorKeyId } from './useThemeColors'

export type ColorScheme = 'light' | 'dark' | 'oled'
type BuiltinColorThemePreset =
    | 'default'
    | 'evolved-ocean'
    | 'evolved-iris'
    | 'evolved-sand'
    | 'notion'
    | 'one'
    | 'proof'
    | 'raycast'
    | 'rose-pine'
    | 'solarized'
    | 'vercel'
    | 'vs-code-plus'
    | 'xcode'
    | 'linear'
    | 'lobster'
    | 'material'
    | 'matrix'
    | 'monokai'
    | 'night-owl'
    | 'nord'
export type ColorThemePreset = BuiltinColorThemePreset | `plugin:${string}`
export type PluginColorTheme = { id: `plugin:${string}`; name: string; mode: 'light' | 'dark'; colors: { background: string; surface: string; text: string; muted: string; accent: string; accentText: string; border: string } }

export type ColorThemeOption = {
    value: ColorThemePreset
    labelKey: string
    label?: string
    pluginMode?: 'light' | 'dark'
    preview: {
        light: string
        dark: string
        accent: string
    }
}

type ThemePalette = {
    accent: string
    background: string
    foreground: string
    hint: string
    secondary: string
    dialog: string
    surface: string
    surfaceHover: string
    code: string
    border: string
    subtle: string
    buttonText: string
}

const COLOR_THEME_KEY = 'hapi-color-theme'
let pluginThemes = new Map<string, PluginColorTheme>()

const COLOR_THEME_OPTIONS: ReadonlyArray<ColorThemeOption> = [
    { value: 'default', labelKey: 'settings.display.colorTheme.default', preview: { light: '#f6f8f7', dark: '#0d1312', accent: '#0f766e' } },
    { value: 'evolved-ocean', labelKey: 'settings.display.colorTheme.ocean', preview: { light: '#f5f8fc', dark: '#0e1726', accent: '#175c9e' } },
    { value: 'evolved-iris', labelKey: 'settings.display.colorTheme.iris', preview: { light: '#faf7fc', dark: '#191424', accent: '#7242a0' } },
    { value: 'evolved-sand', labelKey: 'settings.display.colorTheme.sand', preview: { light: '#fbf8f1', dark: '#211b14', accent: '#855217' } },
    { value: 'notion', labelKey: 'settings.display.colorTheme.notion', preview: { light: '#fafafa', dark: '#191919', accent: '#3183d8' } },
    { value: 'one', labelKey: 'settings.display.colorTheme.one', preview: { light: '#fbfbff', dark: '#1f2433', accent: '#526fff' } },
    { value: 'proof', labelKey: 'settings.display.colorTheme.proof', preview: { light: '#f8f7f2', dark: '#18231f', accent: '#2f7d5b' } },
    { value: 'raycast', labelKey: 'settings.display.colorTheme.raycast', preview: { light: '#ffffff', dark: '#201617', accent: '#ff5555' } },
    { value: 'rose-pine', labelKey: 'settings.display.colorTheme.rosePine', preview: { light: '#fffaf3', dark: '#191724', accent: '#c65f7b' } },
    { value: 'solarized', labelKey: 'settings.display.colorTheme.solarized', preview: { light: '#fdf6e3', dark: '#002b36', accent: '#b58900' } },
    { value: 'vercel', labelKey: 'settings.display.colorTheme.vercel', preview: { light: '#ffffff', dark: '#000000', accent: '#0070f3' } },
    { value: 'vs-code-plus', labelKey: 'settings.display.colorTheme.vsCodePlus', preview: { light: '#ffffff', dark: '#1e1e1e', accent: '#007acc' } },
    { value: 'xcode', labelKey: 'settings.display.colorTheme.xcode', preview: { light: '#f7f9ff', dark: '#1f2024', accent: '#0a84ff' } },
    { value: 'linear', labelKey: 'settings.display.colorTheme.linear', preview: { light: '#f7f7fb', dark: '#08090d', accent: '#5e6ad2' } },
    { value: 'lobster', labelKey: 'settings.display.colorTheme.lobster', preview: { light: '#fff7f4', dark: '#161821', accent: '#ff5b6e' } },
    { value: 'material', labelKey: 'settings.display.colorTheme.material', preview: { light: '#fffbfe', dark: '#1c1b1f', accent: '#6750a4' } },
    { value: 'matrix', labelKey: 'settings.display.colorTheme.matrix', preview: { light: '#f5fff7', dark: '#030806', accent: '#00ff66' } },
    { value: 'monokai', labelKey: 'settings.display.colorTheme.monokai', preview: { light: '#f8f7ef', dark: '#272822', accent: '#a6e22e' } },
    { value: 'night-owl', labelKey: 'settings.display.colorTheme.nightOwl', preview: { light: '#fbfdff', dark: '#011627', accent: '#82aaff' } },
    { value: 'nord', labelKey: 'settings.display.colorTheme.nord', preview: { light: '#eceff4', dark: '#2e3440', accent: '#88c0d0' } },
]

const PALETTES: Record<Exclude<BuiltinColorThemePreset, 'default'>, Record<'light' | 'dark', ThemePalette>> = {
    'evolved-ocean': {
        light: palette('#175c9e', '#f5f8fc', '#172b42', '#485f77', '#e5edf6'),
        dark: palette('#8fc5ff', '#0e1726', '#e5edf7', '#aabdd2', '#19283d'),
    },
    'evolved-iris': {
        light: palette('#7242a0', '#faf7fc', '#30233b', '#695575', '#efe7f5'),
        dark: palette('#d3b1f4', '#191424', '#f0e8f7', '#bfaccd', '#2b203a'),
    },
    'evolved-sand': {
        light: palette('#855217', '#fbf8f1', '#362b1e', '#6b5b43', '#f0e8d9'),
        dark: palette('#efc581', '#211b14', '#f1e9db', '#c3b49c', '#34291d'),
    },
    notion: {
        light: palette('#3183d8', '#fafafa', '#37352f', '#787774', '#f1f1ef'),
        dark: palette('#3183d8', '#191919', '#d9d9d8', '#9b9a97', '#252525'),
    },
    one: {
        light: palette('#526fff', '#fbfbff', '#383a42', '#696c77', '#f0f2ff'),
        dark: palette('#7b8cff', '#1f2433', '#d8dee9', '#aab2c0', '#2c3245'),
    },
    proof: {
        light: palette('#2f7d5b', '#f8f7f2', '#26352f', '#64706b', '#eef1ea'),
        dark: palette('#7fc8a6', '#18231f', '#d9e4dc', '#9dafaa', '#23332d'),
    },
    raycast: {
        light: palette('#ff4d4d', '#ffffff', '#2b2b31', '#72727a', '#fff0f0'),
        dark: palette('#ff6363', '#201617', '#f3eded', '#c9bfc0', '#321f21'),
    },
    'rose-pine': {
        light: palette('#d7827e', '#fffaf3', '#575279', '#797593', '#f2e9e1'),
        dark: palette('#ebbcba', '#191724', '#e0def4', '#908caa', '#26233a'),
    },
    solarized: {
        light: palette('#b58900', '#fdf6e3', '#586e75', '#839496', '#eee8d5'),
        dark: palette('#268bd2', '#002b36', '#93a1a1', '#839496', '#073642'),
    },
    vercel: {
        light: palette('#0070f3', '#ffffff', '#111111', '#666666', '#f5f5f5'),
        dark: palette('#3291ff', '#000000', '#ededed', '#a1a1a1', '#111111'),
    },
    'vs-code-plus': {
        light: palette('#007acc', '#ffffff', '#24292f', '#6e7781', '#f3f6f8'),
        dark: palette('#3794ff', '#1e1e1e', '#d4d4d4', '#9cdcfe', '#252526'),
    },
    xcode: {
        light: palette('#0a84ff', '#f7f9ff', '#1f2328', '#59636e', '#eef4ff'),
        dark: palette('#409cff', '#1f2024', '#eef2ff', '#a9b0bd', '#2a2c33'),
    },
    linear: {
        light: palette('#5e6ad2', '#f7f7fb', '#25262f', '#70717d', '#eeeeF8'),
        dark: palette('#8a91f6', '#08090d', '#f7f8ff', '#a6a8b5', '#151722'),
    },
    lobster: {
        light: palette('#e84d68', '#fff7f4', '#33262b', '#7d636a', '#ffe9e2'),
        dark: palette('#ff5b6e', '#161821', '#f5d7dc', '#be9ca5', '#242333'),
    },
    material: {
        light: palette('#6750a4', '#fffbfe', '#1c1b1f', '#6f6a73', '#f2edf7'),
        dark: palette('#d0bcff', '#1c1b1f', '#e6e1e5', '#cac4cf', '#2b2930'),
    },
    matrix: {
        light: palette('#10883a', '#f5fff7', '#102016', '#55735f', '#e8f8ec'),
        dark: palette('#00ff66', '#030806', '#d8ffe4', '#6aff9b', '#07150d'),
    },
    monokai: {
        light: palette('#7a8f00', '#f8f7ef', '#3b3a32', '#747065', '#efeee4'),
        dark: palette('#a6e22e', '#272822', '#f8f8f2', '#cfcfc2', '#33342d'),
    },
    'night-owl': {
        light: palette('#4876d9', '#fbfdff', '#25354a', '#60708a', '#eef6ff'),
        dark: palette('#82aaff', '#011627', '#d6deeb', '#7fdbca', '#0b2942'),
    },
    nord: {
        light: palette('#5e81ac', '#eceff4', '#2e3440', '#667085', '#e5e9f0'),
        dark: palette('#88c0d0', '#2e3440', '#eceff4', '#d8dee9', '#3b4252'),
    },
}

function palette(accent: string, background: string, foreground: string, hint: string, secondary: string): ThemePalette {
    const isDark = relativeLuminance(background) < 0.5
    return {
        accent,
        background,
        foreground,
        hint,
        secondary,
        dialog: isDark ? mix(background, '#ffffff', 0.05) : mix(background, '#000000', 0.015),
        surface: isDark ? mix(background, '#ffffff', 0.09) : mix(background, '#000000', 0.035),
        surfaceHover: isDark ? mix(background, '#ffffff', 0.14) : mix(background, '#000000', 0.065),
        code: isDark ? mix(background, '#ffffff', 0.11) : mix(background, '#000000', 0.045),
        border: withAlpha(isDark ? '#ffffff' : '#0f172a', isDark ? 0.11 : 0.10),
        subtle: withAlpha(isDark ? '#ffffff' : '#0f172a', isDark ? 0.06 : 0.045),
        buttonText: readableText(accent),
    }
}

function isBrowser(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined'
}

function safeGetItem(key: string): string | null {
    if (!isBrowser()) return null
    try {
        return localStorage.getItem(key)
    } catch {
        return null
    }
}

function safeSetItem(key: string, value: string): void {
    if (!isBrowser()) return
    try {
        localStorage.setItem(key, value)
    } catch {
        // Ignore storage errors
    }
}

function safeRemoveItem(key: string): void {
    if (!isBrowser()) return
    try {
        localStorage.removeItem(key)
    } catch {
        // Ignore storage errors
    }
}

export function parseColorTheme(raw: string | null): ColorThemePreset {
    return raw && (COLOR_THEME_OPTIONS.some((option) => option.value === raw) || pluginThemes.has(raw)) ? raw as ColorThemePreset : 'default'
}

export function getStoredColorTheme(): ColorThemePreset {
    return parseColorTheme(safeGetItem(COLOR_THEME_KEY))
}

export function getColorThemeOptions(): ReadonlyArray<ColorThemeOption> {
    return [...COLOR_THEME_OPTIONS, ...[...pluginThemes.values()].map(theme => ({ value: theme.id, labelKey: '', label: theme.name, pluginMode: theme.mode, preview: { light: theme.colors.background, dark: theme.colors.surface, accent: theme.colors.accent } }))]
}

export function getColorThemePreview(theme: ColorThemePreset): ColorThemeOption['preview'] {
    return getColorThemeOptions().find((option) => option.value === theme)?.preview ?? COLOR_THEME_OPTIONS[0]!.preview
}

export function getColorThemeStorageKey(): string {
    return COLOR_THEME_KEY
}

export function getColorThemeBackground(theme: ColorThemePreset, scheme: ColorScheme): string | null {
    return resolvePalette(theme, scheme)?.background ?? null
}

export function getColorThemePickerValue(theme: ColorThemePreset, scheme: ColorScheme, id: ThemeColorKeyId): string | null {
    const palette = resolvePalette(theme, scheme)
    if (!palette) return null
    const values: Record<ThemeColorKeyId, string> = {
        background: palette.background,
        surface: palette.secondary,
        text: palette.foreground,
        hint: palette.hint,
        accent: palette.accent,
        border: compositeOnBackground(palette.border, palette.background),
        userBubble: palette.surface,
    }
    return values[id]
}

export function applyColorTheme(theme: ColorThemePreset = getStoredColorTheme(), scheme: ColorScheme): void {
    if (!isBrowser()) return

    const root = document.documentElement
    root.setAttribute('data-color-theme', theme)

    const values = resolvePalette(theme, scheme)
    if (!values) {
        removeThemeProperties(root)
        return
    }
    const properties: Record<string, string> = {
        '--app-bg': values.background,
        '--app-fg': values.foreground,
        '--app-hint': values.hint,
        '--app-link': values.accent,
        '--app-button': values.accent,
        '--app-button-text': values.buttonText,
        '--app-banner-bg': values.accent,
        '--app-banner-text': values.buttonText,
        '--app-secondary-bg': values.secondary,
        '--app-dialog-bg': values.dialog,
        '--app-chat-user-bg': values.surface,
        '--app-chat-user-fg': values.foreground,
        '--app-chat-user-chip-bg': withAlpha(values.accent, toPaletteScheme(scheme) === 'dark' ? 0.24 : 0.15),
        '--app-chat-user-chip-fg': values.accent,
        '--app-tool-card-bg': values.surface,
        '--app-tool-card-hover-bg': values.surfaceHover,
        '--app-tool-card-accent': values.hint,
        '--app-tool-card-muted-action-fg': withAlpha(values.hint, 0.72),
        '--app-tool-card-subtitle': values.hint,
        '--app-code-header-bg': values.surfaceHover,
        '--app-code-header-fg': values.hint,
        '--app-code-bg': values.code,
        '--app-inline-code-bg': values.code,
        '--app-inline-code-fg': values.foreground,
        '--app-md-quote-bg': values.surface,
        '--app-md-quote-border': withAlpha(values.accent, 0.35),
        '--app-md-quote-fg': values.foreground,
        '--app-md-table-bg': values.surface,
        '--app-md-table-head-bg': values.surfaceHover,
        '--app-reasoning-bg': values.surface,
        '--app-border': values.border,
        '--app-divider': values.border,
        '--app-subtle-bg': values.subtle,
        '--app-scrollbar-thumb': withAlpha(values.hint, 0.38),
        '--app-scrollbar-thumb-hover': withAlpha(values.hint, 0.56),
    }

    for (const [key, value] of Object.entries(properties)) {
        root.style.setProperty(key, value)
    }
}

function removeThemeProperties(root: HTMLElement): void {
    const properties = [
        '--app-bg', '--app-fg', '--app-hint', '--app-link', '--app-button', '--app-button-text', '--app-banner-bg', '--app-banner-text',
        '--app-secondary-bg', '--app-dialog-bg', '--app-chat-user-bg', '--app-chat-user-fg', '--app-chat-user-chip-bg',
        '--app-chat-user-chip-fg', '--app-tool-card-bg', '--app-tool-card-hover-bg', '--app-tool-card-accent',
        '--app-tool-card-muted-action-fg', '--app-tool-card-subtitle', '--app-code-header-bg', '--app-code-header-fg', '--app-code-bg',
        '--app-inline-code-bg', '--app-inline-code-fg', '--app-md-quote-bg', '--app-md-quote-border', '--app-md-quote-fg', '--app-md-table-bg',
        '--app-md-table-head-bg', '--app-reasoning-bg', '--app-border', '--app-divider', '--app-subtle-bg', '--app-scrollbar-thumb', '--app-scrollbar-thumb-hover',
    ]
    for (const property of properties) root.style.removeProperty(property)
}


function getDocumentColorScheme(): ColorScheme {
    if (!isBrowser()) return 'light'
    const theme = document.documentElement.getAttribute('data-theme')
    return theme === 'dark' || theme === 'oled' ? theme : 'light'
}

function toPaletteScheme(scheme: ColorScheme): 'light' | 'dark' {
    return scheme === 'light' ? 'light' : 'dark'
}

export function getPluginThemeMode(theme: ColorThemePreset): 'light' | 'dark' | null {
    return pluginThemes.get(theme)?.mode ?? null
}

function resolvePalette(theme: ColorThemePreset, scheme: ColorScheme): ThemePalette | null {
    if (theme === 'default') return null
    const plugin = pluginThemes.get(theme)
    if (plugin) {
        if (plugin.mode !== toPaletteScheme(scheme)) return null
        const { colors } = plugin
        return { ...palette(colors.accent, colors.background, colors.text, colors.muted, colors.surface), dialog: colors.surface, surface: colors.surface, secondary: colors.surface, code: colors.surface, surfaceHover: colors.surface, border: colors.border, buttonText: colors.accentText }
    }
    const builtin = PALETTES[theme as keyof typeof PALETTES]
    return builtin?.[toPaletteScheme(scheme)] ?? null
}

/** Server manifests never become CSS. Only seven bounded hex colors are accepted. */
export function registerPluginColorThemes(input: unknown): void {
    const next = new Map<string, PluginColorTheme>()
    if (Array.isArray(input)) for (const candidate of input.slice(0, 100)) {
        if (!candidate || typeof candidate !== 'object') continue
        const value = candidate as Partial<PluginColorTheme>
        if (typeof value.id !== 'string' || !/^plugin:[a-zA-Z0-9_-]{1,80}:[a-zA-Z0-9_-]{1,80}$/.test(value.id) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100 || (value.mode !== 'light' && value.mode !== 'dark') || !value.colors) continue
        const keys = ['background', 'surface', 'text', 'muted', 'accent', 'accentText', 'border'] as const
        if (!keys.every(key => typeof value.colors![key] === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.colors![key]))) continue
        const colors = Object.fromEntries(keys.map(key => [key, value.colors![key]])) as PluginColorTheme['colors']
        if ([colors.background, colors.surface].some(background => colorContrast(colors.text, background) < 4.5 || colorContrast(colors.muted, background) < 4.5 || colorContrast(colors.accent, background) < 4.5) || colorContrast(colors.accentText, colors.accent) < 4.5) continue
        next.set(value.id, { id: value.id, name: value.name, mode: value.mode, colors })
    }
    if (JSON.stringify([...pluginThemes]) === JSON.stringify([...next])) return
    pluginThemes = next
    if (isBrowser()) {
        applyColorTheme(getStoredColorTheme(), getDocumentColorScheme())
        window.dispatchEvent(new CustomEvent('hapi-color-theme-change'))
    }
}

export function colorContrast(a: string, b: string): number {
    const x = relativeLuminance(a), y = relativeLuminance(b)
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

export function useColorTheme(): { colorTheme: ColorThemePreset; setColorTheme: (theme: ColorThemePreset) => void } {
    const [colorTheme, setColorThemeState] = useState<ColorThemePreset>(getStoredColorTheme)
    const [, refreshRegistry] = useState(0)

    useEffect(() => {
        if (!isBrowser()) return
        const onStorage = (event: StorageEvent) => {
            if (event.key !== COLOR_THEME_KEY) return
            const nextTheme = parseColorTheme(event.newValue)
            setColorThemeState(nextTheme)
            applyColorTheme(nextTheme, getDocumentColorScheme())
            window.dispatchEvent(new CustomEvent('hapi-color-theme-change', { detail: nextTheme }))
        }
        window.addEventListener('storage', onStorage)
        const onThemeChanged = () => { setColorThemeState(getStoredColorTheme()); refreshRegistry(value => value + 1) }
        window.addEventListener('hapi-color-theme-change', onThemeChanged)
        return () => { window.removeEventListener('storage', onStorage); window.removeEventListener('hapi-color-theme-change', onThemeChanged) }
    }, [])

    const setColorTheme = useCallback((theme: ColorThemePreset) => {
        setColorThemeState(theme)
        applyColorTheme(theme, getDocumentColorScheme())
        if (theme === 'default') {
            safeRemoveItem(COLOR_THEME_KEY)
        } else {
            safeSetItem(COLOR_THEME_KEY, theme)
        }
        window.dispatchEvent(new CustomEvent('hapi-color-theme-change', { detail: theme }))
    }, [])

    return { colorTheme, setColorTheme }
}

function mix(a: string, b: string, weight: number): string {
    const ca = parseHex(a)
    const cb = parseHex(b)
    const channel = (x: number, y: number) => Math.round(x * (1 - weight) + y * weight)
    return toHex(channel(ca.r, cb.r), channel(ca.g, cb.g), channel(ca.b, cb.b))
}

function withAlpha(hex: string, alpha: number): string {
    const color = parseHex(hex)
    return `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`
}

function compositeOnBackground(rgba: string, background: string): string {
    const match = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(rgba)
    if (!match) return rgba
    const base = parseHex(background)
    const alpha = Number(match[4])
    const blend = (foreground: number, behind: number) => Math.round(foreground * alpha + behind * (1 - alpha))
    return toHex(blend(Number(match[1]), base.r), blend(Number(match[2]), base.g), blend(Number(match[3]), base.b))
}

function readableText(hex: string): string {
    return relativeLuminance(hex) > 0.45 ? '#111827' : '#ffffff'
}

function relativeLuminance(hex: string): number {
    const { r, g, b } = parseHex(hex)
    const convert = (value: number) => {
        const next = value / 255
        return next <= 0.03928 ? next / 12.92 : ((next + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * convert(r) + 0.7152 * convert(g) + 0.0722 * convert(b)
}

function parseHex(hex: string): { r: number; g: number; b: number } {
    const clean = hex.replace('#', '')
    const value = clean.length === 3
        ? clean.split('').map((char) => `${char}${char}`).join('')
        : clean
    return {
        r: parseInt(value.slice(0, 2), 16),
        g: parseInt(value.slice(2, 4), 16),
        b: parseInt(value.slice(4, 6), 16),
    }
}

function toHex(r: number, g: number, b: number): string {
    return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`
}
