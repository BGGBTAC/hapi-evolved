# Claude- und Codex-Abos im Browser verbinden

Öffne **Abos verbinden**, wähle dein Projekt und klicke auf **Verbinden** beim gewünschten Anbieter. Die gesamte Bedienung erfolgt in der Weboberfläche. Ein Projektadministrator benötigt dafür einen frischen Passkey.

Beim ersten Verbinden richtet HAPI den verwalteten Projektdienst automatisch ein. Er erhält ein eigenes privates Home, das aktuelle Ausführungsprofil und einen dauerhaften, widerrufbaren HAPI-Zugang. Bereits manuell angelegte Zugänge bleiben unverändert. Die Betreiberinstallation des lokalen Steuerdienstes ist unter [Deployment](DEPLOYMENT.md#browser-anmeldung-und-verwaltete-projektdienste) beschrieben.

## Codex

1. **Verbinden** wählen und kurz auf den Gerätecode warten.
2. Den Code kopieren und die angebotene offizielle OpenAI-Seite öffnen.
3. Beim gewünschten ChatGPT-Konto anmelden und den Gerätecode bestätigen.
4. Zu HAPI zurückkehren. Der Status wechselt nach der nativen Statusprüfung auf **Verbunden**.

Falls das Konto die Geräteanmeldung nicht freigegeben hat, zeigt die OpenAI-Seite den dafür notwendigen Schritt. Der Gerätecode ist höchstens 15 Minuten gültig. Maßgeblich ist der [offizielle Codex-Anmeldeweg](https://learn.chatgpt.com/docs/auth).

## Claude

1. **Verbinden** wählen und die offizielle Claude-Anmeldeseite öffnen.
2. Mit dem gewünschten Claude-Abo anmelden und die Verbindung bestätigen.
3. Den vollständigen dort angezeigten Bestätigungscode kopieren und im HAPI-Dialog einfügen.
4. **Anmeldung bestätigen** wählen. HAPI prüft anschließend den tatsächlichen nativen Anmeldestatus.

Der native Claude-Ablauf bindet den Code an den gerade gestarteten Vorgang. Ein Code aus einem alten Fenster passt nicht zu einer neuen Anmeldung. Siehe auch die [Claude-Dokumentation zur Anmeldung](https://code.claude.com/docs/en/authentication).

## Dauerhafter Zugriff und Kontrolle

Die Anbieteranmeldung bleibt im privaten Projekt-Runner erhalten; ein Browser-Neuladen oder Server-Neustart löscht sie nicht. Der Anbieter kann die Anmeldung dennoch widerrufen oder eine erneute Bestätigung verlangen. **Abmelden** entfernt ausdrücklich die native Anmeldung dieses Anbieters für diesen Projektdienst. Bereits gestartete Agenten können eine erneute Anmeldung beziehungsweise einen Neustart benötigen.

**Abbrechen** beendet einen laufenden Anmeldevorgang. Nach einem Neuladen kann derselbe angemeldete Benutzer mit **Verbinden** seinen noch laufenden Vorgang wieder aufnehmen. Ein anderer Administrator erhält keine fremden Anmeldecodes. Eine bestehende API-Key-Anmeldung wird als solche angezeigt und nie stillschweigend durch ein Abo ersetzt.

Ein Wechsel des Projektprofils oder Widerruf der Runner-Freigabe stoppt den Dienst. Erneutes **Verbinden** richtet den Dienst mit den aktuellen Berechtigungen wieder ein; vorhandene Anbieteranmeldungen bleiben erhalten. Der Runner-Zugang in HAPI und die Anmeldung beim Anbieter sind getrennte Berechtigungen.

## Schutz der Zugangsdaten

HAPI fragt keine Anbieterpasswörter ab. Die Anmeldung findet auf der offiziellen Anbieterseite statt. Der Hub vermittelt ausschließlich die kurzlebige Challenge. Anmeldecodes werden nicht in URLs, Browser-Speicher, Auditlogs oder Wissenseinträge geschrieben. Anbieterzugangsdaten liegen in `/runner/claude` beziehungsweise `/runner/codex`, mit privatem Home und ohne Zugriff auf den Hub-Tresor.

Der Hub besitzt keinen Docker-Socket. Ein gesonderter Hostdienst akzeptiert nur signierte, kurzlebige und wiederholungsgeschützte Projektaktionen über einen lokalen Unix-Socket. Er leitet Pfade und Container selbst ab. Ein unprivilegierter Helfer im Runner beendet native Loginprozesse bei Abbruch, Ablauf, verlorener Verbindung oder ausbleibender Berechtigungsbestätigung. Fortsetzung erfordert dieselbe gültige HAPI-Sitzung, Projektrolle, Runner-Freigabe und dasselbe Profil.

Ein Status **Verbunden** bedeutet, dass die native CLI die Anmeldung bestätigt hat. Eine kostenpflichtige Modellanfrage und die verbleibende Abo-Kapazität sind davon getrennte Prüfungen.

## Modelle auswählen

In **Neue Sitzung**, in den Modelleinstellungen des Chats und beim Start eines spezialisierten Agenten stammt die Claude-/Codex-Auswahl aus dem nativen CLI-Katalog des Projekts. Beim ersten Öffnen ohne aktuellen Katalog fragt HAPI ihn für Projektadministratoren automatisch ab. **Liste aktualisieren** wiederholt diese Abfrage ausdrücklich. Projektmitglieder lesen den zuletzt abgefragten Katalog; sie starten dadurch keinen zusätzlichen CLI-Prozess.

Die Anzeige nennt den Prüfzeitpunkt und markiert veraltete Daten. Eine CLI kann ihrerseits zwischengespeicherte oder mitgelieferte Modelle melden. HAPI garantiert deshalb weder einen ungepufferten Anbieterabruf noch die Freigabe jedes Modells für dein Konto. Die tatsächliche Freigabe prüft der Anbieter beim Start. Die Katalogabfrage sendet keinen Prompt und startet keine Modellinferenz.

Kataloge gelten fünf Minuten als frisch; ältere gespeicherte Ergebnisse sind als veraltet markiert. **Liste aktualisieren** umgeht den HAPI-Cache; den eigenen Cache des Anbieters verändert HAPI nicht. Nach An- oder Abmeldung wird der HAPI-Katalog verworfen. Während einer laufenden Anmeldung startet keine Modellabfrage auf diesem Projektrunner, damit Codeeingabe und Abbruch erreichbar bleiben. Bei fehlender Anmeldung, Verbindungsfehlern oder einer ungültigen Antwort erscheint ein entsprechender Status, keine fest eingebaute Ersatzliste.

Die Quelle ist der verwaltete Projektrunner. Bei einem anderen manuell verbundenen Runner können Konto und Modelle abweichen. **Abo** und **API-Schlüssel** bleiben getrennte Anmeldemethoden: Ein Abo ist kein Schlüssel für die öffentliche Models-API. Codex verwendet den dokumentierten [App-Server-Katalog `model/list`](https://learn.chatgpt.com/docs/app-server); dessen Antwort kann laut [OpenAI auch gebündelte Daten enthalten](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server). Claude meldet seine Modelloptionen über die native Initialisierung. Die Auflösung seiner [Modellaliase ist unter anderem von der CLI-Version abhängig](https://code.claude.com/docs/en/model-config). Ein aktueller HAPI-Prüfzeitpunkt bestätigt deshalb die erneute CLI-Abfrage und keine vollständig aktuelle Liste aller beim Anbieter neu veröffentlichten Modelle.

**Standard des Anbieters** überlässt die Auswahl der CLI. Über **Eigene Modell-ID** lässt sich eine neue oder besondere ID ausdrücklich eingeben. Eine bestehende Auswahl bleibt beim Aktualisieren erhalten, auch wenn sie nicht mehr im Katalog steht. Ungültige oder nicht freigegebene IDs führen zu einem sichtbaren Anbieterfehler und werden nicht stillschweigend durch ein anderes Modell ersetzt.
