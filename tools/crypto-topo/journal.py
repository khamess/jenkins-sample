#!/usr/bin/env python3
"""Journal des trades proposes par le topo, et bilan sur les prix reels MEXC.

  python3 journal.py add --sym ZEC --side LONG --entry 1268 --stop 1092 \
      --t1 1619 --t2 1795 --lev 3 (--margin 72 | --risk 30) [--valid 24] [--note "..."]
  python3 journal.py eval            # met a jour les statuts et affiche le bilan

Regles de suivi (simples et conservatrices) :
- l'entree est un ordre limite valable --valid heures (24 par defaut) ; non touchee -> "expire" ;
- une fois en position : moitie prise a T1, stop remonte au prix d'entree, reste a T2 ;
- si une meme bougie 1h touche le stop et un objectif, on compte le stop ;
- position fermee au prix du marche apres 7 jours ("temps") ;
- frais 0,04 % par cote sur la taille de position.
Lecture seule sur MEXC : aucun ordre n'est passe.
"""
import argparse
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
JOURNAL = os.path.join(HERE, "journal.jsonl")
FEE = 0.0004
MAX_HOLD_H = 24 * 7


def load():
    if not os.path.exists(JOURNAL):
        return []
    with open(JOURNAL) as f:
        return [json.loads(l) for l in f if l.strip()]


def save(rows):
    with open(JOURNAL, "w") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def klines_1h(sym, start):
    url = ("https://contract.mexc.com/api/v1/contract/kline/%s_USDT?interval=Min60&start=%d"
           % (sym, int(start)))
    for i in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "crypto-topo/1.0"})
            with urllib.request.urlopen(req, timeout=30) as r:
                d = json.loads(r.read().decode())["data"]
            return list(zip(d["time"], d["high"], d["low"], d["close"]))
        except Exception:  # noqa: BLE001
            time.sleep(5 * (i + 1))
    raise RuntimeError("klines indisponibles pour %s" % sym)


def pnl_of(t, exit1, exit2):
    """PnL en $ : moitie sortie a exit1, moitie a exit2."""
    sgn = 1 if t["side"] == "LONG" else -1
    n = t["notional"]
    g = 0.5 * n * sgn * (exit1 - t["entry"]) / t["entry"] + 0.5 * n * sgn * (exit2 - t["entry"]) / t["entry"]
    return g - 2 * FEE * n


def evaluate(t, now):
    if t["status"] not in ("en attente", "ouvert", "ouvert T1"):
        return t
    created = datetime.fromisoformat(t["date"]).timestamp()
    ks = klines_1h(t["sym"], created)
    long_ = t["side"] == "LONG"
    status, filled_at, stop = t["status"], t.get("filled_at"), t["stop"]
    if status == "ouvert T1":
        stop = t["entry"]
    for ts, hi, lo, cl in ks:
        if ts < created:
            continue
        if status == "en attente":
            if ts > created + t["valid_h"] * 3600:
                t["status"] = "expire"
                return t
            if lo <= t["entry"] <= hi:
                status, filled_at = "ouvert", ts
            else:
                continue
        hit_stop = lo <= stop if long_ else hi >= stop
        hit_t1 = hi >= t["t1"] if long_ else lo <= t["t1"]
        hit_t2 = hi >= t["t2"] if long_ else lo <= t["t2"]
        if hit_stop:
            if status == "ouvert":
                t["pnl"] = round(pnl_of(t, stop, stop), 2)
                t["status"] = "stop"
            else:
                t["pnl"] = round(pnl_of(t, t["t1"], stop), 2)
                t["status"] = "T1 puis seuil"
            break
        if status == "ouvert" and hit_t1:
            status, stop = "ouvert T1", t["entry"]
        if status == "ouvert T1" and hit_t2:
            t["pnl"] = round(pnl_of(t, t["t1"], t["t2"]), 2)
            t["status"] = "T2"
            break
        if ts > filled_at + MAX_HOLD_H * 3600:
            e1 = t["t1"] if status == "ouvert T1" else cl
            t["pnl"] = round(pnl_of(t, e1, cl), 2)
            t["status"] = "temps"
            break
    else:
        t["status"] = status
        if status.startswith("ouvert") and ks:
            last = ks[-1][3]
            e1 = t["t1"] if status == "ouvert T1" else last
            t["pnl_latent"] = round(pnl_of(t, e1, last), 2)
            t["last"] = last
    t["filled_at"] = filled_at
    t["checked"] = now.isoformat(timespec="minutes")
    return t


def cmd_add(a):
    rows = load()
    now = datetime.now(timezone.utc)
    sgn = 1 if a.side == "LONG" else -1
    if sgn * (a.entry - a.stop) <= 0 or sgn * (a.t1 - a.entry) <= 0 or sgn * (a.t2 - a.t1) < 0:
        sys.exit("stop/objectifs du mauvais cote de l'entree")
    stop_pct = abs(a.entry - a.stop) / a.entry
    liq_pct = 1 / a.lev - 0.005
    if liq_pct < 1.5 * stop_pct:
        sys.exit("levier x%d trop eleve : liquidation a %.1f %%, trop pres du stop (%.1f %%)"
                 % (a.lev, 100 * liq_pct, 100 * stop_pct))
    if a.margin is None:
        if a.risk is None:
            sys.exit("donner --margin ou --risk")
        a.margin = round(a.risk / (a.lev * (stop_pct + 2 * FEE)), 2)
    notional = a.margin * a.lev
    risk = notional * abs(a.entry - a.stop) / a.entry + 2 * FEE * notional
    liq = a.entry * (1 - sgn * liq_pct)
    t = dict(liq=round(liq, 6), id="%s-%s-%s" % (now.strftime("%Y%m%d"), a.sym, a.side), date=now.isoformat(timespec="minutes"),
             sym=a.sym.upper(), side=a.side, entry=a.entry, stop=a.stop, t1=a.t1, t2=a.t2, lev=a.lev,
             margin=a.margin, notional=round(notional, 2), risk=round(risk, 2), valid_h=a.valid,
             status="en attente", note=a.note)
    rows = [r for r in rows if r["id"] != t["id"]] + [t]
    save(rows)
    print("ajoute :", json.dumps(t, ensure_ascii=False))


def cmd_eval(_):
    rows = load()
    now = datetime.now(timezone.utc)
    for i, t in enumerate(rows):
        try:
            rows[i] = evaluate(t, now)
        except RuntimeError as e:
            print("!", e)
        time.sleep(0.2)
    save(rows)
    closed = [t for t in rows if "pnl" in t]
    print("# Bilan des trades proposes")
    if not rows:
        print("Journal vide.")
        return
    print("| Date | Trade | Entree | Stop | T1 / T2 | Levier | Marge | Statut | PnL $ |")
    print("|---|---|---|---|---|---|---|---|---|")
    for t in rows[-20:]:
        p = t.get("pnl", t.get("pnl_latent"))
        ps = "-" if p is None else ("%+.2f%s" % (p, "" if "pnl" in t else " (latent)"))
        print("| %s | %s %s | %g | %g | %g / %g | x%d | %g $ | %s | %s |"
              % (t["date"][:10], t["side"], t["sym"], t["entry"], t["stop"], t["t1"], t["t2"],
                 t["lev"], t["margin"], t["status"], ps))
    if closed:
        wins = [t for t in closed if t["pnl"] > 0]
        tot = sum(t["pnl"] for t in closed)
        r = [t["pnl"] / t["risk"] for t in closed if t.get("risk")]
        print("\n%d trades clotures · %d gagnants (%.0f %%) · PnL total %+.2f $ · moyenne %+.2f R"
              % (len(closed), len(wins), 100 * len(wins) / len(closed), tot, sum(r) / len(r) if r else 0))
    exp = sum(t["status"] == "expire" for t in rows)
    op = sum(t["status"].startswith("ouvert") for t in rows)
    pend = sum(t["status"] == "en attente" for t in rows)
    print("%d en cours · %d en attente d'entree · %d expires (entree jamais touchee)" % (op, pend, exp))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add")
    a.add_argument("--sym", required=True)
    a.add_argument("--side", required=True, choices=["LONG", "SHORT"])
    for k in ("entry", "stop", "t1", "t2"):
        a.add_argument("--" + k, type=float, required=True)
    a.add_argument("--margin", type=float, help="marge en $ (sinon calculee depuis --risk)")
    a.add_argument("--risk", type=float, help="perte max voulue au stop, en $")
    a.add_argument("--lev", type=int, required=True)
    a.add_argument("--valid", type=int, default=24, help="validite de l'ordre limite (heures)")
    a.add_argument("--note", default="")
    sub.add_parser("eval")
    args = ap.parse_args()
    (cmd_add if args.cmd == "add" else cmd_eval)(args)


if __name__ == "__main__":
    main()
