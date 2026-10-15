import { Panel } from './ui'

const operatorShell = `RUNNER_ENV=/privater/pfad/runner.env
RUNNER_UID=1000
RUNNER_GID=1000

docker compose --env-file "$RUNNER_ENV" \\
  -f deploy/evolved/runner.compose.yml exec \\
  --user "$RUNNER_UID:$RUNNER_GID" \\
  -e HOME=/runner \\
  -e CLAUDE_CONFIG_DIR=/runner/claude \\
  -e CODEX_HOME=/runner/codex \\
  --workdir /runner runner sh`

function Commands({ children }: { children: string }) {
    return <pre className="whitespace-pre-wrap break-words rounded-lg border p-3 text-sm"><code>{children}</code></pre>
}

export function ProviderLoginPanel() {
    return <Panel title="Abos verbinden" description="Nutze dein Claude- oder ChatGPT-Abo mit den Agenten auf deinem Runner.">
        <div className="ev-stack">
            <p>Die Anmeldung erfolgt derzeit im Terminal des jeweiligen Runners. HAPI-eVolved bietet dafür noch keinen direkten Browser-Login. Ein Betreiber mit Serverzugang führt die folgenden Schritte aus; die Anmeldung beim Anbieter bestätigst du in deinem eigenen Browser.</p>
            <p role="status" className="ev-muted">Anmeldestatus hier nicht geprüft. Ein verbundener Runner oder eine Kapazitätsanzeige bestätigt keine gültige Anbieteranmeldung.</p>
            <div className="ev-form-grid">
                <section aria-labelledby="provider-codex-title">
                    <h3 id="provider-codex-title">Codex · ChatGPT-Abo</h3>
                    <p>Im Runner-Terminal anmelden und anschließend den lokalen Status prüfen:</p>
                    <Commands>{'codex login --device-auth\ncodex login status'}</Commands>
                    <p>Öffne die angezeigte Anbieteradresse in deinem Browser und gib dort den Gerätecode ein. Falls gesperrt, muss die Geräteanmeldung in den ChatGPT-Sicherheitseinstellungen oder durch den Workspace-Administrator freigegeben werden.</p>
                    <a className="inline-flex min-h-11 items-center underline" href="https://learn.chatgpt.com/docs/auth#login-on-headless-devices" target="_blank" rel="noopener noreferrer">Offizielle Codex-Anmeldehilfe</a>
                </section>
                <section aria-labelledby="provider-claude-title">
                    <h3 id="provider-claude-title">Claude · Claude-Abo</h3>
                    <p>Im Runner-Terminal ausdrücklich mit dem Claude-Abo anmelden:</p>
                    <Commands>{'claude auth login --claudeai\nclaude auth status --text'}</Commands>
                    <p>Öffne die angezeigte Anmeldeadresse in deinem Browser. Zeigt der Anbieter einen Rückgabecode, füge ihn nur in die zugehörige Aufforderung dieses Terminals ein.</p>
                    <a className="inline-flex min-h-11 items-center underline" href="https://code.claude.com/docs/en/authentication" target="_blank" rel="noopener noreferrer">Offizielle Claude-Anmeldehilfe</a>
                </section>
            </div>
            <details>
                <summary className="min-h-11 cursor-pointer py-3 font-medium">Docker-Anleitung für Betreiber</summary>
                <div className="ev-stack">
                    <p>Auf dem Runner-Server im Repository-Verzeichnis ausführen. Der Projekt-Runner muss bereits mit gültigem Runner-Zugang laufen. Ersetze den Dateipfad und die Beispielwerte 1000 durch die tatsächlichen Werte für <code>EVOLVED_UID</code> und <code>EVOLVED_GID</code> aus seiner Konfiguration.</p>
                    <Commands>{operatorShell}</Commands>
                    <p>Nutze dieselbe Compose-Konfiguration wie beim Start. Wurde ein eigener Projektname mit <code>-p</code> verwendet, ergänze ihn auch hier. Falls Docker es erfordert, führe den Docker-Befehl mit <code>sudo</code> aus; die Anmeldung im Container bleibt durch <code>--user</code> unprivilegiert.</p>
                    <p>In dieser Shell führst du die gewünschten Anbieterbefehle oben aus. Beende sie anschließend mit <code>exit</code> und starte eine neue Agentensitzung. Bei Netzwerkfehlern prüft der Betreiber die erlaubten Anbieterhosts des Runners.</p>
                </div>
            </details>
            <p className="ev-muted">Anmeldedaten bleiben im privaten Home dieses Runners und sind für seine Agenten verfügbar. Andere Runner werden separat angemeldet. Gib hier keine Passwörter, API-Schlüssel oder Anmeldecodes ein. Dein HAPI-Passkey und der Runner-Zugang ersetzen kein Anbieterabo; der Anbieter entscheidet über dessen Berechtigungen und Kontingent.</p>
        </div>
    </Panel>
}
