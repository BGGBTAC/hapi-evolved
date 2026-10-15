# Installation und Betrieb

Diese Version ist eine eigenständige Linux-Neuinstallation. Sie verändert keine bestehende
HAPI-Instanz und importiert keine bisherigen Sitzungen, Konten oder Secrets. Voraussetzungen:
Docker mit Compose, Git und Bun 1.3.14. Für Codegraph außerhalb von Docker: Node 24.
Für den gesamten Dienstverbund einschließlich eines Runners etwa 12 GB RAM einplanen.

## Dienste initialisieren

```sh
bun install --frozen-lockfile
bun deploy/evolved/init.ts "$HOME/.local/share/hapi-evolved"
```

Der Initialisierer legt private Betreiberdateien außerhalb des Repositorys an. Wiederholtes
Ausführen erhält vorhandene Schlüssel. `compose.env` enthält ausschließlich Pfade und Einstellungen.
Vor der ersten Passkeyregistrierung `EVOLVED_ORIGIN` darin auf die endgültige private HTTPS-Adresse
setzen. WebAuthn bindet Passkeys an deren Domain. `http://localhost:3006` eignet sich für lokale Tests.
Den Hub über einen bestehenden privaten HTTPS-Reverse-Proxy erreichen; Compose veröffentlicht
ausschließlich `127.0.0.1:3006`. Es richtet weder DNS noch öffentliche Freigaben ein.

```sh
docker compose --env-file "$HOME/.local/share/hapi-evolved/compose.env" \
  -f deploy/evolved/compose.yml up -d --build
```

Im Browser die konfigurierte Adresse öffnen. Den einmaligen Einrichtungscode aus der privaten
Betreiberdatei `hub/bootstrap.token` lokal in das Formular übernehmen; ihn nicht in Chat, Logs
oder Tickets kopieren. Passkey registrieren, Recovery-Codes offline sichern, Team und Projekt
anlegen. Projektpfade liegen im Container unter `/workspaces/<verzeichnis>`; entsprechende
Quelldateien liegen auf dem Host unter `<EVOLVED_STATE_DIR>/workspaces/<verzeichnis>`.
Hub und Codegraph bekommen diese Quellen schreibgeschützt. Codegraph hält seinen eigenen
Quellenspiegel und Index im privaten Dienstverzeichnis, außerhalb der Agent-Workspaces.

Wird die erstmalige Registrierung unterbrochen, lässt sie sich innerhalb von zehn Minuten im
gleichen Browser fortsetzen. Nach Ablauf ohne fertig registrierten Erstnutzer darf der Betreiber
ausschließlich `hub/bootstrap.token` entfernen und den neuen Hub neu starten. So entsteht ein
neuer Einmalcode; die Datenbank bleibt erhalten. Es gibt keinen öffentlichen Reset-Endpunkt.

## Vault und Ressourcenaktionen

Der eigene Vault-Prozess speichert AES-256-GCM-verschlüsselte Werte und pro Projekt verpackte
Schlüssel. `credentials/vault/master.key` bleibt ausschließlich dort eingebunden. Der Hub signiert
Anfragen mit seinem getrennten Ed25519-Schlüssel. Browser können Werte anlegen/ersetzen/löschen;
kein Endpunkt gibt gespeicherte Klartextwerte zurück. Der Browser muss dafür frisch authentisiert sein.

Ressourcenaktionen legt der Betreiber in `credentials/vault/actions.json` fest, beispielsweise:

```json
[
  {
    "id": "service-health",
    "projectId": "PROJEKT-ID",
    "name": "Dienst prüfen",
    "profiles": ["workspace", "extended"],
    "type": "http",
    "url": "https://dienst.example/health",
    "method": "GET",
    "secretId": "SECRET-ID-AUS-DEM-KATALOG",
    "header": "Authorization",
    "prefix": "Bearer ",
    "expectedStatus": 200
  }
]
```

Danach nur den Vault-Dienst neu starten. Keine Secret-Werte gehören in diese Datei.
HTTP-Ziel, Methode und SSH-Befehl sind fest vorgegeben. SSH verlangt einen gepinnten
`knownHostsFile`, der separat nur in den Vault eingebunden wird, sowie den gespeicherten
SSH-Schlüssel. Die Standard-Hub/Vault-Image enthält OpenSSH. Ergebnisse enthalten ausschließlich
Status/Exitcode, keine HTTP-Antworttexte oder SSH-Ausgaben. Wiederholungen verwenden dieselbe
Idempotenz-ID; unklare Ergebnisse werden nicht automatisch erneut ausgeführt.

## Persistentes Memory und Codegraph

Lokale Quellen, Vorschläge, Verifikation und Volltextsuche funktionieren ohne Cloudkonfiguration.
Graphiti und Neo4j bilden den zusätzlichen Wissensgraphen. Der Wissensdienst bleibt zunächst pausiert.
Der Betreiber hinterlegt einen eigenen Provider-Key in `credentials/memory/provider.key`, setzt
die Modell-/Embeddingnamen und deren tatsächlich gültige Preise in `compose.env` und startet den
Memory-Dienst neu. Unterstützt wird zunächst der OpenAI-Endpunkt. Alle Variablen und Kostenregeln
stehen in [services/memory/README.md](../../services/memory/README.md).
Ein menschlicher Projektadmin aktiviert anschließend Cloudverarbeitung und Projektbudget im Browser.
Ohne diese Freigabe entstehen keine Modellaufrufe. Preise müssen bei Anbieteränderungen gepflegt werden.

Codegraph benötigt keinen Cloudanbieter. Er indexiert erlaubte Quelldateien automatisch und gleicht
Änderungen alle drei Sekunden ab. [Dienstkonfiguration](../../services/codegraph/README.md).
Dateilöschung und Rechteentzug werden vor Memory-Ergebnissen erneut geprüft. Löschung markiert alte
Graphgenerationen sofort als unzugänglich; die physische Bereinigung wird dauerhaft nachgeholt.

## Einen isolierten Projekt-Runner starten

Pro Projekt einen eigenen Compose-Stack und ein eigenes Runner-Home verwenden. Im Browser eine
zeitlich begrenzte Runner-Freigabe mit `runner:connect` und den gewünschten Memory-/Codegraph-/
Ressourcenrechten anlegen. Die einmalig ausgegebene Lease-Datei außerhalb aller Workspaces und
außerhalb des Runner-Homes mit Modus `0600` speichern. Sie wird ausschließlich in den Proxy gemountet.

Eine private Betreiberdatei `runner.env` enthält nur die folgenden Einstellungen. Die Vorprüfung
akzeptiert ausschließlich unquotierte `KEY=VALUE`-Zeilen, Leerzeilen und Kommentare. Keine
Leerzeichen in Werten, Quotes, `export`, Variablenersetzung oder Shellbefehle verwenden.

```dotenv
EVOLVED_UID=1000
EVOLVED_GID=1000
EVOLVED_PROJECT_ID=PROJEKT-ID
EVOLVED_PROJECT_DIRECTORY=projekt
EVOLVED_RUNNER_PROFILE=restricted
EVOLVED_WORKSPACE_MODE=ro
EVOLVED_RUNNER_WORKSPACE=/absolut/zum/statusverzeichnis/workspaces/projekt
EVOLVED_RUNNER_HOME=/absolut/zum/privaten/runner-home
EVOLVED_RUNNER_LEASE_FILE=/absolut/zur/privaten/lease
EVOLVED_BACKEND_NETWORK=hapi-evolved_backend
```

UID/GID entsprechen dem Besitzer der privaten Dateien. Runner-Home vorher mit Modus `0700`
anlegen. `restricted` verlangt einen schreibgeschützten Workspace und startet Claude in Plan-/
Codex in Read-only-Modus. `workspace` und `extended` erlauben bei explizitem `rw`-Mount Schreiben
im eigenen Projekt. Änderungen am Projektprofil verlangen eine neue Freigabe und passenden Neustart.

```sh
bun deploy/evolved/check-runner.ts /privater/pfad/runner.env
docker compose --env-file /privater/pfad/runner.env \
  -f deploy/evolved/runner.compose.yml up -d --build
```

Nur nach erfolgreicher Vorprüfung starten. Sie prüft Projekt-UUID, Verzeichnisnamen, Profil und
Mountmodus sowie die tatsächlichen Pfade, Besitzer und Rechte. Pfade ohne `.`-/`..`-Segmente
und ohne abschließenden Schrägstrich angeben. Workspace und Runner-Home müssen
getrennte Verzeichnisse sein; die Lease muss außerhalb beider liegen und darf weder Symlink noch
mehrfach verlinkt sein. Ihr Inhalt wird dabei nicht gelesen. Abweichende exportierte `EVOLVED_*`
Variablen vor beiden Befehlen entfernen, da Compose diese gegenüber `--env-file` bevorzugt.
Zwischen Prüfung und Start Konfiguration, Dateien und Verzeichnisse unverändert lassen.

Compose verwendet automatisch `hapi-evolved-runner-<Projekt-UUID>` als Stacknamen. **`-p` und
`COMPOSE_PROJECT_NAME` überschreiben diese Trennung.** Wer einen eigenen Namen setzt, muss ihn
für jedes Projekt eindeutig wählen und bei allen späteren Compose-Aufrufen identisch verwenden.
Die Wiederverwendung desselben Namens für verschiedene Projekte kann deren Container ersetzen
und ihre internen Projektnetze zusammenlegen. Im üblichen Ablauf beide Overrides weglassen.

Das Hauptimage muss zuvor gebaut sein. Native Agentversionen sind festgelegt:
Claude Code 2.1.285 und Codex 0.157.0. Der Betreiber meldet die gewünschten nativen CLIs im
Runner unter der **unprivilegierten UID/GID** an; deren eigene Provider-Anmeldung liegt im privaten
Runner-Home und ist für diesen Agenten lesbar. Dieses Login ist getrennt vom Evolved-Vault:
Vault-Master, Datenbankkennwörter und Hub-Lease sind dem Agentcontainer nicht zugänglich.
Bei OAuth-Login können weitere exakt benannte Providerhosts in `EVOLVED_EGRESS_HOSTS` nötig sein;
die Standardliste erlaubt ausschließlich die eingetragenen Claude-/OpenAI-HTTPS-Hosts.
Keine echten Provideranmeldungen oder kostenpflichtigen Agentläufe sind Teil der automatischen Abnahme.

Der Agentcontainer besitzt ausschließlich sein internes Projektnetz. Der Proxy hält die widerrufbare
Hub-Lease und erneuert kurzlebige Capabilities. Ein separater HTTPS-CONNECT-Proxy erlaubt nur
festgelegte öffentliche Modellhosts; private Adressen und DNS-Rebinding werden abgewiesen.
Root-PID 1 startet alle Agentprozesse unter der unprivilegierten UID und prüft laufend die aktuelle
Freigabe. Widerruf, Profiländerung, Ablauf oder Nichterreichbarkeit beendet den gesamten Container
nach dem nächsten Prüfzyklus (eine Sekunde plus höchstens zwei Sekunden Anfrage-Timeout).
Es gibt keine Docker-Socket-, Host-Netz- oder fremden Projekt-Mounts.

MCP-Werkzeuge für Codegraph, Memory und Ressourcen werden in Claude/Codex automatisch ergänzt.
Im Runner ist auch `bun /app/cli/src/index.ts evolved --help` verfügbar.

## Betrieb, Sicherung und Aktualisierung

`docker compose ... ps` und `logs --tail 100` prüfen ausschließlich diesen neuen Stack.
Der Hub bietet `/health`. Interne Dienste sind nicht öffentlich veröffentlicht. Vorschauen brauchen
standardmäßig Anmeldung; explizite Share-Links laufen spätestens nach 24 Stunden ab und bleiben
widerrufbar. Ihr Inhalt läuft in einer isolierten Browser-Sandbox ohne Kontocookies.

Für konsistente Sicherungen diesen Stack anhalten und Datenverzeichnisse **und** private Schlüssel
gemeinsam in ein verschlüsseltes Backup übernehmen. Ohne Vault-Master sind Vault-Daten nicht
wiederherstellbar. Backups benötigen eine eigene Aufbewahrungs-/Löschregel für entfernte Quellen.
Die laufenden Dienste verwenden private Dateien statt Geheimnissen in Compose-Umgebungsvariablen.
Hostroot und der Betriebssystembenutzer bleiben Teil der Vertrauensgrenze.

Aktualisierungen auf einem Branch prüfen, Images neu bauen, ausschließlich diese Compose-Stacks
neu erstellen. Bei Änderungen der Agentversionen auch das Runnerimage neu bauen. Für Rücknahme
die vorherigen Images und eine dazu passende Datensicherung verwenden; ältere Upstream-Programme
dürfen nicht gegen Evolved-Datenbanken gestartet werden.
