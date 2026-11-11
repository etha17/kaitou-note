/* 科目ページ：合言葉で解答を表示する（読むだけ） */
(function () {
  "use strict";
  var h = NK.h;
  var RECENT = 48 * 3600 * 1000;

  var S = {
    id: null, name: "", index: null, key: null, data: null,
    phase: "loading",    // loading | missing | locked | open | unsupported
    err: "", sel: null, urls: {}, pending: {}
  };

  function $(id) { return document.getElementById(id); }
  function answersOf(uid) {
    return S.data.answers.filter(function (a) { return a.unitId === uid; }).sort(NK.byTitle);
  }
  function currentUnit() {
    var u = S.data.units.filter(function (x) { return x.id === S.sel; })[0];
    return u || S.data.units[0] || null;
  }

  /* ---------- 写真（表示する単元のぶんだけ読み込む） ---------- */
  function photoUrl(pid) {
    if (S.urls[pid]) return Promise.resolve(S.urls[pid]);
    if (!S.pending[pid]) {
      var info = (S.index.photos || {})[pid];
      /* 写真はブラウザに覚えてもらう（no-store を付けない）＝ 2回目以降は通信しない */
      S.pending[pid] = !info ? Promise.reject(new Error("no photo")) :
        fetch("data/" + S.id + "/" + pid + ".bin")
          .then(function (r) { if (!r.ok) throw new Error("fetch"); return r.arrayBuffer(); })
          .then(function (buf) { return NK.decBytes(S.key, new Uint8Array(buf)); })
          .then(function (plain) {
            S.urls[pid] = URL.createObjectURL(new Blob([plain], { type: info.t || "image/jpeg" }));
            return S.urls[pid];
          });
    }
    return S.pending[pid];
  }

  /* ---------- 入室 ---------- */
  function open(key) {
    return NK.decJson(key, S.index.meta).then(function (data) {
      S.data = { units: data.units || [], answers: data.answers || [] };
      S.key = key; S.phase = "open";
    });
  }
  function unlock(pass) {
    S.err = "";
    NK.showBusy("確認中…");
    NK.deriveKey(pass, NK.unb64(S.index.salt), S.index.iter)
      .then(open)
      .then(function () {
        NK.showBusy("");
        return NK.rememberKey(S.id, NK.unb64(S.index.salt), S.key);
      })
      .catch(function () {
        NK.showBusy("");
        S.err = "合言葉が違います。";
      })
      .then(render);
  }
  function lock() {
    NK.forgetKey(S.id);
    Object.keys(S.urls).forEach(function (k) { URL.revokeObjectURL(S.urls[k]); });
    S.urls = {}; S.pending = {}; S.key = null; S.data = null; S.phase = "locked"; S.err = "";
    render();
  }

  /* ---------- 表示 ---------- */
  function select(uid) {
    S.sel = uid;
    try { if (location.hash !== "#" + uid) location.hash = uid; } catch (e) {}
    $("nav").classList.remove("open");
    $("navtoggle").setAttribute("aria-expanded", "false");
    render();
  }

  function renderGate() {
    var gate = $("gate"), card = h("div", { class: "card" });
    gate.textContent = "";
    if (S.phase === "unsupported") {
      card.appendChild(h("h2", { text: "このブラウザでは開けません" }));
      card.appendChild(h("p", { text: "Chrome、Safari、Edge などの新しいブラウザで開いてください。" }));
    } else if (S.phase === "loading") {
      card.appendChild(h("h2", { text: "読み込み中…" }));
      card.appendChild(h("p", { text: "解答データを取得しています。" }));
    } else if (S.phase === "missing") {
      card.appendChild(h("h2", { text: "まだ公開されていません" }));
      card.appendChild(h("p", { text: "この科目の解答はまだ用意されていません。科目一覧に戻ってほかの科目を選んでください。" }));
      card.appendChild(h("a", { href: "index.html", text: "科目一覧へ" }));
    } else {
      var input = h("input", { id: "pass", type: "password", autocomplete: "current-password", required: "required" });
      card.appendChild(h("form", { on: { submit: function (ev) { ev.preventDefault(); unlock(input.value); } } },
        h("h2", { text: "合言葉を入力" }),
        h("p", { text: "教えてもらった合言葉を入れると解答が表示されます。この端末では次回から入力を省けます。" }),
        h("div", { class: "field" }, h("label", { for: "pass", text: "合言葉" }), input),
        h("button", { class: "primary", type: "submit", text: "開く" }),
        h("p", { class: "err", role: "alert", text: S.err })));
    }
    gate.appendChild(card);
  }

  function renderNav(cur) {
    var nav = $("nav"), now = Date.now(), list = h("ul", { class: "units" });
    nav.textContent = "";
    S.data.units.forEach(function (u) {
      var as = answersOf(u.id);
      var fresh = as.some(function (a) { return now - (a.updatedAt || 0) < RECENT; });
      list.appendChild(h("li", null,
        h("button", {
          class: "unit", type: "button",
          "aria-current": cur && cur.id === u.id ? "true" : false,
          on: { click: function () { select(u.id); } }
        },
          h("span", { class: "name", text: u.name }),
          fresh ? h("span", { class: "new", text: "更新" }) : null,
          h("span", { class: "n", text: as.length + "問" }))));
    });
    nav.appendChild(h("section", null, h("div", { class: "course-head" }, h("h2", { text: "単元" })), list));
    nav.appendChild(h("div", { class: "side-tools" },
      h("button", { class: "icon", type: "button", text: "この端末の合言葉を忘れる（ロック）", on: { click: lock } })));
    $("navlabel").textContent = cur ? cur.name : "単元";
  }

  function infoOf(pid) { return (S.index.photos || {})[pid] || {}; }
  function docCard(pid) {
    var info = infoOf(pid);
    return NK.fileCard({
      name: info.name || "資料.pdf",
      size: info.n,
      load: function () { return photoUrl(pid); }
    });
  }

  function renderMain(cur) {
    var main = $("main");
    main.textContent = "";
    if (!cur) {
      main.appendChild(h("div", { class: "empty" }, h("strong", { text: "まだ単元がありません" }), "解答が追加されるとここに表示されます。"));
      return;
    }
    var as = answersOf(cur.id);
    var last = as.reduce(function (m, a) { return Math.max(m, a.updatedAt || 0); }, 0);
    var docs = cur.docs || [];
    main.appendChild(h("div", { class: "unit-title" },
      h("div", { class: "grow" },
        h("p", { class: "crumb", text: S.name }),
        h("h2", { text: cur.name }),
        h("p", { class: "meta", text: as.length + "問" + (docs.length ? " ・ 資料" + docs.length + "件" : "") + (last ? " ・ 最終更新 " + NK.fmt(last) : "") }))));
    if (docs.length) {
      var box = h("div", { class: "docs" }, h("h3", { text: "この単元の資料" }));
      docs.forEach(function (pid) { box.appendChild(docCard(pid)); });
      main.appendChild(box);
    }
    if (!as.length && !docs.length) {
      main.appendChild(h("div", { class: "empty" }, h("strong", { text: "この単元にはまだ解答がありません" }), "解答が追加されるとここに表示されます。"));
      return;
    }
    var wrap = h("div", { class: "answers" });
    as.forEach(function (a) {
      var revised = (a.rev || 0) > 0;
      var photos = h("div", { class: "photos" });
      (a.photos || []).forEach(function (pid, i) {
        if (NK.isPdf(infoOf(pid))) { photos.appendChild(docCard(pid)); return; }
        var img = h("img", { alt: a.title + " の解答 " + (i + 1) });
        var btn = h("button", {
          class: "view", type: "button",
          "aria-label": a.title + " の写真 " + (i + 1) + " を拡大",
          on: { click: function () { if (img.src) NK.lightbox(img.src); } }
        }, img);
        photoUrl(pid).then(function (u) { img.src = u; }, function () { img.alt = "写真を読み込めませんでした"; });
        photos.appendChild(h("figure", { class: "photo" }, btn));
      });
      wrap.appendChild(h("article", { class: "answer" + (revised ? " revised" : "") },
        h("div", { class: "answer-head" },
          h("h3", { text: a.title }),
          revised ? h("span", { class: "badge", text: "修正 " + a.rev + "回" }) : null,
          h("span", { class: "stamp", text: (revised ? "更新 " : "追加 ") + NK.fmt(a.updatedAt) })),
        photos,
        a.note ? h("p", { class: "note", text: a.note }) : null));
    });
    main.appendChild(wrap);
  }

  var queued = false;
  function render() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      var open = S.phase === "open";
      $("gate").hidden = open;
      $("shell").hidden = !open;
      if (!open) { renderGate(); return; }
      var cur = currentUnit();
      renderNav(cur);
      renderMain(cur);
    });
  }

  /* ---------- 起動 ---------- */
  $("navtoggle").addEventListener("click", function () {
    var o = $("nav").classList.toggle("open");
    this.setAttribute("aria-expanded", o ? "true" : "false");
  });
  window.addEventListener("hashchange", function () {
    var v = (location.hash || "").replace(/^#/, "");
    if (v) { S.sel = v; render(); }
  });
  var hash = (location.hash || "").replace(/^#/, "");
  if (hash) S.sel = hash;

  S.id = new URLSearchParams(location.search).get("s") || "";
  if (!NK.supported()) { S.phase = "unsupported"; render(); return; }
  if (!NK.safeId(S.id)) { location.replace("index.html"); return; }

  render();
  NK.loadSubjects().then(function (subjects) {
    var me = subjects.filter(function (x) { return x.id === S.id; })[0];
    S.name = me ? me.name : "";
    if (S.name) {
      document.title = "解答ノート " + S.name;
      $("title").textContent = S.name;
    }
    return fetch("data/" + S.id + ".json", { cache: "no-store" });
  }).then(function (r) {
    if (!r.ok) throw new Error("missing");
    return r.json();
  }).then(function (index) {
    if (!index || !index.salt || !index.meta) throw new Error("missing");
    S.index = index;
    S.phase = "locked";
    render();
    return NK.recallKey(S.id, index.salt).then(function (key) {
      if (!key) return;
      return open(key).catch(function () { NK.forgetKey(S.id); });
    });
  }).catch(function () {
    if (S.phase === "loading") S.phase = "missing";
  }).then(render);
})();
