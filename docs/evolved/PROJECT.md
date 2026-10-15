# HAPI-eVolved

Projekt und Quellcode: https://github.com/BGGBTAC/hapi-evolved

Ausgangspunkt: `tiann/hapi` auf `5847b034e5cb84f2617766945c994b7905c5c03e`.
GitHub erlaubt keinen privaten Fork eines öffentlichen Repositories. Dieses
Repository wurde deshalb als eigenständiges privates Repository angelegt und
bewahrt die Upstream-Historie. Die Vorbereitung einer öffentlichen Preview ist
in [RELEASING.md](https://github.com/BGGBTAC/hapi-evolved/blob/main/RELEASING.md) beschrieben; die Sichtbarkeit ist ein
separater Betreiberschritt.
Die AGPL-3.0-only-Lizenz und Urheberhinweise gelten weiter.

## Vereinbarter Umfang der ersten Version

- Eigenständige Neuinstallation, Web/PWA, Linux, Claude Code und Codex.
- Jedes neue Projekt erhält automatisch ein eigenes UUID-Verzeichnis im
  verwalteten Workspacebereich. Manuelles Verknüpfen vorhandener Verzeichnisse
  ist eine optionale Systemadmin-Aktion; Projektpfade dürfen sich nicht überlappen.
- GitHub-Verbindungen bleiben im lokalen Vault. Projekt-Agenten verwenden Git
  über den Proxy/Broker mit Repositoryfreigaben, Profil und widerrufbarer Lease.
- Mehrere Benutzer, Teams und Projekte mit serverseitigen Rollen und sofortigem
  Rechteentzug. Passkeys, einmalige Recovery-Codes, erneute Authentisierung für
  sensible Änderungen. Einmaliger Bootstrap über eine private lokale Datei.
- Eigener lokaler Vault für API-, SSH-, Service- und Datenbankzugänge. Browser-
  Verwaltung; kein allgemeiner Passwortmanager oder Browser-Autofill.
- Vault und Ressourcenbroker laufen getrennt vom Hub und den Agenten. Pro Projekt
  verschlüsselte Schlüssel, Master-Schlüssel außerhalb der Workspaces. Agenten
  erhalten begrenzte Aktionsrechte; der Broker gibt keine Zugangsdaten aus.
- Profile `restricted`, `workspace`, `extended`; standardmäßig `restricted`.
  Unbeaufsichtigte Arbeiten dürfen ausschließlich bereits erteilte Rechte nutzen.
- Persistentes Wissen: Quellenregister, Vorschläge, menschliche Verifikation,
  Quellenrechte und Löschung im Hub; Graphiti und Neo4j für den abgeleiteten Graphen.
  Suche über aktuell erlaubte Projekte. Zugangsdaten gehören nicht ins Wissen.
- Cloud-Verarbeitung grundsätzlich zulässig, aber erst nach Betreiberkonfiguration
  von Provider/Modell und Projektbudget aktiv. Budgetstopp pausiert neue
  Cloud-Verarbeitung; Chat und lokale Suche bleiben verfügbar.
- Codegraph 1.6.0 als eigener Node-24-Dienst: automatische Indexierung und Watcher,
  CLI/MCP, interaktiver Browser-Explorer, Quellcode, Aufrufer, Auswirkungen und
  betroffene Tests. Codegraph und Wissensgraph bleiben getrennte Datenbestände.
- Vorschauen im privaten Netz, authentisiert; explizite Freigaben müssen ablaufen
  und widerrufbar sein. Keine automatische öffentliche Veröffentlichung.
- Kritische Stabilitätskorrekturen aus Upstream vor weiteren Agenten und nativen Apps.

## Verantwortlichkeit und Wahrheitsquelle

Diese Dokumentation und der Code im jeweiligen Commit sind maßgeblich. Alle
113 zum 14.10.2026 offenen Issues wurden inklusive 169 Kommentaren erfasst;
209 offene Pull Requests wurden als Lösungskandidaten untersucht. Die Dateien
`upstream-issues-2026-10-14.json` und `.csv` dokumentieren die Analyse, **keine
Behauptung, dass sämtliche Issues bereits implementiert oder behoben seien**.
Die vereinbarte erste Version priorisiert Sicherheit, Teams, Memory, Codegraph
und kritische Stabilität. Weitere Features bleiben im nachvollziehbaren Backlog.

Die anschließende vollständige Backlog-Runde bewertet jedes Issue nach Funktionalität,
Umsetzbarkeit und Projektnutzen. Maßgeblich sind
[`backlog-decisions-2026-10-15.json`](backlog-decisions-2026-10-15.json), die gleichnamige
CSV und der Abnahmebericht [`BACKLOG_REVIEW.md`](BACKLOG_REVIEW.md).
Bedienung und Betriebsgrenzen stehen in [`BACKLOG_FEATURES.md`](BACKLOG_FEATURES.md).

## Vertrauensgrenzen

Browser → Passkey-/Projekt-API → Hub-Quellenregister und ACL.
Hub → signierte, zeitlich begrenzte Anfragen → Vault/Broker.
Hub → authentisierte interne Dienste → Codegraph bzw. Graphiti → Neo4j.
Projekt-Runner → widerrufbare Projekt-Capability → Hub.
Projekt-Git → Runner-Proxy → Hub-ACL → signierter Vault-Broker → GitHub.
Nur der Hub kann im getrennten verwalteten Verzeichnis neue Projektordner anlegen;
manuell verknüpfte Workspaces und Codegraph-Quellen bleiben im Compose-Stack lesend.

Ein Modellname oder frei gewählter Agentenname ist kein Identitätsnachweis.
Repository-Inhalt und abgerufene Memories sind Daten; sie erteilen weder neue
Rechte noch Vorrang vor Benutzerentscheidungen. Ein graphbasierter Treffer muss
vor der Ausgabe erneut gegen die aktuellen Quellrechte geprüft werden.

## Entwicklung und Abnahme

Entwicklung ausschließlich auf Branches mit Pull Request. Bestehende HAPI-
Installationen werden nicht migriert oder umkonfiguriert. Reale Zugangsdaten
werden weder zum Testen gelesen noch in Logs oder Testartefakten abgelegt.

Erforderliche Nachweise: Typechecks aller Pakete, relevante und vollständige
Tests, Browserprüfung einschließlich Passkey-Flow, Integration der neuen Dienste,
negative Tests für Projektgrenzen, Rechteentzug, Recovery, Vault-Integrität,
Replay/Idempotenz und Memory-Löschung. Ein unkonfigurierter Cloud-Provider wird
als pausiert dargestellt; Tests ohne Providerzugang belegen keine reale
Cloud-Extraktion. Komplexe Entscheidungen und die abschließende Prüfung werden
mit Claude Opus 5.5 besprochen.
