# Review evidence

Start with [ITERATIVE-FIXES.md](ITERATIVE-FIXES.md) for the latest assessment and validation. The active regression suite lives in `tests/` and runs with `npm test`; the local Firefox integration runner is `tests/firefox_test.py`.

Historical records are retained to explain the changes:

- [REVIEW.md](REVIEW.md): original v2.4 review.
- [FIXES.md](FIXES.md): first refactor and resolution mapping.
- [SECOND-PASS.md](SECOND-PASS.md): subsequent findings, since fixed.
- `reproduce.cjs`, `popup-reproduce.cjs`, `standalone-reproduce.cjs`, and `firefox-probe.py`: original defect reproductions. These load v2.4 source from Git commit `be4a77f` and assert historical bugs, so they are intentionally excluded from the current test suite. They require that commit to exist locally; a shallow checkout may need more history. The historical Firefox probe uses the newer base64 installation API; use `tests/firefox_test.py` for current Firefox 128+ validation.
- `lint-result.json`: package lint output retained with the reviewed compatibility warnings.

All fixtures use synthetic data and do not modify a real YouTube account.
