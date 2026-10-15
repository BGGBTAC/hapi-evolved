# HAPI-eVolved: lokaler Codegraph-Dienst

Dieser Adapter ergänzt den unabhängigen Fork von
[tiann/hapi](https://github.com/tiann/hapi). Er ist vom persistenten Memory-Graphen
getrennt und benötigt keine Modellanmeldung. Einstieg:
[Quickstart](../../docs/evolved/QUICKSTART.md) und
[Betreiberanleitung](../../docs/evolved/DEPLOYMENT.md).
Die Codegraph-SDK-Herkunft und MIT-Lizenz bleiben erhalten.

Node 24 betreibt das gepinnte `@colbymchenry/codegraph@1.6.0` unabhängig vom Bun-Hub.
Der Hub prüft Passkey-Sitzung, Projektmitgliedschaft und Capability-Scope vor jeder Anfrage;
dieser Dienst akzeptiert ausschließlich das interne Servicetoken. Der Browser spricht nie direkt mit ihm.

## Start

```sh
npm ci --prefix services/codegraph --ignore-scripts
npm start --prefix services/codegraph
```

Docker und `npm start` starten Node mit `--liftoff-only`, wie vom eingebetteten
Codegraph-SDK für große Indexläufe verlangt. Der Parameter verhindert dessen
bekannten V8-WASM-Optimierungscompiler-Fehler und wird an die Worker vererbt.
Bei einem direkten Start gilt daher `node --liftoff-only server.mjs`.
`NODE_OPTIONS` oder ein nachträglicher Worker-Parameter sind dafür kein Ersatz.
Der Parameter ersetzt keine Speichergrenze: Ein Container-OOM durch den gesamten
Indexierungsbedarf muss weiterhin separat anhand des tatsächlichen Verbrauchs bewertet werden.

Konfiguration:

| Variable | Bedeutung |
|---|---|
| `EVOLVED_SERVICE_TOKEN_FILE` | Datei mit mindestens 32 Zeichen; alternativ `EVOLVED_SERVICE_TOKEN` |
| `EVOLVED_CODE_ROOTS` | JSON-Liste erlaubter absoluter Workspace-Verzeichnisse; Standard `[]` verweigert alles |
| `EVOLVED_CODEGRAPH_HOST` | Standard `127.0.0.1`; im privaten Compose-Netz `0.0.0.0` |
| `EVOLVED_CODEGRAPH_STATE_DIR` | Privates beschreibbares Datenverzeichnis außerhalb aller Workspace-Roots; Standard `/data` |
| `EVOLVED_CODEGRAPH_PORT` | Standard `8011` |
| `EVOLVED_CODEGRAPH_MAX_PROJECTS` | Maximale gleichzeitig geladene Projekte; Standard `4` |

Pro Projekt/Worktree entsteht unter `EVOLVED_CODEGRAPH_STATE_DIR` (Standard `/data`)
`projects/<Projekt-ID>/workspace/` als privater Quellenspiegel mit eigenem SQLite-Index.
Quell-Workspaces werden nur gelesen; der Adapter kopiert freigegebene Dateien über überprüfte offene
Dateideskriptoren in seinen Spiegel. SDK und SQLite erhalten ausschließlich diese privaten Pfade.
`deleted/<Projekt-ID>` hält Löschmarkierungen dauerhaft über Dienstneustarts hinweg.
Ein Worker pro Projekt isoliert die SDK-Konfiguration und begrenzt den JS-Heap auf 512 MB.
Eine Kapazitätsüberschreitung liefert 503 und wird nicht als leerer Graph dargestellt.

Vor der Indexierung werden nur unterstützte Code-Endungen ausgewählt. Symlinks, Secret-Verzeichnisse,
Credential-Dateien, `.env`, `.git`, Abhängigkeiten und Build-Ausgaben werden ausgeschlossen.
Alle drei Sekunden erfolgt ein begrenzter Dateiabgleich; nur geänderte/gelöschte Pfade gehen an das SDK.
Maximal 50.000 Dateien, 10.000 Verzeichnisse und 1 MiB pro Quelldatei werden verarbeitet.
Die Anzeige meldet Indexierungszustand, ausstehende Änderungen und Fehler.
Ein leerer Projektordner ist ein erfolgreicher leerer Index: `graph` liefert
`nodes: []` und `edges: []` statt eines fehlenden Symbols. Die Standardansicht
wählt ein vorhandenes Symbol unabhängig von seinem Namen. Explizite unbekannte
Knoten-IDs bleiben Fehler. Statusstatistiken enthalten ausschließlich die Zahlen
`nodeCount`, `edgeCount`, `fileCount`; verschachtelte SDK-Verteilungen werden
nicht an die Oberfläche durchgereicht. `lastIndexedAt` invalidiert dort die
Abfragen nach einer automatischen Quelltextaktualisierung.

`DO_NOT_TRACK=1`, `CODEGRAPH_TELEMETRY=0`, `CODEGRAPH_NO_UPDATE_CHECK=1` und
`CODEGRAPH_NO_DOWNLOAD=1` werden vor dem Laden des SDK erzwungen. Laufzeit braucht keine externen Dienste.
Netzwerkseitig sollte der Container ausschließlich im internen Servicenetz stehen.

`POST /query` nimmt `{projectId,root,operation,params}` entgegen. Operationen:
`status`, `search`, `node`, `graph`, `impact`, `affected`, `reindex`; `drop` ist dem internen
Projekt-Löschworkflow vorbehalten. Antworten sind auf maximal 200 Knoten und viermal so viele Kanten begrenzt.
`GET /health` verlangt ebenfalls das Servicetoken. Projektlöschung stoppt den Worker und entfernt seinen Index;
Quelldateien bleiben erhalten. Bei Ausfall behält der Hub den Bereinigungsauftrag dauerhaft.

## Prüfung

```sh
node --liftoff-only --test services/codegraph/test/*.test.mjs
```

Der Integrationstest baut einen echten temporären Index, prüft Aufrufkanten, Quelltextvorschau,
Secret-Ausschluss und automatische Aktualisierung. Er benötigt keine Produktionsdaten oder Cloudzugänge.
Das SDK ist MIT-lizenziert; die mitgelieferten Lizenzhinweise und Drittanbieterhinweise bleiben im Paket.

Der HTTP-Abnahmelauf im isolierten Compose-Teststack erzeugt und entfernt nur sein eigenes Testworkspace:

```sh
EVOLVED_VALIDATION_STATE=/tmp/hapi-evolved-stack-validation node services/codegraph/validate_stack.mjs
```


Die Browserregression kann unter Linux x64 den echten Dienst einschließen
(nach Installation der lokalen Codegraph-Abhängigkeiten und Web-Build):

```sh
EVOLVED_TEST_CODEGRAPH_NODE="$PWD/services/codegraph/node_modules/@colbymchenry/codegraph-linux-x64/node" \
  node web/scripts/evolved-browser-check.mjs
```

Sie verwendet nur temporäre synthetische Konten/Workspaces und prüft den leeren
Index, automatische Aufnahme neuer Dateien, Graphausschnitt, Quelltext und
Neuindizierung über den echten authentifizierten Hub.
