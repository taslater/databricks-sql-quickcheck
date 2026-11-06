"""Compare an evaluation run with the committed catch baseline (eval/baseline.json).

evaluate.py fails on a false positive. This script fails on a lost catch: a
reference must-reject case that the baseline records as caught and that is no
longer flagged, or a guaranteed mutation kind whose caught count went down.

    python eval/compare_baseline.py                 # compare eval/results/latest.json
    python eval/compare_baseline.py --update        # rewrite eval/baseline.json from it
    python eval/compare_baseline.py --headline      # markdown headline numbers only

Exit status: 0 when nothing was lost, 1 on a lost catch, a dropped kind or a
config mismatch, 2 when a file is missing or unreadable. New catches never fail;
they are printed, and the PR that gains them updates eval/baseline.json in the
same commit.

The baseline is generated with the pinned corpus (CORPUS_REF in
.github/workflows/ci.yml) and the config recorded in it (seed and mutation
budget). Run evaluate.py with those, then --update, to regenerate it.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
DEFAULT_RESULTS = ROOT / "eval" / "results" / "latest.json"
DEFAULT_BASELINE = ROOT / "eval" / "baseline.json"
GUARANTEED = "guaranteed"


def baseline_from(results: dict) -> dict:
    """The baseline a run would commit. Pure and deterministic: sorted, no timestamps."""
    guaranteed = {k: v for k, v in results["mutation"].items() if v.get("tier") == GUARANTEED}
    return {
        "config": {
            "mutations": results["config"]["mutations"],
            "seed": results["config"]["seed"],
        },
        "reference_must_reject_caught": sorted(results["reference"]["caught_ids"]),
        "mutation_guaranteed_caught": {k: guaranteed[k]["error"] for k in sorted(guaranteed)},
        "mutation_guaranteed_total": {k: guaranteed[k]["total"] for k in sorted(guaranteed)},
    }


def compare(baseline: dict, results: dict) -> dict:
    """Differences between a committed baseline and a run. Pure; no I/O."""
    now = baseline_from(results)
    report: dict = {
        "config_mismatch": None,
        "lost_cases": [],
        "new_cases": [],
        "dropped_kinds": [],
        "gained_kinds": [],
        "total_changes": [],
    }
    if baseline.get("config") != now["config"]:
        report["config_mismatch"] = (
            f"baseline was measured with {baseline.get('config')}, this run used {now['config']}"
        )

    before = set(baseline["reference_must_reject_caught"])
    after = set(now["reference_must_reject_caught"])
    report["lost_cases"] = sorted(before - after)
    report["new_cases"] = sorted(after - before)

    old_kinds = baseline["mutation_guaranteed_caught"]
    new_kinds = now["mutation_guaranteed_caught"]
    for kind in sorted(set(old_kinds) | set(new_kinds)):
        old = old_kinds.get(kind, 0)
        new = new_kinds.get(kind, 0)
        if new < old:
            report["dropped_kinds"].append((kind, old, new))
        elif new > old:
            report["gained_kinds"].append((kind, old, new))

    old_totals = baseline.get("mutation_guaranteed_total", {})
    new_totals = now["mutation_guaranteed_total"]
    for kind in sorted(set(old_totals) | set(new_totals)):
        if old_totals.get(kind) != new_totals.get(kind):
            report["total_changes"].append((kind, old_totals.get(kind), new_totals.get(kind)))
    return report


def failed(report: dict) -> bool:
    return bool(report["config_mismatch"] or report["lost_cases"] or report["dropped_kinds"])


def format_report(report: dict, baseline_path: str = "eval/baseline.json") -> str:
    lines: list[str] = []
    if report["config_mismatch"]:
        lines.append(f"CONFIG MISMATCH: {report['config_mismatch']}")
    if report["lost_cases"]:
        lines.append(f"LOST CATCHES ({len(report['lost_cases'])}): reference must-reject cases "
                     "that were caught in the baseline and are no longer flagged:")
        lines += [f"  - {cid}" for cid in report["lost_cases"]]
    for kind, old, new in report["dropped_kinds"]:
        lines.append(f"DROPPED KIND {kind}: caught {old} in the baseline, now {new}")
    if report["new_cases"]:
        lines.append(f"new catches ({len(report['new_cases'])}):")
        lines += [f"  + {cid}" for cid in report["new_cases"]]
    for kind, old, new in report["gained_kinds"]:
        lines.append(f"new catches in {kind}: {old} -> {new}")
    for kind, old, new in report["total_changes"]:
        lines.append(f"note: mutant count for {kind} changed {old} -> {new}; "
                     "the corpus or the generator moved")
    if report["new_cases"] or report["gained_kinds"]:
        lines.append(f"Update {baseline_path} in this same commit: "
                     "python eval/compare_baseline.py --update")
    if not lines:
        lines.append("catches match the baseline")
    return "\n".join(lines)


def headline(results: dict) -> str:
    """Markdown headline numbers for the job summary, from a run's results."""
    ref = results["reference"]
    parse_total = ref["parse_total"]
    parse_fp = len(ref["false_positives"])
    guaranteed = [v for v in results["mutation"].values() if v.get("tier") == GUARANTEED]
    g_total = sum(v["total"] for v in guaranteed)
    g_err = sum(v["error"] for v in guaranteed)
    rate = f"{g_err / g_total * 100:.1f}%" if g_total else "n/a"
    s_total, s_caught = ref["structural_total"], ref["structural_caught"]
    target = f"{s_caught}/{s_total} ({s_caught / s_total * 100:.1f}%)" if s_total else "n/a"
    return "\n".join([
        "## quickcheck corpus evaluation",
        "",
        "| headline | value |",
        "| --- | --- |",
        f"| must-parse clean (reference) | {parse_total - parse_fp}/{parse_total}"
        f" ({parse_fp} false positives) |",
        f"| must-reject caught as errors | {ref['reject_error']}/{ref['reject_total']} |",
        f"| target (structurally reachable must-reject) | {target} |",
        f"| guaranteed mutation rate | {g_err}/{g_total} ({rate}) |",
        "",
    ])


def _load(path: pathlib.Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"cannot read {path}: {exc}", file=sys.stderr)
        raise SystemExit(2)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--results", type=pathlib.Path, default=DEFAULT_RESULTS)
    ap.add_argument("--baseline", type=pathlib.Path, default=DEFAULT_BASELINE)
    ap.add_argument("--update", action="store_true", help="rewrite the baseline from the results")
    ap.add_argument("--headline", action="store_true", help="print the markdown headline and exit")
    args = ap.parse_args(argv)

    results = _load(args.results)
    if args.headline:
        print(headline(results))
        return 0
    if args.update:
        args.baseline.write_text(json.dumps(baseline_from(results), indent=2, sort_keys=True) + "\n",
                                 encoding="utf-8")
        print(f"wrote {args.baseline}: {len(baseline_from(results)['reference_must_reject_caught'])} "
              "reference cases, guaranteed kinds "
              f"{sorted(baseline_from(results)['mutation_guaranteed_caught'])}")
        return 0
    if not args.baseline.exists():
        print(f"no baseline at {args.baseline}; create it with --update", file=sys.stderr)
        return 2
    report = compare(_load(args.baseline), results)
    print(format_report(report, str(args.baseline)))
    return 1 if failed(report) else 0


if __name__ == "__main__":
    sys.exit(main())
