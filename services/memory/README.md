# Persistentes Memory

Der Hub besitzt das maßgebliche SQLite-Quellenledger und die Kostenreservierungen. Dieser Python-Dienst
projiziert freigegebene Episoden mit `graphiti-core==0.30.2` in Neo4j. Die Abhängigkeiten sind in
`requirements.lock` vollständig gepinnt. Es gibt keinen simulierten Graphmodus: ohne Dienst/Modellkonfiguration
bleibt die lokale Ledger-Suche verfügbar; hybride Suche meldet den fehlenden Dienst ausdrücklich.

## Konfiguration

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
Modellnamen und Preise haben absichtlich keine impliziten Vorgaben. Graphiti-Telemetrie ist deaktiviert.
Cloudverarbeitung muss anschließend ein menschlicher Projektadmin im Hub mit Monats- und Operationsbudget aktivieren.

## Kosten, Quellen und Löschung

Kosten werden als ganzzahlige USD-Millionstel geführt. SQLite reserviert das komplette Operationsbudget atomar,
bevor eine Anfrage den Hub verlässt. Der Python-Transport reserviert zusätzlich vor **jedem** Modellaufruf
die konservative Token-Obergrenze. Er begrenzt Ausgabetokens und rechnet die Provider-Usage zurück.
Unklare/abgebrochene Aufrufe behalten ihre Reservierung; Wiederholungen mit derselben Operations-ID verursachen
keinen erneuten Aufruf. Ein regelmäßiger Belegabgleich löst endgültig abgeschlossene Reservierungen auch
nach abgebrochener Suche oder Quellenlöschung auf; unbekannte/laufende Operationen bleiben reserviert. Nach Prozessabsturz werden laufende Operationen als unklar abgeschlossen.
Die eingetragenen Preise müssen zu den ausgewählten Modellen passen.

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
