export interface HubTestConfig {
    port: number
    token: string
    tmpHome: string
    bunExec: string
    stubClaudePath?: string
}

declare module 'vitest' {
    export interface ProvidedContext {
        hapiTestConfig: HubTestConfig
    }
}
