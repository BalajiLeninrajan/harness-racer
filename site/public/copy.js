// Copy-the-command interaction. No build step and no framework — the page is
// one screen, so a script tag is the whole client.

(function () {
  var btn = document.getElementById("copy");
  var cmd = document.getElementById("cmd");
  var revert = null;
  // The button's content is two SVGs, so the state has to live on the class
  // and the tip — writing textContent here would delete the glyphs.
  var LABEL = btn.getAttribute("aria-label");

  // navigator.clipboard needs a secure context. That covers production and
  // `wrangler dev` on localhost, but a page opened over plain http:// from a
  // LAN address would have no clipboard at all — hence the textarea fallback.
  function write(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand("copy");
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error("copy failed"));
    });
  }

  btn.addEventListener("click", function () {
    write(btn.getAttribute("data-command")).then(
      function () {
        btn.classList.add("done");
        btn.setAttribute("data-tip", "Copied");
        btn.setAttribute("aria-label", "Copied");
      },
      function () {
        // Selecting the text is the honest fallback: the user copies it. The
        // tip is the only place left to say so, now that the button has no
        // words of its own.
        btn.setAttribute("data-tip", "Press ⌘C");
        btn.setAttribute("aria-label", "Press Command C to copy");
        var range = document.createRange();
        range.selectNodeContents(cmd);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      },
    );

    clearTimeout(revert);
    revert = setTimeout(function () {
      btn.classList.remove("done");
      btn.setAttribute("data-tip", "Copy");
      btn.setAttribute("aria-label", LABEL);
    }, 1800);
  });
})();
