#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["matplotlib>=3.8"]
# ///
"""Charts for the README, made from the repo's own data.

  uv run docs/charts/make_charts.py                              # from the bundled files
  uv run docs/charts/make_charts.py --events sim/data/events.jsonl   # first re-derive ledger-by-day.csv

- docs/media/day-timeline.png: where each citizen was during the recorded run (samples/run-2026-07-18/tape.jsonl).
- docs/media/ledger-by-day.png: the sim's event ledger counted per day (ledger-by-day.csv, counts only: the raw
  ledger carries tx hashes that point at the testnet wallets, so it is not shipped).
"""
import argparse, collections, csv, json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Patch
from matplotlib.lines import Line2D

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
MEDIA = ROOT / "docs" / "media"
SAMPLE = ROOT / "samples" / "run-2026-07-18"

SURFACE, INK, INK2, GRID = "#fcfcfb", "#0b0b0b", "#52514e", "#e4e3df"
BLUE, ORANGE, AQUA, YELLOW, MAGENTA, VIOLET = "#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#4a3aa7"
STREET = "#c9c8c2"

# role -> (workplace, home), as citizens/building-map.ts resolves them
ROLES = {
    "baker": ("bakery", "home-baker"), "courier": ("depot", "home-courier"), "barista": ("cafe", "home-barista"),
    "grocer": ("grocer", "home-grocer"), "smith": ("smithy", "home-smith"), "student": ("college", "dorm"),
    "musician": ("pub", "coliving"), "regular": ("pub", "coliving"),
}


def style(ax):
    ax.set_facecolor(SURFACE)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    for s in ("left", "bottom"):
        ax.spines[s].set_color(GRID)
    ax.tick_params(colors=INK2, labelsize=9)


def hhmm(gm):
    m = int(gm) % 1440
    return f"{m // 60:02d}:{m % 60:02d}"


def day_timeline():
    beats = [json.loads(l) for l in (SAMPLE / "tape.jsonl").read_text().splitlines() if l.strip()]
    man = json.loads((SAMPLE / "manifest.json").read_text())
    g0, g1 = man["startedGameMin"], man["endedGameMin"]
    order = [r["id"] for r in man["roster"]]
    place = {}  # actor -> list of (gm, category)
    talks, buys = collections.defaultdict(list), collections.defaultdict(list)
    for b in beats:
        a, at = b.get("actor"), b.get("at")
        if b["kind"] == "dialogue" and b["data"].get("outcome") == "conversed":
            for p in b["data"]["participants"]:
                talks[p].append(b["gm"])
        if b["kind"] == "purchase" and a:
            buys[a].append(b["gm"])
        if not a or not at:
            continue
        where = (at.get("inside") or {}).get("b") or at.get("building")
        work, home = ROLES[a]
        cat = "street" if not where else "work" if where == work else "home" if where == home else "visit"
        seq = place.setdefault(a, [])
        if not seq or seq[-1][1] != cat:
            seq.append((b["gm"], cat))
    colors = {"work": BLUE, "home": VIOLET, "visit": ORANGE, "street": STREET}
    fig, ax = plt.subplots(figsize=(10, 4.4), dpi=150)
    fig.patch.set_facecolor(SURFACE)
    style(ax)
    for row, a in enumerate(order):
        seq = place.get(a, [])
        for i, (gm, cat) in enumerate(seq):
            end = seq[i + 1][0] if i + 1 < len(seq) else g1
            if end > gm:
                ax.barh(row, end - gm, left=gm, height=0.62, color=colors[cat], edgecolor=SURFACE, linewidth=1)
        ax.scatter(talks[a], [row] * len(talks[a]), marker="v", s=46, color=INK, edgecolors=SURFACE, linewidths=1, zorder=3)
        ax.scatter(buys[a], [row] * len(buys[a]), marker="D", s=44, color=AQUA, edgecolors=SURFACE, linewidths=1.2, zorder=4)
    ax.set_yticks(range(len(order)), order)
    ax.invert_yaxis()
    ticks = list(range((g0 // 120) * 120, g1 + 1, 120))
    ax.set_xticks(ticks, [hhmm(t) for t in ticks])
    ax.set_xlim(g0, g1)
    ax.grid(axis="x", color=GRID, linewidth=0.6)
    ax.set_axisbelow(True)
    ax.set_xlabel("game time (one 20-minute real run covered day 5 07:00 to day 6 02:00)", color=INK2, fontsize=9)
    ax.set_title("Where each citizen was during the recorded run", loc="left", color=INK, fontsize=12, fontweight="bold")
    handles = [Patch(color=colors[k], label=l) for k, l in
               (("work", "at their workplace"), ("home", "at home"), ("visit", "in another building"), ("street", "on the street"))]
    handles += [Line2D([], [], marker="v", ls="", color=INK, label="closed a conversation"),
                Line2D([], [], marker="D", ls="", color=AQUA, markersize=5, label="x402 purchase")]
    ax.legend(handles=handles, ncol=3, fontsize=8, frameon=False, loc="upper center", bbox_to_anchor=(0.5, -0.2))
    fig.tight_layout()
    fig.savefig(MEDIA / "day-timeline.png", facecolor=SURFACE)


def ledger_csv(events_path):
    by = collections.defaultdict(collections.Counter)
    for l in Path(events_path).read_text().splitlines():
        try:
            e = json.loads(l)
        except json.JSONDecodeError:
            continue
        by[e.get("ts", "")[:10]][e.get("kind", "?")] += 1
    kinds = ["purchase", "say", "decision", "produce", "move", "consume"]
    with open(HERE / "ledger-by-day.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["day"] + kinds)
        for d in sorted(by):
            w.writerow([d] + [by[d][k] for k in kinds])


def ledger_chart():
    rows = list(csv.DictReader(open(HERE / "ledger-by-day.csv")))
    series = [("purchase", "x402 purchases", BLUE), ("say", "says (one line to a neighbour)", ORANGE),
              ("produce", "goods produced", AQUA), ("move", "moves", YELLOW)]
    fig, ax = plt.subplots(figsize=(10, 4.2), dpi=150)
    fig.patch.set_facecolor(SURFACE)
    style(ax)
    w = 0.2
    for i, (k, label, c) in enumerate(series):
        xs = [j + (i - 1.5) * w for j in range(len(rows))]
        ys = [int(r[k]) for r in rows]
        bars = ax.bar(xs, [y if y else float("nan") for y in ys], width=w * 0.9, color=c, label=label)
        if k == "purchase":
            for x, y in zip(xs, ys):
                if y:
                    ax.text(x, y * 1.15, str(y), ha="center", va="bottom", fontsize=8, color=INK)
    ax.set_yscale("log")
    ax.set_xticks(range(len(rows)), [r["day"][5:] for r in rows])
    ax.set_ylabel("events that day (log scale)", color=INK2, fontsize=9)
    ax.grid(axis="y", color=GRID, linewidth=0.6)
    ax.set_axisbelow(True)
    ax.set_title("The sim's event ledger, per day (2026)", loc="left", color=INK, fontsize=12, fontweight="bold")
    ax.annotate("06-18: the unattended runaway loop\n(see the incident write-up)", xy=(-0.25, 900), xytext=(0.62, 260),
                fontsize=8, color=INK2, arrowprops=dict(arrowstyle="-", color=INK2, lw=0.6))
    ax.legend(fontsize=8, frameon=False, ncol=4, loc="upper center", bbox_to_anchor=(0.5, -0.12))
    fig.tight_layout()
    fig.savefig(MEDIA / "ledger-by-day.png", facecolor=SURFACE)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--events", help="re-derive ledger-by-day.csv from a sim events.jsonl first")
    args = ap.parse_args()
    if args.events:
        ledger_csv(args.events)
    day_timeline()
    ledger_chart()
