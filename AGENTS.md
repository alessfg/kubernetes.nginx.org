# AGENTS.md

Instructions for AI coding agents working on this repository. Claude Code reads this via `.claude/CLAUDE.md`, which imports it; Copilot's coding agent and other tools read it directly.

Keep this file to rules that must apply **before** anything is read — the ones that fail silently. Reference material and procedures live in the skills listed at the bottom.

## What this is

A documentation-only site covering NGINX on Kubernetes: a landing page for the ecosystem plus an interactive migration tool. No build system and no package manager; there *are* checks and a test suite, and CI runs them on every push and pull request — see [Checks](#checks). Static HTML with CSS/JS in `assets/`, no CDN and no third-party runtime dependencies — with one deliberate exception: the featured videos load poster images from `i.ytimg.com` and are click-to-play into `youtube-nocookie`, so nothing off-origin runs until a reader asks for it. Owned by F5, Inc., Apache 2.0.

It covers four things: **NGINX Ingress Controller** (`nginx/kubernetes-ingress`), **NGINX Gateway Fabric** (`nginx/nginx-gateway-fabric`), the **NGINX Ingress Migration Tool** (community `kubernetes/ingress-nginx` → NIC), and **ingress2gateway** (`kubernetes-sigs/ingress2gateway`).

- `index.html` — the live landing page, a hub linking to all four. Markup only; styles in `assets/css/{shared,index}.css`, behavior in `assets/js/{shared,index}.js`.
- `ingress-nginx-migration.html` — the live migration tool: YAML analyzer, 130 annotation mappings, CRD examples, ConfigMap guidance. **4,952 lines / ~92k tokens — do not read it whole.** Navigate by `grep -n '<section id='` and `grep -n '<h3 id='`; `.github/data/mapping-index.json` maps every annotation to its category, anchor and CRD generator.
- Repo `nginx/kubernetes.nginx.org`; GitHub Pages serves `main` at https://kubernetes.nginx.org/.

**Never touch `CHANGELOG.md` unless you are explicitly asked to.** Its entries are release-shaped and written by hand, and a released section can already be on `main` and serving production — so "helpfully" appending to one revises a shipped record. Make the code change, mention in your summary that the changelog is untouched, and let the maintainer decide whether the work warrants an entry and under which version.

## Directory layout

```
assets/
  css/  tokens.css        # THE design surface: every colour, size, space, radius, shadow, duration.
        #                   Declarations only — two blocks, `:root` and the `@media screen` dark theme.
        shared.css        # @font-face, reset, top bar, sidebar and banner, components both pages use
        index.css         # landing page only (hero, feature/project grids, compat tables, CTAs)
        migration.css     # migration tool (analyzer UI, mapping/reference tables, badges, checklist, print)
  js/   shared.js         # shared behavior: dark-mode toggle, sidebar drawer, copy-to-clipboard, copyright year
        index.js          # version auto-fetch, SPA product switching, entrance animation, YouTube
        migration-core.js           # source-agnostic engine: analyzer orchestration/rendering, filtering, nav, checklist; defines window.MigrationTool (NIC target versions + utils)
        migration-ingress-nginx.js  # ingress-nginx SOURCE module: INGRESS_NGINX_VERSION, ANNOTATION_MAPPINGS, parsers, CRD generators, presets; defines window.MIGRATION_SOURCE
  img/  icon.svg, icon-512.png, apple-touch-icon.{svg,png}, og-image.{svg,png}
  fonts/ InterVariable-subset.woff2, OFL.txt, README.md
```

## Load order and asset invariants

These fail silently — nothing errors, the page just renders wrong.

- **CSS order on every page: `tokens.css` → `shared.css` → the page CSS.**
- **`shared.js` before the page JS.** Page scripts are IIFEs calling shared.js globals like `closeSidebar` / `copyToClipboard`.
- **Migration pages load three scripts in this order: `shared.js` → `migration-<source>.js` → `migration-core.js`.** The source module must precede the core, because the core reads `window.MIGRATION_SOURCE` at top level. Source modules never touch the DOM and may dereference `MigrationTool.*` only inside function bodies, never at top level.
- **Asset paths are relative** (`assets/css/…`, no leading `/`) so they resolve identically from the filesystem, from a local server and in production. (There is no PR preview environment — Pages serves `main` only.)
- **Every page carries `<link rel="preload" as="font" … crossorigin>` for the woff2 *before* the stylesheet links.** The `@font-face` lives inside `shared.css`, so without the preload the font is not discoverable until that CSS has parsed.
- The inline `<head>` dark-mode flash-prevention script and the page-specific JSON-LD stay inline. Classic (non-module) scripts keep functions global.
- The font is **self-hosted, never a CDN** — see `assets/fonts/README.md` before upgrading or re-subsetting it.

## Shared header, sidebar and banner

These shared parts live in `assets/css/shared.css` and `assets/js/shared.js` as the single source of truth — **edit it once there**, not per page. Its colours, spacing, type and elevation all come from `tokens.css`. `shared.css` does write a few structural literals — the 44px mobile touch target, the 32px brand rule, the 3px nav rail, the 1px hairlines — and carries a second `:root` block of `--icon-*` and `--pattern-hex` values that `tokens.css` does not contain. It covers the event banner, the top bar, the sidebar and its drawer, and the dark-mode token overrides plus toggle.

- **The topbar/sidebar/banner markup is duplicated in both HTML pages and must stay structurally in sync** — the shared CSS/JS keys off `#sidebar`, `#sidebarBackdrop`, `#menuToggle`, `#darkToggle`, `#mobileBreadcrumb`, `.topbar`, `.event-banner`, `#copyright-year`, `#page-announce`. `check-classes.py` asserts every id `shared.js` queries exists on every page.
- **Top bar**: `--topbar-h` 52px. Logo left-aligned at the start of the bar, then a short centred rule (`.topbar-brand::after`, 32px tall) rather than a full-height border, then the heading; GitHub link and dark-mode toggle at the right. The heading is **one line, and which line depends on width** — above 900px `.topbar-eyebrow` carries the site/tool label and `.mobile-breadcrumb` is hidden; at or below 900px they swap, because the drawer hides the sidebar's active-item marker. `index.js` and `migration-core.js` both keep it in step with the active view via `getElementById('mobileBreadcrumb')`, so renaming that **id** means touching both. The `.mobile-breadcrumb` class is styling only and appears in neither script.
- **Tried and reverted, don't re-propose**: pinning the branding block to `--sidebar-w` with the logo centred inside it (spends 264px on a 99px logo, and a label like "Networking for Kubernetes" truncated when it sat inside); a `.topbar::after` bottom rule starting at `--sidebar-w`; a stacked eyebrow-over-title heading; a 64px bar.
- **Page-scoped exception — dark-mode content link colours.** These (`a:link`, `a:visited`) must be scoped to the content area (`.page-body` in `index.css`, `.main-inner` in `migration.css`) and stay in the **per-page** CSS. Never in `shared.css`, never global, or they override the topbar/sidebar link colours.

## Design system: the hard rules

The site follows the **F5 Design System (F5DS)**, the system behind the F5 Distributed Cloud console. Never blend it with the F5 **marketing** brand (Neusa Next Pro Wide / Proxima Nova, F5 Red, the Brand Center ramps) — a value correct in one is a defect in the other, and `check-tokens.py` fails on the retired marketing hexes by name.

**`assets/css/tokens.css` is the reference for every value and every measured ratio.** Read it before choosing a colour.

- **Never write a raw value at a call site** — including inline `style=` attributes and JS-generated `cssText`, both of which exist in the migration tool and are easy to miss.
- **Spacing**: base 8, every value a multiple of 4. **12px is not in the system** — resolve to 8 or 16 by context, never to itself.
- **Radius**: `--radius` 4px for everything. `--radius-small` 2px **only when genuinely too small for 4px** — the 3px nav rail, the 16px tick box; not a 20px button. `--radius-pill` for Tags and Badges only.
- **Type**: sizes only through `--fs-*`/`--lh-*`. F5DS pairs a fixed leading with each size, so `line-height` is a length, not a multiplier: **any rule that sets `font-size` must restate the paired `--lh-*`.** Weights 400/500/700 only. **Zero `letter-spacing` declarations anywhere.**
- **Elevation**: `--elev-*` only. Cards are border-only at rest, and there is no hover lift.
- **A status hue is never used as text**, and colour is never the only signal: a status dot always ships with its text label, an info box always with its sentiment icon.
- **Filled green buttons use `--green-text`**, not `--green` — white on `#009639` is 3.87:1.
- **CRD badges use F5DS's graph palette**, not the sentiment hues.
- **Capitalization: sentence case, except buttons and tabs.** F5 ships three
  standards that disagree here, and for a documentation site the documentation
  one wins: sentence case for headings, prose, navigation and anything that
  reads as content. The exception is the parts that are purely interface —
  button and tab labels take Title Case, which is what F5DS specifies for them.
  A toggle is not a button: F5DS puts toggles in sentence case, which is why the
  migration strategy selector stays lowercase. And the sidebar labels *are* the
  `<h2>` headings they link to, so they match the headings verbatim — with one
  measured exception: `.sidebar-link-name` is `white-space: nowrap` inside a
  264px rail, so a heading that would clip is shortened instead. Today that is
  "Config analyzer" for "Ingress NGINX config analyzer" (the full string
  measures ~285px against ~226px of usable width). Shorten only when it clips,
  and measure rather than assume — "Phased migration strategy" is 150.5px and
  fits, which is why it is spelled out in full.

**Documented deviations — do not "fix" these.** Each has a reason, in the `f5ds-design` skill: NGINX green leads rather than Dodger Blue; the hexagon lattice in the landing hero; no hover lift; the authored dark theme; two button vocabularies (`.cta*` and `.btn*`); `--mono` = SF Mono; the VS Code code palette and its neutral `#1E1E1E` surface; inline code as a borderless wash; the 900/600px breakpoints and all max-widths; 48px content gutters; `min-height: 44px` on mobile controls; `border-radius: 50%` on dots and spinners; hover scale on the checklist marker and scroll-to-top.

## Checks

One command, no dependencies:

```bash
python3 .github/scripts/check-all.py
```

It runs all eight and prints how many **ran**, which is the number that matters. Run them individually when you want one check's full output:

```bash
python3 .github/scripts/check-syntax.py     # every script parses (one `node --check` per file)
python3 .github/scripts/check-tokens.py     # token invariants, retired colours/typefaces, undefined var(), webfont coverage
python3 .github/scripts/check-contrast.py   # every colour pairing against WCAG 2.1 AA, both themes, plus pairings derived from the CSS
python3 .github/scripts/check-classes.py    # classes resolve to rules; load order, asset paths and navigation labels hold
python3 .github/scripts/check-versions.py   # every version string agrees with its source of truth
python3 .github/scripts/check-markup.py     # tag balance, duplicate ids, anchors, JSON-LD
node    .github/scripts/test-analyzer.js    # the migration analyzer, under a DOM stub
node --test .github/test/*.test.js          # page ↔ engine ↔ module wiring
```

`.github/workflows/tests.yml` runs the same eight on every push and pull request, one step each.

Why a runner rather than a shell line, and why one command per line when you run them by hand: a mistyped shell construct reports "clean" for a check that never ran, which has now happened six times — a `$F` that expanded to one filename, broken `grep -c` arithmetic, a zsh glob swallowing `--include`, a `for c in "python3 …"; do $c; done` loop where zsh treated each whole string as one command name and printed `exit=0` four times having run nothing, a `$b:` followed by a path in zsh (parsed as a history modifier, so `$b:assets/…` silently became `mainssets/…`), and — for two months, inside CI — `node --check assets/js/*.js`, which parses only the first glob match. If you must capture status through a pipe, zsh is `${pipestatus[1]}`, not `$?`.

The same shape is why the test step names its glob and guards on `find`: `node --test` exits 0 when it matches no files, so a moved directory turns it into a green no-op.

Five things to know about them:

1. **None of them can see the rendered page.** Every one is a static reader, so the entire class of visual defect — a stretched grid, a collapsed flex item, a truncated label, a card wrapping 3+1 — passes all of them green. A clean run means "nothing is structurally broken", not "it looks right". Render and look.
2. **`check-contrast.py` now derives pairings from the stylesheets as well as asserting a hand-written list**, so a new coloured surface is measured without anyone remembering to add it. Two limits remain: it only sees pairs declared through tokens in the same rule (or a dark override of one), and it cannot know which text is large enough for the 3:1 bar, so it holds everything to 4.5:1.
3. **`check-classes.py` matters most after a restyle.** A class that loses its rule does not error — the element just renders unstyled, which is invisible on a page with thousands of rows. It reports unused classes too but never fails on them: there is dormant-by-design CSS here, listed by name in the script's own `DORMANT` set — the event banner and the ingress2gateway annotation grid, both built ahead of their content. Run `git log -S` before deleting anything on that list.
4. **`check-all.py` is a Python runner, not a shell one.** That is the point: a literal `(label, argv)` tuple per check, no globbing or word-splitting between it and the process, an assertion that the result count matches the declared count, and a summary line naming how many ran. A missing script or interpreter is a failure, never a skip.
5. **They live under `.github/` because Pages publishes this branch.** A top-level `scripts/` was being served (`/scripts/check-tokens.py` returned 200); dot-directories 404, because Jekyll runs on this branch and skips dot-prefixed paths. **There is no `.nojekyll` here and adding one would publish `.github/` wholesale** — it disables Jekyll rather than configuring it, so the dot-prefix exclusion goes with it. Anything else that must not be served goes under `.github/` too, which is why the test suite is at `.github/test/` rather than `test/`. Each script and the test loader derive `ROOT` by walking up from their own path, so moving one means fixing that.

## Branches, deploying, and undoing

**Pushing to `main` is deploying.** Pages serves this branch; a push is live in
roughly a minute, and CI finishes at about the same time, so a red run does not
stop a bad commit reaching production. Verify before you push, not after.

- Routine work goes straight to `main`. Large or risky efforts get a branch by
  explicit request.
- `preview/**` branches carry additional migration tools built on the same
  engine. **`main` owns the shared engine and the checks** — `assets/js/shared.js`,
  `assets/js/migration-core.js`, `.github/scripts/`, `.github/test/` and this
  file. A branch behind `main` on those is graded by its own older checks, so CI
  warns about it. Merge `main` into the branch rather than porting fixes across.
- To undo something already on `main`: `git revert <sha>` and push. **Never**
  `push --force`, `reset --hard` or `clean` on a branch that has been pushed —
  the deployed history is the record.

Agent permissions, hooks and MCP servers are deliberately **not** checked in:
they are a property of whoever is working, not of the project. If you want the
checks to run automatically before a turn ends, point a `Stop` hook at
`.claude/hooks/verify-before-stop.sh` from your own settings — the script is
tracked, its wiring is yours. It no-ops on a clean tree and honours
`SKIP_REPO_VERIFY=1`.

## Where the reasoning is written down

The commit bodies are the largest body of decision-making in this repository —
around 4,000 words, containing a genre that exists in no other file: what was
tried, what was rejected, and how it was verified. Before re-proposing something
or deleting something that looks dead:

```bash
git log --grep='Considered and rejected'   # ideas already weighed and dropped
git log -S'<name>'                         # why a class, token or function exists
```

Write commits the same way: what changed, why, what was rejected, and how it was
verified. A commit that records a fault injection ("planted X, the check
reported Y") is worth more later than one that says "fix check".

## Performance budget

Numbers to stay near, not a hard gate. Measured on the migration page: **789KB
uncompressed** (HTML 333, CSS 128, JS 218, font 110), **4,860 elements**, 130
mapping rows. Content grows this page; if a change moves any of these
appreciably, say so.

One invariant behind that: `filterTable` caches row text in a `WeakMap` and is
debounced. It used to call `row.textContent.toLowerCase()` on every row on every
keystroke, re-serialising 75 row subtrees per character. Do not undo that.

## Spelling

British in agent-facing prose and code comments (`colour`, `behaviour`) —
166 occurrences, including in `tokens.css` comments, which are served to every
visitor. American in user-facing page copy. CSS property names are `color`
regardless. If a style tool proposes normalising these, it is out of scope here.

## Migration tool: the one rule that cannot wait

**The analyzer's mappings and the static reference tables must agree in both directions.** Editing a mapping or generator means updating the matching reference row *and* the example YAML in its expanded panel; editing a reference row whose construct the analyzer handles means updating the mapping. The generator is the source of truth — a hand-written example drifting from its still-correct generator is the recurring bug here.

Everything else about the tool — ordering rules, collapsed-cell conventions, how to test a generator with no build system, the accuracy checklist — is in the `migration-tool` skill.

## Domain concepts

- **Annotation prefixes**: community `nginx.ingress.kubernetes.io/`; NIC `nginx.org/` (OSS) or `nginx.com/` (Plus).
- **CRDs**: NIC supports VirtualServer, VirtualServerRoute, Policy, TransportServer, GlobalConfiguration.
- **NGINX Plus**: only NIC has Plus features (JWT, OIDC, WAF).
- **Gateway API**: the standard Kubernetes traffic-management API; NGINX Gateway Fabric is the NGINX implementation.
- **Naming**: "NGINX Ingress Controller" — never "Official NGINX Ingress Controller" or "NGINX Inc.". The other one is "the community controller" or `kubernetes/ingress-nginx`.

## Research resources

Prefer GitHub MCP tools over WebFetch for these.

**Community controller** (`kubernetes/ingress-nginx`)

- GitHub: https://github.com/kubernetes/ingress-nginx
- Annotations: https://github.com/kubernetes/ingress-nginx/blob/main/docs/user-guide/nginx-configuration/annotations.md
- Docs site: https://kubernetes.github.io/ingress-nginx — published annotations at `/user-guide/nginx-configuration/annotations/`

**NGINX Ingress Controller** (`nginx/kubernetes-ingress`)

- GitHub: https://github.com/nginx/kubernetes-ingress — CRD types at `pkg/apis/configuration/v1/types.go`. The prose docs are **not** in this repo; they live in `nginx/documentation` (next line).
- Annotations: https://github.com/nginx/documentation/blob/main/content/nic/configuration/ingress-resources/advanced-configuration-with-annotations.md
- Docs site: https://docs.nginx.com/nginx-ingress-controller/ — published annotations at `/configuration/ingress-resources/advanced-configuration-with-annotations/`, and the VirtualServer/VirtualServerRoute, Policy, TransportServer and GlobalConfiguration resource pages under `/configuration/`
- Migration guide: https://docs.nginx.com/nginx-ingress-controller/install/migrate-ingress-nginx

**NGINX Gateway Fabric** (`nginx/nginx-gateway-fabric`)

- GitHub: https://github.com/nginx/nginx-gateway-fabric
- Docs site: https://docs.nginx.com/nginx-gateway-fabric/

**ingress2gateway**: https://github.com/kubernetes-sigs/ingress2gateway

## Deeper references

These are Claude Code skills, but they are plain markdown — any agent can read them directly.

- **`.claude/skills/f5ds-design/SKILL.md`** — why the design decisions are what they are: the accent split, the three F5DS pairings that fail WCAG AA and their replacements, the badge graph palette, the full type scale, and every deviation with its justification. Read before changing a design value or "fixing" a deviation.
- **`.claude/skills/migration-tool/SKILL.md`** — authoring and verifying the migration tool: the engine split, row ordering and cell conventions, the Node verification recipe and its silent-failure gotcha, and the four-point accuracy check.
- **`.claude/skills/release-update/SKILL.md`** — the checklist for an NIC, NGF or ingress2gateway release, including the three version formats a plain grep misses, the feature badges that must *not* be swept along, and the compatibility table and Kubernetes-version rules that are the steps most often missed.
- **`.claude/skills/verify-visually/SKILL.md`** — how to actually look at the site: `shot.sh`, DOM measurement, and the four facts that make a correct render command look like it failed. Read before reporting that anything visual was verified.
