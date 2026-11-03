"""Generates SYNTHETIC bank statements (PDF, OFX, QIF) plus ground truth, used by tests and demos.
Not real data: balances, merchants and account numbers are invented. Run with a Python that has reportlab:
    python make_samples.py
"""
import json, os, random
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4, letter

HERE = os.path.dirname(os.path.abspath(__file__)); random.seed(7)
W, H = A4

def money(c, comma=False):
    s = f"{abs(c) / 100:,.2f}"
    return s.replace(",", "X").replace(".", ",").replace("X", ".") if comma else s

def doc(path, size=A4, encrypt=None):
    return canvas.Canvas(path, pagesize=size, encrypt=encrypt)

def header(cv, title, lines, y=800):
    cv.setFont("Helvetica-Bold", 15); cv.drawString(40, y, title)
    cv.setFont("Helvetica", 9)
    for i, l in enumerate(lines): cv.drawString(40, y - 18 - i * 12, l)

def save_truth(name, rows, **meta):
    json.dump({"rows": rows, **meta}, open(os.path.join(HERE, name + ".expected.json"), "w"), indent=1)

# ---------- A: checking account, debit/credit/balance columns, year-less dates, two pages ----------
def sample_a():
    ops = [("01/02", "PAYROLL ACME CORP DIRECT DEP", 285000), ("01/03", "RENT PROPERTY MGMT", -145000), ("01/04", "WHOLE FOODS #123 AUSTIN TX", -8234),
           ("01/05", "STARBUCKS #8812 SEATTLE WA", -675), ("01/06", "ELECTRIC CO UTILITY AUTOPAY", -11042), ("01/07", "UBER TRIP HELP.UBER.COM", -2150), ("01/08", "NETFLIX.COM", -1999),
           ("01/09", "TRANSFER FROM SAVINGS", 50000), ("01/10", "SHELL OIL 5772", -4120), ("01/11", "AMZN MKTP US*2K4", -3299), ("01/12", "CHIPOTLE 1932", -1287), ("01/13", "COMCAST XFINITY INTERNET", -6500),
           ("01/14", "SPOTIFY USA", -1099), ("01/15", "PAYROLL ACME CORP DIRECT DEP", 285000), ("01/16", "TRADER JOES 551", -6120), ("01/17", "CVS PHARMACY 0042", -1850), ("01/18", "DOORDASH*ORDER", -3480),
           ("01/19", "ATM WITHDRAWAL 7TH AVE", -6000), ("01/20", "PLANET FITNESS", -4500), ("01/21", "KROGER 0042", -9211), ("01/22", "INTEREST PAID", 312), ("01/23", "LYFT RIDE", -1890), ("01/24", "TARGET 00231", -5476),
           ("01/25", "AUTO LOAN PAYMENT", -38500), ("01/26", "MCDONALDS F2201", -945), ("01/27", "COSTCO WHSE #772", -15233), ("01/28", "WALGREENS 1180", -2210), ("01/29", "DELTA AIR 0062 ATLANTA", -21000),
           ("01/30", "CHEVRON 0991", -3875), ("01/31", "MONTHLY MAINTENANCE FEE", -1200)]
    opening = 412050; bal = opening; rows = []; tx = []
    for d, desc, amt in ops: bal += amt; tx.append((d, desc, amt, bal)); rows.append({"date": f"2026-{d[:2]}-{d[3:]}", "description": desc, "amount": amt})
    cv = doc(os.path.join(HERE, "sample-checking.pdf")); cols = {"w": 420, "d": 480, "b": 555}
    def page_head(first):
        header(cv, "NORTHWIND BANK", ["Everyday Checking  ·  Account ending 4821", "Statement period 01/01/2026 - 01/31/2026", ""] if first else ["Everyday Checking (continued)  Page 2 of 2"])
        y = 740 if first else 772
        if first:
            cv.setFont("Helvetica", 9); cv.drawString(40, y, "Beginning balance"); cv.drawRightString(cols["b"], y, money(opening)); y -= 22
        cv.setFont("Helvetica-Bold", 8.5); cv.drawString(40, y, "Date"); cv.drawString(95, y, "Description"); cv.drawRightString(cols["w"], y, "Withdrawals"); cv.drawRightString(cols["d"], y, "Deposits"); cv.drawRightString(cols["b"], y, "Balance")
        return y - 16
    y = page_head(True); cv.setFont("Helvetica", 8.5)
    for i, (d, desc, amt, b) in enumerate(tx):
        if y < 70: cv.showPage(); y = page_head(False); cv.setFont("Helvetica", 8.5)
        cv.drawString(40, y, d); cv.drawString(95, y, desc)
        cv.drawRightString(cols["d"] if amt > 0 else cols["w"], y, money(amt)); cv.drawRightString(cols["b"], y, money(b)); y -= 13
        if desc.startswith("DELTA"):  # wrapped description line
            cv.setFillGray(.25); cv.drawString(95, y, "FLIGHT 0062 CONFIRMATION XK29QP"); cv.setFillGray(0); y -= 13
    y -= 8; cv.setFont("Helvetica-Bold", 9); cv.drawString(40, y, "Ending balance"); cv.drawRightString(cols["b"], y, money(bal)); y -= 14
    cv.setFont("Helvetica", 7.5); cv.drawString(40, y, "Questions? Call 1-800-555-0100. Member FDIC. Page footer text appears here.")
    cv.save(); save_truth("sample-checking", rows, opening=opening, closing=bal, kind="pdf")

# ---------- B: credit card, positive purchases, CR credits, two dates, period crossing the year ----------
def sample_b(fname="sample-creditcard.pdf", encrypt=None):
    ops = [("Dec 28", "Dec 29", "AIRBNB * HMXY CITY", 48000), ("Dec 30", "Dec 31", "WHOLE FOODS #123", 9134), ("Jan 02", "Jan 03", "NETFLIX.COM", 1999), ("Jan 03", "Jan 04", "STARBUCKS #8812", 785),
           ("Jan 05", "Jan 06", "PAYMENT THANK YOU", -90000), ("Jan 08", "Jan 09", "UBER EATS PENDING", 2494), ("Jan 09", "Jan 10", "AMAZON.COM*1R7", 4599), ("Jan 12", "Jan 13", "RETURN AMAZON.COM*1R7", -4599),
           ("Jan 15", "Jan 16", "SHELL OIL 5772", 4210), ("Jan 18", "Jan 19", "DOORDASH*ORDER", 3815), ("Jan 21", "Jan 22", "FOREIGN TXN FEE", 142), ("Jan 22", "Jan 23", "INTEREST CHARGED", 9877)]
    prev = 85000; rows = []; sumx = 0
    cv = doc(os.path.join(HERE, fname), letter, encrypt); Wl, Hl = letter
    header(cv, "MERIDIAN VISA REWARDS", ["Account ending 9034", "Statement period Dec 26, 2025 - Jan 25, 2026", "Payment due date Feb 15, 2026   Minimum payment due $75.00   Credit limit $8,000"], y=Hl - 50)
    cv.setFont("Helvetica", 9); y = Hl - 130; cv.drawString(40, y, "Previous balance"); cv.drawRightString(560, y, money(prev)); y -= 24
    cv.setFont("Helvetica-Bold", 8.5); cv.drawString(40, y, "Trans Date"); cv.drawString(100, y, "Post Date"); cv.drawString(165, y, "Description"); cv.drawRightString(560, y, "Amount"); y -= 15; cv.setFont("Helvetica", 8.5)
    for td, pd, desc, amt in ops:
        yr = 2025 if td.startswith("Dec") else 2026; mm = {"Dec": 12, "Jan": 1}[td[:3]]
        rows.append({"date": f"{yr}-{mm:02d}-{td[4:]}", "description": desc, "amount": -amt}); sumx += amt
        cv.drawString(40, y, td); cv.drawString(100, y, pd); cv.drawString(165, y, desc)
        cv.drawRightString(560, y, ("-" + money(amt)) if amt < 0 else money(amt)); y -= 13
        if amt < 0 and "PAYMENT" in desc: pass
    new = prev + sumx; y -= 8; cv.setFont("Helvetica-Bold", 9); cv.drawString(40, y, "New balance"); cv.drawRightString(560, y, money(new))
    cv.save(); save_truth("sample-creditcard", rows, opening=prev, closing=new, kind="pdf", credit_card=True)

# ---------- C: single signed amount with parentheses + running balance, "15 Jan 2026" dates ----------
def sample_c():
    ops = [("02 Jan 2026", "SALARY JANUARY", 320000), ("03 Jan 2026", "CARD PURCHASE TESCO STORES", -4521), ("05 Jan 2026", "DIRECT DEBIT COUNCIL TAX", -15800), ("07 Jan 2026", "FASTER PAYMENT FROM J SMITH", 12000),
           ("09 Jan 2026", "CARD PURCHASE COSTA COFFEE", -385), ("12 Jan 2026", "STANDING ORDER RENT", -95000), ("14 Jan 2026", "CARD PURCHASE AMAZON PRIME", -899), ("20 Jan 2026", "CASH WITHDRAWAL", -5000)]
    opening = 154300; bal = opening; rows = []
    cv = doc(os.path.join(HERE, "sample-currentaccount.pdf")); header(cv, "HARBOR BUILDING SOCIETY", ["Current account 20-45-17 ****6290", "Statement from 01 Jan 2026 to 31 Jan 2026"])
    cv.setFont("Helvetica-Bold", 8.5); y = 730; cv.drawString(40, y, "Date"); cv.drawString(120, y, "Details"); cv.drawRightString(440, y, "Amount"); cv.drawRightString(540, y, "Balance"); y -= 15
    cv.setFont("Helvetica", 8.5); cv.drawString(120, y, "Opening balance"); cv.drawRightString(540, y, money(opening)); y -= 14
    for d, desc, amt in ops:
        bal += amt; mon = {"Jan": 1}[d[3:6]]; rows.append({"date": f"2026-{mon:02d}-{d[:2]}", "description": desc, "amount": amt})
        cv.drawString(40, y, d); cv.drawString(120, y, desc); cv.drawRightString(440, y, f"({money(amt)})" if amt < 0 else money(amt)); cv.drawRightString(540, y, money(bal)); y -= 13
    cv.drawString(120, y - 6, "Closing balance"); cv.drawRightString(540, y - 6, money(bal)); cv.save(); save_truth("sample-currentaccount", rows, opening=opening, closing=bal, kind="pdf")

# ---------- D: European formatting (dd.mm.yyyy, decimal comma, trailing minus) ----------
def sample_d():
    ops = [("02.01.2026", "GEHALT JANUAR", 285000), ("03.01.2026", "REWE SAGT DANKE", -4567), ("05.01.2026", "MIETE WOHNUNG", -98000), ("08.01.2026", "LASTSCHRIFT STROM", -7650), ("15.01.2026", "SPOTIFY AB", -1099)]
    opening = 120000; bal = opening; rows = []
    cv = doc(os.path.join(HERE, "sample-european.pdf")); header(cv, "NORDSEE BANK", ["Girokonto  DE** **** 3321", "Kontoauszug 01.01.2026 - 31.01.2026"])
    cv.setFont("Helvetica-Bold", 8.5); y = 730; cv.drawString(40, y, "Buchung"); cv.drawString(120, y, "Text"); cv.drawRightString(440, y, "Betrag EUR"); cv.drawRightString(540, y, "Saldo"); y -= 15; cv.setFont("Helvetica", 8.5)
    cv.drawString(120, y, "Alter Saldo"); cv.drawRightString(540, y, money(opening, True)); y -= 14
    for d, desc, amt in ops:
        bal += amt; rows.append({"date": f"2026-{d[3:5]}-{d[:2]}", "description": desc, "amount": amt})
        cv.drawString(40, y, d); cv.drawString(120, y, desc); cv.drawRightString(440, y, money(amt, True) + ("-" if amt < 0 else "")); cv.drawRightString(540, y, money(bal, True)); y -= 13
    cv.drawString(120, y - 6, "Neuer Saldo"); cv.drawRightString(540, y - 6, money(bal, True)); cv.save(); save_truth("sample-european", rows, opening=opening, closing=bal, kind="pdf", comma=True)

# ---------- OFX and QIF ----------
def sample_ofx_qif():
    rows = [("20260105", -6575, "WHOLE FOODS #123", "AUSTIN TX", "1001"), ("20260106", 285000, "ACME CORP PAYROLL", "DIRECT DEP", "1002"), ("20260109", -1999, "NETFLIX.COM", "", "1003"), ("20260112", -4210, "SHELL OIL 5772", "FUEL", "1004")]
    sg = ["OFXHEADER:100", "DATA:OFXSGML", "VERSION:102", "SECURITY:NONE", "ENCODING:USASCII", "CHARSET:1252", "COMPRESSION:NONE", "OLDFILEUID:NONE", "NEWFILEUID:NONE", "",
          "<OFX><SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20260131<LANGUAGE>ENG</SONRS></SIGNONMSGSRSV1>",
          "<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STATUS><CODE>0<SEVERITY>INFO</STATUS><STMTRS><CURDEF>USD<BANKACCTFROM><BANKID>123456789<ACCTID>000111222<ACCTTYPE>CHECKING</BANKACCTFROM>",
          "<BANKTRANLIST><DTSTART>20260101<DTEND>20260131"]
    for d, a, n, m, f in rows: sg += ["<STMTTRN>", "<TRNTYPE>" + ("CREDIT" if a > 0 else "DEBIT"), "<DTPOSTED>" + d + "120000[0:GMT]", f"<TRNAMT>{a / 100:.2f}", "<FITID>" + f, "<NAME>" + n] + (["<MEMO>" + m] if m else []) + ["</STMTTRN>"]
    sg += ["</BANKTRANLIST>", "<LEDGERBAL><BALAMT>3156.16<DTASOF>20260131</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>"]
    open(os.path.join(HERE, "sample.ofx"), "w").write("\n".join(sg))
    q = ["!Type:CCard"]
    for d, a, n, m, f in rows: q += [f"D{d[4:6]}/{d[6:]}/{d[:4]}", f"T{a / 100:,.2f}", f"P{n}", "M" + m, "^"]
    open(os.path.join(HERE, "sample.qif"), "w").write("\n".join(q) + "\n")
    save_truth("sample-ofx", [{"date": f"{d[:4]}-{d[4:6]}-{d[6:]}", "description": (n + (" " + m if m else "")), "amount": a} for d, a, n, m, f in rows], kind="ofx")

if __name__ == "__main__":
    sample_a(); sample_b(); sample_b("sample-locked.pdf", "secret1"); sample_c(); sample_d(); sample_ofx_qif(); print("ok", sorted(os.listdir(HERE)))
