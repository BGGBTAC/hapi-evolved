import { Github, Menu, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ModeToggle } from './ModeToggle'
import { LanguageToggle } from './LanguageToggle'

const repository = 'https://github.com/BGGBTAC/hapi-evolved'

export function Layout({ children }: { children: ReactNode }) {
    const { t } = useTranslation()
    const [isMenuOpen, setIsMenuOpen] = useState(false)
    return (
        <div className="flex min-h-screen flex-col bg-background font-sans text-foreground">
            <a href="#main-content" className="sr-only focus:not-sr-only focus:p-3">{t('nav.skip')}</a>
            <header className="sticky top-0 z-50 border-b border-border bg-background/95 backdrop-blur-lg">
                <div className="container flex h-18 items-center justify-between gap-3">
                    <a href="/" className="flex items-center gap-2 font-bold tracking-tight"><img src="/evolved-mark.svg" width="28" height="28" alt="" /><span className="text-sm sm:text-xl">HAPI-eVolved</span></a>
                    <nav aria-label={t('nav.main')} className="hidden items-center gap-6 text-sm md:flex">
                        <a href="/#features" className="hover:text-primary">{t('nav.features')}</a>
                        <a href="/#origins" className="hover:text-primary">{t('nav.origins')}</a>
                        <a href={`${repository}/blob/main/docs/evolved/QUICKSTART.md`} className="hover:text-primary">{t('nav.docs')}</a>
                    </nav>
                    <div className="flex items-center gap-2">
                        <LanguageToggle /><ModeToggle />
                        <Button variant="outline" size="icon" asChild className="hidden md:inline-flex"><a href={repository} aria-label={t('nav.source')}><Github aria-hidden="true" /></a></Button>
                        <Button variant="ghost" size="icon" className="h-9 w-9 md:hidden" aria-label={t('nav.menu')} aria-expanded={isMenuOpen} aria-controls="mobile-navigation" onClick={() => setIsMenuOpen(!isMenuOpen)}>{isMenuOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}</Button>
                    </div>
                </div>
                {isMenuOpen && <nav id="mobile-navigation" aria-label={t('nav.main')} className="container grid gap-4 border-t border-border py-5 text-sm md:hidden" onClick={() => setIsMenuOpen(false)}>
                    <a href="/#features">{t('nav.features')}</a><a href="/#origins">{t('nav.origins')}</a><a href={`${repository}/blob/main/docs/evolved/QUICKSTART.md`}>{t('nav.docs')}</a><a href={repository}>{t('nav.source')}</a>
                </nav>}
            </header>
            <main id="main-content" className="flex-1">{children}</main>
            <footer className="border-t border-border py-10">
                <div className="container flex flex-col justify-between gap-8 md:flex-row">
                    <div><p className="font-bold">HAPI-eVolved</p><p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">{t('footer.description')}</p></div>
                    <div className="flex flex-wrap gap-x-6 gap-y-3 text-sm">
                        <a href={repository}>{t('nav.source')}</a><a href={`${repository}/issues`}>{t('footer.issues')}</a><a href={`${repository}/blob/main/LICENSE`}>AGPL-3.0-only</a><a href="https://github.com/tiann/hapi">{t('footer.upstream')}</a>
                    </div>
                </div>
            </footer>
        </div>
    )
}
