"""Derive -- and re-check -- the shape sets used by src/statements.ts.

Two of the statement-shape checks rest on a claim about Databricks SQL that no
keyword list can express:

    NEEDS_FOLLOWER   keywords that cannot be the last token of a statement
                     (`ALTER VIEW v RENAME TO`, `CACHE TABLE`)
    EMPTY_LIST_OWNERS  keywords whose bracket may not be empty
                     (`ALTER SCHEMA s SET DBPROPERTIES ()`)

Both are curated constants in `statements.ts`, not generated into it: they are
judgements about the grammar, and a generated file would hide the reasoning.
What can be automated is the *safety* half. A keyword belongs in NEEDS_FOLLOWER
only if no valid statement anywhere ends with it, and that is checkable against
every valid source this workspace has:

    the 562 valid corpus files, the reference must-parse cases, and
    spark-sql-tests (304 files of deliberately unusual syntax)

Run it after adding a keyword, or after the reference corpus grows:

    ../databricks-sql-corpus/.venv/bin/python scripts/derive_shape_sets.py

It prints the candidates the data supports, and -- the part that matters --
fails loudly if a keyword already in `statements.ts` now ends a valid
statement somewhere. That is the invariant: an error must never fire on valid
SQL.
"""
from __future__ import annotations

import argparse
import collections
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]

# Fragments led by these are raw text to Spark, so statements.ts never applies
# shape checks to them and their tails must not feed the derivation either.
RAW_STATEMENTS = {"SET", "RESET", "ADD", "LIST", "REFRESH", "DFS"}
IGNORED = ("whitespace", "newline", "inline_comment", "block_comment")


def ts_set(name: str) -> set[str]:
    """Read a `const NAME = new Set([...])` block out of statements.ts."""
    text = (ROOT / "src" / "statements.ts").read_text()
    m = re.search(rf"const {name}[^=]*= new Set\(\[(.*?)\]\)", text, re.S)
    return set(re.findall(r'"([A-Z_0-9]+)"', m.group(1))) if m else set()


def fragments(lex, text: str) -> list[list]:
    """Split into the same fragments check.ts uses: between `;` and cell separators."""
    try:
        toks = lex(text)
    except Exception:
        return []
    out: list[list] = []
    cur: list = []
    for t in toks:
        if t.type in IGNORED:
            continue
        if t.type in ("semicolon", "command"):
            out.append(cur)
            cur = []
            continue
        cur.append(t)
    out.append(cur)
    return [f for f in out if f]


def terminal_keyword(frag: list, keywords: set[str]) -> str | None:
    if frag[0].type == "word" and frag[0].upper in RAW_STATEMENTS:
        return None
    last = frag[-1]
    return last.upper if last.type == "word" and last.upper in keywords else None


def empty_bracket_owners(frag: list, keywords: set[str]) -> list[str]:
    """Keywords directly before an empty `()`."""
    out = []
    for i in range(len(frag) - 2):
        if (
            frag[i].type == "word" and frag[i].upper in keywords
            and frag[i + 1].type == "start_bracket"
            and frag[i + 2].type == "end_bracket"
        ):
            out.append(frag[i].upper)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", default=str(ROOT.parent / "databricks-sql-corpus"))
    args = ap.parse_args()
    corpus = pathlib.Path(args.corpus).resolve()
    sys.path.insert(0, str(corpus / "src"))
    from dbsqlparse.corpus.harness import CACHE_DIR, iter_sql_files, looks_like_json
    from dbsqlparse.corpus.mutate import _tokens
    from dbsqlparse.corpus.reference import MUST_PARSE, MUST_REJECT, load_reference
    from dbsqlparse.corpus.sources import REMOTE_SOURCES

    keywords = set(re.findall(r'"([A-Z_0-9]+)",', (ROOT / "src" / "keywords.ts").read_text()))

    # --- what VALID SQL does. A hit here vetoes a candidate. -------------------
    valid_tails: collections.Counter = collections.Counter()
    valid_empty: collections.Counter = collections.Counter()
    where_valid: dict[str, str] = {}
    files = 0

    def scan_valid(text: str, origin: str) -> None:
        for frag in fragments(_tokens, text):
            kw = terminal_keyword(frag, keywords)
            if kw:
                valid_tails[kw] += 1
                where_valid.setdefault(kw, f"{origin}: ...{' '.join(t.raw for t in frag)[-60:]}")
            for owner in empty_bracket_owners(frag, keywords):
                valid_empty[owner] += 1
                where_valid.setdefault(owner + " ()", origin)

    for source in REMOTE_SOURCES:
        root = CACHE_DIR / source.name
        if not root.exists():
            continue
        # spark-sql-tests mixes valid and invalid, but it is the adversarial set
        # that has caught every false positive so far, so it vetoes too.
        if source.expectation != "valid" and source.name != "spark-sql-tests":
            continue
        for path in iter_sql_files(root):
            text = path.read_text(encoding="utf-8", errors="replace")
            if looks_like_json(text):
                continue
            files += 1
            scan_valid(text, source.name)

    cases = load_reference(corpus / "corpus" / "reference")
    for case in cases:
        if case.verdict == MUST_PARSE:
            scan_valid(case.sql, f"reference {case.id}")

    # --- what the must-reject cases quickcheck still misses need ---------------
    proc = subprocess.Popen(
        ["node", str(ROOT / "out" / "cli.js"), "--jsonl"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding="utf-8",
    )
    want_tails: collections.Counter = collections.Counter()
    want_empty: collections.Counter = collections.Counter()
    for case in cases:
        if case.verdict != MUST_REJECT:
            continue
        proc.stdin.write(json.dumps({"id": case.id, "text": case.sql}) + "\n")
        proc.stdin.flush()
        if json.loads(proc.stdout.readline())["diagnostics"]:
            continue  # already caught
        for frag in fragments(_tokens, case.sql)[-1:]:
            kw = terminal_keyword(frag, keywords)
            if kw:
                want_tails[kw] += 1
        for frag in fragments(_tokens, case.sql):
            want_empty.update(empty_bracket_owners(frag, keywords))
    proc.stdin.close()
    proc.wait()

    print(f"scanned {files} valid files + {sum(1 for c in cases if c.verdict == MUST_PARSE)} must-parse cases\n")

    # --- the safety check on what is already shipped ---------------------------
    failures = []
    for name, valid, label in (
        ("NEEDS_FOLLOWER", valid_tails, "ends a valid statement"),
        ("EMPTY_LIST_OWNERS", valid_empty, "takes an empty () in valid SQL"),
    ):
        shipped = ts_set(name)
        clashes = sorted(shipped & set(valid))
        print(f"{name}: {len(shipped)} shipped")
        for kw in clashes:
            failures.append(f"{name}: {kw} {label} -- {where_valid.get(kw, where_valid.get(kw + ' ()', ''))}")
        print(f"  unsafe now: {clashes if clashes else 'none'}")

    # --- candidates the data supports ------------------------------------------
    print("\n-- NEEDS_FOLLOWER candidates (end a missed must-reject, never a valid statement) --")
    cand = sorted(set(want_tails) - set(valid_tails))
    print(f"   {len(cand)} keywords covering {sum(want_tails[k] for k in cand)} cases")
    print("  ", cand)
    rejected = sorted(set(want_tails) & set(valid_tails))
    print(f"   vetoed by valid SQL: {rejected}")

    print("\n-- EMPTY_LIST_OWNERS candidates --")
    cand2 = sorted(set(want_empty) - set(valid_empty))
    print(f"   {len(cand2)} keywords covering {sum(want_empty[k] for k in cand2)} cases")
    print("  ", cand2)
    print(f"   vetoed by valid SQL: {sorted(set(want_empty) & set(valid_empty))}")

    if failures:
        print("\nFAILED: a shipped keyword now fires on valid SQL")
        for f in failures:
            print("  " + f)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
