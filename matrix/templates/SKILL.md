---
name: matrix
description: Query the Matrix knowledge graph of this project - the default place to look things up before reading source. Use to find where something lives, what connects to what, or how one thing reaches another; also to rebuild the graph or open the universe view. Triggers: "matrix", "knowledge graph", "where is", "what connects", "how does X reach Y", "what touches", "rebuild the graph", "reindex", "open the universe".
---

# Matrix knowledge graph

Matrix is a stdlib-only Python knowledge graph of this project: code, notebooks,
SQL, markdown docs (and optionally a notes/memory folder). Every edge is tagged
with how it was obtained. Query it **before** grepping or opening files - one
command answers structural questions that would otherwise cost many file reads.

Interpreter: `{PY}`
Install dir: `{MX}`
Config: `{CONFIG}`
Output: `{OUT}`

## Read these first

| File | What it gives you |
|---|---|
| `{OUT}\INDEX.md` | one line per community (cluster), linking to a wiki article |
| `{OUT}\GRAPH_REPORT.md` | hub nodes, communities, parse errors |
| `{OUT}\wiki\*.md` | per-community article listing nodes and edges |
| `{OUT}\graph.html` | interactive 3D universe - for the user, not for you |

Do not read the raw graph file directly - it is large. Query it.

Note: `graph.html` lists every registered universe (name, root folder, install
and interpreter paths) for its Multiverse switcher. Set `"embed_scopes": false`
in the config to keep only this one if the file is shared.

## Commands

```
"{PY}" "{MX}\query.py" find "auth token"                    # ranked text search (--json for machine output)
"{PY}" "{MX}\query.py" explain UserService                  # a node and every edge touching it
"{PY}" "{MX}\query.py" path OrderController Database        # how two things connect
"{PY}" "{MX}\query.py" neighbors UserService -d 2           # local subgraph, 2 hops
"{PY}" "{MX}\query.py" stats                                # graph shape and provenance counts
```

`-l N` caps list length (default 20) and `--config F` queries another config;
both go before or after the subcommand. Names match on exact id, then
exact label, then substring; an ambiguous name prints its candidates - rerun
with a more specific one.

## Provenance - say which tier you rely on

- `EXTRACTED` - stated in the source (import, definition, link). Reliable.
- `INFERRED` - resolved across files by the indexer. Usually right, occasionally
  a coincidence. Verify in the source before acting on it.
- `AMBIGUOUS` - several candidates matched. A lead, not a fact.

Every answer drawn from the graph must state which tier it rests on.

## Rebuilding

```
"{PY}" "{MX}\indexer.py" --if-stale --quiet    # incremental; exits at once if nothing changed
"{PY}" "{MX}\indexer.py" --full                # ignore the cache, rebuild from scratch
"{PY}" "{MX}\indexer.py" --config "{CONFIG}"   # build with an explicit config
```

A Stop hook runs the `--if-stale --quiet` build at the end of every turn that
changed a file, so the graph is normally current. Run `--full` after editing the
config or after changes made outside the session.

## Universe UI

Open `{OUT}\graph.html` in a browser: double-click it, or run
`{OPEN}` (any shell; in PowerShell put `& ` in front).
It is a self-contained offline page: groups form clusters, node types form
galaxies, hubs are the bright centres.

## Multiverse (other folders, one switcher)

Each indexed folder is a universe; the registry (`$MATRIX_HOME/scopes.json`,
default `~/.claude/matrix`) is shared by every install. This project is its
`home` universe. **Open the Multiverse with `matrix`** in any terminal: it
starts the local engine if needed (127.0.0.1 only, per-run key and token)
and opens the browser; use the page's **Multiverse** button to browse, add,
build, stop and switch universes.

```
matrix                                         # open (starts the engine if needed)
matrix status | matrix list | matrix stop      # engine state / universes / stop the engine
matrix add "D:\proj" --name Proj --build       # register a folder and build it
matrix build <id|name> [--full] [--force]      # (re)build; --force passes the max_files cap
matrix stop-build <id|name>                    # stop a running build
```

The `matrix` launcher was installed by setup.py (rerun it to repair; it
points at the most recently installed copy via `$MATRIX_HOME/launcher.json`).
Without it, the same through the scripts:

```
"{PY}" "{MX}\serve.py" --open                  # prints the URL; Ctrl+C stops
"{PY}" "{MX}\scopes.py" list                   # terminal: list universes
"{PY}" "{MX}\scopes.py" add "D:\proj" --name Proj
"{PY}" "{MX}\scopes.py" build <id>             # build/rebuild one universe
"{PY}" "{MX}\scopes.py" rename <id> <name>
"{PY}" "{MX}\scopes.py" remove <id>
```

Added universes keep their config, graph and `last_build.log` in
`$MATRIX_HOME/scopes/<id>/` and write nothing into the folder itself. A whole
drive skips its Windows / Program Files / ProgramData / AppData folders, and a
build from scratch refuses more than `max_files` (default 60000) files unless
confirmed ("Index anyway" / `--force`). Query one with
`"{PY}" "{MX}\query.py" --config <that config.json> find ...`.

## Config

`{CONFIG}` (JSON; defaults apply for omitted keys). Relative paths resolve
against the config file's directory. Key options:

- `roots` - folders to index: paths or `{"path", "label"}`
- `memory` - optional notes folder, indexed as root `memory`
- `ignore_dirs`, `ignore_globs`, `ignore_paths` - names, globs and folders never walked
- `data_dirs` - walked for source/docs only; big/data files become dataset nodes
- `data_exts`, `max_file_bytes` - what counts as a data file / size cap
- `out_dir` - where the graph, wiki, search db and `graph.html` are written
- `adf_json` - optional data-factory JSON extraction (default off)
- `claims` - parse claim headings in docs (default on)
- `title` - browser title of `graph.html`
- `max_files` - a build from scratch refuses roots holding more files (default 60000; 0 = no cap; `--force` overrides)
- `embed_scopes` - list the other universes in `graph.html` (default true)

After changing the config, rebuild with `--full`.

## Troubleshooting

- **Stale or missing results**: run `indexer.py --full`; confirm the file's folder is under a `roots` entry and not in an ignore list.
- **Ambiguous name**: use the full id or label shown in the candidate list, or `find` first.
- **No path found**: the link may not be statically visible (dynamic calls, config-driven wiring); fall back to reading source.
- **Binary/Office/PDF files**: appear only as dataset nodes; there is no text extraction.
