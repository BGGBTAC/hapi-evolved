# Beispiel: Django-Entwicklungsmodul

`hapi-evolved.plugin.json` in diesem Ordner ist ein vollständiges Plugin mit
`schemaVersion: 2`: ein Entwicklungsmodul `django`, ein Review-Spezialist
`django-reviewer` und ein Skill. Format, Lebenszyklus und Grenzen beschreibt
[Entwicklungsmodule als Plugin bereitstellen](../../../docs/evolved/DEVELOPMENT_MODULES.md).

## Installieren

Der Installer liest **nur** `hapi-evolved.plugin.json` im Stamm eines **öffentlichen**
GitHub-Repositorys. Dieser Unterordner wird nicht automatisch installiert.

1. Neues öffentliches Repository anlegen, z. B. `<owner>/hapi-django-kit`.
2. `hapi-evolved.plugin.json` aus diesem Ordner in den Stamm kopieren und committen.
3. Lokal prüfen: `hapi evolved plugin validate <pfad-zum-repo>`. Notiere den Digest.
4. In HAPI unter **Agenten** (`/evolved?tab=agents`) im Plugin-Bereich `<owner>/hapi-django-kit` und den Commit angeben,
   Vorschau öffnen (Digest vergleichen), Installation bestätigen.
5. In einem Projekt mit freigegebenem Django-Repository unter **Entwicklung** das Modul
   „Django“ wählen, Projektordner und Django-Reihe setzen, speichern.

Die Aktivierung installiert nichts. Das Projekt-venv entsteht erst durch die Aufgabe
„Projekt-venv einrichten“; Tests, Migrations- und Systemprüfungen sind eigene Aufgaben.

## Lokal ausprobieren

```sh
hapi evolved plugin validate examples/plugins/django
hapi evolved development doctor --local --definition examples/plugins/django
hapi evolved development inspect --local --definition examples/plugins/django --checkout ./mein-django-repo
```

## Inhalt und Quellen

Handbuchthemen: unterstützte Django-Reihen und Python-Versionen, Tests mit
`manage.py test`, Migrationen, `DJANGO_SETTINGS_MODULE`, Systemprüfungen,
projekteigenes venv. Alle Quellen sind Primärdokumentation (djangoproject.com,
docs.python.org, pip.pypa.io) und wurden am 2026-10-18 abgerufen. Versionsangaben
(z. B. 6.1.2 als neueste Version) gelten für dieses Datum; die im Projekt festgelegte
Version hat immer Vorrang. Wer das Plugin weiterpflegt, prüft die Quellen erneut und
erhöht `contentVersion` und `version`; Projekte übernehmen die neue Fassung
ausdrücklich.
