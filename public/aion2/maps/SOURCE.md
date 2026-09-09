# AION 2 map data

The map images and marker positions in this folder come from
**[AION2 Hub](https://aion2hub.com/maps)**. The marker database is their work,
not this project's. If you find it useful, visit and support the source.

They are kept here so the map works offline and so the app does not hit their
servers every time someone opens a zone.

## What is here

| File | Contents |
|---|---|
| `World_*.jpg`, `Abyss_*.jpg` | Zone maps, 4096×4096, assembled from the source tiles |
| `../../../src/games/aion2/data/maps/` | 4,799 markers, 77 region outlines, 25 categories |

## How it was assembled

The source serves each zone as a grid of 1024px `.webp` tiles named
`{map}_{column}_{row}`, with the marker data embedded in its JavaScript bundle.

Tiles were reassembled into one image per zone and saved as JPEG. Sides are
4096px, capped by the source's own resolution — half resolution for the largest
zones, full resolution for the smaller ones. This is why the map softens past
roughly 8× zoom, and why the viewer stops zooming at 12×.

This work was done for [Vibemacro](https://github.com/Helveticxa) and imported
here from that project's `assets/maps` by `scripts/import-map-data.mjs`. Nothing
in Aether's build fetches from the source.

### The Y axis

The source uses Leaflet with Y pointing up: `y=0` is the **bottom** edge of the
map. Coordinates are flipped once on import so that stored values run the same
way as the image. Checked against the site rather than assumed — a marker with
y=5208 is drawn 8192−5208=2984 from the top edge.

Aether's own model is world-space with Y up, and its projection flips once when
drawing, so `import-map-data.mjs` flips these image-space values back. One
convention, applied in one place.

### What was left out

The `monster` category (6,467 points in Verteron alone) and `creature` / Named
Boss (13 points across the Abyss maps) were deliberately not imported: they
blanket the map without helping anyone find anything.

Poeta and Ishalgen are empty because the source has no markers for those two
starter zones.

## Verification

Every packed marker was compared back against the raw data: none missing, none
displaced, every point in a valid group. All eight maps matched.
