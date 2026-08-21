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

## Was wo hingehört — und wohin es am Ende soll

**Grundhaltung: Deutsche Korrekturen gehören upstream.** Der `locales`-Mechanismus ist genau dafür gebaut — deren `en.json5` korrigiert englische Strings, unsere `de.json5` korrigiert deutsche. Dieselbe Struktur, dasselbe Schema. Deutsch fehlt dort nur, weil es bisher niemand beigetragen hat.

Drei Gründe:
1. **Fair.** Wir leben von 211 Korrekturen, die andere gepflegt haben. Deutschsprachige Nutzer von tarkovtracker.org hätten denselben Nutzen.
2. **Billiger für uns.** Was upstream landet, pflegen wir nicht mehr. Jeder Eintrag, der hier liegen bleibt, ist Ballast bei jedem Merge.
3. **MIT-Lizenz**, also geringe Hürde.

### Dieses Repo ist die Vorstufe, nicht das Endlager

| Fall | Weg |
|---|---|
| Deutsche Übersetzung objektiv falsch/fehlend | hier eintragen, testen, **dann als PR upstream** |
| Sachlicher Datenfehler (Level, Map, Händler) | **direkt** Upstream-PR gegen `src/overrides/tasks.json5` — nie hier |
| Stammtisch-spezifische Formulierung | bleibt hier |
| Upstream lehnt ab / PR hängt | bleibt hier, bis geklärt |

**Ablauf:** Eintrag hier → bauen → im Tracker prüfen, dass die Übersetzung ankommt → PR an Upstream. Wird er gemerged, **Eintrag hier wieder entfernen** (der nächste `git merge upstream/main` bringt ihn dann von dort mit). `npm run check-overrides` hilft dabei: es meldet, was Upstream inzwischen selbst abdeckt.

So bleibt diese Datei dauerhaft klein — sie enthält idealerweise nur, was gerade unterwegs oder bewusst unser ist.

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
