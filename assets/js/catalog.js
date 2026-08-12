/* catalog.js — the Catalog page's expand/collapse controls.
   =========================================================================
   The console puts a "Details" control at the top right of each workspace
   card, collapsing the description and leaving the header and the services
   table visible. Cards start expanded: on a public catalog the description
   is the point, and collapsing by default would hide the only thing that
   explains why the products in a card belong together.

   Progressive enhancement: with JavaScript off the detail regions have no
   `hidden` attribute and simply stay open, which is the useful state.
   ========================================================================= */
'use strict';

(function () {
    var toggles = document.querySelectorAll('.catalog-toggle');
    if (!toggles.length) { return; }

    for (var i = 0; i < toggles.length; i++) {
        toggles[i].addEventListener('click', function () {
            var detail = document.getElementById(this.getAttribute('aria-controls'));
            if (!detail) { return; }

            var expanded = this.getAttribute('aria-expanded') === 'true';
            this.setAttribute('aria-expanded', expanded ? 'false' : 'true');
            detail.hidden = expanded;

            var card = this.closest('.catalog-card');
            var name = card ? card.querySelector('.catalog-card-title').textContent.trim() : 'Details';
            announce(name + (expanded ? ' collapsed' : ' expanded'));
        });
    }

    /* Chromium reveals a `hidden="until-found"` region when find-in-page
       matches inside it, but leaves the button claiming to be collapsed. This
       keeps the two in step. The listener is harmless where unsupported. */
    var details = document.querySelectorAll('.catalog-card-detail');
    for (var j = 0; j < details.length; j++) {
        details[j].addEventListener('beforematch', function () {
            var btn = document.querySelector('[aria-controls="' + this.id + '"]');
            if (btn) { btn.setAttribute('aria-expanded', 'true'); }
        });
    }
}());
