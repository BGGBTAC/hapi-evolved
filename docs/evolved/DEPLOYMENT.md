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
  -f deploy/evolved/compose.yml build hub
docker compose --env-file "$HOME/.local/share/hapi-evolved/compose.env" \
  -f deploy/evolved/compose.yml up -d --build
```

Im Browser die konfigurierte Adresse öffnen. Den einmaligen Einrichtungscode aus der privaten
Betreiberdatei `hub/bootstrap.token` lokal in das Formular übernehmen; ihn nicht in Chat, Logs
oder Tickets kopieren. Passkey registrieren, Recovery-Codes offline sichern, Team und Projekt
anlegen. Neue Projekte bekommen automatisch einen eigenen Ordner unter
`/managed-workspaces/<Projekt-UUID>`; auf dem Host liegt er unter
`<EVOLVED_STATE_DIR>/managed-workspaces/<Projekt-UUID>`. Nur dieser getrennte Bereich
ist für den Hub beschreibbar, damit er Verzeichnisse anlegen kann. Codegraph liest
ihn weiterhin ausschließlich. `EVOLVED_MANAGED_WORKSPACE_ROOT` legt den verwalteten
Root fest; bei nativen Installationen ist der Standard `project-workspaces` im
Hub-Datenverzeichnis. Verzeichnisse müssen privat sein und dem Hub-Benutzer gehören.
Hub, Codegraph und Runner verwenden für diese privaten Ordner dieselbe konfigurierte
UID/GID; ein abweichender Runnerbenutzer kann die Ordner mit Modus 0700 nicht öffnen.

Manuell verknüpfte Quellen liegen im Compose-Container unter `/workspaces/<verzeichnis>`,
auf dem Host unter `<EVOLVED_STATE_DIR>/workspaces/<verzeichnis>`. Hub und Codegraph
bekommen diesen bestehenden Bereich weiterhin schreibgeschützt. Manuelles Verknüpfen
verlangt Systemadminrechte und einen frischen Passkey; überlappende Projektpfade sind
gesperrt. Projektlöschung entfernt keine Quellverzeichnisse. Codegraph hält seinen eigenen
Quellenspiegel und Index im privaten Dienstverzeichnis, außerhalb der Agent-Workspaces.

Wird die erstmalige Registrierung unterbrochen, lässt sie sich innerhalb von zehn Minuten im
gleichen Browser fortsetzen. Nach Ablauf ohne fertig registrierten Erstnutzer darf der Betreiber
ausschließlich `hub/bootstrap.token` entfernen und den neuen Hub neu starten. So entsteht ein
neuer Einmalcode; die Datenbank bleibt erhalten. Es gibt keinen öffentlichen Reset-Endpunkt.

Vor der menschlichen Ersteinrichtung lässt sich ein separater synthetischer Teststand
mit der [HTTPS-Live-Abnahme](LIVE_ACCEPTANCE.md) einschließlich Passkey, Vault, Memory,
Codegraph, Vorschau-Sandbox, Persistenz und Runner-Widerruf prüfen.

## Vault und Ressourcenaktionen

Der eigene Vault-Prozess speichert AES-256-GCM-verschlüsselte Werte und pro Projekt verpackte
Schlüssel. `credentials/vault/master.key` bleibt ausschließlich dort eingebunden. Der Hub signiert
Anfragen mit seinem getrennten Ed25519-Schlüssel. Browser können Werte anlegen/ersetzen/löschen;
kein Endpunkt gibt gespeicherte Klartextwerte zurück. Der Browser muss dafür frisch authentisiert sein.

Bei nativem Betrieb ohne Container braucht der Vault einen eigenen Dienstbenutzer und ein
privates Zustandsverzeichnis außerhalb aller manuellen und verwalteten Projektordner.
Vault-Datenbank und Masterkey dürfen weder im Hub-Zustandsverzeichnis noch in einem
Runner-Home liegen. Der Hub erhält nur seinen Signaturschlüssel, nicht den Vault-Masterkey.
Die Compose-Installation stellt diese Dateigrenze durch getrennte Mounts her.

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
stehen in [services/memory/README.md](https://github.com/BGGBTAC/hapi-evolved/blob/main/services/memory/README.md).
Ein menschlicher Projektadmin aktiviert anschließend Cloudverarbeitung und Projektbudget im Browser.
Ohne diese Freigabe entstehen keine Modellaufrufe. Preise müssen bei Anbieteränderungen gepflegt werden.

Codegraph benötigt keinen Cloudanbieter. Er indexiert erlaubte Quelldateien automatisch und gleicht
Änderungen alle drei Sekunden ab. [Dienstkonfiguration](https://github.com/BGGBTAC/hapi-evolved/blob/main/services/codegraph/README.md).
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

Der Container hält einen Kernel-Lock für sein dediziertes Runner-Home. Nach einem Wechsel
des Linux-Boots oder PID-Namespace bereinigt sein Startprozess ausschließlich die veralteten
Runner-State-/PID-Lockdateien; Maschinen-ID, Einstellungen und Resume-Daten bleiben erhalten.
Beim Upgrade einer älteren Runner-Version den alten Projektcontainer zuerst vollständig stoppen,
bevor die neue Version dasselbe Home verwendet: Ein alter Prozess ohne diesen Kernel-Lock wird
durch den neuen Lock nicht nachträglich ausgeschlossen. Ein Runner-Home nie parallel zwischen
alten und neuen Containern teilen. Der neue Start folgt keinen Symlinks und verweigert unklare
Metadaten, statt private Dateien pauschal zu löschen.

MCP-Werkzeuge für Codegraph, Memory und Ressourcen werden in Claude/Codex automatisch ergänzt.
Im Runner ist auch `bun /app/cli/src/index.ts evolved --help` verfügbar.

Für automatisch verwaltete Projekte in `runner.env` zusätzlich
`EVOLVED_WORKSPACE_PREFIX=/managed-workspaces` setzen und als
`EVOLVED_PROJECT_DIRECTORY` exakt die Projekt-UUID verwenden. Der resultierende
Containerpfad muss dem im Browser angezeigten Projektpfad entsprechen, beispielsweise
`/managed-workspaces/12345678-1234-4234-8234-123456789abc`. Den entsprechenden privaten
Hostpfad als `EVOLVED_RUNNER_WORKSPACE` einsetzen; der Runner darf nicht unter einem
abweichenden Alias arbeiten. Für bisherige manuelle Projekte bleibt der Standard
`/workspaces/<EVOLVED_PROJECT_DIRECTORY>` erhalten. Die Vorprüfung lehnt falsche Pfade ab.

Die [GitHub-Anbindung](GITHUB.md) ist in den Runner integriert. Neue Leases enthalten
standardmäßig `git:read`, schreibfähige Profile zusätzlich `git:write`; die konkrete
Repositoryfreigabe erfolgt separat durch einen Projektadministrator. Bereits ausgegebene
Leases erhalten keine zusätzlichen Rechte: bei Bedarf widerrufen und neu erstellen.
Profil- und Rollenänderungen widerrufen die alten Leases dauerhaft.

Beim Upgrade auf automatische Workspaces den Initialisierer erneut als ursprünglicher
Betreiberbenutzer ausführen; bestehende Schlüssel bleiben erhalten. Er legt den neuen
privaten Workspacebereich an. Anschließend Haupt- und Runnerimages aus demselben Commit
neu bauen und die zugehörigen Compose-Dateien verwenden. Bestehende Projektpfade und
Benutzerdaten nicht umschreiben. Die neue Funktion erzeugt Verzeichnisse für neue Projekte.
Bei nativer Installation zusätzlich den tatsächlichen verwalteten Root in die
`EVOLVED_CODE_ROOTS`-Liste des Codegraphdiensts aufnehmen; Compose enthält bereits
beide Pfade. Fehlende, unzureichend private oder über Symlinks konfigurierte
Workspace-Roots führen zu einem Startfehler, statt die Pfadgrenze aufzuweichen.

### Isolierte VM-Abnahme ohne Provideranmeldung

Für ein eigens angelegtes Testprojekt ein neues, leeres Runner-Home und eine kurzlebige
`restricted`-Freigabe mit `runner:connect` verwenden. Die private `runner.env` erhält Modus
`0600` und die zusätzliche Kommentarzeile `# HAPI_EVOLVED_RUNNER_VALIDATION=<Projekt-UUID>`.
Als separates Backend ist ausschließlich `EVOLVED_BACKEND_NETWORK=hapi-evolved-acceptance_backend`
zulässig. Das Skript prüft dessen Compose-Eigentümer und internes Netzwerk.
Haupt- und Runnerimage müssen bereits gebaut sein.

```sh
bun deploy/evolved/validate-runner-vm.mjs /privater/pfad/runner.env --start
```

Das Skript verwendet ausschließlich den Stacknamen `hapi-evolved-validation-<Projekt-UUID>`
und markiert dessen drei Container. Es baut keine Images, ersetzt keine vorhandenen Container
und verweigert unmarkierte oder abweichend konfigurierte Stacks. Ohne `--start` prüft es nur
den bereits gestarteten Teststack. Docker muss lokal über einen Unixsocket erreichbar sein;
bei Bedarf verwendet das Skript `sudo -n docker`.

Die Abnahme prüft aktive Hubregistrierung, unprivilegierte Runnerprozesse ohne Linux-Capabilities,
einen tatsächlich schreibgeschützten Workspace, getrennte Netze und Mounts ohne Docker-Socket
oder Lease im Runner sowie gesperrte private Egressziele und Verwaltungs-API. Vor der ersten
aktiven Runnerprobe muss die Container-Generation mindestens fünf Sekunden passiv beobachtet
stabil laufen; so kann die Probe keinen PID-Wiederverwendungsfehler beim Start verdecken. Der Bericht enthält
nur IDs und Prüfergebnisse. Providerlogin, Build, Stop und Widerruf bleiben separate Betreiberschritte;
der Teststack bleibt zur anschließenden Widerrufsprüfung bestehen.
Für den echten VM-Neustarttest bleibt dessen Wiederstartregel aktiv. Unmittelbar nach dem
nachgewiesenen Lease-Widerruf den exakt benannten Teststack kontrolliert herunterfahren:
Andernfalls versucht Docker nach Lease-Ablauf oder Widerruf wiederholt, den abgewiesenen
Runner neu zu starten. Vor Aktivierung des finalen Hauptstacks auch den Abnahmestack entfernen.

## Betrieb, Sicherung und Aktualisierung

`docker compose ... ps` und `logs --tail 100` prüfen ausschließlich diesen neuen Stack.
Der Hub bietet `/health`. Interne Dienste sind nicht öffentlich veröffentlicht. Vorschauen brauchen
standardmäßig Anmeldung; explizite Share-Links laufen spätestens nach 24 Stunden ab und bleiben
widerrufbar. Ihr Inhalt läuft in einer isolierten Browser-Sandbox ohne Kontocookies.

Für konsistente Sicherungen diesen Stack anhalten und Datenverzeichnisse **und** private Schlüssel
gemeinsam in ein verschlüsseltes Backup übernehmen. Ohne Vault-Master sind Vault-Daten nicht
wiederherstellbar. Backups benötigen eine eigene Aufbewahrungs-/Löschregel für entfernte Quellen.
`hapi.db` (einschließlich des zugehörigen WAL-/SHM-Zustands, falls vorhanden) und das
komplette Anhangsverzeichnis müssen aus **demselben gestoppten Stand** stammen. Im
Compose-Hub sind die Laufzeitpfade `/data/hapi.db` und `/data/attachments`; der
Host-Mount ist `${EVOLVED_STATE_DIR}/hub`. Die Datenbank speichert absolute
Anhangspfade. Beim Restore dieselben absoluten Laufzeitpfade wiederherstellen;
ein anderer Hostpfad ist nur bei unverändertem Container-Mount `/data` möglich.
Keinen laufenden Hub, Runner oder anderen Schreiber während Backup/Restore benutzen.

Vor dem ersten Hubstart im wiederhergestellten Linux-Container zuerst prüfen,
dann die Notification-Epoche rotieren (hier aus dem Projektverzeichnis):

```sh
docker compose -p hapi-evolved --env-file /absolut/evolved/compose.env -f deploy/evolved/compose.yml run --rm --no-deps hub bun hub/scripts/check-restored-attachments.ts /data/hapi.db /data/attachments
docker compose -p hapi-evolved --env-file /absolut/evolved/compose.env -f deploy/evolved/compose.yml run --rm --no-deps hub bun hub/scripts/invalidate-restored-notifications.ts /data/hapi.db
```

Projektname und Betreiberdatei müssen zum wiederhergestellten Stack gehören. Für die separate
Abnahme stattdessen `-p hapi-evolved-acceptance` und deren eigene `compose.env` verwenden.

Erst bei erfolgreicher Prüfung und Rotation den Stack starten. Der Prüfer öffnet
SQLite nur lesend, führt keine Migration/Reparatur/Löschung aus und folgt weder
Symlinks noch Pfaden außerhalb des verankerten Anhangsverzeichnisses. Er meldet
fehlende Dateien, Größen-/SHA-256-Abweichungen, ungültige Pfade sowie verwaiste
Dateien mit exakten Zählern und höchstens 100 Beispielen. Offene Löschjournalzeilen
werden als erwarteter Cleanup ausgewiesen. Exitcode 0 bedeutet konsistent,
1 Integritätsbefunde und 2 ungültige Eingabe/Prüffehler. Bei Befunden die passende
vollständige Sicherung wiederherstellen; keine automatische Löschbereinigung ausführen.

Die laufenden Dienste verwenden private Dateien statt Geheimnissen in Compose-Umgebungsvariablen.
Hostroot und der Betriebssystembenutzer bleiben Teil der Vertrauensgrenze.

Aktualisierungen auf einem Branch prüfen, Images neu bauen, ausschließlich diese Compose-Stacks
neu erstellen. Bei Änderungen der Agentversionen auch das Runnerimage neu bauen. Für Rücknahme
die vorherigen Images und eine dazu passende Datensicherung verwenden; ältere Upstream-Programme
dürfen nicht gegen Evolved-Datenbanken gestartet werden.
