<!-- matrix:begin -->
## Matrix knowledge graph

`{OUT}` holds a knowledge graph of this project (code, notebooks, SQL, docs),
with every edge tagged by how it was obtained. **Query it before grepping or
opening files** to answer "where does X live", "what does Y touch", "how do
these connect".

```
"{PY}" "{MX}\query.py" find "auth token"
"{PY}" "{MX}\query.py" explain UserService
"{PY}" "{MX}\query.py" path OrderController Database
```

**Provenance:** `EXTRACTED` is stated in the source and reliable. `INFERRED`
was resolved across files by the indexer - verify before acting. `AMBIGUOUS` is
a lead, not a fact. Say which tier an answer relies on.

Orientation: `{OUT}\INDEX.md`, `{OUT}\GRAPH_REPORT.md`. Interactive universe view:
`{OUT}\graph.html`. Other indexed folders (universes) and the Multiverse
switcher: open with `matrix` in any terminal (or
`"{PY}" "{MX}\serve.py" --open`). The graph rebuilds automatically at
the end of any turn that changed a file. See the `matrix` skill for the full
command set.
<!-- matrix:end -->
