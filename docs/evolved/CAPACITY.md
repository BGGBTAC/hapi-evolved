# Gemeldete Abo-Kapazität

Deutsch · [English version](CAPACITY.en.md)

Die Projektübersicht zeigt die von Claude Code und Codex tatsächlich gemeldeten
Nutzungsfenster. Diese Grenzen gelten **für das jeweilige Anbieterkonto**, auch
wenn die Meldung aus einer Session dieses Projekts stammt. Sie sind weder ein
Projektbudget noch die Summe der in HAPI angefallenen Tokenkosten.

Mehrere Sessions können dasselbe Konto oder verschiedene Konten verwenden.
HAPI zeigt ihre Meldungen getrennt und addiert sie nicht. Es überträgt keine
Anbieter-Konto-ID, E-Mail-Adresse oder Zugangsdaten zur Zuordnung. Die Angabe
„Rest“ ist ausschließlich `100 − gemeldeter Verbrauch in Prozent`. Ein fehlender
Verbrauchswert ergibt keinen Restwert. Nur ausdrücklich gemeldete 0 % Verbrauch
ergeben 100 % Rest.

## Datenquellen

| Anbieter | Verwendete native Schnittstelle | Verfügbarkeit |
| --- | --- | --- |
| Codex | Lokaler App-Server: `account/read`, `account/rateLimits/read`, `account/rateLimits/updated` | ChatGPT-Anmeldung und eine unterstützende Codex-Version erforderlich |
| Claude | Strukturiertes `rate_limit_event` aus dem bereits laufenden Claude-SDK-Prozess | Nur die vom SDK tatsächlich gelieferten Fenster und Felder |

Codex liest nach Initialisierung oder Wiederverbindung die Kontokategorie und
die gemeldeten Grenzen. Ein bestehender App-Server wird anschließend alle
60 Sekunden erneut gelesen; einzelne RPCs laufen höchstens fünf Sekunden.
Änderungsereignisse erscheinen ohne dieses Intervall abzuwarten. Die
Kapazitätsanzeige startet oder verbindet keinen Agentenprozess eigenständig.
API-Key-Anmeldungen sind für diese **Abo**-Ansicht ausdrücklich nicht unterstützt.

Claude meldet beispielsweise ein Fünfstundenfenster, ein Wochenfenster oder
modellspezifische Wochenfenster. `utilization` ist optional: „allowed“ bedeutet,
dass Anfragen erlaubt sind, und beweist keinen freien Prozentsatz. Ohne
numerischen Wert bleibt das Fenster unbekannt. HAPI fragt dafür keine privaten
OAuth-HTTP-Endpunkte ab und startet keine kostenpflichtige Testnachricht.
Das optionale `overage`-Fenster bezeichnet zusätzliche Nutzung und ist kein
zusätzliches kostenloses Abo-Budget. Lokale PTY-/ACP-Sessions ohne eingebundene
strukturierte Kapazitätsmeldungen bleiben ebenfalls unbekannt.

Die Anmeldung erfolgt über den nativen CLI-Ablauf, bei verwalteten Projekten aus
[Abos verbinden](PROVIDER_LOGIN.md) im Browser. Für die Kapazitätsanzeige werden
keine zusätzlichen Anbieter-Credentials eingerichtet,
keine Credentialdateien ausgelesen und keine Tokens an den Browser geliefert.

Offizielle Protokollquellen, geprüft am 15. Oktober 2026:

- [OpenAI: Codex App Server, Konten und Rate Limits](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt): `usedPercent`, `windowDurationMins`, `resetsAt` sowie einzelne und mehrere Limit-Buckets.
- [Anthropic: offizielle Agent-SDK-Typen](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py): `RateLimitInfo` und `RateLimitEvent`, insbesondere optionale Auslastung als Anteil zwischen 0 und 1.

## Aktualität und Grenzen

Jedes Fenster trägt seinen eigenen Empfangszeitpunkt. Teilmeldungen ersetzen
nur tatsächlich gemeldete Fenster und erhalten andere Fenster mit deren
ursprünglicher Zeit. Leere oder ungültige Teilmeldungen verändern weder die
Fenster noch ihre Zeitstempel; ein ausdrückliches `null` entfernt das betreffende
Codex-Fenster. Ein vollständiger
Codex-Lesevorgang ersetzt den vollständigen Codex-Schnappschuss. Kontowechsel
und native Neustarts verwerfen die vorherige Zuordnung; verspätete Antworten
einer älteren Kontogeneration überschreiben keine neue Meldung.

Ein Fenster ist veraltet, wenn die zugehörige Session inaktiv ist, seine Meldung
mindestens fünf Minuten alt ist oder die gemeldete Rücksetzzeit erreicht wurde.
HAPI setzt den Verbrauch nach Ablauf **nicht** selbst auf null. Der alte Wert
bleibt als veraltet erkennbar, bis der Anbieter einen neuen Wert liefert.
Unplausible zukünftige Empfangszeiten erzeugen keine frische Anzeige.

Ein frisches Fenster kann neben einem veralteten Fenster stehen. Der
Anbieterstatus lautet nur dann `available`, wenn mindestens ein frischer
numerischer Wert vorhanden ist. `unknown` bedeutet fehlende, veraltete oder
nicht numerische Meldungen beziehungsweise einen fehlgeschlagenen nativen
Lesevorgang. `unsupported` bezeichnet eine erkannte, für Abo-Kapazität nicht
unterstützte Anmeldung. HAPI schätzt keine Tokenanzahl aus diesen Prozentwerten.

## Projektgebundene Lese-API

`GET /api/evolved/projects/:id/capacity` verlangt eine menschliche Anmeldung und
mindestens die aktuelle Projektrolle `viewer`. Runner-Capabilities gewähren
keinen Zugriff auf diesen Endpunkt. Der Hub liest ausschließlich Sessions des
autorisierten Projekt-Namespace und liefert `Cache-Control: private, no-store`.
Ein Rechteentzug wirkt bei der nächsten Anfrage. Der Browser-Aufruf lädt die
zuletzt eingegangenen Meldungen; er erzwingt keine direkte Anbieterabfrage.

Der gemeinsame TypeScript-Vertrag heißt `ProjectCapacity` und wird aus
`@hapi/protocol` exportiert. Sämtliche Zeitfelder verwenden Unix-Millisekunden;
die nativen Anbieterzeitstempel werden aus Sekunden umgerechnet.

```ts
{
  projectId: string,
  generatedAt: number,
  providers: [{
    provider: 'claude' | 'codex',
    status: 'available' | 'unknown' | 'unsupported',
    reports: [{
      sessionId: string,
      source: 'claude-sdk' | 'codex-app-server',
      scope: 'account',
      observedAt: number,
      status: 'available' | 'unknown' | 'unsupported',
      reason: string | null,
      stale: boolean,
      windows: [{
        id: string,
        observedAt: number,
        usedPercent: number | null,
        remainingPercent: number | null,
        resetsAt: number | null,
        durationMinutes: number | null,
        status: 'allowed' | 'warning' | 'rejected' | 'unknown',
        stale: boolean
      }]
    }]
  }]
}
```

Leere `reports` sind ein unbekannter Zustand. Fehlergründe sind feste Codes:
`not_reported`, `utilization_not_reported`, `native_read_failed`,
`authentication_required`, `subscription_auth_required` und `invalid_report`.
Rohantworten und Anbieter-Fehlermeldungen gehören nicht zur Antwort. Diese
Meldungen sind Betriebsinformationen der angebundenen CLI und keine vom
Anbieter kryptografisch attestierte Abrechnung.
