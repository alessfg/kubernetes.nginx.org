'use strict';
/* sources.js — the one table that knows which migration source is which.
   =========================================================================
   The CLI runs whichever source module the site ships, and the modules differ
   in two ways the CLI cannot infer from `window.MIGRATION_SOURCE`:

     prefixes  which annotation keys belong to the source controller. The
               scanner needs this to count what an object carries.
     kinds     which Kubernetes kinds are worth handing to the analyzer.
               ingress-nginx keeps every setting on the Ingress, so anything
               else is noise. HAProxy spreads the same job across annotated
               Ingress AND Service objects, its controller ConfigMap, and five
               CRs — so an Ingress-only gate would silently skip most of a real
               deployment and then report "no documents found".

   Deliberately here rather than in the source modules: those are page
   contracts loaded in a browser, and input-gathering is a CLI concern. Adding
   a field the page never reads would invite it to drift unnoticed.

   Adding a source is this table plus a module in assets/js/. Nothing else in
   the CLI hardcodes a source name.
   ========================================================================= */

const SOURCES = {
    'ingress-nginx': {
        id: 'ingress-nginx',
        label: 'ingress-nginx',
        module: 'assets/js/migration-ingress-nginx.js',
        prefixes: ['nginx.ingress.kubernetes.io/'],
        kinds: ['Ingress'],
        // What the report calls the unit it iterates over.
        unit: 'Ingress'
    },
    haproxy: {
        id: 'haproxy',
        label: 'HAProxy',
        module: 'assets/js/migration-haproxy.js',
        // All three are accepted by the controller and by the analyzer; see
        // HAPROXY_PREFIXES in assets/js/migration-haproxy.js.
        prefixes: ['haproxy.org/', 'haproxy.com/', 'ingress.kubernetes.io/'],
        // Ingress and Service carry annotations; ConfigMap is the controller
        // ConfigMap or the legacy tcp-services map; the five CRs are the
        // ingress.v3.haproxy.org (and superseded v1) group.
        kinds: ['Ingress', 'Service', 'ConfigMap', 'Global', 'Defaults', 'Backend', 'Frontend', 'TCP'],
        unit: 'resource'
    },
    traefik: {
        id: 'traefik',
        label: 'Traefik',
        module: 'assets/js/migration-traefik.js',
        prefixes: ['traefik.ingress.kubernetes.io/'],
        /* Traefik is the opposite of HAProxy: one annotation prefix, but almost
           everything real lives in CRs rather than on the Ingress. The eleven
           kinds are the ones assets/js/migration-traefik.js switches on —
           routing (IngressRoute and its TCP/UDP siblings, TraefikService),
           behaviour (Middleware, MiddlewareTCP), TLS (TLSOption, TLSStore) and
           backend transport (ServersTransport, ServersTransportTCP).

           Traefik's static configuration is deliberately absent: it is CLI
           flags or a traefik.yml file, not a Kubernetes object, so there is no
           kind to gate on. The page documents it; the CLI cannot read it. */
        kinds: ['Ingress', 'IngressRoute', 'IngressRouteTCP', 'IngressRouteUDP',
                'Middleware', 'MiddlewareTCP', 'ServersTransport', 'ServersTransportTCP',
                'TLSOption', 'TLSStore', 'TraefikService'],
        unit: 'resource'
    }
};

const DEFAULT_SOURCE = 'ingress-nginx';

function resolveSource(id) {
    const key = String(id || DEFAULT_SOURCE);
    const found = SOURCES[key];
    if (!found) {
        throw new Error('unknown source "' + key + '" (expected: ' + Object.keys(SOURCES).join(', ') + ')');
    }
    return found;
}

module.exports = { SOURCES, DEFAULT_SOURCE, resolveSource };
