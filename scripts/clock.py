#!/usr/bin/env python3
"""Ticket clock: records when work on a ticket starts and stops, so the checkpoints measure velocity instead of guessing.

Usage: python3 scripts/clock.py start AIR-020 [--dir plan/tickets]
       python3 scripts/clock.py stop AIR-020 [--minus 20] [--dir plan/tickets]
       python3 scripts/clock.py pause AIR-020 [--minus 20] [--dir plan/tickets]
start writes `started: <local ISO minute>` and sets status in_progress. stop writes `stopped:`, `actual_h:` (hours between
start and stop, minus --minus minutes of breaks, one decimal, plus any `logged_h` banked by pause) and sets status done. Run
stop again to correct it. pause is for a lane that is blocked and writes a handoff instead of finishing (LANES.md stop
rules): it adds the hours since start to `logged_h`, writes `paused:` and sets status blocked, so the ticket is not counted as
done; a later start resumes the clock and keeps `logged_h`. The
front matter is edited in place; nothing else in the ticket changes. Standard library only.
"""
import argparse, datetime as dt, os, re, sys


def ticket_path(d, tid):
    for n in sorted(os.listdir(d)):
        if n.startswith(tid + "-") and n.endswith(".md"):
            return os.path.join(d, n)
    sys.exit(f"no ticket file for {tid} in {d}")


def set_field(fm, key, value):
    line = f"{key}: {value}"
    if re.search(rf"^{key}:.*$", fm, re.M):
        return re.sub(rf"^{key}:.*$", line, fm, count=1, flags=re.M)
    return re.sub(r"^(status:.*)$", lambda m: m.group(1) + "\n" + line, fm, count=1, flags=re.M)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=["start", "stop", "pause"])
    ap.add_argument("ticket")
    ap.add_argument("--dir", default="plan/tickets")
    ap.add_argument("--minus", type=float, default=0, help="minutes of breaks to leave out on stop")
    ap.add_argument("--at", help="override the time (YYYY-MM-DDTHH:MM), for corrections and tests")
    a = ap.parse_args()
    p = ticket_path(a.dir, a.ticket)
    text = open(p, encoding="utf-8").read()
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if not m:
        sys.exit(f"{p}: no front matter")
    fm = m.group(1)
    now = dt.datetime.strptime(a.at, "%Y-%m-%dT%H:%M") if a.at else dt.datetime.now().replace(second=0, microsecond=0)
    if a.action == "start":
        fm = set_field(fm, "started", now.strftime("%Y-%m-%dT%H:%M"))
        fm = re.sub(r"^status:.*$", "status: in_progress", fm, count=1, flags=re.M)
        msg = f"{a.ticket} started {now:%Y-%m-%d %H:%M}"
    else:
        s = re.search(r"^started:\s*(\S+)", fm, re.M)
        if not s:
            sys.exit(f"{a.ticket}: no started time; run start first (or pass --at to start)")
        t0 = dt.datetime.strptime(s.group(1), "%Y-%m-%dT%H:%M")
        ps = re.search(r"^paused:\s*(\S+)", fm, re.M)
        if ps and dt.datetime.strptime(ps.group(1), "%Y-%m-%dT%H:%M") >= t0:
            # the hours up to the pause are already in logged_h; counting from started again would add them twice
            sys.exit(f"{a.ticket}: paused at {ps.group(1)}; run start to resume the clock first, then {a.action}")
        session = max(0.0, (now - t0).total_seconds() / 3600 - a.minus / 60)
        lg = re.search(r"^logged_h:\s*([\d.]+)", fm, re.M)
        banked = float(lg.group(1)) if lg else 0.0
        if a.action == "pause":
            fm = set_field(fm, "logged_h", f"{banked + session:.1f}")
            fm = set_field(fm, "paused", now.strftime("%Y-%m-%dT%H:%M"))
            fm = re.sub(r"^status:.*$", "status: blocked", fm, count=1, flags=re.M)
            open(p, "w", encoding="utf-8").write("---\n" + fm + "\n---\n" + text[m.end():])
            print(f"{a.ticket} paused (blocked): {banked + session:.1f} h logged so far")
            return
        hours = banked + session
        fm = set_field(fm, "stopped", now.strftime("%Y-%m-%dT%H:%M"))
        fm = set_field(fm, "actual_h", f"{hours:.1f}")
        fm = re.sub(r"^status:.*$", "status: done", fm, count=1, flags=re.M)
        est = re.search(r"^estimate_h:\s*([\d.]+)", fm, re.M)
        msg = f"{a.ticket} done: {hours:.1f} h actual" + (f" against {est.group(1)} h estimated" if est else "")
    open(p, "w", encoding="utf-8").write("---\n" + fm + "\n---\n" + text[m.end():])
    print(msg)


if __name__ == "__main__":
    main()
