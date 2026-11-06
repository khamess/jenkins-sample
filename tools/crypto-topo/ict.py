"""Lecture Price Action / ICT automatique sur des bougies OHLC.

Concepts couverts (definitions standard ICT / Smart Money) :
- FVG (Fair Value Gap) haussier / baissier non comble, avec son CE (Consequent
  Encroachment = milieu du gap, le "mean threshold") ;
- swings (plus hauts / plus bas) et structure : dernier MSS / BOS (cassure de structure
  en cloture) ;
- prise de liquidite (sweep / Turtle Soup) : meche au-dela d'un swing ou du PDH/PDL puis
  cloture revenue a l'interieur ;
- PDH / PDL (plus haut / plus bas de la veille) ;
- zone Premium / Discount du range en cours (au-dessus / en dessous de 50 %), OTE
  (62-79 % de retracement) ;
- Kill Zones (heures UTC des sessions Londres et New York).

Toutes les fonctions prennent des listes o, h, l, c dans l'ordre chronologique.
"""
from datetime import datetime, timezone


def fvgs(o, h, l, c, lookback=60):
    """FVG non combles des `lookback` dernieres bougies (bougie centrale = displacement)."""
    out = []
    n = len(c)
    for i in range(max(1, n - lookback), n - 1):
        if l[i + 1] > h[i - 1]:  # haussier : trou entre le haut de i-1 et le bas de i+1
            top, bot, side = l[i + 1], h[i - 1], "haussier"
        elif h[i + 1] < l[i - 1]:  # baissier
            top, bot, side = l[i - 1], h[i + 1], "baissier"
        else:
            continue
        # comble ? (le prix est revenu traverser tout le gap apres sa formation)
        after_l = min(l[i + 2:], default=None)
        after_h = max(h[i + 2:], default=None)
        if side == "haussier":
            filled = after_l is not None and after_l <= bot
            touched = after_l is not None and after_l <= top
        else:
            filled = after_h is not None and after_h >= top
            touched = after_h is not None and after_h >= bot
        if not filled:
            out.append(dict(side=side, top=top, bot=bot, ce=(top + bot) / 2, idx=i,
                            age=n - 1 - i, touched=touched))
    return out


def swings(h, l, k=2):
    """Plus hauts / plus bas de swing (fractales k bougies de chaque cote)."""
    sh, sl = [], []
    for i in range(k, len(h) - k):
        if h[i] == max(h[i - k:i + k + 1]):
            sh.append((i, h[i]))
        if l[i] == min(l[i - k:i + k + 1]):
            sl.append((i, l[i]))
    return sh, sl


def structure(o, h, l, c, k=2):
    """Derniere cassure de structure en cloture (BOS/MSS) : (sens, niveau casse, index) ou None."""
    sh, sl = swings(h, l, k)
    last = None
    for i in range(1, len(c)):
        hs = [p for j, p in sh if j + k < i]
        ls = [p for j, p in sl if j + k < i]
        if hs and c[i] > hs[-1] >= c[i - 1]:
            last = ("haussiere", hs[-1], i)
        if ls and c[i] < ls[-1] <= c[i - 1]:
            last = ("baissiere", ls[-1], i)
    return last


def sweeps(o, h, l, c, highs, lows, last_n=3):
    """Prises de liquidite recentes (Turtle Soup) : meche au-dela d'un plus haut (ou plus bas)
    puis cloture revenue a l'interieur. Une seule entree par niveau, la plus recente."""
    out = {}
    n = len(c)
    for i in range(max(0, n - last_n), n):
        for name, lv in highs:
            if lv is not None and h[i] > lv and c[i] < lv:
                out[("haut", name)] = ("haut", name, lv, n - 1 - i)
        for name, lv in lows:
            if lv is not None and l[i] < lv and c[i] > lv:
                out[("bas", name)] = ("bas", name, lv, n - 1 - i)
    return list(out.values())


def premium_discount(h, l, px, lookback=60):
    hi, lo = max(h[-lookback:]), min(l[-lookback:])
    if hi == lo:
        return None
    pos = (px - lo) / (hi - lo)
    zone = "premium" if pos > 0.5 else "discount"
    return dict(hi=hi, lo=lo, pos=pos, zone=zone, eq=(hi + lo) / 2,
                ote_long=(hi - 0.79 * (hi - lo), hi - 0.62 * (hi - lo)),
                ote_short=(lo + 0.62 * (hi - lo), lo + 0.79 * (hi - lo)))


def killzone(now=None):
    """Kill Zones ICT approximatives en UTC (hiver) : Londres 07-10h, New York 12-15h, Asie 00-04h."""
    hr = (now or datetime.now(timezone.utc)).hour
    if 7 <= hr < 10:
        return "Londres"
    if 12 <= hr < 15:
        return "New York"
    if 0 <= hr < 4:
        return "Asie"
    return None


def read(o4, h4, l4, c4, hd, ld, px):
    """Synthese ICT sur le 4h (avec PDH/PDL du jour precedent)."""
    pdh, pdl = (hd[-2], ld[-2]) if len(hd) >= 2 else (None, None)
    sh, sl = swings(h4, l4)
    last_sh = sh[-1][1] if sh else None
    last_sl = sl[-1][1] if sl else None
    st = structure(o4, h4, l4, c4)
    if st:
        st = (st[0], st[1], len(c4) - 1 - st[2])
    gaps = fvgs(o4, h4, l4, c4)
    above = sorted([g for g in gaps if g["bot"] > px], key=lambda g: g["bot"])
    below = sorted([g for g in gaps if g["top"] < px], key=lambda g: -g["top"])
    inside = [g for g in gaps if g["bot"] <= px <= g["top"]]
    # liquidite : swings confirmes AVANT les 3 dernieres bougies (sinon le sweep cree son propre swing)
    old_sh = [p for j, p in sh if j < len(c4) - 3]
    old_sl = [p for j, p in sl if j < len(c4) - 3]
    sw = sweeps(o4, h4, l4, c4, [("PDH", pdh), ("swing haut", old_sh[-1] if old_sh else None)],
                [("PDL", pdl), ("swing bas", old_sl[-1] if old_sl else None)])
    pd = premium_discount(h4, l4, px)
    return dict(pdh=pdh, pdl=pdl, last_sh=last_sh, last_sl=last_sl, structure=st,
                fvg_above=above[:2], fvg_below=below[:2], fvg_inside=inside, sweeps=sw, pd=pd,
                kz=killzone())


def _f(x):
    if x is None:
        return "-"
    return ("%.4g" % x) if x < 1 else ("%.2f" % x if x < 1000 else "%.0f" % x)


def describe(r):
    """Une ligne lisible."""
    parts = []
    if r["structure"]:
        s, lv, age = r["structure"]
        parts.append("derniere cassure de structure 4h %s (cloture au-dela de %s, il y a %d bougies)" % (s, _f(lv), age))
    if r["pd"]:
        pd = r["pd"]
        parts.append("%s (%.0f %% du range 4h %s-%s, equilibre %s)" % (pd["zone"], 100 * pd["pos"], _f(pd["lo"]), _f(pd["hi"]), _f(pd["eq"])))
    if r["fvg_inside"]:
        g = r["fvg_inside"][0]
        parts.append("prix DANS un FVG %s %s-%s (CE %s)" % (g["side"], _f(g["bot"]), _f(g["top"]), _f(g["ce"])))
    if r["fvg_below"]:
        g = r["fvg_below"][0]
        parts.append("FVG %s dessous %s-%s (CE %s)" % (g["side"], _f(g["bot"]), _f(g["top"]), _f(g["ce"])))
    if r["fvg_above"]:
        g = r["fvg_above"][0]
        parts.append("FVG %s dessus %s-%s (CE %s)" % (g["side"], _f(g["bot"]), _f(g["top"]), _f(g["ce"])))
    parts.append("PDH %s / PDL %s" % (_f(r["pdh"]), _f(r["pdl"])))
    parts.append("liquidite : swing haut %s / swing bas %s" % (_f(r["last_sh"]), _f(r["last_sl"])))
    for side, name, lv, age in r["sweeps"]:
        parts.append("SWEEP %s %s (%s) il y a %d bougie(s) 4h" % ("au-dessus du" if side == "haut" else "sous le", name, _f(lv), age))
    if r["kz"]:
        parts.append("kill zone %s en cours" % r["kz"])
    return " · ".join(parts)


def confluence(r, side):
    """Points pour / contre un trade LONG ou SHORT selon la lecture ICT."""
    pro, con = [], []
    long_ = side.startswith("LONG")
    st = r["structure"]
    if st:
        (pro if (st[0] == "haussiere") == long_ else con).append("derniere cassure de structure 4h %s" % st[0])
    pd = r["pd"]
    if pd:
        if long_:
            (pro if pd["zone"] == "discount" else con).append("prix en %s" % pd["zone"])
        else:
            (pro if pd["zone"] == "premium" else con).append("prix en %s" % pd["zone"])
    for s, name, lv, age in r["sweeps"]:
        if long_ and s == "bas":
            pro.append("liquidite prise sous %s (%s)" % (name, _f(lv)))
        if not long_ and s == "haut":
            pro.append("liquidite prise au-dessus de %s (%s)" % (name, _f(lv)))
    for g in r["fvg_inside"]:
        if (g["side"] == "haussier") == long_:
            pro.append("reaction dans un FVG %s" % g["side"])
    return pro, con
