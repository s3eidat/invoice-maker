/* Invoice Maker — everything is computed and stored locally (localStorage via S3.store). */
(function () {
  "use strict";
  var $ = S3.$, $$ = S3.$$, h = S3.h;
  var CUR = ["USD", "EUR", "GBP", "JOD", "SAR", "AED", "EGP", "KWD", "QAR", "BHD", "OMR", "IQD", "LBP", "MAD", "TND", "DZD",
    "TRY", "INR", "PKR", "CAD", "AUD", "NZD", "JPY", "CNY", "CHF", "SEK", "NOK", "DKK", "PLN", "ZAR", "BRL", "MXN", "SGD"];
  var KEY = "invoice.all", CUR_KEY = "invoice.cur";
  var list = [], cur = null;

  // ---------- pure logic (tested in S3_SELFTEST) ----------
  function digits(c) {
    try { return new Intl.NumberFormat("en", { style: "currency", currency: c }).resolvedOptions().maximumFractionDigits; }
    catch (e) { return 2; }
  }
  // Half-up rounding to d decimals without float drift (1.005 -> 1.01).
  function round(n, d) {
    if (!isFinite(n)) return 0;
    var s = n < 0 ? -1 : 1, a = +Math.abs(n).toPrecision(12), str = String(a); // toPrecision drops float noise: 1.72549999… → 1.7255
    if (/e/i.test(str)) return s * Math.round(a * Math.pow(10, d)) / Math.pow(10, d);
    return s * Number(Math.round(Number(str + "e" + d)) + "e-" + d);
  }
  function num(v) { var n = typeof v === "number" ? v : parseFloat(v); return isFinite(n) ? n : 0; }
  function pct(v) { return Math.min(100, Math.max(0, num(v))); }

  // Each line: gross = qty×price, discount and tax are rounded per line to the currency's minor unit.
  function calc(inv) {
    var d = digits(inv.currency), sub = 0, disc = 0, tax = 0, rates = {};
    var lines = inv.items.map(function (it) {
      var gross = round(num(it.qty) * num(it.price), d);
      var dc = round(gross * pct(it.disc) / 100, d);
      var net = round(gross - dc, d);
      var tx = round(net * pct(it.tax) / 100, d);
      sub += gross; disc += dc; tax += tx;
      if (pct(it.tax)) rates[pct(it.tax)] = round((rates[pct(it.tax)] || 0) + tx, d);
      return { gross: gross, disc: dc, net: net, tax: tx };
    });
    sub = round(sub, d); disc = round(disc, d); tax = round(tax, d);
    return { d: d, lines: lines, sub: sub, disc: disc, tax: tax, rates: rates, total: round(sub - disc + tax, d) };
  }

  function nextNumber(s) {
    var m = /^(.*?)(\d+)(\D*)$/.exec(s || "");
    if (!m) return (s || "INV") + "-2";
    var n = String(Number(m[2]) + 1);
    while (n.length < m[2].length) n = "0" + n;
    return m[1] + n + m[3];
  }

  function iso(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function today(add) { var d = new Date(); d.setDate(d.getDate() + (add || 0)); return iso(d); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  // Imported/stored JSON is untrusted: coerce every field to the shape we expect.
  function obj(v) { return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }
  function str(v, max) { return typeof v === "string" ? v.slice(0, max || 400) : typeof v === "number" && isFinite(v) ? String(v) : ""; }
  function date(v) { return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ""; }
  function clean(o) {
    o = obj(o);
    var f = obj(o.from), t = obj(o.to);
    return {
      id: typeof o.id === "string" && /^[a-z0-9]{1,24}$/i.test(o.id) ? o.id : uid(),
      created: typeof o.created === "number" && isFinite(o.created) ? o.created : Date.now(),
      number: str(o.number, 40) || "INV-0001",
      date: date(o.date) || today(),
      due: date(o.due),
      currency: CUR.indexOf(o.currency) >= 0 ? o.currency : "USD",
      accent: typeof o.accent === "string" && /^#[0-9a-f]{6}$/i.test(o.accent) ? o.accent.toLowerCase() : "#0e9f9a",
      paid: o.paid === true,
      logo: typeof o.logo === "string" && o.logo.length < 1500000 && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(o.logo) ? o.logo : "",
      from: { name: str(f.name, 120), email: str(f.email, 120), phone: str(f.phone, 60), address: str(f.address), taxId: str(f.taxId, 60) },
      to: { name: str(t.name, 120), email: str(t.email, 120), address: str(t.address) },
      items: (Array.isArray(o.items) ? o.items : []).slice(0, 300).map(function (it) {
        it = obj(it);
        return { desc: str(it.desc, 500), qty: num(it.qty), price: num(it.price), disc: pct(it.disc), tax: pct(it.tax) };
      }),
      notes: str(o.notes, 4000),
      terms: str(o.terms, 4000)
    };
  }
  function blank(from) {
    var inv = clean({ date: today(), due: today(14), items: [{ qty: 1 }] });
    if (from) {
      inv.from = JSON.parse(JSON.stringify(from.from)); inv.logo = from.logo; inv.currency = from.currency;
      inv.accent = from.accent; inv.terms = from.terms; inv.notes = from.notes;
    }
    return inv;
  }
  function uniqueNumber(base) {
    var n = nextNumber(base);
    while (list.some(function (x) { return x.number === n; })) n = nextNumber(n);
    return n;
  }
  function newest() { return list.reduce(function (a, b) { return !a || b.created > a.created ? b : a; }, null); }

  // ---------- formatting ----------
  var fmtCache = {};
  function money(c, v) {
    var d = digits(c);
    var f = fmtCache[c] || (fmtCache[c] = new Intl.NumberFormat("en-US", { style: "currency", currency: c, minimumFractionDigits: d, maximumFractionDigits: d }));
    return f.format(v);
  }
  function plain(v) { return String(Math.round(v * 1e6) / 1e6); }
  function fmtDate(s) {
    if (!s) return "";
    var p = s.split("-");
    return new Date(+p[0], p[1] - 1, +p[2]).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  }

  // ---------- storage ----------
  function persist() {
    if (S3.store(KEY, list) === undefined) S3.toast("Browser storage is full — export your invoices to keep them safe", "error");
    S3.store(CUR_KEY, cur.id);
  }
  var saveSoon = S3.debounce(function () { persist(); fillPick(); }, 400);

  // ---------- editor ----------
  var editor = $("#editor"), paper = $("#paper"), itemsBox = $("#items");
  function getK(k) { return k.split(".").reduce(function (o, p) { return o[p]; }, cur); }
  function setK(k, v) { var ps = k.split("."), o = cur; while (ps.length > 1) o = o[ps.shift()]; o[ps[0]] = v; }

  function fillPick() {
    var pick = $("#pick");
    pick.textContent = "";
    list.slice().sort(function (a, b) { return b.created - a.created; }).forEach(function (inv) {
      var label = inv.number + " · " + (inv.to.name || "No client") + " · " + money(inv.currency, calc(inv).total) + (inv.paid ? " · paid" : "");
      pick.appendChild(h("option", { value: inv.id, text: label }));
    });
    pick.value = cur.id;
  }
  function fillEditor() {
    $$("[data-k]", editor).forEach(function (el) {
      var v = getK(el.dataset.k);
      if (el.type === "checkbox") el.checked = !!v; else el.value = v == null ? "" : v;
    });
    showLogo();
    drawItems();
  }
  function showLogo() {
    $("#logoImg").hidden = !cur.logo; $("#logoHint").hidden = !!cur.logo; $("#logoRm").hidden = !cur.logo;
    if (cur.logo) $("#logoImg").src = cur.logo; else $("#logoImg").removeAttribute("src");
  }
  function numField(label, f, v, step) {
    return h("label", { "class": "field" }, [label, h("input", { "class": "input", type: "number", inputmode: "decimal", step: step || "any", "data-f": f, value: plain(v) })]);
  }
  function drawItems() {
    itemsBox.textContent = "";
    if (!cur.items.length) itemsBox.appendChild(h("div", { "class": "empty" }, [h("b", { text: "No items yet" }), "Add the first product or service."]));
    var c = calc(cur);
    cur.items.forEach(function (it, i) {
      itemsBox.appendChild(h("div", { "class": "item", "data-i": i }, [
        h("div", { "class": "item-top" }, [
          h("label", { "class": "field grow" }, ["Description", h("input", { "class": "input", "data-f": "desc", dir: "auto", maxlength: "500", value: it.desc, placeholder: "Product or service" })]),
          h("button", { "class": "btn ghost icon small", "data-del": "", "aria-label": "Remove item " + (i + 1), title: "Remove item", html: S3.icon("trash") })
        ]),
        h("div", { "class": "item-nums" }, [
          numField("Qty", "qty", it.qty), numField("Unit price", "price", it.price),
          numField("Disc %", "disc", it.disc), numField("Tax %", "tax", it.tax),
          h("div", { "class": "item-amt" }, [h("span", { "class": "faint", text: "Amount" }), h("b", { "class": "amt", text: money(cur.currency, c.lines[i].net) })])
        ])
      ]));
    });
  }

  editor.addEventListener("input", function (e) {
    var el = e.target;
    if (el.dataset.k) {
      setK(el.dataset.k, el.type === "checkbox" ? el.checked : el.value);
      if (el.dataset.k === "currency") drawItems();
    } else if (el.dataset.f) {
      var row = el.closest(".item"), i = +row.dataset.i, f = el.dataset.f;
      cur.items[i][f] = f === "desc" ? el.value.slice(0, 500) : f === "disc" || f === "tax" ? pct(el.value) : num(el.value);
      $(".amt", row).textContent = money(cur.currency, calc(cur).lines[i].net);
    } else return;
    render(); saveSoon();
  });
  itemsBox.addEventListener("click", function (e) {
    var b = e.target.closest("[data-del]"); if (!b) return;
    cur.items.splice(+b.closest(".item").dataset.i, 1);
    drawItems(); render(); saveSoon();
  });
  $("#addItem").addEventListener("click", function () {
    var last = cur.items[cur.items.length - 1];
    cur.items.push({ desc: "", qty: 1, price: 0, disc: 0, tax: last ? last.tax : 0 });
    drawItems(); render(); saveSoon();
    var inputs = $$(".item:last-child input[data-f=desc]", itemsBox); if (inputs[0]) inputs[0].focus();
  });

  // Logo: downscale to keep localStorage small.
  S3.drop($("#logoDrop"), function (files) {
    var f = files[0];
    if (f.size > 8 * 1024 * 1024) { S3.toast("That image is over 8 MB", "error"); return; }
    S3.readFile(f, "dataurl").then(function (url) {
      var img = new Image();
      img.onload = function () {
        var s = Math.min(1, 480 / Math.max(img.width, img.height)), cv = document.createElement("canvas");
        cv.width = Math.max(1, Math.round(img.width * s)); cv.height = Math.max(1, Math.round(img.height * s));
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        cur.logo = cv.toDataURL("image/png"); showLogo(); render(); saveSoon();
      };
      img.onerror = function () { S3.toast("Couldn't read that image", "error"); };
      img.src = url;
    });
  }, { accept: "image/png,image/jpeg,image/webp,image/gif", multiple: false });
  $("#logoRm").addEventListener("click", function () { cur.logo = ""; showLogo(); render(); saveSoon(); });

  // ---------- preview ----------
  function lines(text, cls) { return text ? h("div", { "class": cls || "pre", text: text }) : null; }
  function ph(text, fallback, cls) { return h("div", { "class": (cls || "") + (text ? "" : " ph"), text: text || fallback }); }
  function kv(k, v) { return h("div", { "class": "p-kv" }, [h("span", { text: k }), h("b", { text: v })]); }

  function render() {
    var inv = cur, c = calc(inv), m = function (v) { return money(inv.currency, v); };
    var hasDisc = inv.items.some(function (it) { return pct(it.disc) > 0; }), hasTax = inv.items.some(function (it) { return pct(it.tax) > 0; });
    paper.style.setProperty("--ink", inv.accent);
    paper.textContent = "";

    paper.appendChild(h("header", { "class": "p-head" }, [
      h("div", { "class": "p-from" }, [
        inv.logo ? h("img", { "class": "p-logo", src: inv.logo, alt: "" }) : null,
        ph(inv.from.name, "Your business", "p-biz"),
        lines(inv.from.address),
        lines([inv.from.email, inv.from.phone].filter(Boolean).join("  ·  ")),
        inv.from.taxId ? lines("Tax ID: " + inv.from.taxId) : null
      ]),
      h("div", { "class": "p-meta" }, [
        h("div", { "class": "p-title", text: "Invoice" }),
        kv("Invoice no.", inv.number), kv("Issue date", fmtDate(inv.date)), inv.due ? kv("Due date", fmtDate(inv.due)) : null
      ])
    ]));

    paper.appendChild(h("section", { "class": "p-parties" }, [
      h("div", null, [h("div", { "class": "p-label", text: "Bill to" }), ph(inv.to.name, "Client name", "p-client"), lines(inv.to.address), lines(inv.to.email)]),
      h("div", { "class": "p-due" }, [h("div", { "class": "p-label", text: inv.paid ? "Amount paid" : "Amount due" }), h("div", { "class": "p-big", text: m(c.total) }),
        inv.paid ? h("div", { "class": "p-stamp", text: "Paid" }) : null])
    ]));

    var head = ["Description", "Qty", "Unit price"].concat(hasDisc ? ["Disc."] : [], hasTax ? ["Tax"] : [], ["Amount"]);
    var tbody = h("tbody");
    inv.items.forEach(function (it, i) {
      var cells = [h("td", { dir: "auto", text: it.desc || "—" }), h("td", { text: plain(num(it.qty)) }), h("td", { text: m(num(it.price)) })];
      if (hasDisc) cells.push(h("td", { text: pct(it.disc) ? plain(pct(it.disc)) + "%" : "—" }));
      if (hasTax) cells.push(h("td", { text: pct(it.tax) ? plain(pct(it.tax)) + "%" : "—" }));
      cells.push(h("td", { text: m(c.lines[i].net) }));
      tbody.appendChild(h("tr", null, cells));
    });
    if (!inv.items.length) tbody.appendChild(h("tr", null, [h("td", { colspan: String(head.length), "class": "ph", text: "Add items in the form" })]));
    paper.appendChild(h("table", { "class": "p-items" }, [h("thead", null, [h("tr", null, head.map(function (t) { return h("th", { text: t }); }))]), tbody]));

    var tot = h("div", { "class": "p-totals" }, [h("div", { "class": "p-row" }, [h("span", { text: "Subtotal" }), h("span", { text: m(c.sub) })])]);
    if (c.disc) tot.appendChild(h("div", { "class": "p-row" }, [h("span", { text: "Discount" }), h("span", { text: "−" + m(c.disc) })]));
    Object.keys(c.rates).sort(function (a, b) { return a - b; }).forEach(function (r) {
      tot.appendChild(h("div", { "class": "p-row" }, [h("span", { text: "Tax " + plain(+r) + "%" }), h("span", { text: m(c.rates[r]) })]));
    });
    tot.appendChild(h("div", { "class": "p-row p-total" }, [h("span", { text: "Total " + inv.currency }), h("span", { text: m(c.total) })]));
    paper.appendChild(tot);

    var foot = h("footer", { "class": "p-foot" });
    if (inv.notes) foot.appendChild(h("div", null, [h("div", { "class": "p-label", text: "Notes" }), lines(inv.notes)]));
    if (inv.terms) foot.appendChild(h("div", null, [h("div", { "class": "p-label", text: "Payment terms" }), lines(inv.terms)]));
    paper.appendChild(foot);

    $("#stats").innerHTML = "";
    [["Subtotal", m(c.sub)], ["Tax", m(c.tax)], ["Total", m(c.total)], ["Invoices saved", String(list.length)]].forEach(function (s) {
      $("#stats").appendChild(h("div", { "class": "stat" }, [h("b", { text: s[1] }), h("span", { text: s[0] })]));
    });
  }

  // ---------- actions ----------
  function open(inv) { cur = inv; fillEditor(); render(); fillPick(); persist(); }
  $("#pick").addEventListener("change", function (e) {
    var inv = list.filter(function (x) { return x.id === e.target.value; })[0]; if (inv) open(inv);
  });
  $("#new").addEventListener("click", function () {
    var inv = blank(cur); inv.number = uniqueNumber((newest() || cur).number);
    list.push(inv); open(inv); S3.toast("New invoice " + inv.number);
  });
  $("#dup").addEventListener("click", function () {
    var inv = clean(JSON.parse(JSON.stringify(cur)));
    var gap = cur.due && cur.date ? Math.round((new Date(cur.due) - new Date(cur.date)) / 864e5) : 14;
    inv.id = uid(); inv.created = Date.now(); inv.number = uniqueNumber((newest() || cur).number);
    inv.date = today(); inv.due = cur.due ? today(gap) : ""; inv.paid = false;
    list.push(inv); open(inv); S3.toast("Duplicated as " + inv.number); S3.done();
  });
  $("#del").addEventListener("click", function () {
    var gone = cur, at = list.indexOf(gone);
    list.splice(at, 1);
    if (!list.length) list.push(blank(gone));
    open(newest());
    var t = S3.toast("Deleted " + gone.number + " ");
    t.appendChild(h("button", { "class": "btn small", text: "Undo", onclick: function () { list.push(gone); open(gone); t.remove(); } }));
  });
  $("#print").addEventListener("click", function () { persist(); window.print(); S3.done(); });
  $("#exp").addEventListener("click", function () {
    persist();
    S3.download(JSON.stringify({ app: "s3-invoice-maker", version: 1, invoices: list }, null, 2), "invoices.json", "application/json");
    S3.done();
  });
  $("#imp input").addEventListener("change", function (e) {
    var f = e.target.files[0]; e.target.value = ""; if (!f) return;
    if (f.size > 20 * 1024 * 1024) { S3.toast("That file is too large", "error"); return; }
    S3.readFile(f, "text").then(function (t) {
      var data;
      try { data = JSON.parse(t); } catch (err) { S3.toast("Not valid JSON", "error"); return; }
      var arr = Array.isArray(data) ? data : data && Array.isArray(data.invoices) ? data.invoices : data && data.items ? [data] : null;
      if (!arr || !arr.length) { S3.toast("No invoices found in that file", "error"); return; }
      var added = 0;
      arr.slice(0, 2000).forEach(function (raw) {
        var inv = clean(raw);
        if (list.some(function (x) { return x.id === inv.id; })) inv.id = uid();
        list.push(inv); added++;
      });
      open(list[list.length - 1]); S3.toast("Imported " + added + " invoice" + (added === 1 ? "" : "s")); S3.done();
    });
  });

  // ---------- boot ----------
  $("#currency").append.apply($("#currency"), CUR.map(function (c) { return h("option", { value: c, text: c }); }));
  list = (Array.isArray(S3.store(KEY)) ? S3.store(KEY) : []).map(clean);
  if (!list.length) list.push(blank());
  var savedId = S3.store(CUR_KEY);
  open(list.filter(function (x) { return x.id === savedId; })[0] || newest());

  window.S3_DEMO = function () {
    var inv = clean({
      number: "INV-0042", date: today(), due: today(14), currency: "USD", accent: "#0e9f9a",
      from: { name: "Northwind Studio", email: "hello@northwind.studio", phone: "+1 555 0142", address: "18 Harbour Street\nPortland, OR 97201", taxId: "US-88-1234567" },
      to: { name: "Blue Fern Café", email: "accounts@bluefern.cafe", address: "220 Elm Avenue\nSeattle, WA 98101" },
      items: [
        { desc: "Brand identity design", qty: 1, price: 1200, tax: 8 },
        { desc: "Menu layout (per page)", qty: 4, price: 85, disc: 10, tax: 8 },
        { desc: "Photography session, 3 hours", qty: 3, price: 120, tax: 8 },
        { desc: "Printing & delivery", qty: 1, price: 64.5 }
      ],
      notes: "Thank you for your business!", terms: "Bank transfer within 14 days. IBAN US00 0000 0000 0000."
    });
    list.push(inv); open(inv);
  };

  window.S3_SELFTEST = function () {
    var c = calc(clean({ currency: "USD", items: [{ qty: 3, price: 19.99, disc: 10, tax: 16 }, { qty: 2, price: 1.005 }] }));
    // 59.97 − 6.00 (5.997) = 53.97 → tax 8.64 (8.6352); 2×1.005 = 2.01
    var ok1 = c.sub === 61.98 && c.disc === 6 && c.tax === 8.64 && c.total === 64.62 && c.lines[0].net === 53.97;
    var j = calc(clean({ currency: "JOD", items: [{ qty: 1, price: 10.1235, tax: 16 }] })); // 10.124 → tax 1.620 (1.61984)
    var y = calc(clean({ currency: "JPY", items: [{ qty: 3, price: 333.5, tax: 10 }] })); // 1001 (1000.5) → tax 100 (100.1)
    var ok2 = j.d === 3 && j.sub === 10.124 && j.tax === 1.62 && j.total === 11.744 && y.d === 0 && y.sub === 1001 && y.total === 1101;
    var ok3 = round(17.255 * 10 / 100, 3) === 1.726 && round(1.005, 2) === 1.01 && round(-2.675, 2) === -2.68 && nextNumber("INV-0099") === "INV-0100" && nextNumber("2026/7a") === "2026/8a" && nextNumber("Draft") === "Draft-2";
    var src = clean({ number: "A-1", currency: "EUR", paid: true, from: { name: "Ünïcode ✓" }, items: [{ desc: "x", qty: 2.5, price: 4, tax: 5, disc: 1 }] });
    var ok4 = JSON.stringify(clean(JSON.parse(JSON.stringify(src)))) === JSON.stringify(src);
    var bad = clean({ items: "nope", logo: "javascript:alert(1)", currency: "<b>", accent: "red", from: { name: { x: 1 } }, date: "2026-13" });
    var ok5 = bad.items.length === 0 && bad.logo === "" && bad.currency === "USD" && bad.accent === "#0e9f9a" && bad.from.name === "" && /^\d{4}-\d{2}-\d{2}$/.test(bad.date);
    var p = clean({ items: [{ disc: 150, tax: -5 }] }).items[0];
    return ok1 && ok2 && ok3 && ok4 && ok5 && p.disc === 100 && p.tax === 0;
  };
})();
