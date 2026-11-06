"""Flux institutionnels et liquidite fraiche.

- ETF spot crypto US (BlackRock IBIT/ETHA, Fidelity, Grayscale, Bitwise...) : flux nets
  quotidiens par fonds, lus sur les pages publiques de cryptoetf.today (donnees T+1,
  publiees le matin pour la veille de bourse US).
- USDT / USDC imprimes ou brules jour par jour (DefiLlama) : emission = liquidite fraiche
  qui entre dans la crypto, rachat (burn) = liquidite qui sort.

Lecture seule. Usage autonome : python3 flows.py
"""
import html
import json
import re
import time
import urllib.request
from datetime import datetime, timezone

UA = {"User-Agent": "crypto-topo/1.0 (+personal research)"}
ETF_PAGES = [("BTC", "bitcoin"), ("ETH", "ethereum"), ("SOL", "solana"), ("XRP", "xrp"), ("HYPE", "hype")]


def _get(url, timeout=40, raw=False):
    for i in range(3):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                t = r.read().decode("utf-8", "replace")
                return t if raw else json.loads(t)
        except Exception as e:  # noqa: BLE001
            err = e
            time.sleep(3 * (i + 1))
    raise RuntimeError("%s -> %s" % (url, err))


def _num(s):
    s = s.replace("−", "-").replace(",", "").replace("+", "").strip()
    if s in ("", "—", "-"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _cells(row):
    return [re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", c))).strip()
            for c in re.findall(r"<t[hd][^>]*>.*?</t[hd]>", row, flags=re.S)]


def etf_asset(slug):
    """Tableau 'jour x fonds' (M$) de la page d'un actif."""
    page = _get("https://cryptoetf.today/en/%s-etf-flows" % slug, raw=True)
    tables = re.findall(r"<table.*?</table>", page, flags=re.S)
    for tb in tables:
        rows = [_cells(r) for r in re.findall(r"<tr.*?</tr>", tb, flags=re.S)]
        if rows and rows[0] and rows[0][0] == "Day" and rows[0][-1] == "Total":
            funds = [h.split(" ")[0] for h in rows[0][1:-1]]
            issuers = [" ".join(h.split(" ")[1:]).split(" · ")[0] for h in rows[0][1:-1]]
            days = []
            for r in rows[1:]:
                if not r or not re.match(r"^[A-Z][a-z]{2} \d", r[0]):
                    continue
                vals = [_num(x) for x in r[1:-1]]
                days.append(dict(day=r[0], total=_num(r[-1]), by_fund=dict(zip(funds, vals)),
                                 partial=any(v is None for v in vals)))
            return dict(funds=funds, issuers=dict(zip(funds, issuers)), days=days)
    raise RuntimeError("tableau de flux introuvable pour %s" % slug)


def etf_flows():
    out = {}
    for sym, slug in ETF_PAGES:
        try:
            out[sym] = etf_asset(slug)
        except RuntimeError as e:
            out[sym] = dict(error=str(e))
        time.sleep(1)
    try:
        home = _get("https://cryptoetf.today/en/", raw=True)
        txt = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", re.sub(r"<script.*?</script>", "", home, flags=re.S))))
        m = re.search(r"CEFI\s*:?\s*(\d+)\s*·?\s*([A-Za-z ]+?)\s+(?:BTC|Funds|Net)", txt)
        out["_cefi"] = (int(m.group(1)), m.group(2).strip()) if m else None
    except RuntimeError:
        out["_cefi"] = None
    return out


def blackrock_ticker(a):
    for f, iss in a.get("issuers", {}).items():
        if iss.startswith("BlackRock"):
            return f
    return None


def etf_lines(fl):
    L = []
    if fl.get("_cefi"):
        L.append("CEFI (indice des flux ETF, 0-100, 50 = neutre) : %d · %s" % fl["_cefi"])
    for sym, _ in ETF_PAGES:
        a = fl.get(sym) or {}
        if "days" not in a or not a["days"]:
            if a.get("error"):
                L.append("%s : donnees indisponibles" % sym)
            continue
        d = a["days"]
        last = d[0]
        tot5 = sum(x["total"] or 0 for x in d[:5])
        tot10 = sum(x["total"] or 0 for x in d[:10])
        streak, sign = 0, None
        for x in d:
            t = x["total"] or 0
            s = t > 0
            if t == 0 or (sign is not None and s != sign):
                break
            sign, streak = s, streak + 1
        br = blackrock_ticker(a)
        brs = ""
        if br:
            v = last["by_fund"].get(br)
            v5 = sum((x["by_fund"].get(br) or 0) for x in d[:5])
            brs = " · BlackRock %s %s M$ (5j %+.1f M$)" % (br, "non publie" if v is None else "%+.1f" % v, v5)
        movers = sorted([(f, v) for f, v in last["by_fund"].items() if v], key=lambda kv: -abs(kv[1]))[:3]
        L.append("%s ETF %s : %+.1f M$%s · 5j %+.1f M$ · 10j %+.1f M$ · serie %d jour(s) %s%s · gros mouvements : %s"
                 % (sym, last["day"], last["total"] or 0, " (partiel)" if last["partial"] else "", tot5, tot10,
                    streak, "d'entrees" if sign else "de sorties", brs,
                    ", ".join("%s %+.1f" % (f, v) for f, v in movers) or "-"))
    return L


def stable_daily(days=8):
    """Variation nette quotidienne de l'offre USDT (id 1) et USDC (id 2)."""
    out = {}
    for sid, name in ((1, "USDT"), (2, "USDC")):
        d = _get("https://stablecoins.llama.fi/stablecoincharts/all?stablecoin=%d" % sid, timeout=60)[-(days + 1):]
        vals = [(datetime.fromtimestamp(int(x["date"]), timezone.utc).strftime("%d/%m"),
                 x["totalCirculating"]["peggedUSD"]) for x in d]
        out[name] = [(vals[i][0], vals[i][1] - vals[i - 1][1]) for i in range(1, len(vals))]
        out[name + "_supply"] = vals[-1][1]
    return out


def stable_lines(sd):
    L = []
    tot = 0
    for name in ("USDT", "USDC"):
        ch = sd.get(name) or []
        if not ch:
            continue
        net = sum(v for _, v in ch)
        tot += net
        streak, sign = 0, None
        for _, v in reversed(ch):
            s = v > 0
            if sign is not None and s != sign:
                break
            sign, streak = s, streak + 1
        L.append("%s : %s · %d j : %s · serie de %d jour(s) %s"
                 % (name, " ".join("%s %s" % (dd, _m(v)) for dd, v in ch[-5:]), len(ch), _m(net), streak,
                    "d'impression" if sign else "de burn"))
    if L:
        L.append("Net USDT+USDC %d j : %s -> %s" % (len(sd.get("USDT", [])), _m(tot),
                 "liquidite fraiche qui ENTRE" if tot > 0 else "liquidite qui SORT de la crypto"))
    return L


def _m(v):
    s = "+" if v >= 0 else "-"
    v = abs(v)
    return s + ("%.2f Md$" % (v / 1e9) if v >= 1e9 else "%.0f M$" % (v / 1e6))


if __name__ == "__main__":
    for line in etf_lines(etf_flows()):
        print("-", line)
    for line in stable_lines(stable_daily()):
        print("-", line)
