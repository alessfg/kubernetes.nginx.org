#!/usr/bin/env python3
"""Assert the shared chrome is byte-identical across every page.

This site is static, multi-page and has no build system, so the top bar, the
navigation and the icon sprite are duplicated into every HTML file. That is
the standard trade for having no template step, and the standard failure mode
is one page drifting — a nav item added in four places out of ten, a stale
link, a sprite missing the symbol a later page uses.

Regions are delimited in the markup:

    <!-- sync:nav -->  ...  <!-- /sync:nav -->

Every region name must appear in every page, and every copy of a region must
match the others exactly. The breadcrumb and page title are deliberately NOT
inside a region: they are per-page by definition.

Usage:  python3 scripts/check-chrome-sync.py
Exit:   0 all regions agree, 1 drift found.
"""
import difflib
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# gallery.html is a development harness, not a page of the site.
IGNORE = {'gallery.html'}

# Pre-rebuild pages that still carry the old chrome and have no sync markers
# yet. They are skipped rather than reported as drift, because "this page has
# not been rebuilt" is not the same failure as "this page has drifted".
#
# THIS SET MUST BE EMPTY when the rebuild lands.
PENDING = {'ingress-nginx-migration.html'}

REGION = re.compile(
    r'<!--\s*sync:([\w-]+)\s*-->(.*?)<!--\s*/sync:\1\s*-->', re.S)


def pages():
    out = []
    for dirpath, dirnames, names in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames
                       if d not in ('.git', 'node_modules', '.claude', 'scripts')]
        for n in sorted(names):
            if not n.endswith('.html'):
                continue
            path = os.path.join(dirpath, n)
            rel = os.path.relpath(path, ROOT)
            if rel in IGNORE or rel in PENDING:
                continue
            out.append(path)
    return sorted(out)


def rel(path):
    return os.path.relpath(path, ROOT)


def main():
    files = pages()
    if len(files) < 2:
        print(f'{len(files)} page(s) — nothing to compare yet.')
        return 0

    # region name -> {page: body}
    found = {}
    for path in files:
        with open(path, encoding='utf-8') as fh:
            text = fh.read()
        for name, body in REGION.findall(text):
            found.setdefault(name, {})[path] = body

    if not found:
        print('No sync regions found. Has the chrome lost its markers?')
        return 1

    failures = []

    for name in sorted(found):
        copies = found[name]

        missing = [rel(p) for p in files if p not in copies]
        if missing:
            failures.append(
                f'region "{name}" is missing from: ' + ', '.join(missing))

        if not copies:
            continue

        # The first page alphabetically is the reference. Arbitrary but stable,
        # and the diff shows which side to change.
        ref_path = sorted(copies)[0]
        ref = copies[ref_path]
        drifted = []
        for path in sorted(copies):
            if copies[path] != ref:
                drifted.append(path)

        if drifted:
            failures.append(
                f'region "{name}" differs between {rel(ref_path)} and '
                + ', '.join(rel(p) for p in drifted))
            # Show the first drift concretely — a name alone is not actionable.
            diff = difflib.unified_diff(
                ref.splitlines(), copies[drifted[0]].splitlines(),
                fromfile=rel(ref_path), tofile=rel(drifted[0]),
                lineterm='', n=1)
            for line in list(diff)[:24]:
                failures.append('    ' + line)

        status = 'DRIFT' if drifted or missing else 'ok   '
        print(f'  {status}  {name:10s} in {len(copies)}/{len(files)} pages')

    print()
    if failures:
        print('Chrome drift:')
        for f in failures:
            print(f'  {f}')
        return 1

    print(f'Chrome is identical across all {len(files)} pages '
          f'({len(found)} synced regions).')
    if PENDING:
        print(f'{len(PENDING)} pre-rebuild page(s) skipped: '
              + ', '.join(sorted(PENDING)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
