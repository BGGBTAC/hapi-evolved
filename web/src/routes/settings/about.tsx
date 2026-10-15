import { PROTOCOL_VERSION } from '@hapi/protocol'
import { useTranslation } from '@/lib/use-translation'
import { SettingsPageContent, SettingsRow, SettingsSection } from '@/components/settings/SettingsPrimitives'

const repository = 'https://github.com/BGGBTAC/hapi-evolved'
const linkClass = 'text-[var(--app-link)] hover:underline'

export default function SettingsAboutPage() {
    const { t } = useTranslation()
    return (
        <SettingsPageContent description={t('settings.about.description')}>
            <SettingsSection title="HAPI-eVolved" description={t('settings.about.mission')}>
                <SettingsRow label={t('settings.about.website')} trailing={<a href={repository} target="_blank" rel="noopener noreferrer" className={linkClass}>GitHub</a>} />
                <SettingsRow label={t('settings.about.documentation')} trailing={<a href={`${repository}/blob/main/docs/evolved/QUICKSTART.md`} target="_blank" rel="noopener noreferrer" className={linkClass}>Quick start</a>} />
                <SettingsRow label={t('settings.about.upstream')} trailing={<a href="https://github.com/tiann/hapi" target="_blank" rel="noopener noreferrer" className={linkClass}>tiann/hapi</a>} />
                <SettingsRow label={t('settings.about.license')} trailing={<a href={`${repository}/blob/main/NOTICE`} target="_blank" rel="noopener noreferrer" className={linkClass}>AGPL-3.0-only</a>} />
                <SettingsRow label={t('settings.about.appVersion')} trailing={<span className="text-[var(--app-hint)]">{__APP_VERSION__}</span>} />
                <SettingsRow label={t('settings.about.protocolVersion')} trailing={<span className="text-[var(--app-hint)]">{PROTOCOL_VERSION}</span>} />
            </SettingsSection>
        </SettingsPageContent>
    )
}
