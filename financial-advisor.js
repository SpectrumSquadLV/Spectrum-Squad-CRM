// financial-advisor.js -- Owner-only Financial Center advisor.
//
// Replaces the old ClickUp-backed Financial Center with a plain-English money
// advisor built from uploaded data: bank statements / QuickBooks exports (CSV)
// and the Rethink payroll export (.xlsx). Computes income vs. expenses, budgets
// vs. actuals, a payroll-reconciliation check, a wage-cost simulator, and
// "where you might be losing money" insights. Owner / Super Admin only.
//
// Additive per RULE ZERO: new tables fin_transactions / fin_budgets, routes
// under /api/fin/*. Reuses nothing existing; the ClickUp tables are left alone.

const zlib = require("zlib");

module.exports = function initFinancialAdvisor(ctx) {
  const { dbGet, dbAll, dbRun, nowISO, crypto, readBody, json } = ctx;

  // Spending/earning categories + keyword rules for auto-categorization.
  const CATEGORIES = [
    "Income", "Payroll", "Rent & Utilities", "Software & Subscriptions", "Supplies & Materials",
    "Insurance", "Marketing & Advertising", "Professional Services", "Bank & Card Fees",
    "Travel & Mileage", "Meals & Entertainment", "Taxes", "Office & Equipment", "Other",
  ];
  const RULES = [
    ["Income", /deposit|payment recv|zelle from|remote dep|ach credit|insurance pay|claim|tricare|medicaid|molina|aetna|reimburse|invoice/i],
    ["Payroll", /payroll|gusto|adp|rippling|wage|salary|paychex|direct dep.*payroll|rethink pay/i],
    ["Rent & Utilities", /\brent\b|\blease\b|nv energy|electric|water|gas co|internet|comcast|cox|centurylink|utility|waste/i],
    ["Software & Subscriptions", /google|microsoft|zoom|adobe|slack|clickup|dropbox|notion|quickbooks|intuit|canva|calendly|subscription|saas|openai|anthropic/i],
    ["Supplies & Materials", /amazon|walmart|target|staples|office depot|supplies|materials|therapy|toys|lakeshore/i],
    ["Insurance", /insurance|liability|workers comp|hiscox|next insurance|policy/i],
    ["Marketing & Advertising", /facebook|meta|google ads|indeed|linkedin|advertis|marketing|mailchimp|yelp/i],
    ["Professional Services", /legal|attorney|accountant|cpa|consult|bookkeep|law firm/i],
    ["Bank & Card Fees", /fee|service charge|overdraft|interest charge|nsf|wire fee|atm/i],
    ["Travel & Mileage", /uber|lyft|shell|chevron|gas station|mileage|airline|hotel|parking/i],
    ["Meals & Entertainment", /restaurant|coffee|starbucks|doordash|grubhub|cafe|catering|meal/i],
    ["Taxes", /irs|tax|franchise tax|dept of revenue|edd/i],
    ["Office & Equipment", /best buy|apple store|dell|furniture|equipment|printer|hardware/i],
  ];

  function categorize(desc, amount) {
    const d = String(desc || "");
    if (amount > 0) {
      // Positive amounts default to Income unless clearly a refund of an expense.
      for (const [cat, re] of RULES) if (cat === "Income" && re.test(d)) return "Income";
      return "Income";
    }
    for (const [cat, re] of RULES) { if (cat === "Income") continue; if (re.test(d)) return cat; }
    return "Other";
  }

  async function initTables() {
    await dbRun(`CREATE TABLE IF NOT EXISTS fin_transactions (
      id SERIAL PRIMARY KEY,
      txn_date TEXT,
      month TEXT,
      description TEXT,
      amount NUMERIC,          -- positive = income, negative = expense
      category TEXT,
      source TEXT,
      created_at TEXT
    )`).catch((e) => console.error("fin_transactions:", e.message));
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_fin_txn_month ON fin_transactions(month)`).catch(() => {});
    await dbRun(`CREATE TABLE IF NOT EXISTS fin_budgets (
      id SERIAL PRIMARY KEY,
      category TEXT UNIQUE,
      monthly_limit NUMERIC DEFAULT 0
    )`).catch((e) => console.error("fin_budgets:", e.message));
    await dbRun(`CREATE TABLE IF NOT EXISTS fin_payroll (
      id SERIAL PRIMARY KEY,
      month TEXT UNIQUE,
      gross NUMERIC DEFAULT 0,
      source TEXT,
      created_at TEXT
    )`).catch((e) => console.error("fin_payroll:", e.message));
  }

  function role(u) { return (u && (u.role || u.role_key || "")) || ""; }

  // A per-user grant from the Access editor unlocks this module's ordinary
  // access tier even when the role list wouldn't. Manage/sensitive tiers stay
  // role-gated.
  const granted = (u, k) => !!(ctx.moduleGranted && ctx.moduleGranted(u, k));
  function canView(u) { return ["owner", "super_admin"].includes(role(u)) || granted(u, "financial-center"); }

  function num(v) { const n = parseFloat(String(v == null ? "" : v).replace(/[$,()]/g, (m) => (m === "(" || m === ")" ? "" : ""))); return isFinite(n) ? n : 0; }
  function money(n) { return Math.round((n || 0) * 100) / 100; }
  function monthOf(dateStr) {
    if (!dateStr) return "";
    // Try MM/DD/YYYY, YYYY-MM-DD.
    let m = String(dateStr).match(/^(\d{4})-(\d{2})/); if (m) return `${m[1]}-${m[2]}`;
    m = String(dateStr).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (m) { let y = m[3]; if (y.length === 2) y = "20" + y; return `${y}-${String(m[1]).padStart(2, "0")}`; }
    return "";
  }

  // ---- CSV parsing (handles quotes) ----
  function parseCsv(text) {
    const rows = []; let row = [], cur = "", q = false;
    const s = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
      else cur += c;
    }
    if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
    return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
  }

  // Detect date / description / amount columns from a bank/QuickBooks CSV.
  function importCsv(text, source) {
    const rows = parseCsv(text);
    if (rows.length < 2) return { imported: 0, txns: [] };
    const header = rows[0].map((h) => String(h).trim().toLowerCase());
    const find = (...keys) => header.findIndex((h) => keys.some((k) => h.includes(k)));
    const cDate = find("date", "posted");
    const cDesc = find("description", "name", "memo", "payee", "detail");
    let cAmount = find("amount", "net");
    const cDebit = find("debit", "withdrawal", "money out");
    const cCredit = find("credit", "deposit", "money in");
    const txns = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const date = cDate >= 0 ? String(r[cDate] || "").trim() : "";
      const desc = cDesc >= 0 ? String(r[cDesc] || "").trim() : (r.find((x) => x && isNaN(num(x))) || "");
      let amount = 0;
      if (cAmount >= 0 && String(r[cAmount] || "").trim() !== "") {
        const raw = String(r[cAmount]).trim();
        amount = num(raw);
        if (/^\(.*\)$/.test(raw)) amount = -Math.abs(amount); // (123.45) = negative
      } else if (cDebit >= 0 || cCredit >= 0) {
        const deb = cDebit >= 0 ? num(r[cDebit]) : 0;
        const cred = cCredit >= 0 ? num(r[cCredit]) : 0;
        amount = cred - Math.abs(deb);
      }
      if (!date && !amount && !desc) continue;
      txns.push({ txn_date: date, month: monthOf(date), description: desc, amount: money(amount), category: categorize(desc, amount), source: source || "csv" });
    }
    return { imported: txns.length, txns };
  }

  // ---- PDF bank statements -------------------------------------------
  // Most bank/credit-card statements are text-based PDFs (not scans), so the
  // transaction lines can be pulled straight out of the content streams. Same
  // dependency-free approach as the .xlsx reader below: inflate the streams
  // with zlib, then read the text-showing operators.
  function pdfDecodeString(raw) {
    // A PDF literal string: escapes plus \ooo octal.
    let out = "";
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (c !== "\\") { out += c; continue; }
      const n = raw[++i];
      // These must keep their real byte values. With an embedded subset font
      // the byte IS the glyph code -- 0x08 might be "G" -- so turning \b into
      // a space here silently rewrote letters before the font map ever saw
      // them. Whitespace conversion happens later, only for fonts that have
      // no code map.
      if (n === "n") out += "\n";
      else if (n === "r") out += "\r";
      else if (n === "t") out += "\t";
      else if (n === "b") out += "\b";
      else if (n === "f") out += "\f";
      else if (n >= "0" && n <= "7") {
        let oct = n;
        while (oct.length < 3 && raw[i + 1] >= "0" && raw[i + 1] <= "7") oct += raw[++i];
        out += String.fromCharCode(parseInt(oct, 8));
      } else out += n;
    }
    return out;
  }

  // ---- embedded font decoding ---------------------------------------
  // Real bank statements almost always embed subsetted fonts with their own
  // character codes -- the byte in the content stream is a glyph index, not a
  // letter. Reading those bytes as ASCII produces convincing-looking garbage
  // ("7Yeekdj" instead of "Account"). Each font carries a /ToUnicode CMap that
  // maps its codes back to real characters, so that is what we follow.
  function inflateStreamAt(buffer, raw, objNum) {
    const re = new RegExp(`(?:^|[^0-9])${objNum}\\s+0\\s+obj`, "g");
    const m = re.exec(raw);
    if (!m) return null;
    const objStart = m.index;
    const sIdx = raw.indexOf("stream", objStart);
    if (sIdx < 0) return null;
    const eIdx = raw.indexOf("endstream", sIdx);
    if (eIdx < 0) return null;
    const dict = raw.slice(objStart, sIdx);
    let start = sIdx + 6;
    if (raw[start] === "\r") start++;
    if (raw[start] === "\n") start++;
    const bytes = buffer.slice(start, eIdx);
    if (!/\/FlateDecode/.test(dict)) return bytes;
    try { return zlib.inflateSync(bytes); }
    catch (e) { try { return zlib.inflateRawSync(bytes); } catch (e2) { return null; } }
  }

  function hexToStr(hex) {
    const h = String(hex).replace(/\s+/g, "");
    let out = "";
    // ToUnicode values are UTF-16BE, so consume four hex digits at a time.
    for (let i = 0; i + 3 < h.length; i += 4) out += String.fromCharCode(parseInt(h.substr(i, 4), 16));
    if (h.length % 4 === 2) out += String.fromCharCode(parseInt(h.substr(h.length - 2, 2), 16));
    return out;
  }

  function parseToUnicodeCMap(text) {
    const map = new Map();
    let m;
    const charBlocks = /beginbfchar([\s\S]*?)endbfchar/g;
    while ((m = charBlocks.exec(text))) {
      const pairRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
      let p;
      while ((p = pairRe.exec(m[1]))) map.set(parseInt(p[1], 16), hexToStr(p[2]));
    }
    const rangeBlocks = /beginbfrange([\s\S]*?)endbfrange/g;
    while ((m = rangeBlocks.exec(text))) {
      const body = m[1];
      // <lo> <hi> <dstStart>
      const simple = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
      let r;
      while ((r = simple.exec(body))) {
        const lo = parseInt(r[1], 16), hi = parseInt(r[2], 16);
        const dstHex = r[3];
        const base = parseInt(dstHex.slice(-4) || "0", 16);
        const prefix = dstHex.length > 4 ? hexToStr(dstHex.slice(0, dstHex.length - 4)) : "";
        for (let c = lo; c <= hi && c - lo < 65536; c++) map.set(c, prefix + String.fromCharCode(base + (c - lo)));
      }
      // <lo> <hi> [ <d1> <d2> ... ]
      const arrayForm = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g;
      while ((r = arrayForm.exec(body))) {
        const lo = parseInt(r[1], 16);
        const items = r[3].match(/<([0-9A-Fa-f]*)>/g) || [];
        items.forEach((it, i) => map.set(lo + i, hexToStr(it.slice(1, -1))));
      }
    }
    return map;
  }

  // Resource name (/F1, /F2 ...) -> code map, plus whether the font is
  // two-byte (Identity-H) so string bytes are paired correctly.
  function buildFontMaps(buffer, raw) {
    const fonts = {};
    const objNumByName = {};
    const resRe = /\/Font\s*<<([\s\S]*?)>>/g;
    let rm;
    while ((rm = resRe.exec(raw))) {
      const pairRe = /\/([A-Za-z0-9]+)\s+(\d+)\s+0\s+R/g;
      let p;
      while ((p = pairRe.exec(rm[1]))) if (!objNumByName[p[1]]) objNumByName[p[1]] = Number(p[2]);
    }
    for (const [name, objNum] of Object.entries(objNumByName)) {
      const objRe = new RegExp(`(?:^|[^0-9])${objNum}\\s+0\\s+obj([\\s\\S]{0,1200}?)(?:endobj|stream)`);
      const om = raw.match(objRe);
      if (!om) continue;
      const dict = om[1];
      const twoByte = /\/Encoding\s*\/Identity-[HV]/.test(dict) || /\/Type0/.test(dict);
      const tu = dict.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
      let map = null;
      if (tu) {
        const data = inflateStreamAt(buffer, raw, Number(tu[1]));
        if (data) { try { map = parseToUnicodeCMap(data.toString("latin1")); } catch (e) { map = null; } }
      }
      fonts[name] = { map, twoByte };
    }
    return fonts;
  }

  // Turns the raw bytes of one PDF string into text, using the current font's
  // CMap when there is one and falling back to the bytes themselves when there
  // isn't (plain WinAnsi fonts).
  function decodeWithFont(bytes, font) {
    if (!font || !font.map || !font.map.size) {
      // No code map: the bytes really are characters, so control codes are
      // layout whitespace rather than glyphs.
      return String(bytes).replace(/[\b\f\t\r\n]/g, " ");
    }
    let out = "";
    if (font.twoByte) {
      for (let i = 0; i + 1 < bytes.length; i += 2) {
        const code = (bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1);
        const u = font.map.get(code);
        out += u != null ? u : "";
      }
      if (bytes.length % 2 === 1) {
        const u = font.map.get(bytes.charCodeAt(bytes.length - 1));
        if (u != null) out += u;
      }
    } else {
      for (let i = 0; i < bytes.length; i++) {
        const u = font.map.get(bytes.charCodeAt(i));
        out += u != null ? u : bytes[i];
      }
    }
    return out;
  }

  function pdfContentToLines(content, fonts) {
    // Walk the text operators in order. Any operator that moves to a new line
    // (Td / TD / T* / Tm) or ends a text object (ET) breaks the current line,
    // which is what keeps one statement row on one line.
    const lines = [];
    let cur = "";
    const push = () => { if (cur.trim()) lines.push(cur.replace(/\s+/g, " ").trim()); cur = ""; };
    let font = null;
    const re = /\/([A-Za-z0-9]+)\s+[-\d.]+\s+Tf|\((?:\\.|[^\\()])*\)\s*Tj|\[(?:\\.|[^\\\]])*\]\s*TJ|<[0-9A-Fa-f\s]*>\s*Tj|(?:^|\s)(?:T\*|ET|BT)(?=\s|$)|[-\d.]+\s+[-\d.]+\s+(?:Td|TD)|[-\d.]+(?:\s+[-\d.]+){5}\s+Tm/g;
    let m;
    while ((m = re.exec(content))) {
      const tok = m[0].trim();
      // "/F2 9 Tf" switches font; every following string decodes through it.
      if (/Tf$/.test(tok)) { font = fonts ? fonts[m[1]] : null; continue; }
      if (/(?:Td|TD|Tm|T\*|ET|BT)$/.test(tok)) { push(); continue; }
      if (tok.endsWith("TJ")) {
        // Array form: [(He) -250 (llo)] TJ, or the hex equivalent
        // [<48656c> 80 <6c6f>] TJ, which is what many PDF writers emit.
        // Large negative kerning means a visible gap, so treat it as a space.
        const inner = tok.slice(tok.indexOf("[") + 1, tok.lastIndexOf("]"));
        const partRe = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>|-?\d+(?:\.\d+)?/g;
        let p;
        while ((p = partRe.exec(inner))) {
          const t = p[0];
          if (t.startsWith("(")) cur += decodeWithFont(pdfDecodeString(t.slice(1, -1)), font);
          else if (t.startsWith("<")) {
            const hex = t.slice(1, -1).replace(/\s+/g, "");
            let bytes = "";
            for (let i = 0; i + 1 < hex.length; i += 2) bytes += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
            cur += decodeWithFont(bytes, font);
          } else if (parseFloat(t) <= -100) cur += " ";
        }
      } else if (tok.startsWith("<")) {
        const hex = tok.slice(1, tok.lastIndexOf(">")).replace(/\s+/g, "");
        let bytes = "";
        for (let i = 0; i + 1 < hex.length; i += 2) bytes += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
        cur += decodeWithFont(bytes, font);
      } else {
        cur += decodeWithFont(pdfDecodeString(tok.slice(tok.indexOf("(") + 1, tok.lastIndexOf(")"))), font);
      }
    }
    push();
    return lines;
  }

  function extractPdfLines(buffer) {
    if (buffer.slice(0, 5).toString("latin1") !== "%PDF-") throw new Error("That file isn't a PDF.");
    const raw = buffer.toString("latin1");
    const fonts = buildFontMaps(buffer, raw);
    const lines = [];
    let idx = 0;
    let streams = 0;
    while (true) {
      const s = raw.indexOf("stream", idx);
      if (s < 0) break;
      const e = raw.indexOf("endstream", s);
      if (e < 0) break;
      // The stream's own dictionary is the one that opens at the last "<<"
      // before the keyword. (Taking a fixed-size lookback window instead would
      // drag in neighbouring objects -- e.g. a page's /ProcSet listing
      // /ImageB /ImageC -- and wrongly skip a perfectly readable text stream.)
      const dictStart = raw.lastIndexOf("<<", s);
      const dict = dictStart >= 0 ? raw.slice(dictStart, s) : "";
      let start = s + 6;
      if (raw[start] === "\r") start++;
      if (raw[start] === "\n") start++;
      const bytes = buffer.slice(start, e);
      idx = e + 9;
      if (/\/Subtype\s*\/Image|\/DCTDecode|\/JPXDecode|\/CCITTFaxDecode|\/ObjStm|\/XRef/.test(dict)) continue;
      let data = null;
      if (/\/FlateDecode/.test(dict)) {
        try { data = zlib.inflateSync(bytes); }
        catch (err) { try { data = zlib.inflateRawSync(bytes); } catch (e2) { data = null; } }
      } else if (!/\/Filter/.test(dict)) {
        data = bytes;
      }
      if (!data) continue;
      streams++;
      lines.push(...pdfContentToLines(data.toString("latin1"), fonts));
    }
    if (!streams) throw new Error("This PDF's pages couldn't be read. If it's a scanned statement, download the CSV version from your bank instead.");
    return lines;
  }

  // Pull transactions out of statement lines. Handles the common layouts:
  //   01/15/2026  STARBUCKS #123          -5.42
  //   01/15  ACH DEPOSIT  1,200.00  4,318.22   (last figure is a running balance)
  const MONEY_RE = /\(?-?\$?\d{1,3}(?:,\d{3})*(?:\.\d{2})\)?-?/g;
  const DATE_RE = /^\s*(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,?\s+\d{4})?)/i;
  const CREDIT_RE = /\b(deposit|credit|refund|interest paid|transfer in|payment received|payment recv|reversal|rebate|zelle from|ach credit|remote dep|incoming)\b/i;

  function parseStatementLines(lines, opts) {
    const year = (opts && opts.year) || new Date().getUTCFullYear();
    const txns = [];
    for (const line of lines) {
      const dm = line.match(DATE_RE);
      if (!dm) continue;
      const amounts = line.match(MONEY_RE);
      if (!amounts || !amounts.length) continue;
      // Two or more figures usually means the last one is the running balance.
      const amtRaw = amounts.length >= 2 ? amounts[amounts.length - 2] : amounts[amounts.length - 1];
      let amount = Math.abs(num(amtRaw));
      if (!amount) continue;
      let desc = line.slice(dm[0].length);
      amounts.forEach((a) => { desc = desc.replace(a, " "); });
      desc = desc.replace(/\s{2,}/g, " ").trim();
      if (!desc) continue;
      const explicitNegative = /^\(.*\)$/.test(amtRaw.trim()) || /^-/.test(amtRaw.trim()) || /-$/.test(amtRaw.trim());
      const looksLikeCredit = CREDIT_RE.test(line) && !explicitNegative;
      amount = looksLikeCredit ? amount : -amount;
      let date = dm[0].trim();
      // "01/15" with no year -- assume the statement year.
      if (/^\d{1,2}\/\d{1,2}$/.test(date)) date = `${date}/${year}`;
      txns.push({
        txn_date: date,
        month: monthOf(date),
        description: desc.slice(0, 200),
        amount: money(amount),
        category: categorize(desc, amount),
        source: "pdf",
      });
    }
    return txns;
  }

  function importPdf(buffer, opts) {
    return parseStatementLines(extractPdfLines(buffer), opts);
  }

  // ---- Rethink payroll .xlsx → monthly gross (TotalPay sum) ----
  function unzip(buffer) {
    let eocd = -1;
    for (let i = buffer.length - 22; i >= 0; i--) if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("Not a readable .xlsx.");
    const count = buffer.readUInt16LE(eocd + 10), cdOff = buffer.readUInt32LE(eocd + 16);
    const files = {}; let p = cdOff;
    for (let n = 0; n < count; n++) {
      if (buffer.readUInt32LE(p) !== 0x02014b50) break;
      const method = buffer.readUInt16LE(p + 10), compSize = buffer.readUInt32LE(p + 20);
      const fnLen = buffer.readUInt16LE(p + 28), exLen = buffer.readUInt16LE(p + 30), cmLen = buffer.readUInt16LE(p + 32);
      const lo = buffer.readUInt32LE(p + 42), name = buffer.toString("utf8", p + 46, p + 46 + fnLen);
      const lfn = buffer.readUInt16LE(lo + 26), lex = buffer.readUInt16LE(lo + 28), start = lo + 30 + lfn + lex;
      const comp = buffer.slice(start, start + compSize);
      try { files[name] = method === 0 ? comp : zlib.inflateRawSync(comp); } catch (e) {}
      p += 46 + fnLen + exLen + cmLen;
    }
    return files;
  }
  function parsePayrollGross(buffer) {
    const files = unzip(buffer); const dec = (b) => (b ? b.toString("utf8") : "");
    // Tags may carry a namespace prefix (<x:si>, <x:row>, <x:c>, <x:v>) depending
    // on which library wrote the workbook; match either form.
    const NS = "(?:[A-Za-z0-9]+:)?";
    const shared = []; const sx = dec(files["xl/sharedStrings.xml"]);
    const sre = new RegExp(`<${NS}si>([\\s\\S]*?)<\\/${NS}si>`, "g"); let sm;
    while ((sm = sre.exec(sx))) { let s = ""; const t = new RegExp(`<${NS}t[^>]*>([\\s\\S]*?)<\\/${NS}t>`, "g"); let tm; while ((tm = t.exec(sm[1]))) s += tm[1]; shared.push(s); }
    const rels = dec(files["xl/_rels/workbook.xml.rels"]); const relMap = {}; let rr; const rx = /<Relationship\b([^>]*)\/>/g;
    while ((rr = rx.exec(rels))) { const id = (rr[1].match(/Id="([^"]+)"/) || [])[1], tg = (rr[1].match(/Target="([^"]+)"/) || [])[1]; if (id && tg) relMap[id] = tg; }
    const wb = dec(files["xl/workbook.xml"]); let target = "", startDate = ""; let sh; const shx = /<sheet\b([^>]*)\/>/g;
    while ((sh = shx.exec(wb))) { const nm = (sh[1].match(/name="([^"]+)"/) || [])[1]; const rid = (sh[1].match(/r:id="([^"]+)"/) || [])[1]; if (nm && /summary/i.test(nm)) { target = relMap[rid] || ""; break; } }
    if (!target) return { gross: 0, month: "" };
    if (!target.startsWith("xl/")) target = "xl/" + target.replace(/^\//, "");
    const xml = dec(files[target]);
    const colIdx = (r) => { const m = r.match(/^([A-Z]+)/); let n = 0; for (const c of m[1]) n = n * 26 + (c.charCodeAt(0) - 64); return n - 1; };
    const rows = []; const rre = new RegExp(`<${NS}row[^>]*>([\\s\\S]*?)<\\/${NS}row>`, "g"); let rm;
    const creSrc = `<${NS}c\\s+r="([A-Z]+\\d+)"([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${NS}c>)`;
    while ((rm = rre.exec(xml))) { const cells = []; const cre = new RegExp(creSrc, "g"); let cm; while ((cm = cre.exec(rm[1]))) { const ci = colIdx(cm[1]); const a = cm[2] || "", inner = cm[3] || ""; const tt = (a.match(/t="([^"]+)"/) || [])[1] || ""; const v = inner.match(new RegExp(`<${NS}v>([\\s\\S]*?)<\\/${NS}v>`)); let val = ""; if (tt === "s" && v) val = shared[+v[1]] || ""; else if (v) val = v[1]; cells[ci] = val; } rows.push(cells); }
    // Row 0 has Start Date; header row has "Id"/"TotalPay".
    const meta = rows[0] || []; for (let i = 0; i < meta.length; i++) if (/start date/i.test(String(meta[i]))) startDate = meta[i + 1] || "";
    let h = rows.findIndex((r) => String((r || [])[0] || "").trim().toLowerCase() === "id"); if (h < 0) h = 1;
    const hdr = rows[h] || []; const cTotal = hdr.findIndex((x) => String(x || "").trim().toLowerCase() === "totalpay");
    let gross = 0; for (let i = h + 1; i < rows.length; i++) { const r = rows[i] || []; gross += num(r[cTotal >= 0 ? cTotal : hdr.length - 3]); }
    return { gross: money(gross), month: monthOf(startDate) };
  }

  async function overview(month) {
    const txns = await dbAll("SELECT * FROM fin_transactions WHERE month = ? ORDER BY txn_date", [month]);
    const budgets = await dbAll("SELECT * FROM fin_budgets");
    const budgetMap = {}; budgets.forEach((b) => { budgetMap[b.category] = num(b.monthly_limit); });
    let income = 0, expense = 0; const byCat = {};
    txns.forEach((t) => {
      const a = num(t.amount);
      if (a >= 0) income += a; else expense += -a;
      if (a < 0) byCat[t.category] = (byCat[t.category] || 0) + -a;
    });
    const net = income - expense;
    const categories = Object.keys(byCat).map((cat) => ({
      category: cat, spent: money(byCat[cat]), budget: budgetMap[cat] || 0,
      over: budgetMap[cat] ? byCat[cat] > budgetMap[cat] : false,
      pctOfBudget: budgetMap[cat] ? Math.round((byCat[cat] / budgetMap[cat]) * 100) : null,
    })).sort((a, b) => b.spent - a.spent);

    // Payroll reconciliation: Rethink gross vs. payroll seen in bank txns.
    const payrollRow = await dbGet("SELECT * FROM fin_payroll WHERE month = ?", [month]);
    const bankPayroll = byCat["Payroll"] || 0;
    const rethinkGross = payrollRow ? num(payrollRow.gross) : 0;
    let payrollRecon = null;
    if (rethinkGross || bankPayroll) {
      const diff = money(bankPayroll - rethinkGross);
      payrollRecon = {
        rethink_gross: money(rethinkGross), bank_payroll: money(bankPayroll), difference: diff,
        note: !rethinkGross ? "Upload the Rethink payroll export to compare against bank payroll."
          : !bankPayroll ? "No payroll transactions found in the bank data yet."
          : Math.abs(diff) < 1 ? "Bank payroll matches the Rethink gross. ✅"
          : diff > 0 ? `Bank payroll is $${Math.abs(diff)} MORE than Rethink gross — check for extra/duplicate runs.`
          : `Bank payroll is $${Math.abs(diff)} LESS than Rethink gross — a run may not have cleared yet.`,
      };
    }

    // Plain-English insights.
    const insights = [];
    if (net < 0) insights.push({ level: "bad", text: `You spent $${money(-net)} more than you brought in this month. Expenses ($${money(expense)}) are higher than income ($${money(income)}).` });
    else if (income) insights.push({ level: "good", text: `You kept $${money(net)} this month (${Math.round((net / income) * 100)}% of income). Aim to keep 10–20%.` });
    if (income) {
      const payrollPct = Math.round(((byCat["Payroll"] || 0) / income) * 100);
      if (payrollPct > 0) insights.push({ level: payrollPct > 60 ? "bad" : payrollPct > 45 ? "warn" : "good", text: `Payroll is ${payrollPct}% of income. For ABA, healthy is roughly 45–55%. ${payrollPct > 60 ? "This is high — revenue may be lagging billable hours." : ""}` });
    }
    categories.filter((c) => c.over).forEach((c) => insights.push({ level: "warn", text: `${c.category} is over budget: $${c.spent} spent vs. $${c.budget} budgeted (${c.pctOfBudget}%).` }));
    // Small recurring charges = possible waste.
    const subs = txns.filter((t) => t.category === "Software & Subscriptions" && num(t.amount) < 0);
    if (subs.length >= 3) insights.push({ level: "warn", text: `${subs.length} software/subscription charges this month ($${money(byCat["Software & Subscriptions"] || 0)}). Review for tools you no longer use — a common place to lose money.` });
    const fees = byCat["Bank & Card Fees"] || 0;
    if (fees > 0) insights.push({ level: "warn", text: `$${money(fees)} in bank/card fees — often avoidable by changing account type or paying cards on time.` });
    if (!txns.length) insights.push({ level: "info", text: "No transactions yet for this month. Upload a bank statement or QuickBooks export (CSV) to get started." });

    return {
      month, income: money(income), expense: money(expense), net: money(net),
      categories, budgets: budgetMap, payroll_recon: payrollRecon, insights,
      txn_count: txns.length, all_categories: CATEGORIES,
    };
  }

  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/fin/")) return false;
    try {
      if (!user) return json(res, 401, { error: "Not authenticated" });
      if (!canView(user)) return json(res, 403, { error: "Financials are owner-only." });
      const month = (query.month && /^\d{4}-\d{2}$/.test(query.month)) ? query.month : nowISO().slice(0, 7);

      if (pathname === "/api/fin/overview" && method === "GET") return json(res, 200, await overview(month));

      if (pathname === "/api/fin/months" && method === "GET") {
        const rows = await dbAll("SELECT DISTINCT month FROM fin_transactions WHERE month <> '' ORDER BY month DESC");
        return json(res, 200, rows.map((r) => r.month));
      }

      if (pathname === "/api/fin/transactions" && method === "GET") {
        const rows = await dbAll("SELECT * FROM fin_transactions WHERE month = ? ORDER BY txn_date, id", [month]);
        return json(res, 200, { transactions: rows, categories: CATEGORIES });
      }

      // Parse a PDF bank statement and hand back a preview. Nothing is saved
      // until the owner confirms on screen -- PDF layouts vary far more than
      // CSV, so the figures get eyes on them before they land in the books.
      if (pathname === "/api/fin/parse-pdf" && method === "POST") {
        const b = await readBody(req);
        if (!b.content_base64) return json(res, 400, { error: "No file provided." });
        let buf;
        try {
          let s = String(b.content_base64);
          const ci = s.indexOf(",");
          if (s.startsWith("data:") && ci >= 0) s = s.slice(ci + 1);
          buf = Buffer.from(s, "base64");
        } catch (e) { return json(res, 400, { error: "Could not read file." }); }
        let txns;
        try { txns = importPdf(buf, { year: b.year }); }
        catch (e) { return json(res, 400, { error: e.message }); }
        if (!txns.length) {
          return json(res, 400, {
            error: "No transactions found in that PDF. Some banks lay statements out in a way this can't read -- downloading the CSV version from your bank will always work.",
          });
        }
        return json(res, 200, { ok: true, txns });
      }

      if (pathname === "/api/fin/import" && method === "POST") {
        const b = await readBody(req);
        // Either raw CSV text, or an already-parsed set of rows confirmed from
        // the PDF preview above.
        let txns;
        if (Array.isArray(b.txns)) {
          txns = b.txns
            .filter((t) => t && (t.txn_date || t.description))
            .map((t) => ({
              txn_date: String(t.txn_date || ""),
              month: monthOf(String(t.txn_date || "")),
              description: String(t.description || "").slice(0, 200),
              amount: money(num(t.amount)),
              category: CATEGORIES.includes(t.category) ? t.category : categorize(t.description, num(t.amount)),
              source: b.source || "pdf",
            }));
        } else {
          if (!b.csv) return json(res, 400, { error: "No CSV content provided." });
          txns = importCsv(b.csv, b.source || "bank").txns;
        }
        if (!txns.length) return json(res, 400, { error: "No transactions found. Make sure the file has Date, Description, and Amount columns." });
        let n = 0;
        for (const t of txns) {
          await dbRun("INSERT INTO fin_transactions (txn_date, month, description, amount, category, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [t.txn_date, t.month, t.description, t.amount, t.category, t.source, nowISO()]);
          n++;
        }
        const months = [...new Set(txns.map((t) => t.month).filter(Boolean))];
        return json(res, 200, { ok: true, imported: n, months });
      }

      if (pathname === "/api/fin/import-payroll" && method === "POST") {
        const b = await readBody(req);
        if (!b.content_base64) return json(res, 400, { error: "No file provided." });
        let buf; try { let s = String(b.content_base64); const ci = s.indexOf(","); if (s.startsWith("data:") && ci >= 0) s = s.slice(ci + 1); buf = Buffer.from(s, "base64"); }
        catch (e) { return json(res, 400, { error: "Could not read file." }); }
        let pr; try { pr = parsePayrollGross(buf); } catch (e) { return json(res, 400, { error: "Could not parse payroll: " + e.message }); }
        const mo = (b.month && /^\d{4}-\d{2}$/.test(b.month)) ? b.month : (pr.month || month);
        await dbRun(`INSERT INTO fin_payroll (month, gross, source, created_at) VALUES (?, ?, 'rethink', ?)
                     ON CONFLICT (month) DO UPDATE SET gross = EXCLUDED.gross, created_at = EXCLUDED.created_at`, [mo, pr.gross, nowISO()]);
        return json(res, 200, { ok: true, month: mo, gross: pr.gross });
      }

      const txnMatch = pathname.match(/^\/api\/fin\/transactions\/(\d+)$/);
      if (txnMatch && method === "PATCH") {
        const b = await readBody(req);
        if (b.category && CATEGORIES.includes(b.category)) await dbRun("UPDATE fin_transactions SET category = ? WHERE id = ?", [b.category, Number(txnMatch[1])]);
        return json(res, 200, { ok: true });
      }
      if (txnMatch && method === "DELETE") { await dbRun("DELETE FROM fin_transactions WHERE id = ?", [Number(txnMatch[1])]); return json(res, 200, { ok: true }); }

      if (pathname === "/api/fin/budgets" && method === "GET") {
        const rows = await dbAll("SELECT * FROM fin_budgets ORDER BY category");
        return json(res, 200, { budgets: rows, categories: CATEGORIES });
      }
      if (pathname === "/api/fin/budgets" && method === "POST") {
        const b = await readBody(req);
        if (!b.category || !CATEGORIES.includes(b.category)) return json(res, 400, { error: "Valid category required." });
        await dbRun(`INSERT INTO fin_budgets (category, monthly_limit) VALUES (?, ?)
                     ON CONFLICT (category) DO UPDATE SET monthly_limit = EXCLUDED.monthly_limit`, [b.category, num(b.monthly_limit)]);
        return json(res, 200, { ok: true });
      }

      // Wage-cost simulator.
      if (pathname === "/api/fin/wage-sim" && method === "POST") {
        const b = await readBody(req);
        const rate = num(b.rate), hours = num(b.hours_per_week), count = Math.max(1, num(b.count) || 1), weeks = num(b.weeks) || 4.33;
        const burdenPct = b.burden_pct != null ? num(b.burden_pct) : 12; // employer taxes/burden
        const gross = rate * hours * weeks * count;
        const burden = gross * (burdenPct / 100);
        const totalCost = gross + burden;
        // Revenue potential (RBT billable) from owner settings if available.
        let revPerHour = 0;
        try { const s = await dbGet("SELECT avg_revenue_per_hour FROM owner_financial_settings WHERE id = 1"); revPerHour = s ? num(s.avg_revenue_per_hour) : 0; } catch (e) {}
        const revenue = revPerHour ? revPerHour * hours * weeks * count : null;
        return json(res, 200, {
          monthly_gross: money(gross), monthly_burden: money(burden), monthly_total_cost: money(totalCost),
          annual_total_cost: money(totalCost * 12), rev_per_hour: revPerHour,
          monthly_revenue_potential: revenue == null ? null : money(revenue),
          monthly_margin: revenue == null ? null : money(revenue - totalCost),
        });
      }

      return false;
    } catch (e) {
      console.error("financial-advisor error:", e);
      return json(res, 500, { error: "Financial error: " + e.message });
    }
  }

  // extractPdfLines / unzip are generic document readers that happen to live
  // here because this was the first module that needed them. They are
  // exported so the Policies & SOPs module can reuse them for uploads
  // instead of carrying a second copy.
  return { initTables, handleApi, extractPdfLines, unzip, buildFontMaps, parseToUnicodeCMap, _internal: { importCsv, parsePayrollGross, categorize } };
};
