# Fork-Abweichungen — Tarkov Stammtisch Daten-Overlay

Privater Fork von [tarkovtracker-org/tarkov-data-overlay](https://github.com/tarkovtracker-org/tarkov-data-overlay) (**MIT**).

> ⚠️ **Namensverwirrung:** „Overlay" bedeutet bei uns drei verschiedene Dinge.
> Dieses Repo ist das **Spieldaten-Overlay**: Korrekturen an den Quest-/Item-Daten von tarkov.dev. Reines JSON, keine Darstellung.
> Nicht zu verwechseln mit dem **Theme** des Trackers (Farben, liegen im App-Fork in `tailwind.css`/`app.config.ts`) und nicht mit den **OBS-Overlays** für Streams auf der Hauptseite.

Zugehörig: App-Fork [`miwidot/stammtisch-tracker`](https://github.com/miwidot/stammtisch-tracker) · Epic [#1293](https://github.com/miwidot/tarkov-stammtisch/issues/1293)

---

## Warum wir das forken

Der Tracker unterstützt **genau eine** Overlay-Quelle. Zeigt `OVERLAY_URL` auf eine eigene Datei, ist das Upstream-Overlay **komplett weg** — inklusive aller Korrekturen.

Praktisch gemessen: Ein eigenes Test-Overlay liess die Task-Anzahl von **487 auf 517** springen, weil rund 30 per `disabled: true` ausgefilterte Tasks wieder auftauchten. Dazu wären alle 211 Task-Korrekturen verloren gegangen.

Der Fork löst das: wir bauen **eine** Datei, die Upstream-Korrekturen **und** unser Deutsch enthält.

---

## Unsere einzige Abweichung

| Datei | Art | Kosten pro Upstream-Merge |
|---|---|---|
| `src/overrides/locales/de.json5` | **neue Datei** | **null** — existiert upstream nicht, kann nie konfliktieren |
| `FORK.md` | neue Datei | null |

Das ist alles. Keine Änderung an einer einzigen Upstream-Datei.

Der Build (`scripts/build.ts`) lädt **alle** JSON5-Dateien aus `src/overrides/locales/` — es gibt keine Sprach-Allowlist, `de.json5` wird automatisch eingesammelt. Bestätigt im Build-Log: `Locales: de(tasks: 0), en(tasks: 3)`.

---

## Was wo hingehört

**In unsere `de.json5`:** Korrekturen am *deutschen* Bundle von tarkov.dev. Fehlende, falsche oder unverständliche Übersetzungen.

**NICHT in unsere `de.json5`, sondern als PR an Upstream:** sachliche Datenfehler (falsches Level, falsche Map, falscher Händler). Die sind sprachunabhängig und betreffen alle Nutzer des Overlays — die gehören in `src/overrides/tasks.json5` **upstream**, nicht in unseren Fork.

Faustregel: *„Der deutsche Text ist falsch"* → unser Fork. *„Die Daten sind falsch"* → Upstream-PR.

MIT-Lizenz macht Rückgaben hier unkomplizierter als beim App-Fork (GPL-3).

---

## Ablauf

### Übersetzung ergänzen
1. Eintrag in `src/overrides/locales/de.json5`, mit Beleg als Kommentar (Wiki-Link oder `json.tarkov.dev`-URL)
2. `npm run build` → erzeugt `dist/overlay.json`
3. Ausliefern (siehe unten)

### Upstream nachziehen
```bash
git fetch upstream
git merge upstream/main      # unsere de.json5 ist neu -> kein Konflikt möglich
npm run build
git push origin main
```

### Ausliefern
Der Tracker liest `OVERLAY_URL` **zur Laufzeit** — eine geänderte Overlay-Datei braucht **keinen** Neubau der App, nur einen Neustart bzw. den nächsten Cache-Ablauf (TTL 1 h, `OVERLAY_CACHE_BUSTER` erzwingt sofort).

⚠️ **`OVERLAY_URL` muss HTTPS sein** (seit App-Version 1.73.2 zwingend, PR #755 upstream). Ein `http:`-Overlay fällt **still** auf die Upstream-Adresse zurück — keine Fehlermeldung, unsere Übersetzungen sind einfach weg.

⚠️ **`$meta.version` ist Pflicht** in der ausgelieferten Datei. Fehlt sie, wird das komplette Overlay **still verworfen**. Der Build setzt sie automatisch.

---

## Nützliche Upstream-Werkzeuge (bekommen wir geschenkt)

| Befehl | Zweck |
|---|---|
| `npm run build` | erzeugt `dist/overlay.json` |
| `npm run validate` | prüft gegen die JSON-Schemata |
| `npm run check-overrides` | meldet Korrekturen, die Upstream **inzwischen selbst behoben** hat → bei uns entfernbar |
| `npm run wiki:compare` | Abgleich gegen das Fandom-Wiki |
| `npm run eft:audit` | Datenabgleich gegen die Spieldaten |
| `npm run monitor` | Weboberfläche zum Durchsehen |

`check-overrides` ist auf Dauer der wichtigste: er verhindert, dass wir Korrekturen mitschleppen, die längst überflüssig sind.

---

## Rauchtest nach jedem Upstream-Merge

- [ ] `npm run build` läuft durch, Log zeigt `Locales: de(tasks: N)` mit unserem N
- [ ] `npm run validate` grün
- [ ] `$meta.version` in `dist/overlay.json` vorhanden
- [ ] Ein bekannter deutscher Quest-Name kommt im laufenden Tracker an
- [ ] Task-Anzahl im Tracker plausibel (nicht plötzlich ~30 mehr — das hiesse, das Upstream-Overlay fehlt)
- [ ] `npm run check-overrides` durchsehen: was hat Upstream inzwischen selbst gefixt?
