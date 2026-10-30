## What and why

<!-- What does this change, and why? Link the issue it closes, e.g. "Closes #12". -->

## How it was tested

<!-- Commands you ran and what you saw. For UI changes: which browser, light/dark, webgl/nogl. -->

## Checklist

- [ ] `python tests/smoke.py` passes locally
- [ ] `python tests/selftest.py` passes locally (needed for any change under `matrix/viz/` or to `viz.py`)
- [ ] Standard library only: no new Python packages, npm packages or other dependencies
- [ ] `graph.html` stays a single offline file: nothing loaded from a CDN or any other network URL
- [ ] Docs updated (README.md, docs/) for anything a user would notice
- [ ] Screenshots or a short clip attached for UI changes (before / after)
- [ ] No secrets, tokens, personal data, real company names or machine-specific paths in code, tests, fixtures or screenshots
- [ ] Commits follow the style in CONTRIBUTING.md

<!-- All changes are reviewed and merged by the maintainer. CI must be green first. -->
