# CLAUDE.md

## Project Overview

Documentation-only site for **F5's Kubernetes portfolio**, commercial and open source. It is not an NGINX-only site: NGINX Ingress Controller and NGINX Gateway Fabric are two of six products, and BIG-IP Next for Kubernetes and Container Ingress Services lead.

| Product | Repo / source | Licence |
|---|---|---|
| **BIG-IP Next for Kubernetes** (BNK) | no public repo — OCI charts from F5's artifact registry | Commercial |
| **BIG-IP Container Ingress Services** (CIS) | `F5Networks/k8s-bigip-ctlr` | Apache 2.0, needs a BIG-IP |
| **NGINX Ingress Controller** (NIC) | `nginx/kubernetes-ingress` | Apache 2.0, OSS + Plus builds |
| **NGINX Gateway Fabric** (NGF) | `nginx/nginx-gateway-fabric` | Apache 2.0 |
| **F5 WAF for NGINX** | no public repo | Commercial, requires NGINX Plus |
| **F5 AI Gateway** | no public repo | Commercial |
| ingress-nginx migration tool | this repo | free tool |
| `ingress2gateway` | `kubernetes-sigs/ingress2gateway` | **upstream Kubernetes SIG, not F5** |

Project characteristics:

- **No build system, no package manager, no test framework.** Verification is four scripts under `scripts/` (see *Invariant guards*).
- Static HTML with CSS/JS in `assets/`. **No CDN, no third-party runtime dependency, ever** — including the webfont.
- Owned by F5, Inc. Apache 2.0.

## Directory layout

Multi-page, one directory per page, so URLs end in a trailing slash on GitHub Pages.

```
index.html                                Home — welcome + product tile grid
catalog/index.html                        Catalog — use-case cards + services tables
products/big-ip-next-for-kubernetes/      \
products/container-ingress-services/       |
products/nginx-ingress-controller/         |  Service Landing Pages
products/nginx-gateway-fabric/             |
products/f5-waf-for-nginx/                 |
products/f5-ai-gateway/                   /
solutions/better-together/                How the products combine
tools/ingress-nginx-migration/            The migration tool
tools/ingress2gateway/
ingress-nginx-migration.html              REDIRECT STUB — do not delete (see below)
gallery.html                              dev harness; delete before merging

assets/css/
  tokens.css      F5DS tokens ONLY — the auditable surface. No selectors.
  core.css        @font-face, reset, base type, components, chrome, app shell
  catalog.css     Home tile grid + Catalog use-case cards + layer diagram
  product.css     product / tool / solution pages, and the combo cards
  migration.css   the migration tool
assets/js/
  chrome.js                    theme toggle, nav drawer, active nav item, announce(), copy
  versions.js                  version fetch + [data-version] substitution
  catalog.js                   Catalog card Details toggles
  migration-util.js            CARRIED VERBATIM — NIC constants + 6 pure string utils
  migration-ingress-nginx.js   CARRIED VERBATIM — the mapping data and generators
  migration-core.js            the tool's UI layer (rewritten)
assets/img/    icon.svg, icon-512.png, apple-touch-icon.*, og-image.*, nginx-logo*.svg
assets/fonts/  InterVariable-subset.woff2, OFL.txt, README.md
scripts/       check-tokens.py, check-contrast.py, check-chrome-sync.py, test-analyzer.js
```

**Loading rules.** Every page links `tokens.css` → `core.css` → its page CSS, in that order.

**Asset and internal paths are depth-relative** — `assets/css/core.css` at the root, `../../assets/css/core.css` two levels down — and the site root is `./` or `../../`. Never write a root-absolute `/assets/…` or `/products/…`. The reason is deployment: GitHub Pages serves a project site at `/<repo>/`, so the fork preview lives at `alessfg.github.io/kubernetes.nginx.org/` and a root-absolute path resolves outside the site. Relative paths work at the domain root (production), under a subpath (fork preview) **and** over `file://`.

`<base href>` would have been tidier — one tag per page, chrome identical everywhere — and was rejected: it re-resolves `#fragment` links against the base, which would break every anchor in the migration tool's reference guide.

Two consequences to know:

- **`check-chrome-sync.py` normalises the `../` prefix** before comparing, since the same chrome legitimately reads `href="products/…"` at the root and `href="../../products/…"` deeper. A renamed label, a new nav item or a changed URL still fails the check; only the depth prefix is tolerated.
- **`initActiveNav()` in `chrome.js` reads `link.pathname`, not the `href` attribute.** The property is the browser's resolved absolute path, which is the only thing comparable against `location` when the attribute itself is relative.

**Three pages sit outside this scheme, deliberately**, and all three are in `check-chrome-sync.py`'s `IGNORE` set:

- **`404.html` is entirely self-contained** — no external CSS, no external JS, no sprite, and its tokens are *copied* from `tokens.css` rather than imported. GitHub Pages serves it for a missing URL at any depth, so it has no stable location: a relative href would resolve against whatever the visitor mistyped, and a root-absolute one would break on the subpath. Its links are root-absolute in the markup (correct in production) and rewritten at runtime for the `*.github.io` project-site case. **If the palette moves, update the copy in that file too.**
- **`ingress-nginx-migration.html`** is the redirect stub.
- **`gallery.html`** is a development harness.

Every page carries `<link rel="preload" as="font" … crossorigin>` **before** the stylesheets — the `@font-face` lives in `core.css`, so without the preload the font is not discoverable until that CSS has parsed. `crossorigin` is required even though the file is same-origin: fonts are always fetched in CORS mode, and omitting it fetches the file twice.

The inline `<head>` theme script must stay inline and must stay before the stylesheets, or the theme flashes.

**Migration page script order is load-bearing:** `chrome.js` → `migration-util.js` → `migration-ingress-nginx.js` → `migration-core.js`. The core reads `window.MIGRATION_SOURCE` at top level, so it must be last. The source module dereferences `MigrationTool.*` only inside function bodies (call time, never load time), so it tolerates either order relative to `migration-util.js`.

**The redirect stub.** `/ingress-nginx-migration.html` was the tool's URL before the rebuild and is linked from outside the site. GitHub Pages has no server-side redirects, so it is a zero-delay meta refresh plus a canonical link plus a JS `location.replace`. It is excluded from `sitemap.xml` and carries `noindex, follow`. **Do not delete it.**

## Design system

The site follows the **F5 Design System (F5DS)** — the design system behind the F5 Distributed Cloud console (`~/.claude/skills/f5-product-ui-core`, plus the live zeroheight styleguide via the `zeroheight` MCP; styleguide `54f4bdf5c`, v63060).

This replaced an earlier arrangement that mixed F5DS structure with the F5 **marketing** palette. That split is gone: colour is now F5DS too, with one deliberate exception below. Do not reintroduce marketing palette values — `scripts/check-tokens.py` fails on them by hex.

### The green/blue split is not a deviation

F5DS's platform primary is Dodger Blue `#4F73FF`. This site leads with **NGINX green `#009639`**, and that is what F5 actually ships: in the F5XC console the NGINX One workspace marks its active navigation item in green and uses a green primary button, while platform-level pages in the same console use Dodger Blue. So:

- **NGINX green** — the lead accent. Active nav item, primary buttons, section rails, "new side" of a comparison.
- **Dodger Blue** — platform and tooling. Links, focus rings, the Explore action, tool pictograms, `Commercial` licence dots.
- **F5 Brand Red `#E4002B` is absent entirely.** F5DS restricts it to logo, illustrations and pictograms and forbids it as a CTA, link, accent or error colour. Negative sentiment is Pomegranate.

### Three F5DS pairings fail WCAG AA

F5DS publishes **no accessibility guidance at all**, and three of its own published combinations fail. `tokens.css` therefore carries derived tokens, each with its measured ratio in a comment:

| F5DS value | Measured | Replacement |
|---|---|---|
| N500 secondary text on the N100 page background | 4.25:1 | `--n550` `#677185` — 4.62:1 on N100, 4.91:1 on N0 |
| N400, documented as the icon colour, on white | 2.42:1 | `--n450` `#848FA5` — 3.25:1 on N0, 3.06:1 on N100 |
| White on Dodger Blue `#4F73FF` | 4.02:1 | `--blue-text` `#2E50D9` — 6.43:1 |

Same for green: white on `#009639` is 3.87:1, so **every filled green button uses `--green-text` `#007D30`**, not `--green`.

**Emerald and Amber cannot reach the 3:1 non-text bar at any usable saturation** — 2.02:1 and 1.60:1 on white, and even F5DS's own hover values only manage 2.95:1 and 2.23:1. So a **status dot is never rendered without its text label**, and a notification is never rendered without its sentiment icon. That is F5DS's own rule (colour must never be the only signal), not a workaround. A status hue is **never used as text**; the console does the same, setting "Enabled" in N600 with only the dot in green.

Run `python3 scripts/check-contrast.py` after any colour change. It parses `tokens.css`, resolves `var()` and alpha compositing, and asserts every pairing.

### Typography

- **Every size goes through `--fs-*` / `--lh-*`.** Never a raw `rem`/`px` font-size — including inline `style=` and JS-generated `style`.
- F5DS pairs a **fixed leading with each size**, so `line-height` is a length, not a multiplier: **any rule that sets `font-size` must restate the paired `--lh-*`.**
- **Weights 400 / 500 / 700 only.** No 300, no 600. (`font-weight: 100 900` in `@font-face` is a variable-font axis range, not a weight.)
- **Zero `letter-spacing` declarations anywhere.** The scale specifies no tracking.
- Which size means what: **H1 36/54** = Service Landing Page titles (the product pages). **H2 24/36** = Home and Catalog titles. **H3 18/26** = page titles in the top bar, and card headings. **Body 14/20** is the main UI and body size, not 16.
- Sanctioned deviations, tracked in `check-tokens.py`: `--mono` is SF Mono rather than F5DS's Courier, which is unreadable at code-block sizes (docs.nginx.com deviates identically); inline `code` sizes at `0.9em`, relative to its context rather than off the scale; `border-radius: 50%` on dots and spinners, which cannot take a 4px corner.
- The font is **self-hosted, never a CDN**. See `assets/fonts/README.md` before re-subsetting — `→` is used 29 times in the mapping tables and is outside both stock Google `latin` and `latin-ext` ranges. The metric-override `@font-face` values in `core.css` were computed from these specific files; recompute them if the font is regenerated.

### Spacing, radius, elevation, motion

Never write a raw value at a call site — including inline `style=` and JS.

- **Spacing** (`--space-*`): base 8, every value a multiple of 4. Two hard rules: **12px is not in the system** (resolve to 8 or 16 by context, never to itself — which is why there is deliberately no step between `base` and `2x`), and **2px is only used between a label and its form control**. `--space-6x` 48 and `--space-8x` 64 extend past F5DS's published 40px ceiling using its own `Nx = 8N` formula.
- **Choosing between 8 and 16:** icon↔text 8; between buttons in a group **20**; sibling controls in a row 16; grid gutter 16; same-thought margin 8; peer blocks 16; container insets **20** (which is what the annotated Workspace Card measures); section→section 40. When genuinely ambiguous, round **down**.
- **Radius**: `--radius` 4px for everything; `--radius-small` 2px only when too small for 4px (F5DS's own example is the nav selected-item highlight); **`--radius-pill` for Tags and Badges only** — a pill-shaped button, card or input is off-system.
- **Elevation**: `--elev-*` only, N700-tinted, never black except inside the dark theme where an 8% N700 tint is invisible. **L0 on buttons and typographic elements.** Cards are **border-only at rest** — the console does this on its own Home and landing pages, reserving shadow for surfaces that genuinely float.
- **Motion**: `--dur-*` / `--ease-*` only. F5DS assigns duration **by distance travelled**, adding 100ms per 10% of screen crossed — use that to place a new value rather than guessing.
- **Grid**: 12 columns, 16px gutter adopted. F5DS's 20px page margin is **not** adopted; the site keeps 48px content gutters, because 20px assumes a dense product screen in a chrome-heavy shell and puts prose against the viewport edge on a wide page. `--nav-w` is 264px, F5DS's fixed Primary Navigation width.
- **Buttons**: one system in `core.css` — `.btn` plus `.btn-primary` / `.btn-secondary` / `.btn-accent` / `.btn-tertiary`, sizes `.btn-xs` 24 / default 32 / `.btn-md` 40, 20px group gap via `.btn-row`. **Exactly one Primary per group.** Compose bespoke buttons onto `.btn`; do not redefine geometry.
- **UI-label case**: Title Case on buttons, links, tab labels and nav titles, and on headings that mirror a nav item. Sentence case on notification titles and bodies, tooltips, form labels, error text, table-cell blurbs and `nav-link-meta`. No terminal punctuation on labels. Preserve technical tokens verbatim: `CRD`, `NGINX`, `ConfigMap`, `mTLS`, `InferencePool`, `WAFPolicy`, and the community repo name **`ingress-nginx`** — never `Ingress-Nginx`.

### Documented deviations (keep these; don't let a scanner "fix" them)

| Deviation | Why |
|---|---|
| **NGINX green leads, not Dodger Blue** | What F5 ships on NGINX-branded console surfaces. See above — not really a deviation. |
| **No hover lift** — L1→L2 shadow only, no `translateY` | F5DS's `Elevate Up` is a Motion-page catalogue entry, not a mandate, and a page of cards rising at once is a lot of motion for a docs site. |
| **Dark theme** | F5DS publishes none (Early Availability only). Authored here, deepening into the same N-ramp — N700 page, N600 surface — with both accents lightened until they clear 4.5:1 on both. |
| **Licence column instead of XC's Status** | XC's `Enabled / Requested / Available` are tenant subscription states with no meaning on a public site. Keeps the categorical-dot idiom without editorialising. |
| **Explore navigates to a page, not a 580px Overlay Panel** | Product pages carry compatibility tables and install commands. F5DS documents an **inline Service Landing Page** variant for exactly this case. |
| **Layer diagram instead of an illustration** | F5DS's illustration system is Figma-only; imitating its hand-drawn style badly would read worse than not using it. A diagram is useful on a docs site and is authored from tokens. |
| **900px / 600px breakpoints, and all max-widths** | F5DS publishes no breakpoints and never states its fixed grid's maximum width. |
| **48px content gutters** (not 20px) | See Grid, above. |
| **`--mono` = SF Mono** (not Courier) | Unreadable at code-block sizes; docs.nginx.com deviates identically. |
| **`min-height: 44px` on mobile controls** | WCAG target size beats F5DS's fixed 32px. |
| **`prefers-reduced-motion` kill switch** | F5DS is silent; an addition, not a deviation. |
| **`.info-box` in `migration.css` mirrors `.notification`** | 100 instances carry hand-written content; restructuring each into the flex-plus-icon shape would risk the data for no visual gain. Same tokens, same sentiment binding. |
| **`border-radius: 50%` on dots and spinners** | A 6px state dot and a spinner cannot take a 4px corner. |
| **`Why Migrate?` keeps its `?`** | A genuine question serving as a section title. |

**Inferred, not published** — say so when touching these: table cell padding (F5DS has **no** table component), `.info-box` internal padding, which elevation level a dropdown gets (only Toast=L1 is stated), heading case, and any spacing above 40px.

## Invariant guards

Four scripts, all runnable with no dependencies. Run all four after any change.

```bash
python3 scripts/check-tokens.py        # design-token invariants + retired colours + undefined var()
python3 scripts/check-contrast.py      # every colour pairing against WCAG 2.1 AA
python3 scripts/check-chrome-sync.py   # the shared chrome is byte-identical across all pages
node    scripts/test-analyzer.js       # the migration analyzer, under a DOM stub
```

Three things to understand about them:

1. **The F5DS scanner (`~/.claude/skills/f5-product-ui-core/scripts/scan_ui_tokens.py`) is not a sufficient gate.** It cannot resolve `var()`, so a correct `var(--space-2x)` is invisible to it while a literal `16px` counts as on-token. Its spacing and typography dimensions read low *because* this site uses tokens. `check-tokens.py` reads literals instead. The scanner's colour dimension is meaningful now and worth running as a signal.
2. **These are scripts, not shell greps, partly because a mistyped shell variable reports "clean" for a check that never ran** — which is exactly what happened the first time the old greps were exercised during this rebuild.
3. **`check-tokens.py` also catches undefined custom properties.** An unresolvable `var()` does not error, it silently yields nothing and the declaration is dropped. That is invisible in review and often in the browser.

`check-tokens.py` has a `LEGACY` set and `check-chrome-sync.py` a `PENDING` set, both for files mid-rebuild. **Both are empty and must stay empty.**

### Chrome sync

With no build system the top bar, navigation and icon sprite are duplicated into every page. Regions are delimited:

```html
<!-- sync:nav -->  …  <!-- /sync:nav -->
```

Four regions — `sprite`, `masthead`, `actions`, `nav` — must appear in every page and be byte-identical. The breadcrumb and page title sit **outside** them, being per-page by definition. Edit the chrome in `index.html`, then propagate and run `check-chrome-sync.py`; the script prints a diff naming which side to change.

## The migration tool

`/tools/ingress-nginx-migration/`. Three views as F5DS Tabs: Getting Started, Config Analyzer, Reference Guide. Inactive views keep `hidden="until-found"` so find-in-page still reaches a mapping row in a view the reader is not looking at.

### What is data and what is presentation

This distinction is the single most important thing about this part of the repo.

**Carried verbatim, and must stay that way:**

- `assets/js/migration-ingress-nginx.js` — 130+ `ANNOTATION_MAPPINGS`, 20 CRD generators, `parseInput`/`buildPlan`, sample presets. Pure data and transformation, zero DOM.
- `assets/js/migration-util.js` — NIC version constants and six pure string transformations the source module calls while generating YAML. Their exact behaviour (which characters get neutralised, when a value becomes a block scalar) is part of the contract the mapping entries were written against.
- The ~340 reference rows in the page, their comparison YAML, and the 22 checklist items.

**Rewritten:** `migration-core.js` (rendering, navigation, filtering, checklist), `migration.css`, the page shell.

The `window.MIGRATION_SOURCE` contract is **deliberately unchanged** from before the rebuild — that is what keeps the Traefik and HAProxy source modules on their own branches working against this engine. `test-analyzer.js` asserts all 19 properties the renderer reads.

### Security: no innerHTML with plan data

Two plan fields carry pasted YAML **verbatim**: `infoNotes[].code` is built as `'nginx.ingress.kubernetes.io/' + annotation + ': ' + value`, and `unsupported.cards[].code` joins the annotation names found in the input. An earlier draft interpolated both into `innerHTML`, which made pasting an annotation value of `<img src=x onerror=…>` execute it.

**Everything derived from a plan is set with `textContent` or built as element nodes.** `innerHTML` appears only where the string is a literal in `migration-core.js`, via the deliberately-named `literal()` helper, and every such site is commented. Plan-supplied `href`s go through `safeHref()`, which rejects anything but http(s), a relative path or a fragment. `highlightLine()` is the one function that returns markup, and every interpolation in it passes through `esc()` first.

### Three silent-failure paths

1. **`buildPlan` runs each CRD generator inside a `try/catch` that only `console.warn`s**, so a broken generator **drops its resource** instead of throwing. A thrown exception is *not* the failure signal — **counting `console.warn` is**. `test-analyzer.js` captures warnings and fails on any.
2. **`renderBlock` warns and skips any `block.type` it does not recognise.** The type strings come from the source module, so they can drift on one side only. `test-analyzer.js` asserts every emitted type is renderable.
3. **Copy buttons attach to 344 comparison blocks by matching structure.** The pre-rebuild code bailed out silently, so a change to `.comparison-block`, its `<h4>` or its `<pre><code>` could remove all 344 with nothing in the console. It now counts and warns.

### Bidirectional accuracy between the analyzer and the tables

**The analyzer's mappings (`ANNOTATION_MAPPINGS`) and the static reference tables must stay in agreement in both directions.** Editing a mapping or its generator means updating the matching reference row — **including the example YAML in the expanded panel, which must match what the corresponding generator emits.** Editing a reference row whose construct the analyzer handles means updating the mapping to match. A recurring bug is a hand-written example drifting from its still-correct generator; **treat the generator as the source of truth and fix the example.**

**Exception:** reference rows for NIC-only features with no community equivalent (the left cell reads "No direct equivalent") have no analyzer counterpart, so editing them needs no JS change — e.g. the `apiKey` Policy row, since the community controller has no API-key annotation to map.

Also sanity-check generated `k8s.nginx.org/v1` field names against the `json:` tags in `nginx/kubernetes-ingress/pkg/apis/configuration/v1/types.go`.

### Table ordering and structure rules

- **Annotation mapping rows** within each category table are sorted alphabetically by the community annotation name (left column).
- **"No direct equivalent" rows** go at the end of their category table, after all community-to-NIC mappings.
- **NIC-only annotations are never bundled** into a community mapping row — each gets its own "No direct equivalent" row.
- **Within a single row**, when multiple annotations are listed on either side, they are alphabetical.
- **Collapsed cells stay terse** — both columns of a `tr.expandable` show only badges + `<code>` + a short blurb (≤ ~6 words). Never a full explanatory sentence, caveat or workaround in a collapsed cell. Those belong in the expanded panel as an `info-box`: `warning` for hard "no equivalent" cases (bold lead-in like `<strong>No direct equivalent:</strong>`), `note` for softer guidance. A `warning` added alongside an existing `note` precedes it.

## Version accuracy

**Critical rule:** every annotation, ConfigMap key, CRD field or feature documented anywhere on this site MUST exist in the version stated on the page. Before adding anything:

1. Check the version the page states.
2. Verify the feature exists in that **released** version — use `mcp__github__get_file_contents` against the tag.
3. Never document unreleased features, features from `main` that have not been tagged, or features from future versions.

### Bidirectional: guard against staleness, not just fabrication

The rule above catches **fabrication**. It does not catch **staleness** — describing a construct that *does* exist with outdated semantics, wrong defaults or an incomplete field set. Both are accuracy failures, and staleness is more dangerous because "does it exist?" passes right over it. Verify all four, against tagged source, **never from memory** (adversarial intuition about these constructs is wrong roughly half the time):

1. **Exists** in the pinned version.
2. **Semantics match** — behaviour, status codes, defaults, value formats. E.g. the community `auth-signin` accepts a full URL, but NIC's externalAuth `authSigninURI` is a **relative** URI (CRD pattern `^/.*$`), so the tool must strip the scheme and host rather than pass it through.
3. **Complete** — no omitted sub-options a migrator would hit. E.g. NIC's `accessControl` Policy is allow **xor** deny (validation requires exactly one), so a source rule needing both becomes two Policies; collapsing it silently drops half the intent.
4. **Checked both ways** — NIC-side claims neither overstated (e.g. "no HTTP fallback-service field" when VirtualServer upstreams have `backup`/`backupPort`) nor understated, and any Plus-only capability labelled as such.

### Things this site deliberately does not say

Recorded so nobody "completes" them later:

- **F5 AI Gateway has no public technical documentation.** Its docs site 301s to marketing; no version, changelog, chart reference or install command is published. Its page states only what F5 currently publishes and lists the gaps. The chart reference and namespace that circulate in search results come from that dead site and are **stale index data, not a source.** Do not quote the guardrail-policy count either — the product page gives two different figures in two sections.
- **F5 publishes no BNK + NGINX reference architecture.** BNK is documented as **L4–L7**, not L4-only. The documented two-tier path is **IngressLink** (classic BIG-IP + CIS + **NGINX Plus** IC). A BNK+NGINX pairing is marked Guidance on `/solutions/better-together/` and must stay marked.
- **CIS's repository is archived, but the product is not EOL.** Unmonitored from April 2026; `v2.20.4` shipped June 2026; distribution moved to Red Hat Container Registry, Docker Hub and Quay; support via F5 Technical Support. **No product end-of-support notice exists** — do not write one.
- **BNK prints no install command.** Its published Helm install resolves chart versions through a companion script rather than a pinned `--version`, so any specific version on the page would be fabricated.
- **`ingress2gateway` is an upstream Kubernetes SIG project, not an F5 product.** Say so wherever it appears.

## Release checklist

### Versions that auto-fetch

`assets/js/versions.js` `CONFIG` covers `nic`, `ngf`, `i2g` and `cis`. Update the **fallback** values there *and* the matching text in the markup — the markup value is what no-JS visitors and search engines see. **Bump `CACHE_KEY`** whenever `CONFIG`'s shape or `applyVersions()` changes, or returning visitors read a stale cache written by the old code.

The tag validator is `/^v?\d+\.\d+\.\d+$/` and deliberately rejects prefixed tags like `controller-v1.15.1`. A repo that tags that way needs its own parser, not a looser pattern.

### Versions that are hand-maintained

**No public repository exists for these, so nothing fetches them:**

- **BNK** — `2.3.2`, in the markup of its product page and the Home tile.
- **F5 WAF for NGINX** — three numbers that must not be conflated: **5.14** standalone, **5.13.4** pinned in NIC v5.5.4, **5.13.2** pinned in NGF 2.6.7. The number that matters to a reader is the one pinned into their data plane.

### Kubernetes compatibility

NIC and NGF compat tables show the **latest 3 Kubernetes minor versions**, matching upstream's support window (verify via `kubernetes/kubernetes` releases; exclude prereleases). **CIS is the exception** — F5 publishes its matrix as supported *ranges*, and it is reproduced as published.

BNK's table is split by deployment model, because F5 documents the DPU model on upstream Kubernetes and the Host model on OpenShift.

### Per release

- **NIC:** version + Helm chart on `/products/nginx-ingress-controller/`, the Home tile, `versions.js` fallbacks, `MigrationTool.NIC` in **`assets/js/migration-util.js`** (which drives the migration tool's version banners, the `kubectl apply` example and the Helm command on every migration page), and the NGINX OSS version (check `NGINX_OSS_VERSION` in `build/Dockerfile` at the tag).
- **NGF:** the same set, plus the **Gateway API version** and the **Inference Extension version**, and a review of `apis/v1alpha1`/`v1alpha2` at the tag for new CRDs.
- **CIS:** `versions.js` fallback and the compat ranges.
- `INGRESS_NGINX_VERSION` at the top of `assets/js/migration-ingress-nginx.js` is the source-controller side of the banner. `kubernetes/ingress-nginx` is archived and `controller-v1.15.1` is its final release, so **this should not need bumping again.**

## Naming

- First mention **F5 BIG-IP Next for Kubernetes**, then BNK. BIG-IP is always all-caps and hyphenated — never "BigIP" or "Big-IP".
- **F5 BIG-IP Container Ingress Services**, then CIS. Not "F5 BIG-IP Controller for Kubernetes" (a pre-2.x name), and there is no separate OpenShift product — it is the same binary.
- **NGINX Ingress Controller** — not "Official NGINX Ingress Controller", not "NGINX Inc.". The community project is "the community controller" or `kubernetes/ingress-nginx`.
- **F5 WAF for NGINX** — never "NGINX App Protect", which is the old name.
- **NGINX Plus** is the only edition with JWT, OIDC and WAF.
- Annotation prefixes: community uses `nginx.ingress.kubernetes.io/`; NIC uses `nginx.org/` (OSS) or `nginx.com/` (Plus).

**Voice.** Two standards, and they do not overlap: **F5DS's UX-writing rules govern UI labels** (button text, tab labels, nav titles, notification titles) — note these are Title Case, which directly contradicts the F5 marketing sentence-case rule, so never run `f5-terminology-check`'s sentence-case rule against a UI label. **F5's voice governs long-form prose.**

## Research resources

Prefer GitHub MCP tools over WebFetch for source; prefer the `zeroheight` MCP over the offline skill pack for design-system detail, since the pack is a snapshot.

**Community controller** (`kubernetes/ingress-nginx`, archived): [repo](https://github.com/kubernetes/ingress-nginx) · [annotations](https://kubernetes.github.io/ingress-nginx/user-guide/nginx-configuration/annotations/)

**NIC** (`nginx/kubernetes-ingress`): [repo](https://github.com/nginx/kubernetes-ingress) · [docs](https://docs.nginx.com/nginx-ingress-controller/) · [annotations](https://docs.nginx.com/nginx-ingress-controller/configuration/ingress-resources/advanced-configuration-with-annotations/) · [VirtualServer](https://docs.nginx.com/nginx-ingress-controller/configuration/virtualserver-and-virtualserverroute-resources/) · [Policy](https://docs.nginx.com/nginx-ingress-controller/configuration/policy-resource/) · [TransportServer](https://docs.nginx.com/nginx-ingress-controller/configuration/transportserver-resource/) · [WAF integration](https://docs.nginx.com/nginx-ingress-controller/integrations/app-protect-waf/configuration/) · [IngressLink](https://docs.nginx.com/nginx-ingress-controller/integrations/f5-ingresslink/) · [migration guide](https://docs.nginx.com/nginx-ingress-controller/install/migrate-ingress-nginx/)

**NGF** (`nginx/nginx-gateway-fabric`): [repo](https://github.com/nginx/nginx-gateway-fabric) · [docs](https://docs.nginx.com/nginx-gateway-fabric/) · [tech specs](https://docs.nginx.com/nginx-gateway-fabric/overview/technical-specifications/) · [WAF integration](https://docs.nginx.com/nginx-gateway-fabric/waf-integration/overview/) · [Inference Extension](https://docs.nginx.com/nginx-gateway-fabric/how-to/gateway-api-inference-extension/)

**CIS** (`F5Networks/k8s-bigip-ctlr`): [repo](https://github.com/F5Networks/k8s-bigip-ctlr) · [docs](https://clouddocs.f5.com/containers/latest/) · [what is CIS](https://clouddocs.f5.com/containers/latest/userguide/what-is.html) (holds the compat matrix) · [IngressLink](https://clouddocs.f5.com/containers/latest/userguide/ingresslink/) · [multi-cluster](https://clouddocs.f5.com/containers/latest/userguide/multicluster/)

**BNK**: [docs](https://clouddocs.f5.com/bigip-next-for-kubernetes/latest/) · [overview](https://clouddocs.f5.com/bigip-next-for-kubernetes/latest/overview.html) · [releases](https://clouddocs.f5.com/bigip-next-for-kubernetes/latest/releases/index.html) (`/latest/` is the 2.3 tree; `/2.0.0/` is the *oldest* archive) · [install](https://clouddocs.f5.com/bigip-next-for-kubernetes/latest/install/index.html) · [product page](https://www.f5.com/products/big-ip/next/big-ip-next-for-kubernetes)

**F5 WAF for NGINX**: [docs](https://docs.nginx.com/waf/) · [changelog](https://docs.nginx.com/waf/changelog/)

**Portfolio framing**: [F5 Networking for Kubernetes](https://www.f5.com/solutions/networking-for-kubernetes). Its four tier names (Networking / Production-grade / Enterprise-grade / Strategic) are citable, but the **product-to-tier mapping lives only inside SVG images** — do not assert which products sit in which tier without reading them.

`https://www.f5.com/solutions/use-cases/kubernetes` **404s** — do not link it.

## Hosting

- **Repository**: https://github.com/nginx/kubernetes.nginx.org
- **GitHub Pages** serves `main` at https://kubernetes.nginx.org/
- **Fork previews** go to `alessfg/kubernetes.nginx.org` on a `preview/*` branch, served at `https://alessfg.github.io/kubernetes.nginx.org/` — a **project-site subpath**, not a domain root. The `CNAME` file is inherited from `main` and is ignored there, because the fork cannot claim a domain the upstream org owns. This subpath is the whole reason paths are depth-relative.
- Preview locally with `python3 -m http.server` from the repo root, or just open `index.html` — relative paths mean `file://` works too.
