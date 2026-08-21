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

## Unsere Abweichungen

### Neue Dateien — kosten beim Merge nichts

| Datei                            | Zweck                                                               | Ziel        |
| -------------------------------- | ------------------------------------------------------------------- | ----------- |
| `src/overrides/locales/de.json5` | die deutschen Korrekturen                                           | → upstream  |
| `scripts/status-locale.ts`       | Übersetzungsstand je Händler, `// Was:`-Drift, wirkungslose Patches | → upstream  |
| `tests/status-locale.test.ts`    | Tests dazu                                                          | → upstream  |
| `tests/duplicate-keys.test.ts`   | doppelte Schlüssel in den Override-Quellen                          | → upstream  |
| `FORK.md`                        | dieses Dokument                                                     | bleibt hier |

Der Build (`scripts/build.ts`) lädt **alle** JSON5-Dateien aus `src/overrides/locales/` — es gibt keine Sprach-Allowlist, `de.json5` wird automatisch eingesammelt.

### Geänderte Upstream-Dateien — kosten bei jedem Merge

| Datei                       | Was                                                                  | Ziel                                       |
| --------------------------- | -------------------------------------------------------------------- | ------------------------------------------ |
| `package.json`              | eine Zeile: `"status:locale": "tsx scripts/status-locale.ts"`        | verschwindet, wenn das Skript upstream ist |
| `tests/file-loader.test.ts` | prüft die `package.json` am Wurzelverzeichnis statt des Ordnernamens | → upstream, hilft jedem Fork               |
| `dist/overlay.json`         | eingecheckter Build — siehe unten                                    | bleibt, konstruktionsbedingt               |

### `dist/overlay.json` fassen wir nicht an

Upstream checkt die Datei mit Absicht ein — für sie ist sie das Produkt, die Standard-`OVERLAY_URL` des Trackers zeigt auf `raw.githubusercontent.com/.../dist/overlay.json`.

**Für uns ist sie es nicht.** Unser nginx liefert `~/overlay-fork/dist/overlay.json` aus, und der Server erzeugt diese Datei bei jedem Deploy selbst mit `npm run build`. Die eingecheckte Fassung liest bei uns niemand.

Solange auch unsere CI sie schrieb, gab es zwei Historien für ein erzeugtes Artefakt — und damit einen Konflikt bei **jedem** Upstream-Sync. Am 2026-08-21 dreimal in einer Sitzung, zweimal mit stillschweigend zurückgedrehten Inhalten.

Deshalb:

- Der Schritt `Commit dist` in `.github/workflows/ci.yml` ist bei uns auf `if: false` gesetzt. Die Tag- und Release-Schritte hängen daran und entfallen mit — auch das ist gewollt, ein Fork schneidet keine Releases. Die Versionskennung kommt weiterhin aus upstreams Tags (`git fetch upstream` holt sie mit).
- Unsere `dist/overlay.json` steht auf upstreams Stand und bleibt dort. Upstreams Änderungen laufen dadurch konfliktfrei durch.
- **Niemals selbst committen.** Nach einem lokalen `npm run build` ist das Arbeitsverzeichnis schmutzig — das ist normal, die Änderung gehört verworfen: `git checkout -- dist/`.

⚠️ **Die eine Falle, die dadurch entsteht:** Wer je ohne `npm run build` deployt, liefert upstreams Overlay **ohne unser Deutsch** aus — still, ohne Fehlermeldung. Der Deploy-Ablauf unten baut immer; weicht davon nicht ab.

---

## Was wo hingehört — und wohin es am Ende soll

**Grundhaltung: Deutsche Korrekturen gehören upstream.** Der `locales`-Mechanismus ist genau dafür gebaut — deren `en.json5` korrigiert englische Strings, unsere `de.json5` korrigiert deutsche. Dieselbe Struktur, dasselbe Schema. Deutsch fehlt dort nur, weil es bisher niemand beigetragen hat.

Drei Gründe:

1. **Fair.** Wir leben von 211 Korrekturen, die andere gepflegt haben. Deutschsprachige Nutzer von tarkovtracker.org hätten denselben Nutzen.
2. **Billiger für uns.** Was upstream landet, pflegen wir nicht mehr. Jeder Eintrag, der hier liegen bleibt, ist Ballast bei jedem Merge.
3. **MIT-Lizenz**, also geringe Hürde.

### Dieses Repo ist die Vorstufe, nicht das Endlager

| Fall                                         | Weg                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------- |
| Deutsche Übersetzung objektiv falsch/fehlend | hier eintragen, testen, **dann als PR upstream**                    |
| Sachlicher Datenfehler (Level, Map, Händler) | **direkt** Upstream-PR gegen `src/overrides/tasks.json5` — nie hier |
| Stammtisch-spezifische Formulierung          | bleibt hier                                                         |
| Upstream lehnt ab / PR hängt                 | bleibt hier, bis geklärt                                            |

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
git merge upstream/main      # de.json5 ist neu -> dort kein Konflikt möglich
npm run validate             # Quelle sauber?
npm run build                # dist/ neu erzeugen, NICHT von Hand mergen
git add dist/overlay.json && git commit --no-edit
git push origin main
```

`dist/overlay.json` konfliktiert dabei so gut wie immer — warum und wie, steht oben unter „Unsere Abweichungen".

### Ausliefern

Der Tracker liest `OVERLAY_URL` **zur Laufzeit** — eine geänderte Overlay-Datei braucht **keinen** Neubau der App, nur einen Neustart bzw. den nächsten Cache-Ablauf (TTL 1 h, `OVERLAY_CACHE_BUSTER` erzwingt sofort).

⚠️ **`OVERLAY_URL` muss HTTPS sein** (seit App-Version 1.73.2 zwingend, PR #755 upstream). Ein `http:`-Overlay fällt **still** auf die Upstream-Adresse zurück — keine Fehlermeldung, unsere Übersetzungen sind einfach weg.

⚠️ **`$meta.version` ist Pflicht** in der ausgelieferten Datei. Fehlt sie, wird das komplette Overlay **still verworfen**. Der Build setzt sie automatisch.

---

## Nützliche Upstream-Werkzeuge (bekommen wir geschenkt)

| Befehl                    | Zweck                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------- |
| `npm run build`           | erzeugt `dist/overlay.json`                                                             |
| `npm run validate`        | prüft gegen die JSON-Schemata                                                           |
| `npm run check-overrides` | meldet Korrekturen, die Upstream **inzwischen selbst behoben** hat → bei uns entfernbar |
| `npm run wiki:compare`    | Abgleich gegen das Fandom-Wiki                                                          |
| `npm run eft:audit`       | Datenabgleich gegen die Spieldaten                                                      |
| `npm run monitor`         | Weboberfläche zum Durchsehen                                                            |

`check-overrides` ist auf Dauer der wichtigste: er verhindert, dass wir Korrekturen mitschleppen, die längst überflüssig sind.

---

## Rauchtest nach jedem Upstream-Merge

- [ ] `npm run build` läuft durch, Log zeigt `Locales: de(tasks: N)` mit unserem N
- [ ] `npm run validate` grün
- [ ] `$meta.version` in `dist/overlay.json` vorhanden
- [ ] Ein bekannter deutscher Quest-Name kommt im laufenden Tracker an
- [ ] Task-Anzahl im Tracker plausibel (nicht plötzlich ~30 mehr — das hiesse, das Upstream-Overlay fehlt)
- [ ] `npm run check-overrides` durchsehen: was hat Upstream inzwischen selbst gefixt?
