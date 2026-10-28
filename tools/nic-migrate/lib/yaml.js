'use strict';
/* yaml.js — the YAML parser and emitter nic-migrate uses: the site's own.
   =========================================================================
   This file used to be a second YAML implementation. The page's analyzer
   read manifests with line regexes, so the two read the same paste
   differently: the page truncated kubectl's wrapped values, the CLI turned
   tabs into spaces. The parser now lives in assets/js/migration-core.js
   (MigrationTool.yaml) and both tools use it. This module only hands it
   over, as plain-realm objects, with the API the CLI always had.

   Supported: multi-document streams, block mappings and sequences, plain and
   quoted scalars folded across lines (as kubectl wraps them), block scalars
   with chomping and indentation indicators, flow collections, comments.
   Refused, with the line: anchors and aliases, merge keys, tags other than
   the standard ones, tab indentation, and any line the parser did not use.
   ========================================================================= */

const { loadAnalyzer } = require('../../../.github/test/lib/load.js');

const { tool } = loadAnalyzer('assets/js/migration-ingress-nginx.js');
const Y = tool.yaml;

/* The engine runs in its own vm context, so the objects it builds belong to
   another realm: re-home them, or deepEqual and instanceof see strangers. */
const home = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

module.exports = {
    parse: (text) => home(Y.parse(text)),
    parseAll: (text) => home(Y.parseAll(text)),
    stringify: (value, comments, opts) => Y.stringify(value, comments, opts),
    stringifyAll: (docs) => Y.stringifyAll(docs),
    splitStream: (text) => Y.splitStream(text).map((d) => d.lines)
};
