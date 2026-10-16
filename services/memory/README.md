# HAPI-eVolved: persistentes Memory

Dieser Dienst gehört zur eigenständigen Weiterentwicklung von
[tiann/hapi](https://github.com/tiann/hapi). Einstieg:
[Quickstart](../../docs/evolved/QUICKSTART.md),
[Betreiberanleitung](../../docs/evolved/DEPLOYMENT.md) und
[Datenflüsse](../../docs/evolved/DATA_HANDLING.md).
Graphiti und Neo4j bleiben eigene Drittanbieterkomponenten mit ihren jeweiligen
Lizenzen; ein verbundenes Claude-/Codex-Abo konfiguriert diesen Dienst nicht.

Der Hub besitzt das maßgebliche SQLite-Quellenledger und die Kostenreservierungen. Dieser Python-Dienst
projiziert freigegebene Episoden mit `graphiti-core==0.30.2` in Neo4j. Die Abhängigkeiten sind in
`requirements.lock` vollständig gepinnt. Es gibt keinen simulierten Graphmodus: ohne Dienst/Modellkonfiguration
bleibt die lokale Ledger-Suche verfügbar; hybride Suche meldet den fehlenden Dienst ausdrücklich.

## Konfiguration

Der normale Einrichtungsweg ist **Projekt → Gedächtnis → Graph-Memory einrichten**.
Ein menschlicher Projektadministrator hinterlegt einen OpenAI-API-Key, lädt den
aktuellen Modellkatalog und speichert Sprachmodell, Embedding-Modell und Preise.
Die Verwaltung verlangt eine frische Passkey-Bestätigung. Der Key liegt verschlüsselt
in einer eigenen Tabelle des Projekt-Vaults und ist weder über die generische
Secretverwaltung noch über Agentenwerkzeuge abrufbar. Im Browser bleibt er nur bis
zum Absenden beziehungsweise Verlassen des Projektkontexts im Formular.

Der Hub gibt die aufgelöste Konfiguration intern für `/ingest` und `/search`
als unveränderlichen Snapshot sowie für die Einrichtungsprüfung weiter. Der Python-Dienst schreibt Schlüssel und Preise weder in
Umgebungsvariablen noch in Operationsbelege oder Idempotenz-Fingerprints.
Wiederholungen einer bereits angenommenen Operations-ID behalten ihr ursprüngliches
Ergebnis auch nach einem Schlüsselwechsel. `/receipt` und `/reset` benötigen keinen
Provider-Key. Ein Projektwechsel kann keine Schlüssel eines anderen Projekts übernehmen.

Der interne Endpunkt `/configuration/models` fragt ausschließlich
`https://api.openai.com/v1/models` ab, ohne Redirects, mit Zeit-/Größenlimits.
`/configuration/check` validiert die übergebene Konfiguration und prüft Neo4j;
beide verwenden das interne Dienst-Token. Der Browser-Verbindungstest kombiniert
diese Prüfungen, ohne kostenpflichtige Modellaufrufe. Modelllisten liefern weder
Preise noch einen Nachweis der Graphiti-Kompatibilität. Nötig sind strukturierte
Textausgaben, Chat-Completions-Logprobs und 1536-dimensionale Embeddings.

Projektkonfiguration hat Vorrang vor den unten beschriebenen Betreiberwerten.
Explizites Entfernen hinterlässt eine versionierte Sperre gegen den Rückfall auf
globale Credentials. Ein bestehendes Embeddingprofil bleibt bei Graphdaten gebunden;
die Einrichtung führt keine automatische Neuindizierung durch. Cloud-Freigabe und
positive Monats-/Auftragsbudgets bleiben zusätzliche Voraussetzungen.

Alte Installationen können fehlgeschlagene Indexaufträge ohne jemals erzeugte
Graphdaten enthalten. Jeder Speichervorgang bestätigt deshalb über den internen
Endpunkt `/configuration/binding` die dauerhafte Modellbindung. Eine bereits identische
Bindung erlaubt Schlüssel- und Preisänderungen auch mit vorhandenem Graph. Bei einer
abweichenden oder unbekannten Bindung prüft der Dienst alle Projektgenerationen und
aktive beziehungsweise unklare Aufträge. Nur bei nachgewiesen leerem Graph schreibt er
unter Projektsperre die neue Bindung an Embedding-Modell und Dimensionen. Das erneute
Speichern repariert auch eine vorherige Teilunterbrechung zwischen Dienst und Vault.
Verspätete Anfragen mit abweichendem Modell dürfen danach keine Graphdaten erzeugen;
vorhandene Operationsbelege bleiben unverändert abrufbar. Unsichere Zustände verweigern
die Übernahme. Der Speichervorgang löscht keine Daten, gibt keine alten Reservierungen
frei und wiederholt keine bereits fehlgeschlagenen Indexaufträge automatisch.

### Betreiberwerte und vorhandene Installationen

| Variable | Bedeutung |
|---|---|
| `EVOLVED_SERVICE_TOKEN_FILE` | Internes Hub/Dienst-Token; mindestens 32 Zeichen |
| `NEO4J_URI` | Standard `bolt://neo4j:7687` |
| `NEO4J_USER` | Standard `neo4j` |
| `NEO4J_PASSWORD_FILE` | Datenbankkennwort |
| `OPENAI_API_KEY_FILE` | Schlüssel des konfigurierten Modellanbieters |
| `EVOLVED_MEMORY_API_BASE` | HTTPS-Endpunkt, Standard `https://api.openai.com/v1` |
| `EVOLVED_MEMORY_MODEL` | Explizit gewähltes Modell mit strukturierter Ausgabe |
| `EVOLVED_MEMORY_EMBEDDING_MODEL` | Explizit gewähltes Embeddingmodell |
| `EVOLVED_MEMORY_INPUT_USD_PER_MTOK` | Eingabepreis in USD je Million Tokens |
| `EVOLVED_MEMORY_OUTPUT_USD_PER_MTOK` | Ausgabepreis in USD je Million Tokens, einschließlich Reasoning |
| `EVOLVED_MEMORY_EMBEDDING_USD_PER_MTOK` | Embeddingpreis in USD je Million Tokens |
| `EVOLVED_MEMORY_EMBEDDING_DIM` | Standard `1536`; passend zum Modell festlegen |
| `EVOLVED_MEMORY_MAX_OUTPUT_TOKENS` | Standard `2048`, begrenzt auf `256…4096` |
| `EVOLVED_MEMORY_STATE` | Dauerhafte Operationsdatenbank, Standard `/data/operations.db` |

Für die drei Zugangsdaten funktioniert alternativ die gleichnamige Umgebungsvariable ohne `_FILE`.
Dateivarianten vermeiden Zugangsdaten in Compose-Konfiguration und Prozessargumenten.
Modellnamen und Preise haben serverseitig keine impliziten Vorgaben. Die Browsermaske
bietet nachvollziehbare Preisvorschläge für einzelne Modelle; aktuelle Preise muss
der Projektadministrator prüfen. Graphiti-Telemetrie ist deaktiviert.
Cloudverarbeitung muss anschließend ein menschlicher Projektadmin im Hub mit Monats- und Operationsbudget aktivieren.

## Kosten, Quellen und Löschung

Kosten werden als ganzzahlige USD-Millionstel geführt. SQLite reserviert das komplette Operationsbudget atomar,
bevor eine Anfrage den Hub verlässt. Der Python-Transport reserviert zusätzlich vor **jedem** Modellaufruf
die konservative Token-Obergrenze. Er begrenzt Ausgabetokens und rechnet die Provider-Usage zurück.
Unklare/abgebrochene Aufrufe behalten ihre Reservierung; Wiederholungen mit derselben Operations-ID verursachen
keinen erneuten Aufruf. Ein regelmäßiger Belegabgleich löst endgültig abgeschlossene Reservierungen auch
nach abgebrochener Suche oder Quellenlöschung auf; unbekannte/laufende Operationen bleiben reserviert. Nach Prozessabsturz werden laufende Operationen als unklar abgeschlossen.
Die eingetragenen Preise müssen zu den ausgewählten Modellen passen.
Scheitert eine neue Anfrage nachweislich bereits vor dem HTTP-Versand, entfernt der
Hub ausschließlich ihre frisch angelegte, noch ungenutzte Reservierung. Frühere
Reservierungen und Anfragen mit unklarem Versandstatus bleiben erhalten.

Episoden behalten Projekt, Quellenart, Inhaltshash, gegebenenfalls Datei/Commit sowie Sitzung/Nachricht.
Neue Hub-Nachrichten werden nur mit aktivem, weiterhin berechtigtem Freigabeadmin aufgenommen; historische
Sitzungen werden nicht eingelesen. Code- und Textanhänge lassen sich über den Workspace-Intake aufnehmen.
Secret-Dateien und erkannte Credentials sind ausgeschlossen. Dateilöschung/-änderung und Nachrichtenlöschung
entfernen zugehörige Erinnerungen. Agentenvorschläge bleiben `proposed`, bis ein Mensch sie bestätigt. Eingereichte Chatreferenzen tragen
`origin: user:reference`; nur der echte Hub-Ereignispfad setzt `origin: hub:session:<id>`.

Vor Suche und Ergebnisrückgabe prüft der Hub aktuelle Projektberechtigungen. Graphiti bekommt genau einen
autorisierten Projektgraphen pro Anfrage; der RRF-Abgleich erfolgt innerhalb dieses Scopes.
Bei Löschung wird die Graphgeneration sofort ungültig und der vollständige alte Projektgraph dauerhaft zur
Löschung vorgemerkt. Das entfernt auch Zusammenfassungen, Embeddings und indirekt abgeleitete Inhalte;
verbleibende Quellen werden anschließend unter dem bestehenden Budget neu aufgebaut. Der Löschstatus bleibt
bis zur tatsächlichen Bereinigung ausstehend. Projektlöschung entfernt das Quellenledger und erhält nur
Bereinigungsaufträge und Kostenbelege. Backups brauchen ihre eigene Aufbewahrungs-/Löschregel.

## Prüfung

```sh
python3 -m venv /tmp/hapi-memory-test
/tmp/hapi-memory-test/bin/pip install -r services/memory/requirements.lock
/tmp/hapi-memory-test/bin/python -m unittest discover -s services/memory -p 'test_*.py'
bun test hub/src/evolved/memory.test.ts
```

Die Tests benötigen keine echten Schlüssel und rufen keine Cloudmodelle auf. Sie prüfen atomare Budgets,
Provider-Grenzen, Tokenabrechnung, Idempotenz, ACL/Widerruf und Quellen-/Projektlöschung. Für einen vollständigen
Graphiti/Neo4j-Abnahmelauf müssen die privaten Dienste und ein ausdrücklich budgetiertes Modell konfiguriert sein.

Ein isolierter Compose-Abnahmelauf ohne konfiguriertes Modell ist reproduzierbar mit:

```sh
docker exec -i hapi-evolved-check-memory-1 python - < services/memory/validate_stack.py
```

Das Skript erzeugt ausschließlich eigene temporäre Neo4j-Testknoten und entfernt sie danach. Es verweigert
konfigurierte Modelle und prüft Authentifizierung, Projektisolation, Cascade, Wiederholung und Nullkostenfehler.

Der vollständige SDK-Durchlauf nutzt echtes Graphiti und Neo4j, aber ausschließlich einen ersetzten
HTTP-Providertransport im Test (Responses + Embeddings, keine echten Provideraufrufe):

```sh
docker exec -i hapi-evolved-check-memory-1 python - < services/memory/validate_sdk.py
```
