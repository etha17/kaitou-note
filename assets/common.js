/* 解答ノート — 共通部品：暗号、画面の小道具、入力ダイアログ */
(function (global) {
  "use strict";

  var ITER = 600000;

  /* ---------- base64 ---------- */
  function b64(buf) {
    var u = buf instanceof Uint8Array ? buf : new Uint8Array(buf), s = "", i;
    for (i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function unb64(s) {
    var b = atob(s), u = new Uint8Array(b.length), i;
    for (i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return u;
  }

  /* ---------- 合言葉と暗号 ---------- */
  function cleanPass(p) { return String(p || "").normalize("NFKC").trim(); }

  function deriveKey(pass, salt, iter) {
    return crypto.subtle
      .importKey("raw", new TextEncoder().encode(cleanPass(pass)), "PBKDF2", false, ["deriveKey"])
      .then(function (base) {
        return crypto.subtle.deriveKey(
          { name: "PBKDF2", salt: salt, iterations: iter || ITER, hash: "SHA-256" },
          base, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
      });
  }

  /* 暗号文は「iv(12バイト) + 本体」の形にそろえる */
  function encBytes(key, bytes) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    return crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, bytes).then(function (ct) {
      var out = new Uint8Array(12 + ct.byteLength);
      out.set(iv, 0); out.set(new Uint8Array(ct), 12);
      return out;
    });
  }
  function decBytes(key, u8) {
    return crypto.subtle.decrypt({ name: "AES-GCM", iv: u8.subarray(0, 12) }, key, u8.subarray(12));
  }
  function encJson(key, obj) {
    return encBytes(key, new TextEncoder().encode(JSON.stringify(obj))).then(b64);
  }
  function decJson(key, s) {
    return decBytes(key, unb64(s)).then(function (buf) { return JSON.parse(new TextDecoder().decode(buf)); });
  }

  /* ---------- 画面の小道具 ---------- */
  function h(tag, attrs) {
    var el = document.createElement(tag), k, i, c;
    if (attrs) for (k in attrs) {
      if (k === "text") el.textContent = attrs[k];
      else if (k === "on") { for (var ev in attrs.on) el.addEventListener(ev, attrs.on[ev]); }
      else if (attrs[k] !== false && attrs[k] != null) el.setAttribute(k, attrs[k]);
    }
    for (i = 2; i < arguments.length; i++) {
      c = arguments[i];
      if (c == null || c === false) continue;
      el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return el;
  }
  function nid(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function fmt(t) {
    if (!t) return "";
    var d = new Date(t);
    return (d.getMonth() + 1) + "/" + d.getDate() + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function mb(n) { return (n / 1048576).toFixed(1) + " MB"; }
  function byTitle(a, b) { return String(a.title || "").localeCompare(String(b.title || ""), "ja", { numeric: true }); }
  function safeId(s) { return /^[A-Za-z0-9_-]{1,40}$/.test(s || ""); }

  /* ---------- ダイアログと進行状況の置き場所 ---------- */
  function chrome() {
    if (document.getElementById("nk-busy")) return;
    document.body.appendChild(h("dialog", { id: "nk-form" }, h("form", { id: "nk-formbody", method: "dialog" })));
    document.body.appendChild(h("div", { id: "nk-busy", role: "status", "aria-live": "polite", hidden: "hidden" }));
  }
  var busyTimer = null;
  function showBusy(text, isErr) {
    chrome();
    var b = document.getElementById("nk-busy");
    clearTimeout(busyTimer);
    if (!text) { b.hidden = true; return; }
    b.textContent = text; b.className = isErr ? "err" : ""; b.hidden = false;
    if (isErr) busyTimer = setTimeout(function () { b.hidden = true; }, 9000);
  }

  function openForm(opt) {
    chrome();
    return new Promise(function (resolve) {
      var dlg = document.getElementById("nk-form"), body = document.getElementById("nk-formbody"), inputs = {};
      body.textContent = "";
      body.appendChild(h("h2", { text: opt.title }));
      if (opt.message) body.appendChild(h("p", { text: opt.message }));
      (opt.fields || []).forEach(function (f) {
        var id = "nk-f-" + f.id, input;
        if (f.type === "textarea") { input = h("textarea", { id: id, placeholder: f.placeholder }); input.value = f.value || ""; }
        else if (f.type === "files") input = h("input", { id: id, type: "file", accept: "image/*,application/pdf,.pdf", multiple: "multiple" });
        else if (f.type === "password") input = h("input", { id: id, type: "password", autocomplete: "new-password" });
        else { input = h("input", { id: id, type: "text", placeholder: f.placeholder, maxlength: "80", autocomplete: "off" }); input.value = f.value || ""; }
        if (f.required) input.required = true;
        inputs[f.id] = input;
        body.appendChild(h("div", { class: "field" }, h("label", { for: id, text: f.label }), input, f.help ? h("small", { text: f.help }) : null));
      });
      var done = false;
      function finish(v) { if (done) return; done = true; dlg.close(); resolve(v); }
      body.appendChild(h("div", { class: "dialog-actions" },
        h("button", { type: "button", class: "ghost", text: "やめる", on: { click: function () { finish(null); } } }),
        h("button", { type: "submit", class: "primary" + (opt.danger ? " danger" : ""), text: opt.submit || "決定" })));
      body.onsubmit = function (ev) {
        ev.preventDefault();
        var out = {}, k;
        for (k in inputs) {
          out[k] = inputs[k].type === "file" ? Array.prototype.slice.call(inputs[k].files)
            : inputs[k].type === "password" ? inputs[k].value : inputs[k].value.trim();
        }
        finish(out);
      };
      dlg.oncancel = function () { finish(null); };
      dlg.showModal();
      var first = body.querySelector("input,textarea");
      if (first) first.focus();
    });
  }
  function confirmDelete(what, detail) {
    return openForm({ title: what + "を削除しますか？", message: detail || "この操作は元に戻せません。", submit: "削除する", danger: true });
  }

  /* ---------- PDF の表示 ---------- */
  function isPdf(t) { return t === "application/pdf"; }
  /* urlPromise が解決したら、ページ内に PDF を表示し、新しいタブで開くリンクも付ける */
  function pdfBlock(urlPromise, label) {
    var frame = h("iframe", {
      title: label,
      style: "display:block;width:100%;height:75vh;border:1px solid var(--line);border-radius:6px;background:var(--bg)"
    });
    var link = h("a", { class: "icon", target: "_blank", rel: "noopener", text: "PDF を新しいタブで開く", style: "display:inline-block;margin-top:4px" });
    var fig = h("figure", { class: "photo" }, frame, link);
    urlPromise.then(function (u) { frame.src = u; link.href = u; },
      function () { link.textContent = "PDF を読み込めませんでした"; });
    return fig;
  }

  /* ---------- 写真の拡大表示 ---------- */
  function lightbox(src) {
    var img = h("img", { alt: "", src: src });
    var dlg = h("dialog", { class: "lightbox", "aria-label": "写真を拡大" },
      h("div", { class: "stage" }, img),
      h("button", { class: "close", type: "button", text: "閉じる" }));
    img.addEventListener("click", function (ev) { ev.stopPropagation(); dlg.classList.toggle("zoom"); });
    dlg.addEventListener("click", function () { dlg.close(); });
    dlg.addEventListener("close", function () { dlg.remove(); });
    document.body.appendChild(dlg);
    dlg.showModal();
  }

  /* ---------- 合言葉を端末に覚えておく ---------- */
  function keyStore(id) { return "kaitou-note:" + id; }
  function rememberKey(id, salt, key) {
    return crypto.subtle.exportKey("raw", key).then(function (raw) {
      try { localStorage.setItem(keyStore(id), JSON.stringify({ salt: b64(salt), raw: b64(raw) })); } catch (e) {}
    }).catch(function () {});
  }
  function forgetKey(id) { try { localStorage.removeItem(keyStore(id)); } catch (e) {} }
  function recallKey(id, saltB64) {
    return new Promise(function (resolve) {
      var st;
      try { st = JSON.parse(localStorage.getItem(keyStore(id)) || "null"); } catch (e) { st = null; }
      if (!st || st.salt !== saltB64) return resolve(null);
      crypto.subtle.importKey("raw", unb64(st.raw), { name: "AES-GCM" }, true, ["encrypt", "decrypt"])
        .then(resolve, function () { resolve(null); });
    });
  }

  /* ---------- 科目一覧の読み込み ---------- */
  function loadSubjects() {
    return fetch("subjects.json", { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("subjects");
      return r.json();
    }).then(function (j) {
      var list = (j && j.subjects) || [];
      return list.filter(function (s) { return s && safeId(s.id) && s.name; });
    }, function () { return []; });
  }

  global.NK = {
    ITER: ITER, b64: b64, unb64: unb64, cleanPass: cleanPass, deriveKey: deriveKey,
    encBytes: encBytes, decBytes: decBytes, encJson: encJson, decJson: decJson,
    h: h, nid: nid, fmt: fmt, mb: mb, byTitle: byTitle, safeId: safeId, isPdf: isPdf, pdfBlock: pdfBlock,
    showBusy: showBusy, openForm: openForm, confirmDelete: confirmDelete, lightbox: lightbox,
    rememberKey: rememberKey, forgetKey: forgetKey, recallKey: recallKey, loadSubjects: loadSubjects,
    supported: function () { return !!(global.crypto && crypto.subtle && global.fetch); }
  };
})(window);
