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


# ---------- analyse ----------
def analyse(c, tick, detail):
    sym = c["symbol"].upper() + "_USDT"
    dh, dl, dc, _ = mexc_klines(sym, "Day1", 260)
    time.sleep(0.15)
    hh, hl, hc, _ = mexc_klines(sym, "Hour4", 30)
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
    return dict(sym=c["symbol"].upper(), rank=c["market_cap_rank"], px=px,
                d1=c.get("price_change_percentage_24h_in_currency") or 0,
                d7=c.get("price_change_percentage_7d_in_currency") or 0,
                d30=c.get("price_change_percentage_30d_in_currency") or 0,
                e20=e20, e50=e50, e200=e200, rsi_d=r_d, rsi_4h=r_4h, macd=mh, macd_prev=mh_prev,
                atr=a_d, atr_pct=100 * a_d / px, bb=bb, hi30=hi30, lo30=lo30, fund=fund,
                oi=oi_usd, vol=vol24, trend=trend, mom=mom, setup=setup, why=why,
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

    btc = next((a for a in res if a["sym"] == "BTC"), None)
    up7 = sum(a["d7"] > 0 for a in res)
    bull = sum(a["trend"] >= 3 for a in res)
    bear = sum(a["trend"] <= -3 for a in res)
    med = sorted(a["d1"] for a in res)[len(res) // 2] if res else 0

    w("# Topo crypto — %s UTC" % now.strftime("%Y-%m-%d %H:%M"))
    w("")
    w("Capital %.0f $ · risque %.1f %% par trade (%.0f $) · %d cryptos analysees (top %d CoinGecko avec perpetuel MEXC)"
      % (args.capital, args.risk, args.capital * args.risk / 100, len(res), args.top))
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
        if hl:
            w("- Top traders Hyperliquid : %d long (%.1f M$) / %d short (%.1f M$)"
              % (hl["nl"], hl["long"] / 1e6, hl["ns"], hl["short"] / 1e6))
    if illiq:
        w("")
        w("Setups ecartes car peu liquides sur MEXC (< %.0f M$/24h, risque de glissement et de meches) : %s"
          % (args.min_vol / 1e6, ", ".join("%s %s" % (a["setup"].split()[0], a["sym"]) for a in illiq[:20])))
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

    txt = "\n".join(L)
    if args.out:
        with open(args.out, "w") as f:
            f.write(txt + "\n")
    print(txt)


if __name__ == "__main__":
    sys.exit(main())
