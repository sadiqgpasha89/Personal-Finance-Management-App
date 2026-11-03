"""Vector diagrams and charts used by build_guide.py."""
import json, os
from reportlab.graphics.shapes import Drawing, Rect, String, Line, Polygon, Group
from reportlab.lib import colors
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

BRAND = colors.HexColor("#146e5a"); INK = colors.HexColor("#141821"); MUTE = colors.HexColor("#646c7c")
SOFT = colors.HexColor("#e7f2ef"); LINE = colors.HexColor("#c9ced8"); WARN = colors.HexColor("#fff4dd"); WARN_L = colors.HexColor("#d9a441")
BLUE = colors.HexColor("#e8eefb"); BLUE_L = colors.HexColor("#6f8fd6")
FONT, FONTB = "DejaVu", "DejaVu-Bold"
HERE = os.path.dirname(__file__)


def arrow(d, x1, y1, x2, y2, color=MUTE, dash=None, w=1.1):
    ln = Line(x1, y1, x2, y2, strokeColor=color, strokeWidth=w)
    if dash: ln.strokeDashArray = dash
    d.add(ln)
    import math
    a = math.atan2(y2 - y1, x2 - x1); s = 5
    d.add(Polygon([x2, y2, x2 - s * math.cos(a - 0.45), y2 - s * math.sin(a - 0.45), x2 - s * math.cos(a + 0.45), y2 - s * math.sin(a + 0.45)], fillColor=color, strokeColor=color, strokeWidth=0.5))


def box(d, x, y, w, h, text, fill=SOFT, stroke=BRAND, size=7.6, bold=False, dash=None):
    r = Rect(x, y, w, h, rx=4, ry=4, fillColor=fill, strokeColor=stroke, strokeWidth=1)
    if dash: r.strokeDashArray = dash
    d.add(r)
    lines = text.split("\n"); lh = size + 2.4; top = y + h / 2 + (len(lines) - 1) * lh / 2 - size * 0.3
    for i, t in enumerate(lines):
        d.add(String(x + w / 2, top - i * lh, t, fontName=FONTB if (bold and i == 0) else FONT, fontSize=size, fillColor=INK, textAnchor="middle"))


def label(d, x, y, t, size=6.8, color=MUTE, anchor="middle", bold=False):
    d.add(String(x, y, t, fontName=FONTB if bold else FONT, fontSize=size, fillColor=color, textAnchor=anchor))


def architecture():
    d = Drawing(480, 330)
    label(d, 240, 314, "Ledgerly intelligence: where each piece lives", 9, INK, bold=True)
    box(d, 10, 262, 460, 36, "Browser UI (Next.js pages)\nDashboard · Transactions · Import · Budgets · Bills · Debt · Reports · Offers · Assistant · Profile", fill=BLUE, stroke=BLUE_L)
    arrow(d, 240, 262, 240, 244)
    box(d, 10, 208, 460, 34, "REST dispatcher  /api/[...path]   (auth, origin check, zod validation, rate limits)\nroute table in src/lib/api.ts", fill=colors.HexColor("#f4f5f8"), stroke=LINE)
    arrow(d, 120, 208, 120, 190); arrow(d, 360, 208, 360, 190)
    box(d, 10, 150, 225, 38, "Services (src/lib/service.ts, offers.ts, profile.ts)\nQuery SQLite, assemble inputs, apply results", fill=colors.HexColor("#f4f5f8"), stroke=LINE)
    box(d, 245, 150, 225, 38, "Assistant (src/lib/chat/)\nrouter · tools · Claude agent · offline engine", fill=SOFT, stroke=BRAND, bold=True)
    arrow(d, 120, 150, 120, 132)
    box(d, 10, 70, 225, 60, "Pure algorithms (src/lib/domain/)\ncategorize · csv · analytics · debt\namortization · budget · money · offers\nno I/O, fully unit-tested", fill=SOFT, stroke=BRAND, bold=True)
    arrow(d, 235, 100, 245, 160, color=BRAND)  # services <-> chat uses tools
    arrow(d, 357, 150, 357, 132)
    box(d, 245, 70, 108, 60, "12 read-only tools\nworkspace-scoped,\nzod-validated,\nformatted output", fill=colors.HexColor("#f4f5f8"), stroke=LINE)
    box(d, 362, 70, 108, 60, "Claude Haiku 5.5\nexternal API\n(opt-in, key on\nserver only)", fill=WARN, stroke=WARN_L, dash=[3, 2])
    arrow(d, 353, 100, 362, 100, color=WARN_L, dash=[3, 2])
    arrow(d, 122, 70, 122, 52)
    box(d, 10, 14, 460, 36, "SQLite (node:sqlite, WAL)   ·   money in integer minor units   ·   civil dates   ·   FX rate frozen at write time", fill=colors.HexColor("#f4f5f8"), stroke=LINE)
    return d


def cascade():
    d = Drawing(480, 340)
    label(d, 240, 326, "Categorization cascade (first stage that answers wins)", 9, INK, bold=True)
    steps = [("0  Normalize merchant", "uppercase · strip store/ref codes · noise words · dictionary alias", "no category yet", SOFT),
             ("1  Your rules (priority order)", "all conditions must match  ·  field/op/value  ·  can set category, merchant, tag", "confidence 1.00  → always applied", SOFT),
             ("2  Merchant memory", "set by your own past corrections  (merchant → category)", "confidence 0.95  → applied", SOFT),
             ("3  Curated dictionary", "~40 well-known merchants, exact normalized name", "confidence 0.90  → applied", SOFT),
             ("4  Keyword regex on description", "restaurant, pharmacy, fuel, tuition, cinema …", "confidence 0.60  → NOT auto-applied", WARN)]
    y = 278
    for i, (t, s_, c, fill) in enumerate(steps):
        box(d, 10, y, 300, 38, f"{t}\n{s_}", fill=fill, stroke=BRAND if fill == SOFT else WARN_L, size=7.2, bold=True)
        box(d, 330, y + 6, 140, 26, c, fill=colors.white, stroke=LINE, size=7)
        arrow(d, 310, y + 19, 330, y + 19, color=LINE)
        if i < len(steps) - 1: arrow(d, 160, y, 160, y - 16)
        y -= 54
    arrow(d, 160, y + 54, 160, y + 40)
    box(d, 10, y + 4, 300, 32, "No match → left uncategorized (counted on the dashboard)\nYou categorize once; step 2 remembers it from then on", fill=colors.white, stroke=LINE, size=7.2)
    return d


def agent_sequence():
    d = Drawing(480, 400)
    cols = [("Browser", 40), ("core /api/chat", 140), ("Assistant svc", 250), ("Llama 1B", 350), ("Core tools", 440)]
    for n, x in cols:
        box(d, x - 36, 372, 72, 20, n, fill=SOFT, stroke=BRAND, size=7, bold=True)
        ln = Line(x, 372, x, 12, strokeColor=LINE, strokeWidth=0.8); ln.strokeDashArray = [2, 3]; d.add(ln)
    msgs = [(0, 1, 348, "1  question + last messages"), (1, 1, 330, "2  auth · rate limit · zod · consent check"), (1, 2, 312, "3  POST /v1/chat (service token)"),
            (2, 3, 288, "4  intent form (grammar-constrained)"), (3, 2, 264, "5  {intent, category, period…}"), (2, 4, 240, "6  code resolves dates, names; call tool"),
            (4, 2, 216, "7  formatted JSON result"), (2, 3, 192, "8  render answer from facts"), (3, 2, 168, "9  save both turns (SQLite)"),
            (2, 1, 144, "10 reply + tools_used"), (1, 0, 120, "11 render answer")]
    xs = {i: c[1] for i, c in enumerate(cols)}
    for a, b, y, t in msgs:
        if a == b:
            label(d, xs[a] + 4, y + 2, t, 6.3, INK, "start"); d.add(Rect(xs[a] - 3, y - 2, 6, 6, fillColor=BRAND, strokeColor=BRAND)); continue
        arrow(d, xs[a], y, xs[b] + (-3 if b > a else 3), y, color=BRAND if abs(b - a) else MUTE)
        label(d, (xs[a] + xs[b]) / 2, y + 3, t, 6.3, INK)
    box(d, 20, 52, 440, 44, "The model only fills a small form; dates, categories and merchants are resolved by code.\nIf the service or model is down, core answers with its built-in rules instead.\nNothing is ever written: tools are read-only.", fill=WARN, stroke=WARN_L, size=7)
    box(d, 20, 14, 440, 28, "Privacy: question, figures and history stay on your server; no outbound calls are made.", fill=colors.white, stroke=LINE, size=7)
    return d


def routing():
    d = Drawing(480, 200)
    label(d, 240, 184, "Which engine answers?", 9, INK, bold=True)
    box(d, 8, 120, 80, 40, "Question\narrives\nin core", fill=BLUE, stroke=BLUE_L)
    box(d, 112, 120, 140, 40, "Assistant service up\nand model loaded?", fill=colors.white, stroke=LINE)
    box(d, 300, 120, 172, 40, "Llama 3.2 1B on this server\nplans · tools · saves history", fill=SOFT, stroke=BRAND, bold=True)
    arrow(d, 88, 140, 112, 140); arrow(d, 252, 140, 300, 140); label(d, 276, 145, "yes", 6.5)
    box(d, 112, 44, 140, 40, "Built-in rules engine\n(no chat history)", fill=SOFT, stroke=BRAND, bold=True)
    arrow(d, 182, 120, 182, 84); label(d, 168, 102, "no", 6.5)
    box(d, 300, 44, 172, 40, "Claude Haiku (external)\nonly if operator enables it\nAND you opt in", fill=WARN, stroke=WARN_L, dash=[3, 2], size=7)
    label(d, 386, 100, "never by default", 6.5, WARN_L)
    arrow(d, 386, 120, 386, 84, color=WARN_L, dash=[3, 2])
    return d


def statement_flow():
    d = Drawing(480, 250)
    label(d, 240, 236, "From uploaded statement to reviewed transactions", 9, INK, bold=True)
    box(d, 8, 170, 100, 44, "Upload\nPDF · OFX/QFX · QIF\n(or CSV)", fill=BLUE, stroke=BLUE_L)
    box(d, 130, 170, 100, 44, "Read the file\nPDF: positioned text\n(password if asked)", fill=SOFT)
    box(d, 252, 170, 100, 44, "Find structure\nperiod · balances ·\ncolumns · date order", fill=SOFT)
    box(d, 374, 170, 98, 44, "Rows + signs\ndate, text, amount\nsigned: out is minus", fill=SOFT)
    for x in (108, 230, 352): arrow(d, x, 192, x + 22, 192)
    box(d, 374, 96, 98, 44, "Reconcile\nopening + rows\n= closing ?", fill=WARN, stroke=WARN_L, bold=True)
    arrow(d, 423, 170, 423, 140)
    box(d, 252, 96, 100, 44, "Confidence\nhigh = reconciled\nlow = off or empty", fill=colors.white, stroke=LINE)
    arrow(d, 374, 118, 352, 118)
    box(d, 130, 96, 100, 44, "Normalized CSV\nDate, Description,\nAmount", fill=SOFT)
    arrow(d, 252, 118, 230, 118)
    box(d, 8, 96, 100, 44, "Existing import\npreview · duplicates ·\nauto-categorize", fill=SOFT, bold=True)
    arrow(d, 130, 118, 108, 118)
    box(d, 8, 20, 224, 44, "You review, then import. Undo removes the whole batch.", fill=colors.white, stroke=LINE)
    arrow(d, 58, 96, 58, 64)
    box(d, 252, 20, 220, 44, "Optional: re-read with AI when confidence is not high\n(explicit click, account numbers masked, result re-checked)", fill=WARN, stroke=WARN_L, dash=[3, 2], size=7)
    arrow(d, 302, 96, 302, 64, color=WARN_L, dash=[3, 2])
    return d


def chart_forecast(path):
    c = json.load(open(os.path.join(HERE, "chart_data.json")))["forecast"]
    x = list(range(len(c["base"]))); f = lambda a: [v / 100 for v in a]
    fig, ax = plt.subplots(figsize=(7.2, 3.0), dpi=200)
    ax.fill_between(x, f(c["low"]), f(c["high"]), color="#146e5a", alpha=0.16, label="uncertainty band (σ·√days)")
    ax.plot(x, f(c["base"]), color="#146e5a", lw=1.8, label="expected balance")
    ax.set_xlabel("days from today"); ax.set_ylabel("balance ($)"); ax.grid(alpha=.25); ax.legend(frameon=False, fontsize=8, loc="upper left")
    ax.set_title("90-day cash-flow forecast (example inputs)", fontsize=10, loc="left")
    for s in ("top", "right"): ax.spines[s].set_visible(False)
    fig.tight_layout(); fig.savefig(path); plt.close(fig)


def chart_debt(path):
    c = json.load(open(os.path.join(HERE, "chart_data.json")))["debts"]
    fig, ax = plt.subplots(figsize=(7.2, 3.0), dpi=200)
    for k, col, lab in (("minimum", "#9aa3b2", "minimums only"), ("snowball", "#d9822b", "snowball (+$300/mo)"), ("avalanche", "#146e5a", "avalanche (+$300/mo)")):
        t = c[k]["timeline"]; ax.plot(range(len(t)), [v / 100 for v in t], color=col, lw=1.8, label=f"{lab}: {c[k]['months']} mo, ${c[k]['interest'] / 100:,.0f} interest")
    ax.set_xlabel("months"); ax.set_ylabel("total debt remaining ($)"); ax.grid(alpha=.25); ax.legend(frameon=False, fontsize=8)
    ax.set_title("Debt payoff strategies on the same three debts", fontsize=10, loc="left")
    for s in ("top", "right"): ax.spines[s].set_visible(False)
    fig.tight_layout(); fig.savefig(path); plt.close(fig)
