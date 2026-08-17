/** Scroll to anchors and intercept internal links for webview navigation. */

var vsc = acquireVsCodeApi();

(function(a, sy) {
    // 'on' if the extension has MathJax enabled for this page
    var mjState = 'MATHJAX_PLACEHOLDER';

    var findAnchor = function(anchor) {
        return document.getElementById(anchor)
            || document.querySelector('[name="' + CSS.escape(anchor) + '"]');
    };

    var flash = function(el) {
        el.style.transition = 'background 0.15s ease';
        el.style.background = 'var(--vscode-textLink-activeForeground, #e6b800)';
        setTimeout(function() { el.style.background = ''; }, 1000);
    };

    var scrollTo = function(anchor, key) {
        var el = findAnchor(anchor);
        if (!el) return;
        el.scrollIntoView({ block: 'start', behavior: 'instant' });

        if (key) {
            var visible = el.nextElementSibling
                || (el.parentElement && el.parentElement.nextElementSibling);
            var nearby = visible ? (visible.textContent || '') : '';
            if (nearby.indexOf(key) === -1) {
                var codes = document.querySelectorAll('code');
                for (var i = 0; i < codes.length; i++) {
                    if ((codes[i].textContent || '').indexOf(key) >= 0) {
                        codes[i].scrollIntoView({ block: 'start', behavior: 'instant' });
                        flash(codes[i]);
                        return;
                    }
                }
            }
        }

        var target = el.offsetHeight === 0
            ? (el.nextElementSibling || (el.parentElement && el.parentElement.nextElementSibling) || el)
            : el;
        flash(target);
    };

    document.addEventListener('DOMContentLoaded', function() {
        // On MathJax re-render, restore the exact scroll position instead of an anchor. 
        // Wait for typeset, else fall back to load and a timeout.
        if (typeof sy === 'number') {
            var restored = false;
            var restoreScroll = function() {
                if (restored) return;
                restored = true;
                window.scrollTo(0, sy);
            };
            var tryMathJax = function() {
                if (window.MathJax && window.MathJax.startup && window.MathJax.startup.promise) {
                    try {
                        window.MathJax.startup.promise.then(restoreScroll, restoreScroll);
                        return true;
                    } catch (e) {}
                }
                return false;
            };
            if (!tryMathJax()) {
                // CDN may still load. Re-check on load, then a final timeout.
                window.addEventListener('load', function() {
                    if (!tryMathJax()) restoreScroll();
                });
                setTimeout(restoreScroll, 500);
            }
        } else if (a) {
            var parts = a.split('||', 2);
            scrollTo(parts[0], parts.length > 1 ? parts[1] : '');
        }
        // When MathJax is on we never open *_mj.html; 
        // label the toggle link so the user knows the current state and can turn it off.
        if (mjState === 'on') {
            var mjLink = document.querySelector('#mathjaxlink a');
            if (mjLink) mjLink.textContent = '[MathJax off]';
        }
    });

    window.addEventListener('message', function(ev) {
        if (ev.data.type === 'scroll') {
            scrollTo(ev.data.anchor, ev.data.key || '');
        }
    });

    // Report the current scroll position, throttled, for re-renders.
    var scrollReported = 0;
    var scrollPending = false;
    window.addEventListener('scroll', function() {
        scrollReported = window.scrollY || 0;
        if (scrollPending) return;
        scrollPending = true;
        window.requestAnimationFrame(function() {
            scrollPending = false;
            vsc.postMessage({ type: 'scrollY', y: scrollReported });
        });
    });

    document.addEventListener('click', function(ev) {
        var el = ev.target.closest('a');
        if (!el) return;
        var raw = el.getAttribute('href');
        if (!raw) return;
        var lower = raw.toLowerCase();
        if (lower.indexOf('http://') === 0 || lower.indexOf('https://') === 0 || lower.indexOf('mailto:') === 0) return;

        // The [MathJax on/off] link points at *_mj.html; we never navigate there, 
        // instead we flip the extension's MathJax switch and re-render at the exact scroll position.
        var mj = /^([^?#]*?)(?:\.html?)(?:\?[^#]*)?(?:#[^?]*)?$/.exec(raw);
        if (mj && /_mj$/.test(mj[1]) && el.closest('#mathjaxlink')) {
            ev.preventDefault();
            var turnOn = mjState !== 'on';
            vsc.postMessage({ type: 'mathjax', on: turnOn, scrollY: window.scrollY || 0 });
            return;
        }

        ev.preventDefault();

        // Split off the anchor first, then the query (?GAPDocStyle=...), so '#' appearing before '?' cannot corrupt the parsing.
        var h = raw.indexOf('#');
        var beforeHash = h >= 0 ? raw.substring(0, h) : raw;
        var anchor = h >= 0 ? raw.substring(h + 1) : '';
        var q = beforeHash.indexOf('?');
        var filePart = q >= 0 ? beforeHash.substring(0, q) : beforeHash;
        var query = q >= 0 ? beforeHash.substring(q + 1) : '';

        var style = '';
        if (query) {
            var m = query.match(/(?:^|&)GAPDocStyle=([^&]*)/);
            if (m) {
                try { style = decodeURIComponent(m[1]); }
                catch (e) { style = m[1]; }  // malformed URI sequence
            }
        }

        if (filePart) {
            var msg = { type: 'nav', file: filePart, anchor: anchor };
            if (style) msg.style = style;
            vsc.postMessage(msg);
        } else if (anchor) {
            var t = document.getElementById(anchor) || document.getElementsByName(anchor)[0];
            if (t) t.scrollIntoView();
        }
    });

})(ANCHOR_PLACEHOLDER, SCROLLY_PLACEHOLDER);
