#!/usr/bin/env python3
"""Topo crypto quotidien : top 500 (CoinGecko) x contrats perpetuels MEXC,
indicateurs techniques, setups long/short dimensionnes au risque, et
positionnement des meilleurs traders Hyperliquid.

Aucune dependance (Python 3.8+). N'envoie aucun ordre : lecture seule.

Usage : python3 topo.py [--capital 3000] [--risk 1.0] [--out rapport.md]
"""
import argparse
import json
import math
import sys
import time
import urllib.request
from datetime import datetime, timezone

import flows
import ict
import macro

UA = {"User-Agent": "crypto-topo/1.0", "Accept": "application/json"}
STABLE = {"usdt", "usdc", "dai", "fdusd", "usde", "usds", "tusd", "pyusd", "usd1",
          "usdd", "frax", "busd", "usdtb", "bsc-usd", "susde", "rlusd", "usdf", "usd0",
          "gho", "lusd", "eurc", "usdg", "buidl", "usdx", "syrupusdc", "usyc", "usdai",
          "ustb", "xaut", "paxg"}
SKIP_WORDS = ("wrapped", "staked", "bridged", "liquid staking", "restaked")


def get(url, data=None, timeout=30, tries=4, wait=20):
    body = json.dumps(data).encode() if data is not None else None
    hdr = dict(UA)
    if body:
        hdr["Content-Type"] = "application/json"
    for i in range(tries):
        if i:
            time.sleep(wait * i)
        try:
            req = urllib.request.Request(url, data=body, headers=hdr)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode())
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                raise RuntimeError("%s -> %s" % (url, e))


# ---------- indicateurs ----------
def ema(xs, n):
    if len(xs) < n:
        return [None] * len(xs)
    k = 2 / (n + 1)
    out = [None] * (n - 1)
    e = sum(xs[:n]) / n
    out.append(e)
    for x in xs[n:]:
        e = x * k + e * (1 - k)
        out.append(e)
    return out


def rsi(xs, n=14):
    if len(xs) <= n:
        return None
    g = l = 0.0
    for i in range(1, n + 1):
        d = xs[i] - xs[i - 1]
        g += max(d, 0)
        l += max(-d, 0)
    g /= n
    l /= n
    for i in range(n + 1, len(xs)):
        d = xs[i] - xs[i - 1]
        g = (g * (n - 1) + max(d, 0)) / n
        l = (l * (n - 1) + max(-d, 0)) / n
    return 100.0 if l == 0 else 100 - 100 / (1 + g / l)


def atr(h, lo, c, n=14):
    if len(c) <= n:
        return None
    trs = [max(h[i] - lo[i], abs(h[i] - c[i - 1]), abs(lo[i] - c[i - 1])) for i in range(1, len(c))]
    a = sum(trs[:n]) / n
    for t in trs[n:]:
        a = (a * (n - 1) + t) / n
    return a


def macd_hist(c):
    e12, e26 = ema(c, 12), ema(c, 26)
    m = [a - b for a, b in zip(e12, e26) if a is not None and b is not None]
    if len(m) < 10:
        return None, None
    s = ema(m, 9)
    return m[-1] - s[-1], m[-2] - s[-2]


def bollinger_pct(c, n=20):
    if len(c) < n:
        return None
    w = c[-n:]
    mu = sum(w) / n
    sd = math.sqrt(sum((x - mu) ** 2 for x in w) / n)
    return None if sd == 0 else (c[-1] - (mu - 2 * sd)) / (4 * sd)


# ---------- donnees ----------
def top_coins(n):
    rows = []
    for page in range(1, (n + 249) // 250 + 1):
        if page > 1:
            time.sleep(15)  # limite de debit de l'API gratuite CoinGecko
        rows += get("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd"
                    "&order=market_cap_desc&per_page=250&page=%d"
                    "&price_change_percentage=24h,7d,30d" % page)
    rows = rows[:n]
    out = []
    for c in rows:
        s = c["symbol"].lower()
        nm = c["name"].lower()
        if s in STABLE or any(w in nm or w in c["id"] for w in SKIP_WORDS):
            continue
        out.append(c)
    return out


def mexc_klines(sym, interval, days):
    start = int(time.time()) - days * 86400
    d = get("https://contract.mexc.com/api/v1/contract/kline/%s?interval=%s&start=%d"
            % (sym, interval, start))["data"]
    return d["high"], d["low"], d["close"], d.get("amount", [])


def hl_top_traders(limit=25, min_value=1e6):
    lb = get("https://stats-data.hyperliquid.xyz/Mainnet/leaderboard", timeout=120)["leaderboardRows"]
    picked = []
    for r in lb:
        try:
            av = float(r["accountValue"])
        except (TypeError, ValueError):
            continue
        if av < min_value:
            continue
        w = {k: v for k, v in r["windowPerformances"]}
        try:
            mp, wp, ap = float(w["month"]["pnl"]), float(w["week"]["pnl"]), float(w["allTime"]["pnl"])
            mroi = float(w["month"]["roi"])
        except (KeyError, TypeError, ValueError):
            continue
        # regularite : gagnant sur la semaine, le mois et depuis toujours
        if mp > 0 and wp > 0 and ap > 0:
            picked.append(dict(addr=r["ethAddress"], name=r.get("displayName"), av=av,
                               mpnl=mp, mroi=mroi, apnl=ap))
    picked.sort(key=lambda x: -x["mpnl"])
    picked = picked[:limit]
    agg = {}
    for t in picked:
        try:
            st = get("https://api.hyperliquid.xyz/info", {"type": "clearinghouseState", "user": t["addr"]})
        except RuntimeError:
            continue
        t["positions"] = []
        for ap in st.get("assetPositions", []):
            p = ap["position"]
            coin = p["coin"].lstrip("k") if p["coin"].startswith("k") and p["coin"][1:].isupper() else p["coin"]
            szi = float(p["szi"])
            val = float(p["positionValue"])
            side = "LONG" if szi > 0 else "SHORT"
            t["positions"].append((coin, side, val, p.get("leverage", {}).get("value"),
                                   float(p.get("unrealizedPnl") or 0)))
            a = agg.setdefault(coin, dict(long=0, short=0, nl=0, ns=0))
            if szi > 0:
                a["long"] += val
                a["nl"] += 1
            else:
                a["short"] += val
                a["ns"] += 1
        time.sleep(0.2)
    return picked, agg


def defillama(coins):
    """TVL des chaines et protocoles + flux USDT/USDC par chaine (DefiLlama).

    Renvoie (par_symbole, global) ; par_symbole[SYM] peut contenir :
      chain, chain_tvl, chain_tvl_7d (%), stables, stables_1d, stables_7d, stables_30d ($)
      proto_tvl, proto_tvl_1d (%), proto_tvl_7d (%)
    """
    out = {}
    ids = {c["id"]: c["symbol"].upper() for c in coins if c.get("id")}
    syms = {c["symbol"].upper() for c in coins}
    chains = get("https://api.llama.fi/v2/chains", timeout=60)
    by_name = {c["name"]: c for c in chains}
    assets = get("https://stablecoins.llama.fi/stablecoins?includePrices=false", timeout=90)["peggedAssets"]
    glob = {}
    flows = {}
    for a in assets:
        if a["symbol"] not in ("USDT", "USDC"):
            continue
        cur = a["circulating"].get("peggedUSD", 0)
        glob[a["symbol"]] = dict(
            cur=cur,
            d1=cur - a.get("circulatingPrevDay", {}).get("peggedUSD", cur),
            d7=cur - a.get("circulatingPrevWeek", {}).get("peggedUSD", cur),
            d30=cur - a.get("circulatingPrevMonth", {}).get("peggedUSD", cur))
        for ch, v in a.get("chainCirculating", {}).items():
            c = v["current"].get("peggedUSD", 0)
            f = flows.setdefault(ch, [0.0, 0.0, 0.0, 0.0])
            f[0] += c
            f[1] += c - v.get("circulatingPrevDay", {}).get("peggedUSD", c)
            f[2] += c - v.get("circulatingPrevWeek", {}).get("peggedUSD", c)
            f[3] += c - v.get("circulatingPrevMonth", {}).get("peggedUSD", c)
    chain_rows = []
    for name, f in flows.items():
        ch = by_name.get(name, {})
        sym = ids.get(ch.get("gecko_id")) or (ch.get("tokenSymbol") or "").upper() or None
        chain_rows.append(dict(chain=name, sym=sym, stables=f[0], stables_1d=f[1], stables_7d=f[2],
                               stables_30d=f[3], tvl=ch.get("tvl")))
    # TVL 7j des chaines dont le token est dans le scan
    for c in sorted(chains, key=lambda c: -(c.get("tvl") or 0))[:60]:
        sym = ids.get(c.get("gecko_id"))
        if not sym and (c.get("tokenSymbol") or "").upper() in syms:
            sym = c["tokenSymbol"].upper()
        if not sym or (c.get("tvl") or 0) < 5e7:
            continue
        info = out.setdefault(sym, {})
        info["chain"], info["chain_tvl"] = c["name"], c["tvl"]
        try:
            h = get("https://api.llama.fi/v2/historicalChainTvl/%s" % urllib.request.quote(c["name"]), timeout=60)
            if len(h) > 8 and h[-8]["tvl"]:
                info["chain_tvl_7d"] = 100 * (h[-1]["tvl"] / h[-8]["tvl"] - 1)
        except RuntimeError:
            pass
        time.sleep(0.2)
    for r in chain_rows:
        if r["sym"] and r["sym"] in out:
            out[r["sym"]].update(stables=r["stables"], stables_1d=r["stables_1d"],
                                 stables_7d=r["stables_7d"], stables_30d=r["stables_30d"])
    # protocoles : somme des versions par symbole (hors CEX)
    agg = {}
    for p in get("https://api.llama.fi/protocols", timeout=120):
        if p.get("category") in ("CEX", "Chain") or not p.get("tvl"):
            continue
        sym = ids.get(p.get("gecko_id")) or (p.get("symbol") or "").upper()
        if not sym or sym == "-":
            continue
        tvl = p["tvl"]
        a = agg.setdefault(sym, [0.0, 0.0, 0.0])
        a[0] += tvl
        a[1] += tvl / (1 + (p.get("change_1d") or 0) / 100)
        a[2] += tvl / (1 + (p.get("change_7d") or 0) / 100)
    for sym, (tvl, p1, p7) in agg.items():
        if sym in syms and tvl >= 2e7:
            info = out.setdefault(sym, {})
            info.update(proto_tvl=tvl, proto_tvl_1d=100 * (tvl / p1 - 1) if p1 else 0,
                        proto_tvl_7d=100 * (tvl / p7 - 1) if p7 else 0)
    return out, glob, sorted(chain_rows, key=lambda r: -r["stables"])


def fm(x):
    """Montant en $ lisible : 1.2 Md / 340 M."""
    if x is None:
        return "-"
    s = "-" if x < 0 else ""
    x = abs(x)
    return s + ("%.1f Md" % (x / 1e9) if x >= 1e9 else "%.0f M" % (x / 1e6))


def fm_signed(x):
    return ("+" if x >= 0 else "") + fm(x)


def llama_line(d):
    if not d:
        return None
    parts = []
    if "chain_tvl" in d:
        parts.append("TVL chaine %s $%s" % (fm(d["chain_tvl"]), " (%+.1f %% 7j)" % d["chain_tvl_7d"] if "chain_tvl_7d" in d else ""))
    if "stables" in d:
        parts.append("USDT+USDC sur la chaine %s $ (24h %s, 7j %s, 30j %s)"
                     % (fm(d["stables"]), fm_signed(d["stables_1d"]), fm_signed(d["stables_7d"]), fm_signed(d["stables_30d"])))
    if "proto_tvl" in d:
        parts.append("TVL protocole %s $ (24h %+.1f %%, 7j %+.1f %%)" % (fm(d["proto_tvl"]), d["proto_tvl_1d"], d["proto_tvl_7d"]))
    return " · ".join(parts) if parts else None


# ---------- analyse ----------
def analyse(c, tick, detail):
    sym = c["symbol"].upper() + "_USDT"
    dh, dl, dc, _ = mexc_klines(sym, "Day1", 260)
    time.sleep(0.15)
    hh, hl, hc, _ = mexc_klines(sym, "Hour4", 30)
    ict_r = ict.read(hc, hh, hl, hc, dh, dl, float(tick["lastPrice"])) if len(hc) > 20 else None
    time.sleep(0.15)
    if len(dc) < 60 or len(hc) < 40:
        return None
    px = float(tick["lastPrice"])
    e20, e50, e200 = ema(dc, 20)[-1], ema(dc, 50)[-1], (ema(dc, 200)[-1] if len(dc) >= 200 else None)
    h4e50 = ema(hc, 50)[-1]
    r_d, r_4h = rsi(dc), rsi(hc)
    mh, mh_prev = macd_hist(dc)
    a_d = atr(dh, dl, dc)
    bb = bollinger_pct(dc)
    hi30, lo30 = max(dh[-30:]), min(dl[-30:])
    fund = float(tick.get("fundingRate") or 0) * 100
    csize = float(detail.get("contractSize") or 0) if detail else 0
    oi_usd = float(tick.get("holdVol") or 0) * csize * px
    vol24 = float(tick.get("amount24") or 0)

    trend = 0
    trend += 1 if px > e20 else -1
    trend += 1 if px > e50 else -1
    trend += 1 if e20 > e50 else -1
    if e200:
        trend += 1 if px > e200 else -1
        trend += 1 if e50 > e200 else -1
    mom = 0
    if mh is not None:
        mom += 1 if mh > 0 else -1
        mom += 1 if mh > mh_prev else -1
    mom += 1 if px > h4e50 else -1

    setup, why = None, []
    # LONG : tendance haussiere + repli 4h non excessif + momentum qui repart
    if trend >= 3 and 38 <= r_4h <= 60 and mom >= 1 and r_d < 72:
        setup = "LONG"
        why.append("tendance haussiere (prix > EMA20/50%s)" % ("/200" if e200 and px > e200 else ""))
        why.append("repli 4h sain (RSI4h %.0f)" % r_4h)
    # SHORT : tendance baissiere + rebond 4h + momentum qui se retourne
    elif trend <= -3 and 40 <= r_4h <= 62 and mom <= -1 and r_d > 28:
        setup = "SHORT"
        why.append("tendance baissiere (prix < EMA20/50%s)" % ("/200" if e200 and px < e200 else ""))
        why.append("rebond 4h a vendre (RSI4h %.0f)" % r_4h)
    # Rebond technique (contre-tendance, plus risque)
    elif r_d < 27 and r_4h < 32 and fund < 0:
        setup = "LONG (rebond, contre-tendance)"
        why.append("survente forte (RSI J %.0f / 4h %.0f) et shorts qui paient" % (r_d, r_4h))
    elif r_d > 75 and r_4h > 72 and fund > 0.03:
        setup = "SHORT (exces, contre-tendance)"
        why.append("surachat fort (RSI J %.0f / 4h %.0f) et longs qui paient cher" % (r_d, r_4h))
    if setup and fund:
        if setup.startswith("LONG") and fund < -0.01:
            why.append("funding negatif (%.3f%%) : shorts encombres" % fund)
        if setup.startswith("SHORT") and fund > 0.02:
            why.append("funding eleve (%.3f%%) : longs encombres" % fund)
    perf = {}
    for lab, n in (("24h", 6), ("2j", 12), ("5j", 30), ("7j", 42)):
        perf[lab] = 100 * (px / hc[-1 - n] - 1) if len(hc) > n and hc[-1 - n] else None
    # volume 24h vs moyenne des 7 jours precedents (montant 4h)
    return dict(perf=perf, sym=c["symbol"].upper(), rank=c["market_cap_rank"], px=px,
                d1=c.get("price_change_percentage_24h_in_currency") or 0,
                d7=c.get("price_change_percentage_7d_in_currency") or 0,
                d30=c.get("price_change_percentage_30d_in_currency") or 0,
                e20=e20, e50=e50, e200=e200, rsi_d=r_d, rsi_4h=r_4h, macd=mh, macd_prev=mh_prev,
                atr=a_d, atr_pct=100 * a_d / px, bb=bb, hi30=hi30, lo30=lo30, fund=fund,
                oi=oi_usd, vol=vol24, trend=trend, mom=mom, setup=setup, why=why, ict=ict_r,
                maxlev=(detail or {}).get("maxLeverage"),
                taker=float((detail or {}).get("takerFeeRate") or 0.0002))


def size_trade(a, capital, risk_pct):
    long_ = a["setup"].startswith("LONG")
    mult = 2.0 if "contre" in a["setup"] else 1.5
    dist = mult * a["atr"]
    entry = a["px"]
    stop = entry - dist if long_ else entry + dist
    stop_pct = dist / entry
    risk_usd = capital * risk_pct / 100
    if "contre" in a["setup"]:
        risk_usd /= 2  # contre-tendance : moitie du risque
    notional = risk_usd / (stop_pct + 2 * a["taker"])
    # levier : le plus bas qui laisse la liquidation au moins 1,5x plus loin que le stop
    lev = 1
    for L in (1, 2, 3, 5):
        liq_dist = 1 / L - 0.005
        if liq_dist >= 1.5 * stop_pct:
            lev = L
    margin = notional / lev
    cap_margin = capital * 0.25
    if margin > cap_margin:  # jamais plus de 25 % du capital en marge sur un trade
        margin = cap_margin
        notional = margin * lev
        risk_usd = notional * (stop_pct + 2 * a["taker"])
    liq = entry * (1 - (1 / lev - 0.005)) if long_ else entry * (1 + (1 / lev - 0.005))
    t1 = entry + 2 * dist if long_ else entry - 2 * dist
    t2 = entry + 3 * dist if long_ else entry - 3 * dist
    return dict(entry=entry, stop=stop, stop_pct=100 * stop_pct, t1=t1, t2=t2, notional=notional,
                lev=lev, margin=margin, liq=liq if lev > 1 else None, risk=risk_usd)


def fp(x):
    if x is None:
        return "-"
    if x >= 1000:
        return "{:,.0f}".format(x).replace(",", " ")
    if x >= 1:
        return "%.3f" % x
    return "%.4g" % x


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--capital", type=float, default=3000)
    ap.add_argument("--risk", type=float, default=1.0, help="%% du capital risque par trade")
    ap.add_argument("--top", type=int, default=500, help="taille du classement CoinGecko analyse")
    ap.add_argument("--min-vol", type=float, default=20e6, help="volume futures MEXC 24h minimum ($)")
    ap.add_argument("--out")
    args = ap.parse_args()

    now = datetime.now(timezone.utc)
    L = []
    w = L.append
    errors = []

    coins = top_coins(args.top)
    ticks = {t["symbol"]: t for t in get("https://contract.mexc.com/api/v1/contract/ticker")["data"]}
    details = {d["symbol"]: d for d in get("https://contract.mexc.com/api/v1/contract/detail")["data"]}

    res = []
    for c in coins:
        sym = c["symbol"].upper() + "_USDT"
        if sym not in ticks:
            continue
        try:
            a = analyse(c, ticks[sym], details.get(sym))
        except RuntimeError as e:
            errors.append(str(e))
            continue
        if a:
            res.append(a)

    try:
        traders, agg = hl_top_traders()
    except RuntimeError as e:
        traders, agg = [], {}
        errors.append(str(e))

    try:
        llama, sglob, schains = defillama(coins)
    except RuntimeError as e:
        llama, sglob, schains = {}, {}, []
        errors.append(str(e))

    btc = next((a for a in res if a["sym"] == "BTC"), None)
    WIN = ("24h", "2j", "5j", "7j")
    if btc:
        for a in res:
            a["rs"] = {k: (a["perf"][k] - btc["perf"][k]) if a["perf"].get(k) is not None and btc["perf"].get(k) is not None else None
                       for k in WIN}
            vals = [v for v in a["rs"].values() if v is not None]
            a["rs_avg"] = sum(vals) / len(vals) if vals else 0
            a["rs_up"] = sum(1 for v in vals if v > 0)
            a["rs_dn"] = sum(1 for v in vals if v < 0)
    up7 = sum(a["d7"] > 0 for a in res)
    bull = sum(a["trend"] >= 3 for a in res)
    bear = sum(a["trend"] <= -3 for a in res)
    med = sorted(a["d1"] for a in res)[len(res) // 2] if res else 0

    w("# Topo crypto — %s UTC" % now.strftime("%Y-%m-%d %H:%M"))
    w("")
    w("Capital %.0f $ · risque %.1f %% par trade (%.0f $) · %d cryptos analysees (top %d CoinGecko avec perpetuel MEXC)"
      % (args.capital, args.risk, args.capital * args.risk / 100, len(res), args.top))
    w("")
    w("## Score de liquidite (macro + crypto)")
    w("@@MACRO@@")
    w("")
    w("## Marche")
    if btc:
        w("- BTC %s $ · 24h %+.1f %% · 7j %+.1f %% · RSI J %.0f / 4h %.0f · tendance %+d/5 · funding %.3f %%"
          % (fp(btc["px"]), btc["d1"], btc["d7"], btc["rsi_d"], btc["rsi_4h"], btc["trend"], btc["fund"]))
    w("- Mediane 24h %+.1f %% · %d/%d en hausse sur 7j · %d en tendance haussiere, %d en tendance baissiere"
      % (med, up7, len(res), bull, bear))
    w("")
    w("## Tableau (liquides, volume futures MEXC >= %.0f M$, trie par rang)" % (args.min_vol / 1e6))
    w("| # | Crypto | Prix | 24h | 7j | 30j | RSI J | RSI 4h | MACD | Tend. | ATR % | Funding % | Vol MEXC M$ | Setup |")
    w("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for a in [a for a in res if a["vol"] >= args.min_vol]:
        m = "-" if a["macd"] is None else ("↑" if a["macd"] > a["macd_prev"] else "↓") + ("+" if a["macd"] > 0 else "−")
        w("| %d | %s | %s | %+.1f | %+.1f | %+.1f | %.0f | %.0f | %s | %+d | %.1f | %.3f | %.0f | %s |"
          % (a["rank"], a["sym"], fp(a["px"]), a["d1"], a["d7"], a["d30"], a["rsi_d"], a["rsi_4h"], m,
             a["trend"], a["atr_pct"], a["fund"], a["vol"] / 1e6, a["setup"] or ""))
    w("")
    w("## Setups detectes (liquides : volume futures MEXC >= %.0f M$)" % (args.min_vol / 1e6))
    setups = [a for a in res if a["setup"] and a["vol"] >= args.min_vol]
    setups.sort(key=lambda a: (-(abs(a["trend"]) + abs(a["mom"])), -a["vol"]))
    if not setups:
        w("Aucun setup propre aujourd'hui sur les cryptos liquides. Ne rien faire est une position.")
    illiq = [a for a in res if a["setup"] and a["vol"] < args.min_vol]
    for a in setups[:6]:
        s = size_trade(a, args.capital, args.risk)
        hl = agg.get(a["sym"])
        w("")
        w("### %s %s" % (a["setup"], a["sym"]))
        w("- Pourquoi : %s" % " ; ".join(a["why"]))
        w("- Entree ~%s · stop %s (%.1f %%) · objectifs %s (2R) / %s (3R)"
          % (fp(s["entry"]), fp(s["stop"]), s["stop_pct"], fp(s["t1"]), fp(s["t2"])))
        w("- Taille : position %.0f $ · levier x%d · marge %.0f $ · perte max au stop ~%.0f $%s"
          % (s["notional"], s["lev"], s["margin"], s["risk"],
             " · liquidation ~%s" % fp(s["liq"]) if s["liq"] else " · sans levier, pas de liquidation"))
        w("- Contexte : RSI J %.0f / 4h %.0f · EMA20 %s · EMA50 %s · EMA200 %s · plage 30j %s–%s · funding %.3f %% · OI ~%.0f M$"
          % (a["rsi_d"], a["rsi_4h"], fp(a["e20"]), fp(a["e50"]), fp(a["e200"]), fp(a["lo30"]),
             fp(a["hi30"]), a["fund"], a["oi"] / 1e6))
        if a.get("rs"):
            w("- Force relative vs BTC : " + " · ".join("%s %s" % (k, "-" if a["rs"][k] is None else "%+.1f pt" % a["rs"][k]) for k in WIN))
        if a.get("ict"):
            pro, con = ict.confluence(a["ict"], a["setup"])
            w("- Lecture ICT 4h : " + ict.describe(a["ict"]))
            w("- Confluence ICT : pour %s ; contre %s" % (", ".join(pro) or "-", ", ".join(con) or "-"))
        ll = llama_line(llama.get(a["sym"]))
        if ll:
            w("- DefiLlama : " + ll)
        if hl:
            w("- Top traders Hyperliquid : %d long (%.1f M$) / %d short (%.1f M$)"
              % (hl["nl"], hl["long"] / 1e6, hl["ns"], hl["short"] / 1e6))
    if illiq:
        w("")
        w("Setups ecartes car peu liquides sur MEXC (< %.0f M$/24h, risque de glissement et de meches) : %s"
          % (args.min_vol / 1e6, ", ".join("%s %s" % (a["setup"].split()[0], a["sym"]) for a in illiq[:20])))
    w("")
    w("## Flux institutionnels et liquidite fraiche")
    etf5 = stab = None
    try:
        w("ETF spot US (cryptoetf.today, donnees T+1 en M$) :")
        fl = flows.etf_flows()
        for line in flows.etf_lines(fl):
            w("- " + line)
        if fl.get("BTC", {}).get("days"):
            etf5 = sum(x["total"] or 0 for x in fl["BTC"]["days"][:5])
    except RuntimeError as e:
        w("- ETF indisponibles : %s" % e)
    try:
        w("USDT / USDC imprimes ou brules par jour (DefiLlama) :")
        sd = flows.stable_daily()
        for line in flows.stable_lines(sd):
            w("- " + line)
        stab = sum(v for _, v in sd["USDT"]) + sum(v for _, v in sd["USDC"])
    except RuntimeError as e:
        w("- Stablecoins indisponibles : %s" % e)
    w("")
    w("## Force relative vs BTC (liquides, volume futures MEXC >= %.0f M$)" % (args.min_vol / 1e6))
    if btc:
        w("BTC : 24h %+.1f %% · 2j %+.1f %% · 5j %+.1f %% · 7j %+.1f %%" % tuple(btc["perf"][k] or 0 for k in WIN))
        liq = [a for a in res if a["sym"] != "BTC" and a["vol"] >= args.min_vol and a.get("rs")]
        hdr = "| Crypto | Prix | vs BTC 24h | 2j | 5j | 7j | Vol MEXC M$ | Funding % | Structure 4h |"
        sep = "|---|---|---|---|---|---|---|---|---|"

        def row(a):
            st = a["ict"]["structure"][0] if a.get("ict") and a["ict"]["structure"] else "-"
            return "| %s | %s | %s | %s | %s | %s | %.0f | %.3f | %s |" % (
                a["sym"], fp(a["px"]), *["-" if a["rs"][k] is None else "%+.1f" % a["rs"][k] for k in WIN],
                a["vol"] / 1e6, a["fund"], st)
        outp = sorted([a for a in liq if a["rs_up"] >= 3], key=lambda a: -a["rs_avg"])[:10]
        undp = sorted([a for a in liq if a["rs_dn"] >= 3], key=lambda a: a["rs_avg"])[:10]
        w("")
        w("**Surperforment BTC** (sur au moins 3 des 4 periodes) -> candidats LONG quand le marche rebondit :")
        w(hdr)
        w(sep)
        for a in outp:
            w(row(a))
        w("")
        w("**Sous-performent BTC** (sur au moins 3 des 4 periodes) -> candidats SHORT quand le marche baisse :")
        w(hdr)
        w(sep)
        for a in undp:
            w(row(a))
    w("")
    w("## Lecture ICT 4h des principales cryptos liquides")
    for a in [a for a in res if a["vol"] >= args.min_vol and a.get("ict")][:12]:
        w("- **%s** %s : %s" % (a["sym"], fp(a["px"]), ict.describe(a["ict"])))
    w("")
    w("## Flux DeFi (DefiLlama)")
    if sglob:
        for k in ("USDT", "USDC"):
            g = sglob.get(k)
            if g:
                w("- %s en circulation %s $ · 24h %s · 7j %s · 30j %s"
                  % (k, fm(g["cur"]), fm_signed(g["d1"]), fm_signed(g["d7"]), fm_signed(g["d30"])))
        w("- (emission = liquidite fraiche qui entre dans la crypto ; rachat = liquidite qui sort)")
        w("")
        w("USDT+USDC par chaine (top 10 par encours) :")
        w("| Chaine | Token | Encours | 24h | 7j | 30j | TVL |")
        w("|---|---|---|---|---|---|---|")
        for r in schains[:10]:
            w("| %s | %s | %s | %s | %s | %s | %s |" % (r["chain"], r["sym"] or "-", fm(r["stables"]), fm_signed(r["stables_1d"]),
                                                     fm_signed(r["stables_7d"]), fm_signed(r["stables_30d"]), fm(r["tvl"])))
        movers = sorted([r for r in schains if abs(r["stables_7d"]) >= 5e7], key=lambda r: -r["stables_7d"])
        if movers:
            w("")
            w("Plus gros flux USDT+USDC sur 7j : entrees %s ; sorties %s"
              % (", ".join("%s %s" % (r["chain"], fm_signed(r["stables_7d"])) for r in movers[:5] if r["stables_7d"] > 0) or "-",
                 ", ".join("%s %s" % (r["chain"], fm_signed(r["stables_7d"])) for r in movers[::-1][:5] if r["stables_7d"] < 0) or "-"))
        tv = [(a["sym"], llama[a["sym"]]) for a in res if a["sym"] in llama and a["vol"] >= args.min_vol]
        if tv:
            w("")
            w("Cryptos liquides du scan avec donnees DefiLlama :")
            for sym, d in tv:
                w("- %s : %s" % (sym, llama_line(d)))
    else:
        w("Donnees DefiLlama indisponibles aujourd'hui.")
    w("")
    w("## Meilleurs traders Hyperliquid (gagnants semaine + mois + historique, compte >= 1 M$)")
    if traders:
        w("| Trader | Compte M$ | PnL mois M$ | ROI mois | Positions principales |")
        w("|---|---|---|---|---|")
        for t in traders[:12]:
            pos = sorted(t.get("positions", []), key=lambda p: -p[2])[:4]
            ps = ", ".join("%s %s %.1fM x%s" % (p[1], p[0], p[2] / 1e6, p[3]) for p in pos) or "aucune position"
            w("| %s | %.1f | %+.1f | %+.0f %% | %s |"
              % (t["name"] or t["addr"][:10] + "…", t["av"] / 1e6, t["mpnl"] / 1e6, 100 * t["mroi"], ps))
        w("")
        w("Positionnement net des top traders (par montant) :")
        top = sorted(agg.items(), key=lambda kv: -(kv[1]["long"] + kv[1]["short"]))[:12]
        for coin, v in top:
            net = v["long"] - v["short"]
            w("- %s : %d long %.1f M$ / %d short %.1f M$ → net %s %.1f M$"
              % (coin, v["nl"], v["long"] / 1e6, v["ns"], v["short"] / 1e6,
                 "LONG" if net >= 0 else "SHORT", abs(net) / 1e6))
    else:
        w("Donnees indisponibles aujourd'hui.")
    if errors:
        w("")
        w("_Erreurs de donnees : %d (ex. %s)_" % (len(errors), errors[0][:160]))
    w("")
    w("_Analyse automatique a but informatif, pas un conseil en investissement. Le levier peut faire perdre plus que prevu ; aucun ordre n'est passe._")

    try:
        mtxt = "\n".join("- " + x for x in macro.lines(*macro.score(etf5, stab)))
    except RuntimeError as e:
        mtxt = "- Score macro indisponible : %s" % e
    L = [mtxt if x == "@@MACRO@@" else x for x in L]
    txt = "\n".join(L)
    if args.out:
        with open(args.out, "w") as f:
            f.write(txt + "\n")
    print(txt)


if __name__ == "__main__":
    sys.exit(main())
