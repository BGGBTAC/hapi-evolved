import { ArrowRight, Bot, Braces, FolderGit2, Github, KeyRound, Network, Puzzle, Smartphone } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Layout } from '@/components/Layout'
import { SEO } from '@/components/SEO'

const repository = 'https://github.com/BGGBTAC/hapi-evolved'
const quickstart = `${repository}/blob/main/docs/evolved/QUICKSTART.md`
const features = [
    { key: 'projects', icon: FolderGit2 },
    { key: 'providers', icon: Bot },
    { key: 'vault', icon: KeyRound },
    { key: 'github', icon: Github },
    { key: 'memory', icon: Network },
    { key: 'codegraph', icon: Braces },
    { key: 'extensions', icon: Puzzle },
    { key: 'interface', icon: Smartphone },
] as const

export default function Home() {
    const { t } = useTranslation()
    return (
        <Layout>
            <SEO />
            <section className="container grid items-center gap-12 py-16 lg:grid-cols-[1.2fr_1fr] lg:py-24">
                <div>
                    <span className="inline-flex rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-sm font-semibold text-primary">{t('hero.preview')}</span>
                    <h1 className="mt-6 max-w-3xl text-4xl leading-tight sm:text-5xl lg:text-6xl">
                        {t('hero.title')}<br /><span className="text-primary">{t('hero.highlight')}</span>
                    </h1>
                    <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground">{t('hero.description')}</p>
                    <div className="mt-8 flex flex-wrap gap-3">
                        <Button size="lg" asChild><a href={quickstart}>{t('nav.getStarted')}<ArrowRight aria-hidden="true" /></a></Button>
                        <Button size="lg" variant="outline" asChild><a href={repository}><Github aria-hidden="true" />{t('nav.source')}</a></Button>
                    </div>
                    <p className="mt-5 text-sm text-muted-foreground">{t('hero.note')}</p>
                </div>
                <div className="rounded-3xl border border-border bg-card p-7 shadow-xl shadow-primary/5 sm:p-10">
                    <div className="flex items-center gap-4">
                        <img src="/evolved-mark.svg" width="56" height="56" alt="" />
                        <div><p className="text-2xl font-bold">HAPI-eVolved</p><p className="mt-1 text-sm text-muted-foreground">{t('hero.panelSubtitle')}</p></div>
                    </div>
                    <div className="my-8 h-px bg-border" />
                    <p className="text-xs font-semibold uppercase tracking-widest text-primary">{t('hero.panelLabel')}</p>
                    <ul className="mt-5 space-y-5">
                        {['workspace', 'knowledge', 'control'].map((key, index) => (
                            <li key={key} className="flex items-start gap-4">
                                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 font-mono text-sm text-primary">0{index + 1}</span>
                                <div><p className="font-semibold">{t(`hero.${key}.title`)}</p><p className="mt-1 text-sm leading-relaxed text-muted-foreground">{t(`hero.${key}.description`)}</p></div>
                            </li>
                        ))}
                    </ul>
                </div>
            </section>

            <section id="features" className="scroll-mt-24 border-y border-border bg-muted/30 py-16 lg:py-24">
                <div className="container">
                    <p className="text-sm font-semibold uppercase tracking-widest text-primary">{t('features.eyebrow')}</p>
                    <h2 className="mt-3 text-3xl sm:text-4xl">{t('features.title')}</h2>
                    <p className="mt-4 max-w-2xl leading-relaxed text-muted-foreground">{t('features.description')}</p>
                    <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
                        {features.map(({ key, icon: Icon }) => (
                            <article key={key} className="rounded-2xl border border-border bg-card p-6">
                                <Icon className="h-6 w-6 text-primary" aria-hidden="true" />
                                <h3 className="mt-5 text-lg">{t(`features.${key}.title`)}</h3>
                                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{t(`features.${key}.description`)}</p>
                            </article>
                        ))}
                    </div>
                </div>
            </section>

            <section id="get-started" className="container scroll-mt-24 py-16 lg:py-24">
                <div className="grid grid-cols-1 gap-12 lg:grid-cols-2">
                    <div>
                        <p className="text-sm font-semibold uppercase tracking-widest text-primary">{t('setup.eyebrow')}</p>
                        <h2 className="mt-3 text-3xl sm:text-4xl">{t('setup.title')}</h2>
                        <p className="mt-4 leading-relaxed text-muted-foreground">{t('setup.description')}</p>
                        <ol className="mt-7 space-y-6">
                            {['build', 'configure', 'work'].map((key, index) => (
                                <li key={key} className="flex gap-4"><span className="font-mono text-primary">{index + 1}.</span><div><h3>{t(`setup.${key}.title`)}</h3><p className="mt-1 text-sm leading-relaxed text-muted-foreground">{t(`setup.${key}.description`)}</p></div></li>
                            ))}
                        </ol>
                    </div>
                    <div className="min-w-0 self-start rounded-2xl border border-border bg-card p-6 sm:p-8">
                        <h3 className="text-xl">{t('setup.sourceTitle')}</h3>
                        <p className="mt-3 leading-relaxed text-muted-foreground">{t('setup.sourceDescription')}</p>
                        <pre className="my-6 overflow-x-auto rounded-xl bg-muted p-4 text-sm"><code>git clone https://github.com/BGGBTAC/hapi-evolved.git</code></pre>
                        <Button asChild className="h-auto whitespace-normal py-3 text-center"><a href={quickstart}>{t('setup.guide')}<ArrowRight className="shrink-0" aria-hidden="true" /></a></Button>
                        <p className="mt-5 text-sm leading-relaxed text-muted-foreground">{t('setup.requirements')}</p>
                    </div>
                </div>
            </section>

            <section id="origins" className="scroll-mt-24 border-t border-border bg-muted/30 py-16">
                <div className="container grid gap-8 lg:grid-cols-[1fr_2fr]">
                    <h2 className="text-3xl">{t('origins.title')}</h2>
                    <div className="space-y-4 leading-relaxed text-muted-foreground">
                        <p>{t('origins.description')} <a className="font-semibold text-primary underline underline-offset-4" href="https://github.com/tiann/hapi">tiann/hapi</a>.</p>
                        <p>{t('origins.mission')}</p>
                        <p>{t('origins.independence')}</p>
                        <a className="inline-flex items-center gap-2 font-semibold text-primary underline underline-offset-4" href={`${repository}/blob/main/NOTICE`}>{t('origins.credits')}<ArrowRight size={16} aria-hidden="true" /></a>
                    </div>
                </div>
            </section>
        </Layout>
    )
}
