#!/usr/bin/env python3
"""Positions reelles de l'utilisateur sur MEXC et controle toutes les 4 h.

  python3 positions.py add --sym ETH --side LONG --entry 2210 --lev 3 --margin 200 \
      --stop 2120 [--t1 2400] [--t2 2550] [--note "..."]
  python3 positions.py update --sym ETH --side LONG [--stop 2210] [--t1 ..] [--t2 ..] [--margin ..] [--note ..]
  python3 positions.py close --sym ETH --side LONG [--price 2390] [--part 50]
  python3 positions.py list
  python3 positions.py check        # indicateurs 1h/4h et signaux pour chaque position ouverte

Lecture seule sur MEXC : aucun ordre n'est passe.
"""
import argparse
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ict  # noqa: E402
from topo import ema, rsi, atr, macd_hist, defillama, llama_line, fm, fm_signed  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
FILE = os.path.join(HERE, "positions.json")
FEE = 0.0004


def load():
    if not os.path.exists(FILE):
        return []
    with open(FILE) as f:
        return json.load(f)


def save(rows):
    with open(FILE, "w") as f:
        json.dump(rows, f, ensure_ascii=False, indent=1)
        f.write("\n")


def api(path):
    url = "https://contract.mexc.com/api/v1/contract/" + path
    for i in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "crypto-topo/1.0"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode())["data"]
        except Exception:  # noqa: BLE001
            time.sleep(5 * (i + 1))
    raise RuntimeError("MEXC indisponible : " + path)


def kl(sym, interval, days):
    d = api("kline/%s_USDT?interval=%s&start=%d" % (sym, interval, int(time.time()) - days * 86400))
    return d["open"], d["high"], d["low"], d["close"], d["vol"]


def find(rows, sym, side):
    for r in rows:
        if r["sym"] == sym.upper() and r["side"] == side and r["status"] == "ouverte":
            return r
    sys.exit("aucune position ouverte %s %s" % (side, sym))


def cmd_add(a):
    rows = load()
    sgn = 1 if a.side == "LONG" else -1
    r = dict(sym=a.sym.upper(), side=a.side, entry=a.entry, lev=a.lev, margin=a.margin,
             notional=round(a.margin * a.lev, 2), stop=a.stop, t1=a.t1, t2=a.t2,
             liq=round(a.entry * (1 - sgn * (1 / a.lev - 0.005)), 6),
             opened=datetime.now(timezone.utc).isoformat(timespec="minutes"),
             status="ouverte", note=a.note, history=[])
    rows.append(r)
    save(rows)
    print("ajoutee :", json.dumps(r, ensure_ascii=False))


def cmd_update(a):
    rows = load()
    r = find(rows, a.sym, a.side)
    for k in ("stop", "t1", "t2", "margin", "note"):
        v = getattr(a, k)
        if v is not None:
            r["history"].append("%s %s: %s -> %s" % (datetime.now(timezone.utc).isoformat(timespec="minutes"), k, r.get(k), v))
            r[k] = v
    r["notional"] = round(r["margin"] * r["lev"], 2)
    save(rows)
    print("mise a jour :", json.dumps(r, ensure_ascii=False))


def cmd_close(a):
    rows = load()
    r = find(rows, a.sym, a.side)
    px = a.price or float(api("ticker?symbol=%s_USDT" % r["sym"])["lastPrice"])
    part = a.part / 100
    sgn = 1 if r["side"] == "LONG" else -1
    n = r["notional"] * part
    pnl = n * sgn * (px - r["entry"]) / r["entry"] - 2 * FEE * n
    r.setdefault("realized", 0)
    r["realized"] = round(r["realized"] + pnl, 2)
    r["history"].append("%s ferme %d%% a %g : %+.2f $" % (datetime.now(timezone.utc).isoformat(timespec="minutes"), a.part, px, pnl))
    if a.part >= 100:
        r["status"] = "fermee"
        r["closed"] = datetime.now(timezone.utc).isoformat(timespec="minutes")
    else:
        r["margin"] = round(r["margin"] * (1 - part), 2)
        r["notional"] = round(r["margin"] * r["lev"], 2)
    save(rows)
    print("fermeture %d%% %s %s a %g : %+.2f $ (realise total %+.2f $)" % (a.part, r["side"], r["sym"], px, pnl, r["realized"]))


def cmd_list(_):
    rows = load()
    op = [r for r in rows if r["status"] == "ouverte"]
    if not op:
        print("Aucune position ouverte.")
    for r in op:
        print("%s %s entree %g x%d marge %g $ (position %g $) stop %s T1 %s T2 %s liq %g"
              % (r["side"], r["sym"], r["entry"], r["lev"], r["margin"], r["notional"], r["stop"], r["t1"], r["t2"], r["liq"]))


def check_one(r, llama=None):
    sym, long_ = r["sym"], r["side"] == "LONG"
    sgn = 1 if long_ else -1
    t = api("ticker?symbol=%s_USDT" % sym)
    px = float(t["lastPrice"])
    o4, h4, l4, c4, v4 = kl(sym, "Hour4", 40)
    o1, h1, l1, c1, v1 = kl(sym, "Min60", 8)
    _, hd, ld, cd, _ = kl(sym, "Day1", 260)
    r4, r1, rd = rsi(c4), rsi(c1), rsi(cd)
    r4_prev = rsi(c4[:-1])
    m4, m4p = macd_hist(c4)
    m1, m1p = macd_hist(c1)
    e20_4, e50_4 = ema(c4, 20)[-1], ema(c4, 50)[-1]
    e20_d, e50_d = ema(cd, 20)[-1], ema(cd, 50)[-1]
    a4 = atr(h4, l4, c4)
    # volume : derniere bougie 4h cloturee vs moyenne des 20 precedentes
    vlast, vavg = v4[-2], sum(v4[-22:-2]) / 20
    vratio = vlast / vavg if vavg else 0
    rng = h4[-2] - l4[-2]
    up_wick = (h4[-2] - max(o4[-2], c4[-2])) / rng if rng else 0
    dn_wick = (min(o4[-2], c4[-2]) - l4[-2]) / rng if rng else 0
    # divergence RSI simple sur 4h : nouveau extreme de prix sans nouveau extreme de RSI (10 dernieres bougies)
    rs = [rsi(c4[:i]) for i in range(len(c4) - 10, len(c4) + 1)]
    win = c4[-11:]
    div = None
    if long_ and win[-1] >= max(win[:-1]) and rs[-1] < max(rs[:-1]) - 3:
        div = "divergence baissiere 4h (prix plus haut, RSI plus bas)"
    if not long_ and win[-1] <= min(win[:-1]) and rs[-1] > min(rs[:-1]) + 3:
        div = "divergence haussiere 4h (prix plus bas, RSI plus haut)"
    pnl = r["notional"] * sgn * (px - r["entry"]) / r["entry"] - 2 * FEE * r["notional"]
    risk = r["notional"] * abs(r["entry"] - r["stop"]) / r["entry"] if r.get("stop") else None
    R = pnl / risk if risk else None
    fund = float(t.get("fundingRate") or 0) * 100

    sig = []
    # surchauffe
    if long_ and (r4 > 75 or r1 > 80):
        sig.append("SURCHAUFFE : RSI 4h %.0f / 1h %.0f -> prendre une partie des gains" % (r4, r1))
    if not long_ and (r4 < 25 or r1 < 20):
        sig.append("SURVENTE : RSI 4h %.0f / 1h %.0f -> prendre une partie des gains" % (r4, r1))
    if vratio > 2.5 and ((long_ and up_wick > 0.4) or (not long_ and dn_wick > 0.4)):
        sig.append("CLIMAX DE VOLUME : x%.1f la moyenne avec une meche de rejet -> securiser" % vratio)
    elif vratio > 2.5:
        sig.append("volume x%.1f la moyenne sur la derniere 4h (mouvement fort)" % vratio)
    if div:
        sig.append(div + " -> essoufflement possible")
    # momentum contre la position
    if m4 is not None and sgn * m4 < 0 and sgn * (m4 - m4p) < 0:
        sig.append("MACD 4h contre la position et qui s'accentue")
    if (long_ and c4[-2] < e50_4) or (not long_ and c4[-2] > e50_4):
        sig.append("cloture 4h de l'autre cote de l'EMA50 4h (%g) -> structure qui casse" % round(e50_4, 6))
    if fund * sgn > 0.05:
        sig.append("funding %.3f %% : position encombree de ton cote" % fund)
    # gestion
    if R is not None and R >= 1 and r.get("stop") and sgn * (r["stop"] - r["entry"]) < 0:
        sig.append("gain >= 1R : remonter le stop au prix d'entree (%g)" % r["entry"])
    if r.get("t1") and sgn * (px - r["t1"]) >= 0:
        sig.append("T1 atteint (%g) : prendre 50 %%" % r["t1"])
    if r.get("t2") and sgn * (px - r["t2"]) >= 0:
        sig.append("T2 atteint (%g) : cloturer le reste ou suivre au stop" % r["t2"])
    if r.get("stop") and sgn * (px - r["stop"]) <= 0:
        sig.append("STOP DEPASSE (%g) : sortir" % r["stop"])
    dist_liq = abs(px - r["liq"]) / px * 100
    if dist_liq < 10:
        sig.append("ATTENTION : liquidation a seulement %.1f %% (%g)" % (dist_liq, r["liq"]))

    print("### %s %s x%d · entree %g · prix %g" % (r["side"], sym, r["lev"], r["entry"], px))
    print("- PnL latent %+.2f $ (%+.1f %% de la marge%s) · marge %g $ · position %g $"
          % (pnl, 100 * pnl / r["margin"], ", %+.2f R" % R if R is not None else "", r["margin"], r["notional"]))
    print("- Stop %s · T1 %s · T2 %s · liquidation %g (a %.1f %%)" % (r["stop"], r["t1"], r["t2"], r["liq"], dist_liq))
    print("- RSI 1h %.0f · 4h %.0f (avant %.0f) · jour %.0f" % (r1, r4, r4_prev, rd))
    print("- MACD hist 4h %s (%s) · 1h %s (%s)" % (
        "positif" if m4 > 0 else "negatif", "monte" if m4 > m4p else "baisse",
        "positif" if m1 > 0 else "negatif", "monte" if m1 > m1p else "baisse"))
    print("- EMA20/50 4h %g / %g · EMA20/50 jour %g / %g · ATR 4h %g (%.1f %%)"
          % (round(e20_4, 6), round(e50_4, 6), round(e20_d, 6), round(e50_d, 6), round(a4, 6), 100 * a4 / px))
    print("- Volume derniere 4h x%.1f la moyenne · meche haute %.0f %% / basse %.0f %% · funding %.3f %%"
          % (vratio, 100 * up_wick, 100 * dn_wick, fund))
    print("- Plus haut / bas 24h : %g / %g" % (max(h1[-24:]), min(l1[-24:])))
    ir = ict.read(o4, h4, l4, c4, hd, ld, px)
    pro, con = ict.confluence(ir, r["side"])
    print("- Lecture ICT 4h : " + ict.describe(ir))
    print("- Confluence ICT pour la position : pour %s ; contre %s" % (", ".join(pro) or "-", ", ".join(con) or "-"))
    st = ir["structure"]
    if st and st[2] <= 2 and ((st[0] == "baissiere") == long_):
        sig.append("CASSURE DE STRUCTURE 4h contre la position (cloture au-dela de %g) -> scenario invalide ?" % st[1])
    for sd, name, lv, age in ir["sweeps"]:
        if (sd == "haut") == long_ and age <= 1:
            sig.append("liquidite prise au-dessus de %s (%g) puis rejet -> securiser" % (name, lv) if long_ else
                       "liquidite prise sous %s (%g) puis rejet -> securiser" % (name, lv))
    ll = llama_line((llama or {}).get(sym))
    if ll:
        print("- DefiLlama : " + ll)
    print("- Signaux : " + (" ; ".join(sig) if sig else "aucun, la position se deroule normalement"))
    print()


def cmd_check(_):
    rows = [r for r in load() if r["status"] == "ouverte"]
    print("# Controle des positions — %s UTC" % datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M"))
    if not rows:
        print("Aucune position ouverte.")
        return
    try:
        b = kl("BTC", "Hour4", 40)[3]
        print("BTC %g · RSI 4h %.0f · EMA20/50 4h %g / %g\n" % (b[-1], rsi(b), round(ema(b, 20)[-1]), round(ema(b, 50)[-1])))
    except RuntimeError:
        pass
    llama = {}
    try:
        llama, glob, _ = defillama([{"symbol": r["sym"]} for r in rows])
        print("USDT+USDC (DefiLlama) : " + " · ".join(
            "%s %s $ (24h %s, 7j %s)" % (k, fm(g["cur"]), fm_signed(g["d1"]), fm_signed(g["d7"])) for k, g in glob.items()) + "\n")
    except RuntimeError as e:
        print("DefiLlama indisponible : %s\n" % e)
    for r in rows:
        try:
            check_one(r, llama)
        except RuntimeError as e:
            print("! %s %s : %s\n" % (r["side"], r["sym"], e))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add")
    a.add_argument("--sym", required=True)
    a.add_argument("--side", required=True, choices=["LONG", "SHORT"])
    a.add_argument("--entry", type=float, required=True)
    a.add_argument("--lev", type=int, required=True)
    a.add_argument("--margin", type=float, required=True, help="marge en $")
    a.add_argument("--stop", type=float)
    a.add_argument("--t1", type=float)
    a.add_argument("--t2", type=float)
    a.add_argument("--note", default="")
    u = sub.add_parser("update")
    u.add_argument("--sym", required=True)
    u.add_argument("--side", required=True, choices=["LONG", "SHORT"])
    for k in ("stop", "t1", "t2", "margin"):
        u.add_argument("--" + k, type=float)
    u.add_argument("--note")
    c = sub.add_parser("close")
    c.add_argument("--sym", required=True)
    c.add_argument("--side", required=True, choices=["LONG", "SHORT"])
    c.add_argument("--price", type=float)
    c.add_argument("--part", type=float, default=100, help="%% de la position fermee")
    sub.add_parser("list")
    sub.add_parser("check")
    args = ap.parse_args()
    dict(add=cmd_add, update=cmd_update, close=cmd_close, list=cmd_list, check=cmd_check)[args.cmd](args)


if __name__ == "__main__":
    main()
