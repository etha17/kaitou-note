/* 編集ページ（自分用）：写真を追加して、サイトに置くファイルを作る */
(function () {
  "use strict";
  var h = NK.h;

  /* 写真の取り込み方。白黒・軽量のほうが通信量が半分ほどで済む。 */
  var MODES = {
    gray: { px: 1400, q: 0.6, gray: true, label: "白黒・軽量" },
    color: { px: 1600, q: 0.72, gray: false, label: "カラー" }
  };
  function photoMode() {
    var v;
    try { v = localStorage.getItem("kaitou-photo-mode"); } catch (e) {}
    return MODES[v] ? v : "gray";
  }
  function togglePhotoMode() {
    try { localStorage.setItem("kaitou-photo-mode", photoMode() === "gray" ? "color" : "gray"); } catch (e) {}
    render();
  }

  var S = {
    phase: "loading",      // loading | unsupported | pick | setup | locked | open
    subjects: [], subjectsDirty: false,
    id: null, name: "",
    key: null, salt: null, iter: NK.ITER,
    data: null,            // {units, answers}
    photos: {},            // pid -> {t, n}   保存済み・未保存の両方
    fresh: {},             // pid -> Uint8Array（まだ書き出していない写真）
    removed: [],           // 消した写真の pid
    urls: {}, pending: {},
    dirty: false, err: "", sel: null, dir: null
  };

  function $(id) { return document.getElementById(id); }
  function answersOf(uid) {
    return S.data.answers.filter(function (a) { return a.unitId === uid; }).sort(NK.byTitle);
  }
  function currentUnit() {
    var u = S.data.units.filter(function (x) { return x.id === S.sel; })[0];
    return u || S.data.units[0] || null;
  }
  function usedBytes() {
    var n = 0, k;
    for (k in S.photos) n += S.photos[k].n || 0;
    return n;
  }
  function touch() { S.dirty = true; render(); }

  var working = false;
  function run(label, fn) {
    if (working) return Promise.resolve();
    working = true;
    NK.showBusy(label);
    return Promise.resolve().then(fn).then(function () { NK.showBusy(""); }, function (e) {
      NK.showBusy((e && e.userMessage) || "うまくいきませんでした。もう一度お試しください。", true);
    }).then(function () { working = false; render(); });
  }

  /* ---------- 写真 ---------- */
  function toBlob(canvas, type, q) {
    return new Promise(function (res) { canvas.toBlob(res, type, q); });
  }
  function toGray(ctx, w, h2) {
    var img, d, i, v;
    try { img = ctx.getImageData(0, 0, w, h2); } catch (e) { return; }
    d = img.data;
    for (i = 0; i < d.length; i += 4) {
      v = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
  }
  function shrink(file) {
    var m = MODES[photoMode()];
    return createImageBitmap(file, { imageOrientation: "from-image" }).then(function (bmp) {
      var s = Math.min(1, m.px / Math.max(bmp.width, bmp.height));
      var c = document.createElement("canvas");
      c.width = Math.round(bmp.width * s);
      c.height = Math.round(bmp.height * s);
      var ctx = c.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      if (m.gray) toGray(ctx, c.width, c.height);
      return toBlob(c, "image/webp", m.q).then(function (out) {
        if (out && out.type === "image/webp") return out;
        return toBlob(c, "image/jpeg", m.q);
      });
    }, function () {
      throw { userMessage: "「" + file.name + "」を読み込めませんでした。JPEG か PNG の写真を選んでください。" };
    }).then(function (blob) {
      if (!blob) throw { userMessage: "写真を変換できませんでした。" };
      return blob;
    });
  }
  function isPdfFile(f) { return f.type === "application/pdf" || /\.pdf$/i.test(f.name || ""); }
  function addPhotos(files) {
    var ids = [], i = 0;
    function next() {
      if (i >= files.length) return Promise.resolve(ids);
      var f = files[i], pdf = isPdfFile(f);
      NK.showBusy((pdf ? "資料" : "写真") + "を取り込み中 " + (i + 1) + " / " + files.length);
      /* PDF は縮小せず、そのまま暗号化して置く */
      return (pdf ? Promise.resolve(f) : shrink(f)).then(function (blob) {
        return blob.arrayBuffer().then(function (buf) {
          return NK.encBytes(S.key, buf).then(function (bytes) {
            var pid = NK.nid("p");
            S.fresh[pid] = bytes;
            S.photos[pid] = pdf
              ? { t: "application/pdf", n: bytes.length, name: f.name || "資料.pdf" }
              : { t: blob.type, n: bytes.length };
            S.urls[pid] = URL.createObjectURL(blob);
            ids.push(pid);
            i++;
            return next();
          });
        });
      });
    }
    return next();
  }
  function photoBytes(pid) {
    if (S.fresh[pid]) return Promise.resolve(S.fresh[pid]);
    return fetch("data/" + S.id + "/" + pid + ".bin").then(function (r) {
      if (!r.ok) throw { userMessage: "サイト上の写真を読み込めませんでした。サイトを公開した状態で開いてください。" };
      return r.arrayBuffer();
    }).then(function (buf) { return new Uint8Array(buf); });
  }
  function photoUrl(pid) {
    if (S.urls[pid]) return Promise.resolve(S.urls[pid]);
    if (!S.pending[pid]) {
      var info = S.photos[pid] || {};
      S.pending[pid] = photoBytes(pid)
        .then(function (bytes) { return NK.decBytes(S.key, bytes); })
        .then(function (plain) {
          S.urls[pid] = URL.createObjectURL(new Blob([plain], { type: info.t || "image/jpeg" }));
          return S.urls[pid];
        });
    }
    return S.pending[pid];
  }
  function dropPhoto(pid) {
    delete S.photos[pid];
    if (S.fresh[pid]) delete S.fresh[pid];
    else if (S.removed.indexOf(pid) < 0) S.removed.push(pid);
    if (S.urls[pid]) { URL.revokeObjectURL(S.urls[pid]); delete S.urls[pid]; }
    delete S.pending[pid];
  }

  /* ---------- 保存（フォルダに直接書く / ZIP で書き出す） ---------- */
  function buildIndex() {
    return NK.encJson(S.key, S.data).then(function (meta) {
      return { v: 1, salt: NK.b64(S.salt), iter: S.iter, meta: meta, photos: S.photos };
    });
  }
  function subjectsJson() {
    return JSON.stringify({ v: 1, subjects: S.subjects }, null, 2) + "\n";
  }
  function canPick() { return typeof window.showDirectoryPicker === "function"; }

  function writeFile(dir, name, data) {
    return dir.getFileHandle(name, { create: true }).then(function (fh) {
      return fh.createWritable().then(function (w) {
        return w.write(data).then(function () { return w.close(); });
      });
    });
  }
  async function saveToFolder() {
    if (!S.dir) {
      var root = await window.showDirectoryPicker({ mode: "readwrite" });
      try { await root.getFileHandle("index.html"); }
      catch (e) { throw { userMessage: "サイトのフォルダではないようです。index.html が入っているフォルダを選んでください。" }; }
      S.dir = root;
    }
    var index = await buildIndex();
    var dataDir = await S.dir.getDirectoryHandle("data", { create: true });
    var sub = await dataDir.getDirectoryHandle(S.id, { create: true });
    var ids = Object.keys(S.fresh), i;
    for (i = 0; i < ids.length; i++) {
      NK.showBusy("写真を保存中 " + (i + 1) + " / " + ids.length);
      await writeFile(sub, ids[i] + ".bin", S.fresh[ids[i]]);
    }
    NK.showBusy("保存中…");
    for (i = 0; i < S.removed.length; i++) {
      try { await sub.removeEntry(S.removed[i] + ".bin"); } catch (e) {}
    }
    await writeFile(dataDir, S.id + ".json", JSON.stringify(index));
    if (S.subjectsDirty) await writeFile(S.dir, "subjects.json", subjectsJson());
    S.fresh = {}; S.removed = []; S.dirty = false; S.subjectsDirty = false;
  }
  function exportZip() {
    return buildIndex().then(function (index) {
      var te = new TextEncoder();
      var files = [{ name: "data/" + S.id + ".json", bytes: te.encode(JSON.stringify(index)) }];
      Object.keys(S.fresh).forEach(function (pid) {
        files.push({ name: "data/" + S.id + "/" + pid + ".bin", bytes: S.fresh[pid] });
      });
      if (S.subjectsDirty) files.push({ name: "subjects.json", bytes: te.encode(subjectsJson()) });
      NKZip.download(NKZip.makeZip(files), "kaitou-" + S.id + ".zip");
      S.fresh = {}; S.removed = []; S.dirty = false; S.subjectsDirty = false;
    });
  }
  function save() {
    if (canPick()) {
      return run("保存中…", saveToFolder).then(function () {
        if (!S.dirty) NK.showBusy("フォルダに保存しました。Netlify にフォルダをドラッグすると公開されます。");
      });
    }
    return run("書き出し中…", exportZip).then(function () {
      if (!S.dirty) NK.showBusy("ZIP を書き出しました。解凍してサイトのフォルダに上書きしてください。");
    });
  }

  /* ---------- 科目 ---------- */
  function newSubjectId() {
    var i, s = "s";
    for (i = 0; i < 6; i++) s += "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)];
    return s;
  }
  function addSubject() {
    NK.openForm({
      title: "科目を追加", submit: "追加する",
      fields: [{ id: "name", label: "科目名", required: true, placeholder: "例：微分積分学第二" }]
    }).then(function (v) {
      if (!v || !v.name) return;
      var s = { id: newSubjectId(), name: v.name };
      S.subjects.push(s);
      S.subjectsDirty = true;
      choose(s);
    });
  }
  function renameSubject() {
    var me = S.subjects.filter(function (x) { return x.id === S.id; })[0];
    if (!me) return;
    NK.openForm({ title: "科目名を変更", fields: [{ id: "name", label: "科目名", required: true, value: me.name }] }).then(function (v) {
      if (!v || !v.name || v.name === me.name) return;
      me.name = v.name; S.name = v.name; S.subjectsDirty = true;
      $("title").textContent = v.name + "（編集）";
      touch();
    });
  }
  function choose(s) {
    S.id = s.id; S.name = s.name;
    S.key = null; S.data = null; S.photos = {}; S.fresh = {}; S.removed = [];
    S.urls = {}; S.pending = {}; S.err = ""; S.sel = null;
    $("title").textContent = s.name + "（編集）";
    document.title = "解答ノート 編集 " + s.name;
    S.phase = "loading";
    render();
    fetch("data/" + s.id + ".json", { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("missing");
      return r.json();
    }).then(function (index) {
      if (!index || !index.salt || !index.meta) throw new Error("missing");
      S.index = index;
      S.salt = NK.unb64(index.salt);
      S.iter = index.iter || NK.ITER;
      S.photos = index.photos || {};
      S.phase = "locked";
      render();
      return NK.recallKey(s.id, index.salt).then(function (key) {
        if (!key) return;
        return NK.decJson(key, index.meta).then(function (data) {
          S.data = { units: data.units || [], answers: data.answers || [] };
          S.key = key; S.phase = "open";
        }).catch(function () { NK.forgetKey(s.id); });
      });
    }).catch(function () {
      if (S.phase === "loading") S.phase = "setup";
    }).then(render);
  }

  /* ---------- 合言葉 ---------- */
  function checkNewPass(a, b) {
    a = NK.cleanPass(a);
    if (a.length < 8) return "合言葉は8文字以上にしてください。";
    if (a !== NK.cleanPass(b)) return "2回の入力が一致しません。";
    return "";
  }
  function unlock(pass) {
    S.err = "";
    NK.showBusy("確認中…");
    NK.deriveKey(pass, S.salt, S.iter).then(function (key) {
      return NK.decJson(key, S.index.meta).then(function (data) {
        S.data = { units: data.units || [], answers: data.answers || [] };
        S.key = key; S.phase = "open";
        NK.showBusy("");
        return NK.rememberKey(S.id, S.salt, key);
      });
    }).catch(function () {
      NK.showBusy("");
      S.err = "合言葉が違います。";
    }).then(render);
  }
  function startFresh(pass) {
    return run("準備中…", function () {
      S.salt = crypto.getRandomValues(new Uint8Array(16));
      S.iter = NK.ITER;
      return NK.deriveKey(pass, S.salt, S.iter).then(function (key) {
        S.key = key;
        S.data = { units: [{ id: NK.nid("u"), name: "単元1（名前を変更してください）" }], answers: [] };
        S.photos = {}; S.fresh = {}; S.removed = [];
        S.phase = "open"; S.dirty = true;
        return NK.rememberKey(S.id, S.salt, key);
      });
    });
  }
  function changePass() {
    NK.openForm({
      title: "合言葉を変更",
      message: "変更して保存すると、前の合言葉では開けなくなります。写真をすべて暗号化し直すので、枚数が多いと時間がかかります。",
      submit: "変更する",
      fields: [
        { id: "p1", label: "新しい合言葉（8文字以上）", type: "password", required: true },
        { id: "p2", label: "もう一度入力", type: "password", required: true }
      ]
    }).then(function (v) {
      if (!v) return;
      var bad = checkNewPass(v.p1, v.p2);
      if (bad) { NK.showBusy(bad, true); return; }
      run("合言葉を変更中…", async function () {
        var salt = crypto.getRandomValues(new Uint8Array(16));
        var key = await NK.deriveKey(v.p1, salt, NK.ITER);
        var ids = Object.keys(S.photos), next = {}, info = {}, i;
        for (i = 0; i < ids.length; i++) {
          NK.showBusy("写真を暗号化し直しています " + (i + 1) + " / " + ids.length);
          var plain = await NK.decBytes(S.key, await photoBytes(ids[i]));
          var bytes = await NK.encBytes(key, plain);
          next[ids[i]] = bytes;
          info[ids[i]] = { t: (S.photos[ids[i]] || {}).t, n: bytes.length };
        }
        S.fresh = next; S.photos = info; S.removed = [];
        S.key = key; S.salt = salt; S.iter = NK.ITER;
        S.dirty = true;
        await NK.rememberKey(S.id, salt, key);
      });
    });
  }

  /* ---------- 単元と解答 ---------- */
  function addUnit() {
    NK.openForm({ title: "単元を追加", submit: "追加する", fields: [{ id: "name", label: "単元名", required: true, placeholder: "例：第3回 重積分" }] }).then(function (v) {
      if (!v || !v.name) return;
      var id = NK.nid("u");
      S.data.units.push({ id: id, name: v.name });
      S.dirty = true;
      select(id);
    });
  }
  function renameUnit(u) {
    NK.openForm({ title: "単元名を変更", fields: [{ id: "name", label: "単元名", required: true, value: u.name }] }).then(function (v) {
      if (!v || !v.name || v.name === u.name) return;
      u.name = v.name; touch();
    });
  }
  function deleteUnit(u) {
    var as = answersOf(u.id);
    NK.confirmDelete("単元「" + u.name + "」", as.length ? "この単元の解答 " + as.length + " 件と写真も消えます。" : null).then(function (v) {
      if (!v) return;
      as.forEach(function (a) { (a.photos || []).forEach(dropPhoto); });
      (u.docs || []).forEach(dropPhoto);
      S.data.answers = S.data.answers.filter(function (a) { return a.unitId !== u.id; });
      S.data.units = S.data.units.filter(function (x) { return x.id !== u.id; });
      touch();
    });
  }
  function infoOf(pid) { return S.photos[pid] || {}; }
  function docCard(pid, u) {
    var info = infoOf(pid);
    return NK.fileCard({
      name: info.name || "資料.pdf",
      size: info.n,
      load: function () { return photoUrl(pid); },
      tool: h("button", {
        class: "icon danger", type: "button", text: "資料を削除",
        on: { click: function () { removeDoc(u, pid); } }
      })
    });
  }
  function addDoc(u) {
    pickOne().then(function (file) {
      if (!file) return;
      run("資料を取り込み中…", function () {
        return addPhotos([file]).then(function (ids) {
          u.docs = (u.docs || []).concat(ids);
          S.dirty = true;
        });
      });
    });
  }
  function removeDoc(u, pid) {
    NK.confirmDelete("資料「" + (infoOf(pid).name || "資料") + "」").then(function (v) {
      if (!v) return;
      u.docs = (u.docs || []).filter(function (p) { return p !== pid; });
      dropPhoto(pid);
      S.dirty = true;
      render();
    });
  }

  function addAnswer(u) {
    NK.openForm({
      title: "解答を追加", submit: "追加する",
      fields: [
        { id: "title", label: "問題名", required: true, placeholder: "例：問3 (2)" },
        { id: "files", label: "解答の写真", type: "files", required: true, help: "複数枚まとめて選べます。" },
        { id: "note", label: "メモ（任意）", type: "textarea", placeholder: "例：(2) は置換積分で解いた" }
      ]
    }).then(function (v) {
      if (!v || !v.title || !v.files.length) return;
      run("写真を取り込み中…", function () {
        return addPhotos(v.files).then(function (ids) {
          var now = Date.now();
          S.data.answers.push({ id: NK.nid("a"), unitId: u.id, title: v.title, note: v.note, photos: ids, rev: 0, createdAt: now, updatedAt: now });
          S.dirty = true;
        });
      });
    });
  }
  function editAnswer(a) {
    NK.openForm({
      title: "問題名とメモを編集",
      fields: [
        { id: "title", label: "問題名", required: true, value: a.title },
        { id: "note", label: "メモ（任意）", type: "textarea", value: a.note }
      ]
    }).then(function (v) {
      if (!v || !v.title) return;
      if (v.title === a.title && v.note === (a.note || "")) return;
      if (v.note !== (a.note || "")) a.updatedAt = Date.now();
      a.title = v.title; a.note = v.note; touch();
    });
  }
  function revise(a) { a.rev = (a.rev || 0) + 1; a.updatedAt = Date.now(); S.dirty = true; }
  function pickOne() {
    return new Promise(function (resolve) {
      var p = $("pick");
      p.value = "";
      p.onchange = function () { resolve(p.files[0] || null); };
      p.oncancel = function () { resolve(null); };
      p.click();
    });
  }
  function replacePhoto(a, oldId) {
    pickOne().then(function (file) {
      if (!file) return;
      run("写真を取り込み中…", function () {
        return addPhotos([file]).then(function (ids) {
          a.photos = a.photos.map(function (p) { return p === oldId ? ids[0] : p; });
          dropPhoto(oldId);
          revise(a);
        });
      });
    });
  }
  function addPhoto(a) {
    pickOne().then(function (file) {
      if (!file) return;
      run("写真を取り込み中…", function () {
        return addPhotos([file]).then(function (ids) {
          a.photos = a.photos.concat(ids);
          revise(a);
        });
      });
    });
  }
  function removePhoto(a, pid) {
    NK.confirmDelete("この写真").then(function (v) {
      if (!v) return;
      a.photos = a.photos.filter(function (p) { return p !== pid; });
      dropPhoto(pid);
      revise(a);
      render();
    });
  }
  function deleteAnswer(a) {
    NK.confirmDelete("解答「" + a.title + "」", "写真も一緒に消えます。").then(function (v) {
      if (!v) return;
      (a.photos || []).forEach(dropPhoto);
      S.data.answers = S.data.answers.filter(function (x) { return x.id !== a.id; });
      touch();
    });
  }

  /* ---------- 表示 ---------- */
  function select(uid) {
    S.sel = uid;
    $("nav").classList.remove("open");
    $("navtoggle").setAttribute("aria-expanded", "false");
    render();
  }
  function renderGate() {
    var gate = $("gate"), card = h("div", { class: "card" });
    gate.textContent = "";
    if (S.phase === "unsupported") {
      card.appendChild(h("h2", { text: "このブラウザでは編集できません" }));
      card.appendChild(h("p", { text: "パソコンの Chrome か Edge で開いてください。" }));
    } else if (S.phase === "loading") {
      card.appendChild(h("h2", { text: "読み込み中…" }));
    } else if (S.phase === "pick") {
      card.appendChild(h("h2", { text: "科目を選ぶ" }));
      card.appendChild(h("p", { text: "編集する科目を選んでください。" }));
      var list = h("ul", { class: "subjects" });
      S.subjects.forEach(function (s) {
        list.appendChild(h("li", { class: "subject" },
          h("a", { href: "#", on: { click: function (ev) { ev.preventDefault(); choose(s); } } },
            h("span", { class: "name", text: s.name }),
            h("span", { class: "go", text: "編集する →" }))));
      });
      card.appendChild(list);
      card.appendChild(h("button", { class: "add", type: "button", text: "＋ 科目を追加", on: { click: addSubject } }));
    } else if (S.phase === "setup") {
      var n1 = h("input", { id: "np1", type: "password", autocomplete: "new-password", required: "required" });
      var n2 = h("input", { id: "np2", type: "password", autocomplete: "new-password", required: "required" });
      card.appendChild(h("form", { on: { submit: function (ev) {
        ev.preventDefault();
        S.err = checkNewPass(n1.value, n2.value);
        if (S.err) { render(); return; }
        startFresh(n1.value);
      } } },
        h("h2", { text: "「" + S.name + "」の合言葉を決める" }),
        h("p", { text: "この合言葉を知っている人だけが、この科目の解答を見られます。短い単語ひとつではなく、長めの言葉の組み合わせにしてください。" }),
        h("div", { class: "field" }, h("label", { for: "np1", text: "合言葉（8文字以上）" }), n1),
        h("div", { class: "field" }, h("label", { for: "np2", text: "もう一度入力" }), n2),
        h("button", { class: "primary", type: "submit", text: "この合言葉で始める" }),
        h("p", { class: "err", role: "alert", text: S.err })));
      card.appendChild(h("button", { class: "icon", type: "button", text: "← 科目を選び直す", on: { click: back } }));
    } else {
      var input = h("input", { id: "pass", type: "password", autocomplete: "current-password", required: "required" });
      card.appendChild(h("form", { on: { submit: function (ev) { ev.preventDefault(); unlock(input.value); } } },
        h("h2", { text: "「" + S.name + "」の合言葉を入力" }),
        h("div", { class: "field" }, h("label", { for: "pass", text: "合言葉" }), input),
        h("button", { class: "primary", type: "submit", text: "開く" }),
        h("p", { class: "err", role: "alert", text: S.err })));
      card.appendChild(h("button", { class: "icon", type: "button", text: "← 科目を選び直す", on: { click: back } }));
    }
    gate.appendChild(card);
  }
  function back() {
    if (S.dirty && !confirm("保存していない変更があります。科目を選び直すと失われます。よろしいですか？")) return;
    S.phase = "pick"; S.dirty = false; S.id = null;
    $("title").textContent = "解答ノート 編集";
    render();
  }
  function renderNav(cur) {
    var nav = $("nav"), now = Date.now(), list = h("ul", { class: "units" });
    nav.textContent = "";
    S.data.units.forEach(function (u) {
      var as = answersOf(u.id);
      var fresh = as.some(function (a) { return now - (a.updatedAt || 0) < 48 * 3600 * 1000; });
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
    nav.appendChild(h("section", null, h("div", { class: "course-head" }, h("h2", { text: "単元" })), list,
      h("button", { class: "add", type: "button", text: "＋ 単元を追加", on: { click: addUnit } })));
    nav.appendChild(h("div", { class: "side-tools" },
      h("div", { class: "meter", text: "写真 " + Object.keys(S.photos).length + "枚 ・ " + NK.mb(usedBytes()) }),
      h("button", { class: "icon", type: "button", text: "写真の画質：" + MODES[photoMode()].label, on: { click: togglePhotoMode } }),
      h("button", { class: "icon", type: "button", text: "科目名を変更", on: { click: renameSubject } }),
      h("button", { class: "icon", type: "button", text: "合言葉を変更", on: { click: changePass } }),
      h("button", { class: "icon", type: "button", text: "← 科目を選び直す", on: { click: back } })));
    $("navlabel").textContent = cur ? cur.name : "単元";
  }
  function renderMain(cur) {
    var main = $("main");
    main.textContent = "";
    if (!cur) {
      main.appendChild(h("div", { class: "empty" }, h("strong", { text: "まだ単元がありません" }), "「＋ 単元を追加」から単元を作ってください。"));
      return;
    }
    var as = answersOf(cur.id);
    var last = as.reduce(function (m, a) { return Math.max(m, a.updatedAt || 0); }, 0);
    var docs = cur.docs || [];
    main.appendChild(h("div", { class: "unit-title" },
      h("div", { class: "grow" },
        h("p", { class: "crumb", text: S.name }),
        h("h2", { text: cur.name }),
        h("p", { class: "meta", text: as.length + "問" + (docs.length ? " ・ 資料" + docs.length + "件" : "") + (last ? " ・ 最終更新 " + NK.fmt(last) : "") })),
      h("button", { class: "icon", type: "button", text: "単元名を変更", on: { click: function () { renameUnit(cur); } } }),
      h("button", { class: "icon danger", type: "button", text: "単元を削除", on: { click: function () { deleteUnit(cur); } } }),
      h("button", { class: "ghost", type: "button", text: "＋ 資料（PDF）を追加", on: { click: function () { addDoc(cur); } } }),
      h("button", { class: "primary", type: "button", text: "＋ 解答を追加", on: { click: function () { addAnswer(cur); } } })));
    if (docs.length) {
      var box = h("div", { class: "docs" }, h("h3", { text: "この単元の資料" }));
      docs.forEach(function (pid) { box.appendChild(docCard(pid, cur)); });
      main.appendChild(box);
    }
    if (!as.length) {
      main.appendChild(h("div", { class: "empty" }, h("strong", { text: "この単元にはまだ解答がありません" }),
        "「＋ 解答を追加」で問題名を入れて写真を選び、最後に下の「保存する」を押してください。"));
      return;
    }
    var wrap = h("div", { class: "answers" });
    as.forEach(function (a) {
      var revised = (a.rev || 0) > 0;
      var photos = h("div", { class: "photos" });
      (a.photos || []).forEach(function (pid, i) {
        if (NK.isPdf(infoOf(pid))) {
          photos.appendChild(NK.fileCard({
            name: infoOf(pid).name || "資料.pdf",
            size: infoOf(pid).n,
            load: function () { return photoUrl(pid); },
            tool: h("button", { class: "icon danger", type: "button", text: "削除", on: { click: function () { removePhoto(a, pid); } } })
          }));
          return;
        }
        var img = h("img", { alt: a.title + " の解答 " + (i + 1) });
        photoUrl(pid).then(function (u) { img.src = u; }, function () { img.alt = "写真を読み込めませんでした"; });
        photos.appendChild(h("figure", { class: "photo" },
          h("button", {
            class: "view", type: "button", "aria-label": a.title + " の写真 " + (i + 1) + " を拡大",
            on: { click: function () { if (img.src) NK.lightbox(img.src); } }
          }, img),
          h("div", { class: "tools" },
            h("button", { class: "icon", type: "button", text: "この写真を差し替え", on: { click: function () { replacePhoto(a, pid); } } }),
            h("button", { class: "icon danger", type: "button", text: "写真を削除", on: { click: function () { removePhoto(a, pid); } } }))));
      });
      wrap.appendChild(h("article", { class: "answer" + (revised ? " revised" : "") },
        h("div", { class: "answer-head" },
          h("h3", { text: a.title }),
          revised ? h("span", { class: "badge", text: "修正 " + a.rev + "回" }) : null,
          h("span", { class: "stamp", text: (revised ? "更新 " : "追加 ") + NK.fmt(a.updatedAt) })),
        photos,
        a.note ? h("p", { class: "note", text: a.note }) : null,
        h("div", { class: "answer-tools" },
          h("button", { class: "icon", type: "button", text: "＋ 写真を追加", on: { click: function () { addPhoto(a); } } }),
          h("button", { class: "icon", type: "button", text: "問題名・メモを編集", on: { click: function () { editAnswer(a); } } }),
          h("button", { class: "icon danger", type: "button", text: "解答を削除", on: { click: function () { deleteAnswer(a); } } }))));
    });
    main.appendChild(wrap);
  }
  function renderSaveBar() {
    var bar = $("savebar");
    if (S.phase !== "open" || !S.dirty) {
      if (bar) bar.remove();
      document.body.classList.remove("has-savebar");
      return;
    }
    if (bar) return;
    document.body.classList.add("has-savebar");
    document.body.appendChild(h("div", { id: "savebar" },
      h("span", { text: "保存していない変更があります" }),
      h("button", {
        class: "primary", type: "button",
        text: canPick() ? "サイトのフォルダに保存する" : "ZIP で書き出す",
        on: { click: save }
      })));
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
      $("tag").hidden = !open;
      renderSaveBar();
      if (!open) { renderGate(); return; }
      var cur = currentUnit();
      renderNav(cur);
      renderMain(cur);
    });
  }

  /* ---------- 起動 ---------- */
  $("pick").setAttribute("accept", "image/*,application/pdf");
  $("navtoggle").addEventListener("click", function () {
    var o = $("nav").classList.toggle("open");
    this.setAttribute("aria-expanded", o ? "true" : "false");
  });
  window.addEventListener("beforeunload", function (ev) {
    if (S.dirty) { ev.preventDefault(); ev.returnValue = ""; }
  });

  if (!NK.supported()) { S.phase = "unsupported"; render(); }
  else {
    render();
    NK.loadSubjects().then(function (subjects) {
      S.subjects = subjects;
      S.phase = "pick";
      var want = new URLSearchParams(location.search).get("s");
      var me = subjects.filter(function (x) { return x.id === want; })[0];
      if (me) choose(me); else render();
    });
  }
})();
