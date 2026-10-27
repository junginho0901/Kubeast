#!/usr/bin/env python3
"""List the e2e specs that name a screen string this branch changed.

  scripts/e2e-specs-for-strings.py [base [head]]   # base defaults to origin/main, head to the working tree

A changed catalog entry (frontend/src/i18n/locales/en.json, ko.json) or a changed fallback text in a .ts/.tsx
line can break a spec that asserts the old text — "1 lines" became "1 line" — while a search for the component
name finds nothing. This takes the old and new string values from the diff (and "1 <word>" for a value with a
count before a word) and prints the specs under e2e/ that contain one, with the string. Run it before choosing
the related specs for a screen change.
"""
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
base = sys.argv[1] if len(sys.argv) > 1 else "origin/main"
span = [base, sys.argv[2]] if len(sys.argv) > 2 else ["--merge-base", base]
diff = subprocess.run(
    ["git", "diff", "--unified=0", *span, "--", "frontend/src"],
    cwd=ROOT, capture_output=True, text=True, check=True,
).stdout

catalog_value = re.compile(r'^[-+]\s*"[^"]+":\s*"((?:[^"\\]|\\.)+)",?\s*$')
# the fallback text of a catalog lookup: t('key', 'Text'), tr('key', 'Text'), defaultValue: 'Text'
fallback = re.compile(r"""(?:\btr?\(\s*['"][\w.:-]+['"]\s*,\s*|defaultValue:\s*)(['"`])((?:(?!\1)[^\\]|\\.)+)\1""")
strings = set()
for line in diff.splitlines():
    if not line.startswith(("-", "+")) or line.startswith(("---", "+++")):
        continue
    m = catalog_value.match(line)
    found = [m.group(1)] if m else [f[1] for f in fallback.findall(line)]
    for s in found:
        # a count before a word: a spec may assert it for one ("1 lines")
        for word in re.findall(r"\{\{\w+\}\}\s+([A-Za-z]{3,})", s):
            strings.add(f"1 {word}")
        # text a spec would assert: words, not paths, keys or class lists
        s = re.sub(r"\{\{[^}]+\}\}", " ", s).strip()
        if " " in s and not re.search(r"[/<>{}=]|^[a-z0-9_.-]+$", s):
            for part in re.split(r"\s{2,}", s):
                if len(part) >= 8:
                    strings.add(part)

hits = {}
for spec in sorted((ROOT / "e2e").rglob("*.ts")):
    if "node_modules" in spec.parts:
        continue
    text = spec.read_text(encoding="utf-8", errors="ignore")
    for s in strings:
        if s in text:
            hits.setdefault(spec.relative_to(ROOT).as_posix(), set()).add(s)

print(f"{len(strings)} changed strings, {len(hits)} specs")
for spec, found in sorted(hits.items()):
    print(spec)
    for s in sorted(found):
        print("   ", s[:100])
