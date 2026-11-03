# Ledgerly documentation

| File | What it is |
|---|---|
| [Ledgerly-Intelligence-Guide.pdf](Ledgerly-Intelligence-Guide.pdf) | 27-page guide to every algorithm and agentic solution: how each works, thresholds, worked examples from real runs, how to use it in the app, and where it stops being reliable. Covers categorization, bank statement reading (PDF/OFX/QIF) with reconciliation, subscription and anomaly detection, forecasting, safe-to-spend, health score, debt payoff, offers, and the Claude Haiku assistant with its offline fallback. |
| `build/` | Source that generates the PDF (`build_guide.py`, `diagrams.py`, `kit.py`) and the data behind its charts (`chart_data.json`). |

Rebuild the PDF after changing the algorithms (so the guide stays true):

```bash
python -m venv .venv && .venv/bin/pip install -r docs/build/requirements.txt
LEDGERLY_TEST_COUNT=$(npm test 2>&1 | grep -oP 'Tests\s+\K\d+') PYTHONHASHSEED=0 .venv/bin/python docs/build/build_guide.py
```

Sample statements for trying the import (synthetic, not real accounts) live in `samples/statements/`, with ground truth used by the tests; regenerate them with `samples/statements/make_samples.py`.
