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
Ein menschlicher Projektadministrator konfiguriert drei getrennte Funktionen:

- Sprachmodell: OpenAI oder Anthropic/Claude für Wissensextraktion.
- Embeddings: OpenAI oder Voyage AI mit expliziter Vektorgröße.
- Suchtrefferbewertung: lokale RRF-Rangfusion (Standard, ohne zusätzlichen API-Key)
  oder ein separat konfigurierter OpenAI-/Voyage-Reranker.

Claude + Voyage + lokale RRF benötigt keinen OpenAI-Zugang. Jede kostenpflichtige
Funktion besitzt einen eigenen Schlüssel, eine Modell-ID und aktuelle Preise.
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

Der interne Endpunkt `/configuration/models` fragt die festen OpenAI-/Anthropic-
Katalogendpunkte ohne Redirects mit Zeit- und Größenlimits ab. Bei Voyage wird kein
Katalog vorgetäuscht: IDs werden manuell eingegeben und `verified: false` zurückgegeben.
`/configuration/check` validiert die übergebene Konfiguration und prüft Neo4j;
beide verwenden das interne Dienst-Token. Der Browser-Verbindungstest kombiniert diese
Prüfungen ohne kostenpflichtige Modellaufrufe und nennt ungeprüfte Komponenten.
Modelllisten liefern keine Preise und keinen vollständigen Kompatibilitätsnachweis.
Sprachmodelle benötigen strukturierte Ausgaben; nur der optionale OpenAI-Reranker
benötigt Chat-Completions-Logprobs. Dimensionen werden beim Anbieter angefordert und
vor der Verwendung exakt geprüft, niemals durch lokales Abschneiden angepasst.

Projektkonfigurationen verwenden `schemaVersion: 2` mit `llm`, `embedding` und
`reranker`. Jeder kostenpflichtige Slot hat ein eigenes `apiKey`; öffentliche Antworten
enthalten ausschließlich freigegebene Konfigurationsfelder und Schlüsselstatus.
Alte flache OpenAI-Datensätze werden nach Entschlüsselung lesend normalisiert, ohne
Ciphertext oder Version umzuschreiben: alter Schlüssel für LLM und Embeddings, lokales
RRF als bisher tatsächlich genutzte Suchstrategie. Alte Vektorbindungen werden als
OpenAI-Bindungen erhalten. Ein Anbieterwechsel übernimmt keinen fremden Schlüssel.

Alle kostenpflichtigen Aufrufe laufen über rollenbezogene Budgettransporte. Anthropic
verwendet einen Adapter für ein einzelnes lokales Ausgabe-Schema-Tool ohne automatische
Wiederholungen, Server-Tools oder Prompt-Caching. Voyage läuft direkt über HTTP ohne
unbudgetierten SDK-Client. Das Embedding-Profil nutzt fest `input_type: null`, weil die
Graphiti-Schnittstelle Anfrage und Dokument nicht zuverlässig unterscheidet; es kürzt
Eingaben nicht still. Bei Voyage-Reranking zählt die Reservierung die Anfrage einmal
je Dokument. Mehrdeutige Antworten behalten ihre konservative Reservierung.
Ausgewähltes externes Reranking aktiviert ausdrücklich die Cross-Encoder-Suchstrategie;
lokales RRF setzt einen Adapter ein, der unerwartete kostenpflichtige Aufrufe abweist.

Der Claude-Adapter verwendet `tool_choice: auto` mit höchstens einem internen
Schema-Aufruf. Erzwungene Tool-Aufrufe werden unter anderem von Opus 5.5 abgelehnt
([Anthropic-Kompatibilität](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)).
Zusätzliche Text- und Thinking-Blöcke werden verworfen; ausschließlich das validierte
Schemaergebnis gelangt in die Extraktion. Eine unvollständige oder mehrdeutige
Antwort wird nicht automatisch kostenpflichtig wiederholt.

Das explizit gespeicherte Ausgabelimit kann zwischen `256` und `65536` Tokens liegen.
Bei Claude zählt auch Thinking zu diesem Limit; einige Modelle können Thinking
nicht abschalten ([Anthropic-Tokenbudget](https://platform.claude.com/docs/en/build-with-claude/thinking)).
Ein zu kleines Limit kann deshalb schon vor dem vollständigen Schemaergebnis enden.
Die Obergrenze ist eine Grenze dieser Anwendung, keine zugesicherte Modellfähigkeit;
das gewählte Modell muss das eingestellte Limit unterstützen. Gespeicherte
Projektkonfigurationen behalten ihren Wert bis zum nächsten ausdrücklichen Speichern.
Explizite Betreiberwerte oberhalb `4096` werden künftig bis `65536` berücksichtigt;
ohne Betreiberwert bleibt der bisherige Standard `2048`. Höhere Limits werden
vor jedem Aufruf vollständig im vorhandenen Auftragsbudget reserviert; reichen die
Mittel nicht, wird kein Anbieteraufruf gesendet. Monats-/Auftragsbudgets werden nicht
erhöht und fehlgeschlagene Aufträge nicht automatisch wiederholt.

Erreichbarkeit des Backends bestätigt noch keine erfolgreiche Indexierung. Bei
fehlgeschlagenen Operationen enthalten die internen Belege einen festen `errorCode`
und die Verarbeitungsphase `stage`, bei abgelehnten Claude-Anfragen zusätzlich den
HTTP-Status `providerStatus`. Provider-Antworten, Prompts und Exceptiontexte werden
dabei nicht gespeichert. `anthropic_http_error` weist auf eine abgelehnte Anfrage
hin, `anthropic_output_truncated` auf das Ausgabetokenlimit und
`anthropic_invalid_response` auf ein fehlendes oder ungültiges Schemaergebnis.

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
unter Projektsperre die neue Bindung an Anbieter, Embedding-Modell und Dimensionen. Das erneute
Speichern repariert auch eine vorherige Teilunterbrechung zwischen Dienst und Vault.
Bis zu diesem erneuten Speichern können alte, noch wartende Aufträge wegen der
abweichenden Bindung fehlschlagen. Diese Aufträge werden nicht automatisch wiederholt.
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
| `EVOLVED_MEMORY_MAX_OUTPUT_TOKENS` | Standard `2048`, begrenzt auf `256…65536`; zählt gegebenenfalls Thinking mit |
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
