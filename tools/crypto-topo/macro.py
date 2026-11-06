"""Score de liquidite macro + crypto (feu vert / orange / rouge).

Reprend l'idee de mbouazza-dev/my-screener (taux 10 ans, dollar, SPY/TLT, XLK/SPY,
OBV, MFI, VWAP), avec les variations calculees correctement (aujourd'hui vs J-5, J-15,
J-30), et y ajoute les flux crypto deja suivis (ETF spot BTC, USDT/USDC imprimes ou brules).

Sources : Yahoo Finance (chart API publique) pour la macro, MEXC pour BTC (bougies jour
avec volume). Lecture seule. Usage autonome : python3 macro.py
"""
import json
import time
import urllib.request

UA = {"User-Agent": "Mozilla/5.0 (crypto-topo personal research)"}
TICKERS = {"TNX": "%5ETNX", "DXY": "DX-Y.NYB", "SPY": "SPY", "TLT": "TLT", "XLK": "XLK"}


def _get(url, timeout=30):
    err = None
    for i in range(3):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode())
        except Exception as e:  # noqa: BLE001
            err = e
            time.sleep(3 * (i + 1))
    raise RuntimeError("%s -> %s" % (url, err))


def yahoo_closes(sym, rng="6mo"):
    for host in ("query1", "query2"):
        try:
            d = _get("https://%s.finance.yahoo.com/v8/finance/chart/%s?range=%s&interval=1d" % (host, sym, rng))
            r = d["chart"]["result"][0]
            ts, cl = r["timestamp"], r["indicators"]["quote"][0]["close"]
            return [(t, c) for t, c in zip(ts, cl) if c is not None]
        except (RuntimeError, KeyError, IndexError, TypeError):
            continue
    raise RuntimeError("Yahoo indisponible pour %s" % sym)


def _chg(xs, n):
    return xs[-1] - xs[-1 - n] if len(xs) > n else None


def _ratio(a, b):
    db = dict(b)
    return [x / db[t] for t, x in a if t in db and db[t]]


def mexc_daily(sym="BTC", days=120):
    d = _get("https://contract.mexc.com/api/v1/contract/kline/%s_USDT?interval=Day1&start=%d"
             % (sym, int(time.time()) - days * 86400))["data"]
    return d["high"], d["low"], d["close"], d["vol"]


def obv(c, v):
    out, s = [0.0], 0.0
    for i in range(1, len(c)):
        s += v[i] if c[i] > c[i - 1] else (-v[i] if c[i] < c[i - 1] else 0)
        out.append(s)
    return out


def mfi(h, l, c, v, n=14):
    tp = [(h[i] + l[i] + c[i]) / 3 for i in range(len(c))]
    pos = neg = 0.0
    for i in range(len(tp) - n, len(tp)):
        mf = tp[i] * v[i]
        if tp[i] > tp[i - 1]:
            pos += mf
        elif tp[i] < tp[i - 1]:
            neg += mf
    if neg == 0:
        return 100.0 if pos else 50.0
    return 100 - 100 / (1 + pos / neg)


def vwap(h, l, c, v, n=30):
    tp = [(h[i] + l[i] + c[i]) / 3 for i in range(len(c) - n, len(c))]
    vv = v[-n:]
    return sum(a * b for a, b in zip(tp, vv)) / sum(vv) if sum(vv) else None


def score(etf_btc_5d=None, stable_net=None):
    """Renvoie (dict de mesures, liste de (nom, +1/-1/0, explication), total, max)."""
    m = {k: yahoo_closes(t) for k, t in TICKERS.items()}
    tnx = [x for _, x in m["TNX"]]
    dxy = [x for _, x in m["DXY"]]
    spy_tlt = _ratio(m["SPY"], m["TLT"])
    xlk_spy = _ratio(m["XLK"], m["SPY"])
    h, l, c, v = mexc_daily("BTC")
    o = obv(c, v)
    mf = mfi(h, l, c, v)
    vw = vwap(h, l, c, v)
    meas = dict(
        tnx=tnx[-1], tnx5=_chg(tnx, 5), tnx15=_chg(tnx, 15), tnx30=_chg(tnx, 30),
        dxy=dxy[-1], dxy5=_chg(dxy, 5), dxy15=_chg(dxy, 15), dxy30=_chg(dxy, 30),
        spy_tlt=spy_tlt[-1], spy_tlt5=_chg(spy_tlt, 5), spy_tlt15=_chg(spy_tlt, 15), spy_tlt30=_chg(spy_tlt, 30),
        xlk_spy=xlk_spy[-1], xlk_spy5=_chg(xlk_spy, 5), xlk_spy15=_chg(xlk_spy, 15), xlk_spy30=_chg(xlk_spy, 30),
        btc=c[-1], btc7=100 * (c[-1] / c[-8] - 1), obv5=_chg(o, 5), obv15=_chg(o, 15), obv30=_chg(o, 30),
        mfi=mf, vwap30=vw)
    pts = []

    def add(name, cond, good, bad):
        if cond is None:
            pts.append((name, 0, "donnee manquante"))
        else:
            pts.append((name, 1 if cond else -1, good if cond else bad))

    add("Taux US 10 ans", meas["tnx5"] < 0, "en baisse sur 5j (%+.2f pt) : liquidite vers le risque" % meas["tnx5"],
        "en hausse sur 5j (%+.2f pt) : les obligations aspirent la liquidite" % meas["tnx5"])
    add("Dollar DXY", meas["dxy5"] < 0, "en baisse sur 5j (%+.2f) : favorable au risque" % meas["dxy5"],
        "en hausse sur 5j (%+.2f) : le dollar draine la liquidite" % meas["dxy5"])
    add("Actions / obligations (SPY/TLT)", meas["spy_tlt5"] > 0, "en hausse sur 5j : risk-on", "en baisse sur 5j : risk-off")
    add("Tech vs S&P (XLK/SPY)", meas["xlk_spy5"] > 0, "la tech mene sur 5j", "la tech decroche sur 5j")
    add("BTC vs VWAP 30j", meas["btc"] > vw if vw else None, "prix au-dessus du VWAP 30j (%.0f) : acheteurs en controle" % (vw or 0),
        "prix sous le VWAP 30j (%.0f) : vendeurs en controle" % (vw or 0))
    add("OBV BTC 15j", meas["obv15"] > 0, "volume acheteur cumule en hausse (accumulation)", "volume vendeur domine (distribution)")
    add("ETF spot BTC 5j", None if etf_btc_5d is None else etf_btc_5d > 0,
        "entrees nettes %+.0f M$" % (etf_btc_5d or 0), "sorties nettes %+.0f M$" % (etf_btc_5d or 0))
    add("USDT+USDC 8j", None if stable_net is None else stable_net > 0,
        "imprimes %+.2f Md$ : argent frais" % ((stable_net or 0) / 1e9),
        "brules %+.2f Md$ : liquidite qui sort" % ((stable_net or 0) / 1e9))
    total = sum(p for _, p, _ in pts if p > 0)
    mx = sum(1 for _, p, _ in pts if p != 0)
    return meas, pts, total, mx


def verdict(total, mx):
    if mx == 0:
        return "inconnu"
    r = total / mx
    if r >= 0.7:
        return "FEU VERT (risk-on, liquidite favorable)"
    if r >= 0.4:
        return "FEU ORANGE (neutre, signaux contradictoires)"
    return "FEU ROUGE (risk-off, la liquidite se retire)"


def lines(meas, pts, total, mx):
    L = ["Score liquidite : %d/%d -> %s" % (total, mx, verdict(total, mx))]
    for name, p, why in pts:
        L.append("%s %s : %s" % ({1: "[+]", -1: "[-]", 0: "[ ]"}[p], name, why))
    L.append("Detail : US10Y %.2f %% (5j %+.2f, 15j %+.2f, 30j %+.2f) · DXY %.2f (5j %+.2f, 15j %+.2f, 30j %+.2f) · "
             "SPY/TLT %.2f (5j %+.3f, 30j %+.3f) · XLK/SPY %.4f (5j %+.4f, 30j %+.4f) · BTC 7j %+.1f %% · MFI %.0f%s"
             % (meas["tnx"], meas["tnx5"], meas["tnx15"], meas["tnx30"], meas["dxy"], meas["dxy5"], meas["dxy15"],
                meas["dxy30"], meas["spy_tlt"], meas["spy_tlt5"], meas["spy_tlt30"], meas["xlk_spy"], meas["xlk_spy5"],
                meas["xlk_spy30"], meas["btc7"], meas["mfi"],
                " (surchauffe)" if meas["mfi"] > 80 else (" (survente)" if meas["mfi"] < 20 else "")))
    return L


if __name__ == "__main__":
    import flows
    etf5 = stab = None
    try:
        b = flows.etf_asset("bitcoin")["days"]
        etf5 = sum(x["total"] or 0 for x in b[:5])
    except RuntimeError:
        pass
    try:
        sd = flows.stable_daily()
        stab = sum(v for _, v in sd["USDT"]) + sum(v for _, v in sd["USDC"])
    except RuntimeError:
        pass
    for line in lines(*score(etf5, stab)):
        print("-", line)
