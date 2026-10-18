import { DEVELOPMENT_PACKS } from './developmentPacks'
import type { DevelopmentAppliesToSchema, SpecializedDevelopmentMode } from './evolvedDevelopment'
import type { DevelopmentModuleCondition, DevelopmentModuleView } from './developmentModules'
import type { z } from 'zod'

/**
 * The bundled Odoo/iOS/Android packs expressed in the generic module view, so the
 * registry, catalog, applicability filter and task resolution treat them exactly
 * like plugin modules. Their settings stay the reviewed typed v1 sections
 * (`form.kind = 'builtin'`), and their doctor/inspect providers are the
 * existing v1 runner implementations.
 */

function condition(appliesTo: z.infer<typeof DevelopmentAppliesToSchema>): DevelopmentModuleCondition | null {
    return appliesTo.odooMajors?.length ? { field: 'major', in: [...appliesTo.odooMajors] } : null
}
const views = new Map<SpecializedDevelopmentMode, DevelopmentModuleView>()
export function builtinDevelopmentModuleView(mode: SpecializedDevelopmentMode): DevelopmentModuleView {
    const cached = views.get(mode)
    if (cached) return cached
    const pack = DEVELOPMENT_PACKS[mode], provider = { id: `builtin.${mode}`, version: 1 }
    const view: DevelopmentModuleView = {
        title: pack.title, summary: pack.summary, contentVersion: pack.version, brief: [...pack.brief], constraints: [...pack.constraints],
        form: { kind: 'builtin', renderer: mode },
        topics: pack.topics.map(({ appliesTo, ...topic }) => ({ ...topic, tags: [...topic.tags], sources: topic.sources.map(source => ({ ...source })), when: condition(appliesTo) })),
        recipes: pack.recipes.map(({ appliesTo, ...recipe }) => ({ ...structuredClone(recipe), when: condition(appliesTo) })),
        tasks: pack.tasks.map(({ appliesTo, ...task }) => ({ ...structuredClone(task), when: condition(appliesTo) })),
        doctor: { provider, checks: pack.doctorChecks.map(({ appliesTo, ...check }) => ({ ...check, when: condition(appliesTo) })) },
        inspect: { provider, directoryField: null },
        integrations: pack.integrations.map(spec => ({ ...structuredClone(spec), provider: spec.kind === 'live_read' && spec.id === 'github-status' ? 'github.commit-status' as const : null, links: [] })),
    }
    views.set(mode, Object.freeze(view) as DevelopmentModuleView)
    return view
}
