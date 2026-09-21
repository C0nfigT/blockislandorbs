# Glass Float Atlas

A map of Block Island showing where glass floats have been reported found, from 2012 through the current season. Filter by year and by month. Trails and individual finds are on by default.

## Run it

From this directory:

```bash
python3 -m http.server 8080
```

Open http://localhost:8080.

The page loads `data/finds.json`, so it needs a local server. Opening the HTML file directly will not work.

## GitHub Pages

The same files are a static site. With GitHub Pages set to the `main` branch and the repository root, the map is served at:

https://c0nfigt.github.io/blockislandorbs/

Styles, scripts, and the find data use relative paths. Leaflet, the typefaces, and the map tiles load from public CDNs. `.nojekyll` tells GitHub not to run Jekyll, which would otherwise ignore or rewrite the data files.

## Where the data comes from

Finds are the public registry at the [Block Island Tourism Council](https://www.blockislandinfo.com/glass-float-project/found-floats/?bounds=false&view=list&sort=date), which also includes the older [found-float archive](https://www.blockislandinfo.com/glass-float-project/found-float-archives/).

Finders describe a place in words (“Rodman’s Hollow”, “in a tree on Clay Head”). The registry’s own map coordinates are almost all the tourism office, so they are not used. `scripts/build_finds.py` matches each description to a named place on the island and nudges the dot a short, stable distance so a crowd of finds becomes a heat map instead of one stacked point.

Months are the registration date. Finds copied in from the archive were stamped January 1 and are treated as undated. A month filter is meaningful from 2024 on.

This is a map of past reports, not of where floats are hidden now.

## Refresh the data

```bash
python3 scripts/build_finds.py
```

That rebuilds `data/finds.json` from `data/raw_finds.json`. To pull a new registry snapshot, re-run the download against the tourism council’s public events API and replace `data/raw_finds.json`, then rebuild.
