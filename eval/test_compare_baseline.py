"""Unit tests for compare_baseline.py. Pure Python, fixture dicts, no corpus.

Run from the repo root:

    python -m unittest discover -s eval -p 'test_*.py'
"""
from __future__ import annotations

import unittest

import compare_baseline as cb


def run(caught: list[str], kinds: dict[str, tuple[int, int]], extra_kinds: dict | None = None) -> dict:
    """A minimal evaluate.py results dict. kinds maps kind -> (caught, total), guaranteed tier."""
    mutation = {k: {"total": t, "error": c, "any": c, "tier": "guaranteed"} for k, (c, t) in kinds.items()}
    for k, v in (extra_kinds or {}).items():
        mutation[k] = v
    return {
        "config": {"seed": 0, "mutations": 0},
        "reference": {
            "parse_total": 3, "false_positives": [], "reject_total": 4,
            "reject_error": len(caught), "caught_ids": list(caught),
            "structural_total": 2, "structural_caught": 1,
        },
        "mutation": mutation,
    }


BASE_KINDS = {"double-comma": (10, 10), "dangling-operator": (5, 6)}


class CompareTests(unittest.TestCase):
    def baseline(self, caught: list[str], kinds=BASE_KINDS) -> dict:
        return cb.baseline_from(run(caught, kinds))

    def test_identical_run_passes(self) -> None:
        base = self.baseline(["a.one", "b.two"])
        report = cb.compare(base, run(["a.one", "b.two"], BASE_KINDS))
        self.assertFalse(cb.failed(report))
        self.assertEqual(cb.format_report(report), "catches match the baseline")

    def test_lost_catch_fails_and_names_the_id(self) -> None:
        base = self.baseline(["a.one", "b.two", "c.three"])
        report = cb.compare(base, run(["a.one", "c.three"], BASE_KINDS))
        self.assertTrue(cb.failed(report))
        self.assertEqual(report["lost_cases"], ["b.two"])
        text = cb.format_report(report)
        self.assertIn("LOST CATCHES (1)", text)
        self.assertIn("  - b.two", text)
        self.assertNotIn("  - a.one", text)

    def test_lost_catches_are_listed_sorted(self) -> None:
        base = self.baseline(["z.last", "a.first", "m.mid"])
        report = cb.compare(base, run([], BASE_KINDS))
        self.assertEqual(report["lost_cases"], ["a.first", "m.mid", "z.last"])

    def test_new_catch_passes_and_prints_reminder(self) -> None:
        base = self.baseline(["a.one"])
        report = cb.compare(base, run(["a.one", "b.two"], {"double-comma": (11, 11),
                                                           "dangling-operator": (5, 6)}))
        self.assertFalse(cb.failed(report))
        self.assertEqual(report["new_cases"], ["b.two"])
        text = cb.format_report(report)
        self.assertIn("  + b.two", text)
        self.assertIn("--update", text)
        self.assertIn("eval/baseline.json", text)
        self.assertIn("new catches in double-comma: 10 -> 11", text)

    def test_per_kind_drop_fails_even_with_no_lost_case(self) -> None:
        base = self.baseline(["a.one"])
        report = cb.compare(base, run(["a.one"], {"double-comma": (9, 10),
                                                  "dangling-operator": (5, 6)}))
        self.assertTrue(cb.failed(report))
        self.assertEqual(report["lost_cases"], [])
        self.assertEqual(report["dropped_kinds"], [("double-comma", 10, 9)])
        self.assertIn("DROPPED KIND double-comma: caught 10 in the baseline, now 9",
                      cb.format_report(report))

    def test_kind_missing_from_run_counts_as_dropped(self) -> None:
        base = self.baseline(["a.one"])
        report = cb.compare(base, run(["a.one"], {"double-comma": (10, 10)}))
        self.assertEqual(report["dropped_kinds"], [("dangling-operator", 5, 0)])
        self.assertTrue(cb.failed(report))

    def test_config_mismatch_fails(self) -> None:
        base = self.baseline(["a.one"])
        other = run(["a.one"], BASE_KINDS)
        other["config"] = {"seed": 1, "mutations": 0}
        report = cb.compare(base, other)
        self.assertTrue(cb.failed(report))
        self.assertIn("CONFIG MISMATCH", cb.format_report(report))

    def test_non_guaranteed_kinds_are_not_in_the_baseline(self) -> None:
        results = run(["a.one"], BASE_KINDS, {"delete-comma": {"total": 9, "error": 1, "any": 4,
                                                               "tier": "weak"}})
        base = cb.baseline_from(results)
        self.assertEqual(sorted(base["mutation_guaranteed_caught"]), ["dangling-operator", "double-comma"])

    def test_baseline_is_deterministic(self) -> None:
        a = run(["c", "a", "b"], {"z-kind": (1, 2), "a-kind": (3, 4)})
        b = run(["a", "b", "c"], {"a-kind": (3, 4), "z-kind": (1, 2)})
        self.assertEqual(cb.baseline_from(a), cb.baseline_from(b))
        self.assertEqual(cb.baseline_from(a)["reference_must_reject_caught"], ["a", "b", "c"])

    def test_total_change_is_a_note_not_a_failure(self) -> None:
        base = self.baseline(["a.one"])
        changed = run(["a.one"], {"double-comma": (10, 12), "dangling-operator": (5, 6)})
        report = cb.compare(base, changed)
        self.assertFalse(cb.failed(report))
        self.assertIn("mutant count for double-comma changed 10 -> 12", cb.format_report(report))


class HeadlineTests(unittest.TestCase):
    def test_headline_numbers(self) -> None:
        results = run(["a.one"], {"double-comma": (9, 10), "dangling-operator": (5, 6)})
        text = cb.headline(results)
        self.assertIn("| must-parse clean (reference) | 3/3 (0 false positives) |", text)
        self.assertIn("| must-reject caught as errors | 1/4 |", text)
        self.assertIn("| target (structurally reachable must-reject) | 1/2 (50.0%) |", text)
        self.assertIn("| guaranteed mutation rate | 14/16 (87.5%) |", text)


if __name__ == "__main__":
    unittest.main()
