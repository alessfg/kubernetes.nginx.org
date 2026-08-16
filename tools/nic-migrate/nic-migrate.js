#!/usr/bin/env node
'use strict';
/* nic-migrate — batch the site's migration analyzer over real Ingress manifests.
   =========================================================================
   Stage 1 (this file) is deliberately ADVISORY. It runs the same engine the web
   tool runs, one Ingress document at a time instead of one textarea at a time,
   and adds the thing a paste box cannot: a per-Ingress account of what the
   engine's single-context model left behind. It does not produce manifests you
   should apply unreviewed, and it says so in every output mode.

   Zero dependencies, matching the rest of the repo's tooling. Run it from a
   checkout — it reads the mapping database out of assets/js/ rather than
   vendoring a copy, so it cannot drift from the published page.

   Usage:  node tools/nic-migrate/nic-migrate.js report --help
   ========================================================================= */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createEngine, ROOT, SOURCE_MODULE } = require('./lib/engine');
const { splitDocuments, isIngress, kindOf, describe } = require('./lib/ingress');
const { detect, sortGaps } = require('./lib/gaps');
const { renderReport, toJson, fileHeader } = require('./lib/render');

const USAGE = `nic-migrate — advisory ingress-nginx -> NGINX Ingress Controller report

  node tools/nic-migrate/nic-migrate.js report [options]
  node tools/nic-migrate/nic-migrate.js checklist

Input (choose one; defaults to stdin)
  -f, --file <path>        YAML file, or a directory scanned for .yaml/.yml.
                           Repeatable.
  -k, --kubectl            Read live Ingresses with kubectl.
  -n, --namespace <ns>     Namespace for --kubectl (default: all namespaces).

Options
  -s, --strategy <name>    crd | annotation            (default: crd)
  -o, --out <dir>          Also write per-Ingress YAML, with a gap header.
      --json               Emit JSON instead of the text report.
      --no-color           Disable ANSI colour (also honours NO_COLOR).
      --strict             Exit 1 if any blocking gap was found.
  -h, --help               This text.

Output is advisory. Generated CRDs are single-feature illustrations against one
host/service/path; they are not merged and Policies are not wired in. Resolve
every blocking gap before applying anything.`;

function parseArgs(argv) {
    const opts = {
        command: null, files: [], kubectl: false, namespace: null, strategy: null,
        out: null, json: false, colour: null, strict: false, help: false
    };
    let i = 0;
    if (argv[i] && !argv[i].startsWith('-')) opts.command = argv[i++];
    for (; i < argv.length; i++) {
        const a = argv[i];
        const need = (name) => {
            const v = argv[++i];
            if (v === undefined) throw new Error(name + ' needs a value');
            return v;
        };
        if (a === '-f' || a === '--file') opts.files.push(need(a));
        else if (a === '-k' || a === '--kubectl') opts.kubectl = true;
        else if (a === '-n' || a === '--namespace') opts.namespace = need(a);
        else if (a === '-s' || a === '--strategy') opts.strategy = need(a);
        else if (a === '-o' || a === '--out') opts.out = need(a);
        else if (a === '--json') opts.json = true;
        else if (a === '--no-color' || a === '--no-colour') opts.colour = false;
        else if (a === '--strict') opts.strict = true;
        else if (a === '-h' || a === '--help') opts.help = true;
        else throw new Error('unknown option: ' + a);
    }
    return opts;
}

function collectFiles(target) {
    const st = fs.statSync(target);
    if (st.isFile()) return [target];
    const out = [];
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
        const p = path.join(target, entry.name);
        if (entry.isDirectory()) out.push(...collectFiles(p));
        else if (/\.ya?ml$/i.test(entry.name)) out.push(p);
    }
    return out.sort();
}

function readStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

function readKubectl(namespace) {
    const args = ['get', 'ingress', '-o', 'yaml'];
    if (namespace) args.push('-n', namespace); else args.push('--all-namespaces');
    try {
        return execFileSync('kubectl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch (err) {
        const stderr = (err.stderr || '').toString().trim();
        throw new Error('kubectl failed: ' + (stderr || err.message));
    }
}

/* `kubectl get -o yaml` over multiple objects returns a single List document
   rather than a multi-document stream. Split it back into items so each Ingress
   is analyzed on its own. */
function splitKubectlList(text) {
    if (!/^kind:\s*List\s*$/m.test(text)) return splitDocuments(text);
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const start = lines.findIndex((l) => /^items:\s*$/.test(l));
    if (start === -1) return splitDocuments(text);
    const docs = [];
    let cur = null;
    for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i];
        /* Item check first: a list entry begins "- " at column 0, which is also
           non-whitespace, so a top-level test placed ahead of this one ends the
           scan on the very first item. */
        if (/^- /.test(line)) {
            if (cur) docs.push(cur.join('\n'));
            cur = [line.replace(/^- /, '')];
        } else if (/^\S/.test(line) && line.trim() !== '') {
            break; // a sibling top-level key, e.g. the List's own trailing metadata:
        } else if (cur) {
            cur.push(line.replace(/^ {2}/, ''));
        }
    }
    if (cur) docs.push(cur.join('\n'));
    return docs.length ? docs : splitDocuments(text);
}

function loadChecklist() {
    const html = fs.readFileSync(path.join(ROOT, 'ingress-nginx-migration.html'), 'utf8');
    const block = html.match(/id="migrationChecklist"[\s\S]*?<\/ul>/);
    if (!block) throw new Error('could not find the checklist in ingress-nginx-migration.html');
    const items = [];
    const re = /<li\b[^>]*>\s*<span>([\s\S]*?)<\/span>/g;
    let m;
    while ((m = re.exec(block[0])) !== null) {
        items.push(m[1]
            .replace(/<[^>]+>/g, '')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
            .replace(/\s+/g, ' ')
            .trim());
    }
    return items;
}

function main() {
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (err) {
        process.stderr.write('error: ' + err.message + '\n\n' + USAGE + '\n');
        return 2;
    }
    if (opts.help || !opts.command) {
        process.stdout.write(USAGE + '\n');
        return opts.help ? 0 : 2;
    }

    if (opts.command === 'checklist') {
        const items = loadChecklist();
        process.stdout.write('Migration checklist (' + items.length + ' items, from the published page)\n\n');
        items.forEach((t, i) => process.stdout.write('  ' + String(i + 1).padStart(2) + '. [ ] ' + t + '\n'));
        return 0;
    }
    if (opts.command !== 'report') {
        process.stderr.write('error: unknown command "' + opts.command + '"\n\n' + USAGE + '\n');
        return 2;
    }

    // Gather input.
    const sources = [];
    if (opts.kubectl) {
        sources.push({ file: 'kubectl', text: readKubectl(opts.namespace), isList: true });
    } else if (opts.files.length) {
        for (const target of opts.files) {
            for (const file of collectFiles(target)) {
                sources.push({ file: path.relative(process.cwd(), file), text: fs.readFileSync(file, 'utf8') });
            }
        }
    } else {
        const text = readStdin();
        if (!text.trim()) {
            process.stderr.write('error: no input (pass -f/--file, --kubectl, or pipe YAML on stdin)\n');
            return 2;
        }
        sources.push({ file: '(stdin)', text });
    }

    const engine = createEngine();
    const strategy = opts.strategy || engine.defaultStrategy;
    if (engine.strategies.length && engine.strategies.indexOf(strategy) === -1) {
        process.stderr.write('error: unknown strategy "' + strategy + '" (expected: ' +
            engine.strategies.join(', ') + ')\n');
        return 2;
    }

    const items = [];
    let skipped = 0;
    for (const src of sources) {
        const docs = src.isList ? splitKubectlList(src.text) : splitDocuments(src.text);
        for (const doc of docs) {
            if (!isIngress(doc)) { if (kindOf(doc)) skipped++; continue; }
            const desc = describe(doc);
            const result = engine.analyze(doc, strategy);
            items.push({ desc, result, sourceFile: src.file, gaps: sortGaps(detect(desc, result)) });
        }
    }

    if (!items.length) {
        process.stderr.write('error: no Ingress documents found' +
            (skipped ? ' (' + skipped + ' non-Ingress document' + (skipped !== 1 ? 's' : '') + ' skipped)' : '') + '\n');
        return 1;
    }

    const colour = opts.colour === false || process.env.NO_COLOR ? false : process.stdout.isTTY === true;
    const renderOpts = { strategy, colour, wrap: true };

    if (opts.json) {
        process.stdout.write(JSON.stringify(toJson(items, renderOpts), null, 2) + '\n');
    } else {
        process.stdout.write(renderReport(items, renderOpts) + '\n');
        if (skipped) {
            process.stdout.write('\n' + skipped + ' non-Ingress document' +
                (skipped !== 1 ? 's' : '') + ' skipped.\n');
        }
    }

    if (opts.out) {
        fs.mkdirSync(opts.out, { recursive: true });
        let written = 0;
        for (const item of items) {
            if (!item.result.yaml) continue;
            const base = (item.desc.namespace ? item.desc.namespace + '-' : '') + item.desc.name;
            const file = path.join(opts.out, base.replace(/[^A-Za-z0-9._-]/g, '_') + '.yaml');
            fs.writeFileSync(file, fileHeader(item) + item.result.yaml + '\n');
            written++;
        }
        process.stderr.write('\nwrote ' + written + ' advisory file' + (written !== 1 ? 's' : '') +
            ' to ' + opts.out + '\n');
    }

    const blocking = items.reduce((n, i) => n + i.gaps.filter((g) => g.severity === 'blocking').length, 0);
    return opts.strict && blocking > 0 ? 1 : 0;
}

if (require.main === module) {
    try {
        process.exitCode = main();
    } catch (err) {
        process.stderr.write('error: ' + err.message + '\n');
        process.exitCode = 1;
    }
}

module.exports = { main, loadChecklist, splitKubectlList, SOURCE_MODULE };
