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

Stand 2026-11-21, gemessen mit `git diff upstream/main --stat`. Alles, was wir früher selbst trugen (`de.json5`, `status-locale`, Tests, `package.json`-Zeile, `ci.yml`), ist inzwischen upstream.

### Gelöscht — kostet bei jedem Merge einen Handgriff

| Datei                    | Was                                         | Handgriff beim Merge                                        |
| ------------------------ | ------------------------------------------- | ----------------------------------------------------------- |
| `.github/dependabot.yml` | gelöscht (kein Dependabot im privaten Fork) | Konflikt „deleted in HEAD": `git rm .github/dependabot.yml` |

`ci.yml` und `release.yml` weichen **nicht** mehr ab. Näheres zu `release.yml` unten.

### Neue Dateien — kosten beim Merge nichts

| Datei                                                                                                                         | Zweck                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `FORK.md`                                                                                                                     | dieses Dokument                                                                                           |
| `scripts/build-catalogs.ts`                                                                                                   | Erzeuger-Schritt: Overlay bauen, Tracker-Produzent laufen lassen, Kataloge atomar veröffentlichen         |
| `scripts/producer/*`                                                                                                          | Bausteine dazu (`lib`, `tracker`, `https-server`, `process`) und `tracker.lock.json` (Pin)                |
| `scripts/producer/cron-run.sh`, `scripts/producer/prune-tools.ts`                                                             | Cron-Wrapper mit Discord-Alarm (Fehler, veraltete Daten) und optionales Aufräumen alter Tracker-Checkouts |
| `scripts/parity.ts`, `scripts/parity/*`                                                                                       | Paritätsprüfung gegen tarkovtracker.org                                                                   |
| `tests/producer-lib.test.ts`, `tests/producer-cron.test.ts`, `tests/build-catalogs.test.ts`, `tests/parity-normalize.test.ts` | Tests dazu                                                                                                |

### Geänderte Upstream-Dateien

| Datei          | Was                                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------------- |
| `package.json` | zwei Zeilen unter `scripts`: `build:catalogs` und `parity` (Konfliktrisiko gering, nur bei Änderungen direkt daneben) |

### `dist/` fassen wir nicht an

Upstream checkt `dist/overlay.json` und `dist/overlay-neutral.json` ein; ein Release-Workflow erzeugt sie und tagt. Bei uns liest niemand die eingecheckten Dateien — der Server baut selbst. Deshalb:

- **Niemals selbst committen.** Nach `npm run build` ist das Arbeitsverzeichnis schmutzig (neuer Zeitstempel und Hash) — das ist normal, verwerfen mit `git checkout -- dist/`.
- Beim Upstream-Merge bringt upstream die Dateien mit; sie konfliktieren nur, wenn jemand bei uns eine eigene Fassung eingecheckt hat. Dann `git checkout --theirs dist/` bzw. `git checkout upstream/main -- dist`.
- **Versionskennung:** `npm run build` nimmt die höchste Tag-Version, die in `HEAD` **enthalten** ist (`git tag --merged HEAD`). Wer mitten in einem noch nicht abgeschlossenen Merge baut, bekommt die alte Version (so geschehen: 1.102 statt 1.184). Erst den Merge committen, dann bauen.

⚠️ **`release.yml` läuft nach jedem erfolgreichen CI-Lauf auf `main` und committet, taggt und pusht `dist/`.** Das ist upstreams Release-Weg, in unserem privaten Fork aber unerwünscht (zwei Historien für ein Artefakt). Es steht **nicht** in dieser Datei, sondern muss in den GitHub-Einstellungen des Forks abgeschaltet sein (Actions → Release overlay → Disable, oder Actions ganz aus). Ob das heute so ist, ist hier nicht geprüft.

⚠️ **Die eine Falle:** Wer je ohne `npm run build` deployt, liefert upstreams Overlay **ohne unsere lokalen Änderungen** aus. Heute gibt es keine (Abweichung = null Daten), aber die Falle kommt zurück, sobald wir wieder etwas Eigenes in `src/` haben.

---

## Katalog-Erzeuger (`npm run build:catalogs`)

Der Tracker liest seine Spieldaten (Quests, Items, Hideout, Strings) nicht mehr aus Cloudflare KV, sondern aus einem Verzeichnis (`TARKOV_DATA_DIR`). Dieses Verzeichnis füllt genau dieser Schritt — aus **diesem** Overlay und `json.tarkov.dev`.

```bash
npm run build:catalogs -- --out /var/lib/tracker-data
# danach:  TARKOV_DATA_DIR=/var/lib/tracker-data/current
```

Ablauf: Overlay bauen → Overlay-Paar prüfen (`overlay-neutral.json` muss aus genau diesem `overlay.json` stammen) → Tracker-Code auf dem **gepinnten** Commit auschecken → beide Dateien über einen kurzlebigen HTTPS-Server auf Loopback ausliefern (der Tracker akzeptiert nur `https:`) → Produzent läuft gegen `json.tarkov.dev` und dieses Overlay → Ergebnis in ein Staging-Verzeichnis → prüfen (Manifest, jedes Objekt vorhanden, Größe und SHA-256 stimmen) → `producer-manifest.json` schreiben → Verzeichnis umbenennen nach `releases/<id>` → Symlink `current` atomar umhängen → alte Releases aufräumen (`--keep`, Standard 4). **Jeder Fehler bricht ab, ohne etwas zu veröffentlichen**; das vorige Release bleibt aktiv.

**Warum ein gepinnter Git-Checkout** (statt Submodul oder Kopie): der Produzent importiert den halben App-Baum (`neutralCatalog`, `overlay*`, `tarkov-json`). Kopieren hieße, bei jedem Tracker-Sync Hunderte Dateien nachzuziehen; ein Submodul ändert `.gitmodules` und den Index dieses Forks, braucht Deploy-Key-Handling im Submodul und macht jeden Merge zum Zweitjob. Der Pin ist eine Datei (`scripts/producer/tracker.lock.json`, volle 40-stellige SHA, kein Branchname), der Checkout liegt **außerhalb** des Repos (`~/.cache/stammtisch-overlay-producer`, überschreibbar mit `--tools-dir`/`PRODUCER_TOOLS_DIR`) und wird bei jedem Lauf gegen den Pin und auf lokale Änderungen geprüft.

**Pin anheben:** neue Tracker-SHA in `tracker.lock.json` eintragen, `npm run build:catalogs` — der neue Checkout entsteht daneben. Der Pin muss aus unserem Tracker-Fork erreichbar sein (gepusht).

**Repo-URL:** `scripts/producer/tracker.lock.json` nennt `git@github.com:...`. Auf stammdev gehört der Deploy-Key des Tracker-Forks zum SSH-Alias `github-tracker`; dort `TRACKER_REPO=git@github-tracker:miwidot/stammtisch-tracker.git` setzen (oder `--tracker-repo`). Der Pin (Commit-SHA) bleibt in der Lock-Datei, nur die Quelle wird überschrieben.

**Cron-Betrieb (`scripts/producer/cron-run.sh`):**

```bash
17 */12 * * * CATALOG_OUT_DIR=$HOME/tracker-data TRACKER_REPO=git@github-tracker:miwidot/stammtisch-tracker.git ENV_FILE=$HOME/tarkov-stammtisch/.env /pfad/zum/overlay/scripts/producer/cron-run.sh run
47 *    * * * CATALOG_OUT_DIR=$HOME/tracker-data ENV_FILE=$HOME/tarkov-stammtisch/.env /pfad/zum/overlay/scripts/producer/cron-run.sh check-age
```

- `run` ruft `npm run build:catalogs -- --out <dir> --keep <N>` auf und postet bei Fehlschlag in den Discord-Systemlog (`DISCORD_SYSTEM_LOG_WEBHOOK`, aus der Umgebung oder als einzige Variable aus `ENV_FILE` gelesen, die Datei wird nicht ausgeführt; die URL wird nie geloggt oder als Argument übergeben).
- `check-age` alarmiert, wenn das aktive Release älter als `STALE_HOURS` (30) ist oder kein Manifest lesbar ist; Wiederholung höchstens alle `ALERT_REPEAT_HOURS` (6).
- **Löschen, ausdrücklich:** (1) Alte **Releases** räumt der Produzent selbst auf (`--keep`, Standard 4): nur Verzeichnisse `<out>/releases/<id>` mit gültigem Release-Namen, nie das aktive, nie Symlinks; leere, relative, `/`, Home- und Top-Level-Pfade werden abgelehnt. (2) Alte **Tracker-Checkouts** (`tracker-<sha12>`, je rund 1 GB) löscht nur `prune-tools.ts` und nur, wenn `PRODUCER_TOOLS_KEEP` gesetzt ist (Standard: nie). Es entfernt ausschließlich direkte Unterverzeichnisse `tracker-<12 hex>` mit `.producer-ready`-Marker, nie den gepinnten, nie Symlinks. Trockenlauf: `npx tsx scripts/producer/prune-tools.ts --tools-dir <dir> --keep 2 --dry-run`.

**`manifest`:** `releases/<id>/producer-manifest.json` enthält Overlay-Version, -Zeitstempel und -SHA (beider Dateien), Tracker-Repo und -Commit, Quelle (`json.tarkov.dev`), Zeitstempel des Laufs, Anzahl Objekte/Dateien/Bytes und die SHA-256 jeder Datei.

Der Produzent bekommt nur eine Allowlist an Umgebungsvariablen — keine Cloudflare-Zugangsdaten, kein `OVERLAY_TOKEN`.

### Parität gegen tarkovtracker.org

```bash
npm run parity -- fetch-live --out /tmp/live
npm run parity -- compare --live /tmp/live --catalogs <out>/current --overlay dist/overlay.json --report parity.md --json parity.json
```

Es werden nur die öffentlichen `GET /api/tarkov/*`-Endpunkte abgefragt, nacheinander, mit Pause und ehrlichem User-Agent. Bei 403/429 bricht der Lauf ab; es wird nichts umgangen. Normalisiert werden ausschließlich `dataOverlay.generated`, `dataOverlay.sha256`, `dataOverlay.sourceUrl` und `storedAt`; jede Normalisierung steht im Bericht. `dataOverlay.version` wird bewusst **nicht** normalisiert.

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
git fetch upstream --tags
git merge upstream/main      # Konflikt nur bei .github/dependabot.yml (git rm); dist/ kommt von upstream
npm run validate             # Quelle sauber?
npm run build                # Rauchtest, danach: git checkout -- dist/
git push origin main
```

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
