/** The chooser shim for chooser.html.
 *  It seeds the GAPDocStyle cookie.
 *  It sets the radio states from the style value.
 *  It overrides f and resetf to build the back link.
 *  STYLE_PLACEHOLDER is the escaped style value.
 *  BACK_PLACEHOLDER is the escaped back target.
 */

(function(){
  try { document.cookie = "GAPDocStyle=" + STYLE_PLACEHOLDER + ";Path=/"; } catch(e) {}
  window.__GAP_HELP_BACK = BACK_PLACEHOLDER;
  function applyStyle(style) {
    var a = document.getElementsByName("backLINK")[0];
    if (!a || !window.__GAP_HELP_BACK) return;
    // Keep the query even for default so the extension can clear the style state.
    a.href = window.__GAP_HELP_BACK + (style ? "?GAPDocStyle=" + style : "");
  }
  window.f = function() { try { applyStyle(window.getstyle()); } catch(e) {} };
  window.resetf = function() { applyStyle("default"); };
  document.addEventListener("DOMContentLoaded", function() {
    var want = (STYLE_PLACEHOLDER || "").split(",");
    var chform = document.forms[0].elements;
    // Group the radios by name.
    // A group with a matched value shows that value.
    // A group without a matched value shows its empty default value.
    var groups = {};
    for (var i = 0; i < chform.length; i++) {
      if (chform[i].type === "radio") {
        var name = chform[i].name;
        if (!groups[name]) groups[name] = [];
        groups[name].push(chform[i]);
      }
    }
    for (var g in groups) {
      var group = groups[g];
      var hasMatch = false;
      for (var k = 0; k < group.length; k++) {
        if (want.indexOf(group[k].value) > -1) { hasMatch = true; break; }
      }
      for (var j = 0; j < group.length; j++) {
        if (hasMatch) {
          group[j].checked = want.indexOf(group[j].value) > -1;
        } else {
          group[j].checked = group[j].value === "";
        }
      }
    }
    // chooser.html calls initform and f before DOMContentLoaded.
    // The back link may already be built from the HTML default.
    // Rebuild it here.
    try { window.f(); } catch(e) {}

    // Reset restores the HTML default which conflicts with our system semantics.
    // Intercept it, set all radios to their empty defaults.
    // Rebuild the back link as default.
    var form = document.forms[0];
    if (form) {
      form.addEventListener("reset", function(ev) {
        ev.preventDefault();
        var els = form.elements;
        for (var j = 0; j < els.length; j++) {
          if (els[j].type === "radio") {
            els[j].checked = els[j].value === "";
          }
        }
        window.resetf();
      });
    }
  });
})();
