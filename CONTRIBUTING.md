# Contributing to Matrix

Thanks for helping. Anyone can contribute: bug reports, docs fixes, new file extractors, UI improvements. This page
covers how a change gets from your fork into `main`.

- [How a change gets in](#how-a-change-gets-in)
- [Setting up](#setting-up)
- [Running the tests](#running-the-tests)
- [Coding rules](#coding-rules)
- [Commit messages](#commit-messages)
- [Sign-off (optional)](#sign-off-optional)
- [CI and required checks](#ci-and-required-checks)
- [Reporting bugs and security problems](#reporting-bugs-and-security-problems)

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

---

## How a change gets in

1. **Fork** the repository on GitHub and clone your fork.
2. **Branch** from `main` with a short, descriptive name, such as `fix-sql-view-edges` or `feat-toml-extractor`.
3. **Change** one thing per pull request. Small, focused PRs are reviewed fastest.
4. **Test** locally (see below), and update the docs if anything a user sees has changed.
5. **Open a pull request** against `main` and fill in the checklist in the template.
6. **CI runs** on your PR. A maintainer may need to approve the first workflow run from a new contributor.
7. **Review.** The maintainer, [@Archit3115](https://github.com/Archit3115), is the code owner of the whole repository.
   Every change is reviewed and merged by the maintainer only. Expect questions or change requests. Push follow-up
   commits to the same branch, and do not force-push once a review has started, so the review history stays readable.
8. **Merge.** When CI is green, review threads are resolved and the PR is approved, the maintainer squash-merges it.
   `main` has a linear history, and nobody pushes to it directly.

For large or design-level changes (a new view, a new config key, a change to the graph schema), open an issue first,
so that we can agree on the approach before you write the code.

## Setting up

You need Python 3.10 or later. That is all: Matrix has no dependencies to install.

```bash
git clone https://github.com/<you>/matrix.git
cd matrix
python tests/smoke.py
```

To try your change on a real folder, install it into a scratch project. Point `MATRIX_HOME` at a scratch folder too,
so your experiments stay out of your own universe registry:

```bash
export MATRIX_HOME="$PWD/.matrix_home"                # PowerShell: $env:MATRIX_HOME = "$PWD\.matrix_home"
python matrix/setup.py ../scratch-project --no-launcher
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the repository layout and how to run Matrix from a checkout.

## Running the tests

Both scripts use the standard library only, run from the repository root, and work on Windows, macOS and Linux.

| Command | What it checks | When to run it |
|---|---|---|
| `python tests/smoke.py` | Installs Matrix into a temp folder with a sandboxed `MATRIX_HOME` and `HOME`, builds a sample corpus, then checks `graph.json`, an offline `graph.html`, `query.py find` / `stats` / `explain`, `scopes.py list`, and that the Python sources import only the standard library. | Every change. |
| `python tests/selftest.py` | Opens the built `graph.html` in headless Chrome and runs the page's built-in self-tests, once with WebGL (SwiftShader) and once with the Canvas2D fallback (`?nogl=1`). | Any change under `matrix/viz/` or to `viz.py`. |

`selftest.py` needs Chrome, Chromium or Edge. It finds the browser through `--chrome`, the `CHROME` environment
variable, `PATH`, or the usual install locations. Add `--keep` to either script to keep its temp folder for
inspection.

If you add UI behaviour, add a self-test for it next to the code (`MX.selftest.add(...)`). If you add a file
extractor, extend the sample corpus in `tests/smoke.py` so the new node types are built and checked.

## Coding rules

The full list, with the reasons behind each rule, is in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#coding-rules).
The ones that most often come up in review:

- **Python standard library only.** No third-party packages, ever: Matrix is installed by copying one folder and must
  run on any stock Python 3.10+, offline. The smoke test fails on a non-stdlib import.
- **One offline HTML file.** `graph.html` loads nothing from the network: no CDN, no web fonts, no remote images, no
  `fetch` to the internet. `viz.py` inlines every script and style. The smoke test fails on a remote `src`, `href`
  or `url()`.
- **No build step.** Vanilla JavaScript in IIFEs registered on `window.MX`, plain CSS. What you edit is what runs.
- **Hairline UI.** Monochrome hairline strokes, one bright stroke as the only highlight, opaque plates, faint colour
  as information only, motion gated by reduced motion, everything keyboard-accessible. Colours come from CSS tokens,
  never literals in JS. See [docs/UI-PRINCIPLES.md](docs/UI-PRINCIPLES.md).
- **Generic by design.** Matrix must not assume a language, company, domain, user name or folder layout. No
  hard-coded paths, and no real company names or personal data in code, tests, fixtures or screenshots.
- **Local only.** The engine binds `127.0.0.1` and checks its token on every API call. Do not add remote modes, CORS
  or cookies.
- **The smallest change that works.** Reuse an existing helper before writing a new one.

## Commit messages

Use a short, imperative subject line, optionally prefixed with the area it touches, and a body that explains *why*
when the reason is not obvious:

```text
indexer: resolve SQL views that reference a schema-qualified table

Views like `CREATE VIEW sales.v AS SELECT ... FROM sales.orders` produced
no edge because the table name kept its schema prefix. Strip it before
lookup, and keep the prefixed name as an alias.

Fixes #42
```

- Subject: 72 characters at most, no trailing period, imperative mood ("add", "fix", not "added", "fixes").
- Common prefixes: `indexer`, `query`, `search`, `viz`, `serve`, `setup`, `scopes`, `docs`, `tests`, `ci`.
- Reference issues with `Fixes #N` or `Refs #N`.

Pull requests are squash-merged, so the PR title becomes the commit subject on `main`. Give the PR a title in the
same style.

## Sign-off (optional)

There is **no CLA**. By contributing you agree that your contribution is licensed under the project's
[MIT License](LICENSE).

If you like, you can certify the [Developer Certificate of Origin](https://developercertificate.org/) by signing
off your commits with `git commit -s`, which adds a `Signed-off-by: Your Name <you@example.com>` line. It is
welcome but not required, and no check enforces it.

## CI and required checks

Every pull request and every push to `main` runs `.github/workflows/ci.yml`:

| Check name | What it runs |
|---|---|
| `lint` | `python -m compileall` over `matrix/` and `tests/`, and `node --check` on every `.js` file. |
| `test (<os>, py<version>)` | `python tests/smoke.py` on `ubuntu-latest`, `windows-latest` and `macos-latest`, each with Python 3.10, 3.12 and 3.13: nine checks. |
| `selftest` | `python tests/selftest.py` in headless Chrome on Ubuntu, webgl and nogl modes. |

All of these are **required**: a pull request cannot merge until each one passes on the latest commit, and the
branch must be up to date with `main`. CodeQL (`.github/workflows/codeql.yml`) also scans the Python and JavaScript
on every PR, and its findings are reviewed before merge.

Things worth knowing:

- Workflows run with a **read-only token and no secrets**, including on PRs from forks. CI never needs a secret, so
  nothing in your PR should expect one.
- For first-time contributors, the maintainer approves the workflow run before it starts. This is a GitHub safety
  setting, not a judgement on your PR.
- A new push to a PR cancels the CI run that is still going for the previous push.
- A new push also **dismisses earlier approvals**, and the last push must be approved by someone other than its
  author. Ask for a re-review after pushing.
- All review conversations must be resolved before merge.
- A flaky failure in `selftest` is retried once automatically for a handful of known timing-sensitive tests. If it
  still fails, say so in the PR rather than re-running it repeatedly.

The repository settings and the branch ruleset are documented in [docs/GITHUB-SETUP.md](docs/GITHUB-SETUP.md).

## Reporting bugs and security problems

- **Bugs and ideas:** open an issue using the bug report or feature request form.
- **Security vulnerabilities:** do **not** open a public issue. Report them privately as described in
  [SECURITY.md](SECURITY.md).
