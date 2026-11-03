"""Small layout kit on top of reportlab platypus."""
import os, matplotlib
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, Table, TableStyle, Preformatted, PageBreak, KeepTogether, Image, CondPageBreak)
from reportlab.platypus.tableofcontents import TableOfContents

fd = os.path.join(matplotlib.get_data_path(), "fonts", "ttf")
for name, f in (("DejaVu", "DejaVuSans.ttf"), ("DejaVu-Bold", "DejaVuSans-Bold.ttf"), ("DejaVu-Italic", "DejaVuSans-Oblique.ttf"), ("DejaVu-BoldItalic", "DejaVuSans-BoldOblique.ttf"), ("DejaVu-Mono", "DejaVuSansMono.ttf")):
    pdfmetrics.registerFont(TTFont(name, os.path.join(fd, f)))
pdfmetrics.registerFontFamily("DejaVu", normal="DejaVu", bold="DejaVu-Bold", italic="DejaVu-Italic", boldItalic="DejaVu-BoldItalic")

BRAND = colors.HexColor("#146e5a"); INK = colors.HexColor("#141821"); MUTE = colors.HexColor("#5a6272"); LINE = colors.HexColor("#d3d8e0")
SOFT = colors.HexColor("#eef6f3"); ZEBRA = colors.HexColor("#f6f7fa"); WARN = colors.HexColor("#fff4dd"); WARN_L = colors.HexColor("#d9a441"); NOTE = colors.HexColor("#e8eefb"); NOTE_L = colors.HexColor("#6f8fd6")
PAGE_W, PAGE_H = A4; M = 20 * mm; W = PAGE_W - 2 * M

S = {
    "body": ParagraphStyle("body", fontName="DejaVu", fontSize=8.8, leading=13, textColor=INK, spaceAfter=5, alignment=TA_LEFT),
    "small": ParagraphStyle("small", fontName="DejaVu", fontSize=7.6, leading=10.4, textColor=INK),
    "cell": ParagraphStyle("cell", fontName="DejaVu", fontSize=7.6, leading=10, textColor=INK),
    "cellb": ParagraphStyle("cellb", fontName="DejaVu-Bold", fontSize=7.6, leading=10, textColor=colors.white),
    "cap": ParagraphStyle("cap", fontName="DejaVu-Italic", fontSize=7.4, leading=10, textColor=MUTE, spaceAfter=8),
    "h1x": ParagraphStyle("h1x", fontName="DejaVu-Bold", fontSize=19, leading=24, textColor=BRAND, spaceAfter=10),
    "h1": ParagraphStyle("h1", fontName="DejaVu-Bold", fontSize=19, leading=24, textColor=BRAND, spaceBefore=0, spaceAfter=10),
    "h2": ParagraphStyle("h2", fontName="DejaVu-Bold", fontSize=13, leading=17, textColor=INK, spaceBefore=14, spaceAfter=5),
    "h3": ParagraphStyle("h3", fontName="DejaVu-Bold", fontSize=9.6, leading=13, textColor=BRAND, spaceBefore=8, spaceAfter=3),
    "code": ParagraphStyle("code", fontName="DejaVu-Mono", fontSize=7.1, leading=9.4, textColor=INK),
    "title": ParagraphStyle("title", fontName="DejaVu-Bold", fontSize=30, leading=36, textColor=BRAND),
    "sub": ParagraphStyle("sub", fontName="DejaVu", fontSize=13, leading=19, textColor=MUTE),
    "toc1": ParagraphStyle("toc1", fontName="DejaVu-Bold", fontSize=9.2, leading=15, leftIndent=0, spaceBefore=4),
    "toc2": ParagraphStyle("toc2", fontName="DejaVu", fontSize=8.2, leading=12, leftIndent=14),
}


class Doc(BaseDocTemplate):
    def __init__(self, path, title):
        super().__init__(path, pagesize=A4, leftMargin=M, rightMargin=M, topMargin=M + 4 * mm, bottomMargin=M, title=title, author="Ledgerly", subject="Algorithms and agentic solutions")
        fr = Frame(M, M, W, PAGE_H - 2 * M - 4 * mm, id="f", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
        self.addPageTemplates([PageTemplate(id="cover", frames=[Frame(M, M, W, PAGE_H - 2 * M, id="c")], onPage=lambda c, d: None), PageTemplate(id="main", frames=[fr], onPage=self.chrome)])
        self.heading_n = 0; self.current_part = ''

    def handle_documentBegin(self):
        self.current_part = ''; super().handle_documentBegin()

    def chrome(self, c, d):
        c.saveState(); c.setFont("DejaVu", 7); c.setFillColor(MUTE)
        c.drawString(M, PAGE_H - M + 2 * mm, "Ledgerly · Intelligence Guide"); c.drawRightString(PAGE_W - M, PAGE_H - M + 2 * mm, getattr(self, "current_part", ""))
        c.setStrokeColor(LINE); c.setLineWidth(.5); c.line(M, PAGE_H - M + 0.5 * mm, PAGE_W - M, PAGE_H - M + 0.5 * mm)
        c.drawCentredString(PAGE_W / 2, M - 8 * mm, f"{d.page}"); c.restoreState()

    def afterFlowable(self, f):
        if isinstance(f, Paragraph) and f.style.name in ("h1", "h2"):
            lvl = 0 if f.style.name == "h1" else 1; text = f.getPlainText()
            key = f"h{lvl}-{abs(hash(text)) % 10**9}"
            self.canv.bookmarkPage(key); self.canv.addOutlineEntry(text, key, level=lvl, closed=lvl == 0); self.notify("TOCEntry", (lvl, text, self.page, key))
            if lvl == 0: self.current_part = text


def esc(t): return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
def P(t, s="body"): return Paragraph(t, S[s])
def H1(t): return [CondPageBreak(120 * mm), Spacer(1, 6), Paragraph(t, S["h1"])]
def H2(t): return [CondPageBreak(60 * mm), Paragraph(t, S["h2"])]
def H3(t): return Paragraph(t, S["h3"])
def sp(h=4): return Spacer(1, h)
def code(t): 
    t = t.strip("\n"); tb = Table([[Preformatted(t, S["code"])]], colWidths=[W]); tb.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), ZEBRA), ("BOX", (0, 0), (-1, -1), .5, LINE), ("LEFTPADDING", (0, 0), (-1, -1), 7), ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5)])); return [tb, sp(6)]
def bullets(items, style="body"):
    return [Paragraph(f"<font color='#146e5a'>•</font>&nbsp;&nbsp;{i}", ParagraphStyle("b", parent=S[style], leftIndent=12, firstLineIndent=-10, spaceAfter=2.2)) for i in items] + [sp(3)]
def numbered(items):
    return [Paragraph(f"<font color='#146e5a'><b>{n}.</b></font>&nbsp;&nbsp;{i}", ParagraphStyle("n", parent=S["body"], leftIndent=15, firstLineIndent=-14, spaceAfter=2.4)) for n, i in enumerate(items, 1)] + [sp(3)]
def callout(kind, t):
    fill, edge, tag = (WARN, WARN_L, "Honest limit") if kind == "warn" else (NOTE, NOTE_L, "Note") if kind == "note" else (SOFT, BRAND, "Tip")
    tb = Table([[Paragraph(f"<b>{tag}.</b> {t}", S["small"])]], colWidths=[W]); tb.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), fill), ("LINEBEFORE", (0, 0), (0, -1), 2.5, edge), ("LEFTPADDING", (0, 0), (-1, -1), 8), ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 8)])); return [tb, sp(7)]
def table(rows, widths, header=True, zebra=True, size=None):
    data = [[Paragraph(str(c), S["cellb"] if (header and i == 0) else S["cell"]) if isinstance(c, str) else c for c in r] for i, r in enumerate(rows)]
    tb = Table(data, colWidths=[w * W for w in widths], repeatRows=1 if header else 0)
    st = [("VALIGN", (0, 0), (-1, -1), "TOP"), ("LINEBELOW", (0, 0), (-1, -1), .3, LINE), ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4), ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]
    if header: st.append(("BACKGROUND", (0, 0), (-1, 0), BRAND))
    if zebra: st += [("BACKGROUND", (0, i), (-1, i), ZEBRA) for i in range(1 if header else 0, len(rows), 2)]
    tb.setStyle(TableStyle(st)); return [tb, sp(7)]
def facts(**kw):
    rows = [[Paragraph(f"<b>{k.replace('_', ' ')}</b>", S["cell"]), Paragraph(v, S["cell"])] for k, v in kw.items()]
    tb = Table(rows, colWidths=[.2 * W, .8 * W]); tb.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), SOFT), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LINEBELOW", (0, 0), (-1, -1), .3, colors.white), ("LEFTPADDING", (0, 0), (-1, -1), 5), ("TOPPADDING", (0, 0), (-1, -1), 2.5), ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5)])); return [tb, sp(6)]
def fig(d, cap=None):
    out = [d]; 
    if cap: out.append(P(cap, "cap"))
    return [KeepTogether(out)]
def img(path, cap, width=W):
    from reportlab.lib.utils import ImageReader
    iw, ih = ImageReader(path).getSize(); return [KeepTogether([Image(path, width=width, height=width * ih / iw), P(cap, "cap")])]
