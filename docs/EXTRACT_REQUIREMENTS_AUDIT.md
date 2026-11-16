# Extract requirement gaps

Checked against current tarkov.dev catalogs, captured regular build 1.3.0.0.48484,
fresh Seasonal build 1.3.0.2.48779, and the public references below. PvE values
come from the regular definitions' PvE fields; Regular and PvE were not freshly
recaptured. Public guides do not independently establish every game mode's rules.

## Secret exits fixed by the generator

The game keeps these in `secretExits`, separate from `exits`. The item's ID joins
the named exit to the required extraction intel; tarkov.dev independently exposes
the same item as `transferItem` with count one. Reading both lists resolves ten
displayed markers, plus Night Factory and Ground Zero 21+ catalog variants.
The [wiki extraction-intel list](https://escapefromtarkov.fandom.com/wiki/Keys_%26_Intel#Extraction_intel)
corroborates all ten associations.

| Map               | Extract                                      | Required intel                 |
| ----------------- | -------------------------------------------- | ------------------------------ |
| Factory           | Smugglers' Passage                           | Note with code word Ark        |
| Customs           | Smugglers' Boat; Smugglers' Bunker (ZB-1012) | Note with code word Voron      |
| Woods             | Railway Bridge to Tarkov                     | Minefield map (Woods)          |
| Lighthouse        | Passage by the Lake                          | Minefield map (Lighthouse)     |
| Shoreline         | Mountain Bunker                              | Note with code word Heartbeat  |
| Reserve           | Exit to Woods                                | Minefield map (Reserve)        |
| Streets of Tarkov | Smugglers' Basement                          | Note with code word Onyx       |
| Ground Zero       | Tartowers Sales Office                       | Note with code word Adaptation |
| The Labyrinth     | Ariadne's Path                               | Ariadne symbol key             |

## Public evidence for the remaining markers

Counts describe drawable markers, so Gate 3's PMC and Scav polygons count
separately. After excluding Ground Zero's foreign-map coordinates, 61 markers per
mode still lack complete game-derived rules. The public-source audit identifies
48 of those; it leaves 12 unlisted markers and one conflicting availability claim
for review. This audit does not turn third-party descriptions into captured rules.

The wiki's extraction tables describe the following 44 markers without special
item or equipment requirements. They remain candidates for explicitly sourced
curated rules. This does not mean they appear in every player's extraction list
or are open in every raid.

| Source                                                                                      | Extracts                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Factory](https://escapefromtarkov.fandom.com/wiki/Factory#Extractions)                     | Camera Bunker Door; Courtyard Gate; Gate 0; Gate 3 (PMC and Scav); Office Window                                                                                               |
| [Customs](https://escapefromtarkov.fandom.com/wiki/Customs#Extractions)                     | Administration Gate; Crossroads (Scav); Gate Near Medblock; Railroad to Port; Railroad to Reserve; Railroad to Tarkov; Reserve Checkpoint; Trailer Park (Scav); ZB-1011 (Scav) |
| [Woods](https://escapefromtarkov.fandom.com/wiki/Woods#Extractions)                         | Boat; Dead Man's Place; Eastern Rocks; Mountain Stash; Old Railway Depot; Scav Bunker; Scav House                                                                              |
| [Lighthouse](https://escapefromtarkov.fandom.com/wiki/Lighthouse#Extractions)               | Hideout Under the Landing Stage; Industrial Zone Gates; Path to Shoreline (Scav); Scav Hideout at the Grotto; Southern Road Landslide                                          |
| [Shoreline](https://escapefromtarkov.fandom.com/wiki/Shoreline#Extractions)                 | Admin Basement; East Wing Gym Entrance; Lighthouse (Scav); Road to Customs (Scav); Ruined Road                                                                                 |
| [Reserve](https://escapefromtarkov.fandom.com/wiki/Reserve#Extractions)                     | Checkpoint Fence; Depot Hermetic Door; Heating Pipe; Hole in the Wall by the Mountains                                                                                         |
| [Interchange](https://escapefromtarkov.fandom.com/wiki/Interchange#Extractions)             | Emercom Checkpoint (Scav); Railway Exfil (Scav)                                                                                                                                |
| [Streets of Tarkov](https://escapefromtarkov.fandom.com/wiki/Streets_of_Tarkov#Extractions) | Cardinal Apartment Complex Parking; Entrance to Catacombs; Klimov Shopping Mall Exfil; Near Kamchatskaya Arch; Sewer Manhole (Scav); Ventilation Shaft                         |

Four more markers have useful specific evidence:

- Factory Cellars and Med Tent Gate: the [current Factory table](https://escapefromtarkov.fandom.com/wiki/Factory#Extractions)
  requires the Factory emergency exit key (`5448ba0b4bdc2d02308b456c`) to open
  the door. Gate 0 is listed without a key requirement; old pre-rework guides
  should not override that table. These two key cues can be added to
  `extractCues`, but the missing mechanical baseline still needs a separate
  curated-rule representation before its unknown marker can be cleared.
- Customs Old Gas Station (Scav): the [Customs table](https://escapefromtarkov.fandom.com/wiki/Customs#Extractions)
  explicitly distinguishes always-available Scav access from the PMC opening cue.
  The PMC green-flare condition must not be copied onto the Scav marker.
- Customs Old Road Gate (Scav): [Tarkov.help's exit guide](https://tarkov.help/en/map/customs/extractions/old-road-gate-extraction-point)
  identifies a free Scav exit at the gates behind the dorms, without an additional
  item or equipment condition.

## Unresolved or contradictory entries

The following 12 markers have no matching current extraction-table entry in the
checked wiki pages or the current Tarkov.help map listings:

| Map               | Extracts requiring review                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| Factory           | Gate 2 (PMC)                                                                                        |
| Customs           | RUAF Roadblock (PMC and Scav); Sniper Roadblock; Factory Shacks; Warehouse 4; Passage Between Rocks |
| Shoreline         | Svetliy Dead End; Ruined House Fence; Cliff Descent (PMC)                                           |
| Interchange       | Hole in the Fence (PMC)                                                                             |
| Streets of Tarkov | Basement Entrance (Scav)                                                                            |

They may be outdated, mode-specific, or scene-defined. Their absence from these
sources is not enough to remove them, mark them unrestricted, or copy similarly
named exits from another map. In particular, Reserve's Cliff Descent requirements
do not establish Shoreline's identically named marker. These retain unknown rules.

Woods RUAF Roadblock (Scav) is a separate conflict: the
[wiki table](https://escapefromtarkov.fandom.com/wiki/Woods#Extractions) lists it as
always available without a special requirement, while
[Tarkov.help's exit guide](https://tarkov.help/en/map/woods/extractions/ruaf-roadblock-extraction-point-scav)
calls it optional and describes green smoke as its availability signal. Preserve
unknown availability until current in-game evidence resolves that disagreement.

The checked wiki revisions were Factory 362699, Customs 363971, Interchange
364904, Lighthouse 367830, Reserve 362703, Shoreline 367946, Streets of Tarkov
367947, and Woods 367948. They were retrieved through the MediaWiki API; raw
wikitext and private capture envelopes remain outside tracked source.
