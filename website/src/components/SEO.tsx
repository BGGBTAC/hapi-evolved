import { Helmet } from 'react-helmet-async'
import { useTranslation } from 'react-i18next'

interface SEOProps {
    title?: string
    description?: string
}

export function SEO({ title, description }: SEOProps) {
    const { t, i18n } = useTranslation()
    const language = i18n.language.startsWith('zh') ? 'zh' : 'en'
    const pageTitle = title ? `${title} | HAPI-eVolved` : t('seo.title')
    const pageDescription = description || t('seo.description')
    // This source preview has no dedicated public website yet. Do not claim a
    // canonical domain, hosted service, release version or vendor affiliation.
    return (
        <Helmet>
            <html lang={language} />
            <title>{pageTitle}</title>
            <meta name="description" content={pageDescription} />
            <meta property="og:type" content="website" />
            <meta property="og:title" content={pageTitle} />
            <meta property="og:description" content={pageDescription} />
            <meta property="og:site_name" content="HAPI-eVolved" />
            <meta property="og:locale" content={language === 'zh' ? 'zh_CN' : 'en_US'} />
            <meta name="twitter:card" content="summary" />
            <meta name="twitter:title" content={pageTitle} />
            <meta name="twitter:description" content={pageDescription} />
        </Helmet>
    )
}
