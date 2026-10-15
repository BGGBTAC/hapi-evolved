# Claude- und Codex-Abos verbinden

Unter **Abos verbinden** und im Bereich **Runner** findest du die Anmeldeschritte.
HAPI-eVolved hat derzeit keinen eigenen Browser-Login für diese Anbieter. Die
nativen CLIs melden sich im privaten Home des jeweiligen Runners an. Dafür brauchst
du einen Betreiber mit Terminalzugang zum Runner-Server; die Anbieteranmeldung
bestätigst du in deinem eigenen Browser. Ein HAPI-Passkey oder Runner-Zugang meldet
dich nicht bei Claude oder ChatGPT an.

## Terminal des richtigen Runners öffnen

Der Projekt-Runner muss gemäß [Deployment-Anleitung](DEPLOYMENT.md) bereits laufen
und einen gültigen Runner-Zugang besitzen. Auf seinem Server, im Verzeichnis der
HAPI-eVolved-Arbeitskopie, öffnest du folgende Shell. Ersetze den Dateipfad und die
Beispielwerte `1000` durch `EVOLVED_UID` und `EVOLVED_GID` aus der tatsächlichen
Runner-Konfiguration. Führe die Konfigurationsdatei nicht als Shellskript aus.

```bash
RUNNER_ENV=/privater/pfad/runner.env
RUNNER_UID=1000
RUNNER_GID=1000

docker compose --env-file "$RUNNER_ENV" \
  -f deploy/evolved/runner.compose.yml exec \
  --user "$RUNNER_UID:$RUNNER_GID" \
  -e HOME=/runner \
  -e CLAUDE_CONFIG_DIR=/runner/claude \
  -e CODEX_HOME=/runner/codex \
  --workdir /runner runner sh
```

Verwende dieselbe Compose-Konfiguration wie beim Start. Ein dabei gesetzter
Projektname (`-p`) gehört auch in diesen Aufruf. Falls Docker Administratorrechte
verlangt, nutze `sudo docker compose …`; `--user` hält die Anmeldung im Container
unter der vorgesehenen unprivilegierten Identität. Melde die Anbieter nicht als
Container-root oder auf dem Hub an. Die expliziten Home-Verzeichnisse sind nötig,
weil ein neuer `docker compose exec`-Prozess nicht automatisch die vom Supervisor
gesetzte Umgebung des laufenden Agentenprozesses übernimmt.

## Codex mit dem ChatGPT-Abo

In der geöffneten Runner-Shell:

```bash
codex login --device-auth
codex login status
```

Öffne die angezeigte Anbieteradresse in deinem eigenen Browser, melde dich mit
deinem ChatGPT-Konto an und gib dort den einmaligen Gerätecode ein. Die
Geräteanmeldung muss gegebenenfalls in den ChatGPT-Sicherheitseinstellungen oder
durch den Workspace-Administrator erlaubt werden. Dieser Weg benötigt keinen
erreichbaren lokalen OAuth-Rückrufport am Runner.
[Offizielle Anleitung für Headless-Geräte](https://learn.chatgpt.com/docs/auth#login-on-headless-devices).

`codex login status` prüft die lokal gespeicherte Anmeldung; ein erfolgreicher
Status garantiert kein bestimmtes Restkontingent oder Modellrecht.
[Offizielle Codex-CLI-Referenz](https://learn.chatgpt.com/docs/developer-commands?surface=cli#codex-login).

## Claude mit dem Claude-Abo

In derselben Runner-Shell:

```bash
claude auth login --claudeai
claude auth status --text
```

`--claudeai` wählt ausdrücklich das Claude-Abo. Der separate Console-Modus ist für
API-Abrechnung vorgesehen. Die mitgelieferte Claude-Code-Version 2.1.285
unterstützt diese Option (`claude auth login --help`).
[Offizielle CLI-Referenz](https://code.claude.com/docs/en/cli-reference).

Öffne die angezeigte Anmeldeadresse in deinem eigenen Browser. Wenn der Rückruf
zum Container nicht erreichbar ist und der Anbieter einen Rückgabecode zeigt,
füge ihn in die zugehörige Aufforderung **dieses Terminals** ein. Er gehört nicht
in einen HAPI-Chat, ein Projekt oder einen Screenshot.
[Offizielle Claude-Anmeldehilfe](https://code.claude.com/docs/en/authentication).

## Danach und bei Problemen

Beende die Operator-Shell mit `exit` und starte eine neue Agentensitzung mit dem
gewünschten Anbieter. Vorhandene laufende Sitzungen werden durch diese Anleitung
nicht automatisch neu gestartet.

- **Kein geprüftes Browser-Signal:** HAPI zeigt derzeit keinen verifizierten
  Anbieter-Anmeldestatus. Ein online gemeldeter Runner bestätigt nur die Verbindung
  zum Hub. Fehlende [Kapazitätsdaten](CAPACITY.md) bedeuten nicht automatisch, dass
  die Anmeldung fehlt.
- **Falscher Benutzer oder Runner:** Prüfe Compose-Projekt, Benutzer-ID und die
  oben gesetzten Verzeichnisse. Jeder isolierte Runner hat sein eigenes Home und
  wird separat angemeldet.
- **Netzwerk blockiert:** Der Betreiber prüft die genaue Anbieteradresse gegen
  `EVOLVED_EGRESS_HOSTS`. Zusätzliche tatsächlich benötigte Anbieterhosts
  werden einzeln ergänzt. Eine eigene Liste ersetzt die Standardliste; behalte
  deshalb auch deren benötigte Hosts bei. Keine Wildcards, zusätzlichen OAuth-Ports oder
  allgemeinen Netzfreigaben sind Teil dieses Anmeldewegs.
- **Schutzbereich:** Native Anmeldedaten liegen unter `/runner/claude` bzw.
  `/runner/codex` im persistenten privaten Runner-Home. Die Agenten dieses Runners
  können darauf zugreifen. Sie gehören nicht in Projektordner, Logs, den
  HAPI-Tresor oder Browserformulare. Kopiere keine bestehenden Host-Anmeldedaten
  in einen anderen Runner.
- **Abmelden oder Konto wechseln:** Führe im selben Runner `codex logout` bzw.
  `claude auth logout` aus und melde dich bei Bedarf neu an. Ein Widerruf des
  HAPI-Runner-Zugangs beendet dessen Hub-Berechtigung, widerruft aber keine
  Anbieteranmeldung. Konto- und Tokenwiderruf beim Anbieter sind getrennt.

Diese Anleitung wurde mit den CLI-Hilfen der im Runner gepinnten Versionen
Codex 0.157.0 und Claude Code 2.1.285 abgeglichen. Dabei wurden keine echten
Anbieterkonten angemeldet und keine Anmeldedateien ausgelesen.
