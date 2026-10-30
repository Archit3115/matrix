# Security policy

## Supported versions

Matrix is a small project with a single maintainer. Security fixes are made on `main` and shipped in the next
release. Only the latest release, and `main` itself, are supported.

| Version | Supported |
|---|---|
| `main` and the latest release | Yes |
| Older releases or copies installed from them | No: update by re-running `setup.py` from a current checkout |

`setup.py` is idempotent, so updating an install is a re-run: `python matrix/setup.py <your-project>`.

## Reporting a vulnerability

**Please do not report security problems in public issues, pull requests or discussions.**

Report them privately through GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability**
   ([direct link](https://github.com/Archit3115/matrix/security/advisories/new)).
3. Describe the problem, the affected file or route, the steps to reproduce it, and the impact you expect.

Only the maintainer, [@Archit3115](https://github.com/Archit3115), can see the report. You can expect:

- an acknowledgement within 7 days;
- an assessment, and either a fix plan or an explanation, within 30 days;
- credit in the advisory and release notes, if you would like it.

Please give us a reasonable chance to release a fix before you disclose the problem publicly. If you are unsure
whether something is a security issue, report it privately anyway.

## Scope

Matrix is a local, single-user tool. It calls no model or cloud service, and the graph page loads nothing from the
network. The parts most relevant to security are:

### The Multiverse engine (`matrix/serve.py`)

- It binds **`127.0.0.1` only**. There is no remote or multi-user mode, by design.
- Every run creates a fresh random **API token** and a separate random **page key**. Pages are served only under the
  per-run secret path `/s/<key>/`. Each page served there carries the token, and every `/api/*` call must send it in
  the `X-Matrix-Token` header.
- No cookies are used, because browsers share cookies across ports on `127.0.0.1`.
- The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`, which blocks DNS-rebinding attacks. An `Origin`
  header, if present, must be the engine's own.
- Responses carry a restrictive Content-Security-Policy (`frame-ancestors 'none'`, `connect-src 'self'`, and more).
  Request bodies are size-limited.
- The running engine's port, URL and token are recorded in `$MATRIX_HOME/engine.json` for the `matrix` launcher, and
  the file is removed on a clean shutdown. Anyone who can read your home folder can read that token. That is within
  the threat model of a single-user tool, but report anything that widens it.

In scope, for example: a web page or another local user reaching the engine's API without the token; bypassing the
`Host` or `Origin` checks; path traversal out of a universe's output folder; a build or registry change triggered
without the token; or a way to make the engine bind to anything other than loopback.

### The indexer and the graph page

- The indexer reads files and never executes them. Python is parsed with `ast`, and everything else with small
  structural parsers.
- `graph.html` embeds labels, paths and text taken from the indexed files. These are treated as untrusted and escaped
  before they are rendered.

In scope, for example: a crafted file in an indexed folder that leads to script execution in `graph.html` (XSS); a
crafted file that makes the indexer write outside its output folder or run code; or `setup.py` writing outside the
target folder, `$MATRIX_HOME` and the launcher folder.

### Out of scope

- Attacks that already need control of your user account, your Python interpreter or the folders you chose to index.
- Information you chose to put in a `graph.html` and then shared. By default a page embeds the registered universes'
  names and paths for the Multiverse switcher. Set `"embed_scopes": false` before sharing a page.
- Denial of service from indexing a very large folder you selected yourself.
- Problems in browsers, Python or the operating system. Please report those upstream.
