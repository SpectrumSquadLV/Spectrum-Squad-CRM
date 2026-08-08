// fin-ledger.js -- Financial Center: document ledger, normalization layer and
// the reconciliation engine.
//
// This is the foundation the rest of the Financial Center is built on. Its job
// is narrow and strict:
//
//   1. Take in a financial document, work out what kind it is, and record it.
//   2. Turn its rows into standardized records that can always be traced back
//      to the exact source row they came from.
//   3. Reconcile those records against each other and report, with evidence,
//      where the numbers do not agree.
//
// Two rules run through the whole file:
//
//   * Nothing is ever silently dropped. A row that can't be interpreted goes
//     to the Unrecognized Data queue with the reason, not to /dev/null.
//   * An estimate is never presented as a fact. Every derived figure carries a
//     confidence (VERIFIED / LIKELY MATCH / NEEDS REVIEW / MISSING DATA) and
//     the ids of the records it was computed from.
//
// Owner / Super Admin only, enforced server-side on every route.

"use strict";

const crypto = require("crypto");

module.exports = function initFinLedger(ctx) {
  const {
    dbGet, dbAll, dbRun, nowISO, readBody, json,
    extractPdfLines, unzip, moduleGranted,
  } = ctx;

  // ======================= PERMISSIONS =======================
  function role(u) { return (u && (u.role || u.role_key || "")) || ""; }
  function canView(u) {
    return ["owner", "super_admin"].includes(role(u)) ||
      !!(moduleGranted && moduleGranted(u, "financial-center"));
  }

  // ======================= CONSTANTS =========================
  const CONFIDENCE = {
    VERIFIED: "VERIFIED",
    LIKELY: "LIKELY MATCH",
    REVIEW: "NEEDS REVIEW",
    MISSING: "MISSING DATA",
  };

  const DOC_TYPES = [
    "bank_statement", "credit_card_statement", "payroll", "profit_loss",
    "billing_export", "ar_aging", "claims_report", "remittance",
    "general_ledger", "expense_report", "invoice", "merchant_statement",
    "unknown",
  ];

  // Full expense taxonomy.
  const CATEGORIES = [
    "Income", "Payroll", "Payroll Taxes", "Employee Benefits", "Contract Labor",
    "Rent", "Utilities", "Insurance", "Clinical Software", "Administrative Software",
    "Recruiting", "Advertising/Marketing", "Office Supplies", "Clinical Supplies",
    "Food/Meals", "Travel", "Professional Services", "Legal", "Accounting",
    "Billing Services", "Credentialing", "Bank Fees", "Loan Payments", "Debt Payments",
    "Owner Transfers/Distributions", "Training/Education", "Licensing", "Subscriptions",
    "Equipment", "Furniture", "Repairs/Maintenance", "Transportation", "Refunds",
    "Taxes", "Other",
  ];

  // Seed rules. These are only a starting guess -- a saved vendor rule always
  // wins, so a correction the owner makes is permanent.
  const SEED_RULES = [
    ["Income", /\b(deposit|ach credit|payment recv|payment received|zelle from|remote dep|insurance pay|era payment|eft pmt|claim pmt|tricare|medicaid|molina|aetna|cigna|anthem|uhc|optum|reimbursement)\b/i],
    ["Payroll", /\b(payroll|gusto|homebase|adp|rippling|paychex|justworks|wage|salary|direct dep.*payroll)\b/i],
    ["Payroll Taxes", /\b(941|940|eftps|payroll tax|futa|suta|irs usataxpymt|employment tax)\b/i],
    ["Employee Benefits", /\b(benefit|health plan|dental|vision|401k|retirement|hsa|fsa)\b/i],
    ["Contract Labor", /\b(contractor|1099|freelance|temp agency)\b/i],
    ["Rent", /\b(rent|landlord|property mgmt|lease payment)\b/i],
    ["Utilities", /\b(nv energy|southwest gas|electric|water district|internet|comcast|cox|centurylink|utility|waste mgmt|republic services)\b/i],
    ["Insurance", /\b(insurance|liability|workers comp|hiscox|next insurance|the hartford|policy premium)\b/i],
    ["Clinical Software", /\b(rethink|centralreach|catalyst|motivity|theraplatform|hi rasmus)\b/i],
    ["Administrative Software", /\b(google|microsoft|zoom|adobe|slack|clickup|dropbox|notion|canva|calendly|signnow|docusign|openai|anthropic)\b/i],
    ["Recruiting", /\b(indeed|ziprecruiter|linkedin|glassdoor|handshake|recruit)\b/i],
    ["Advertising/Marketing", /\b(facebook|meta platforms|google ads|yelp|mailchimp|advertis|marketing)\b/i],
    ["Office Supplies", /\b(staples|office depot|office max|amazon|walmart|target|costco)\b/i],
    ["Clinical Supplies", /\b(lakeshore|therapy shoppe|abaresources|sensory|manipulatives)\b/i],
    ["Food/Meals", /\b(restaurant|coffee|starbucks|doordash|grubhub|uber eats|cafe|catering|smith'?s|albertsons)\b/i],
    ["Travel", /\b(airline|southwest air|delta|united air|hotel|marriott|hilton|airbnb)\b/i],
    ["Transportation", /\b(uber|lyft|shell|chevron|76 |arco|gas station|parking|dmv)\b/i],
    ["Legal", /\b(legal|attorney|law firm|law office)\b/i],
    ["Accounting", /\b(cpa|accountant|bookkeep|quickbooks|intuit|xero)\b/i],
    ["Billing Services", /\b(billing service|cube therapy|rcm |revenue cycle|clearinghouse|availity|office ally)\b/i],
    ["Credentialing", /\b(credential|caqh|napb|provider enroll)\b/i],
    ["Professional Services", /\b(consult|advisory|professional services)\b/i],
    ["Bank Fees", /\b(service charge|monthly fee|overdraft|nsf|wire fee|atm fee|analysis charge|returned item)\b/i],
    ["Loan Payments", /\b(loan pmt|loan payment|sba |term loan)\b/i],
    ["Debt Payments", /\b(credit card pmt|card payment|line of credit|loc draw)\b/i],
    ["Owner Transfers/Distributions", /\b(owner draw|distribution|transfer to savings|member draw|owner transfer)\b/i],
    ["Training/Education", /\b(training|course|ceu|conference|seminar|bacb|workshop)\b/i],
    ["Licensing", /\b(license|licensing|state of nevada|secretary of state|business license)\b/i],
    ["Subscriptions", /\b(subscription|monthly plan|annual plan)\b/i],
    ["Equipment", /\b(best buy|apple store|dell|lenovo|printer|laptop|equipment)\b/i],
    ["Furniture", /\b(furniture|ikea|wayfair|desk|chair)\b/i],
    ["Repairs/Maintenance", /\b(repair|maintenance|hvac|plumb|handyman|cleaning service|janitorial)\b/i],
    ["Refunds", /\b(refund|credit memo|chargeback|reversal)\b/i],
    ["Taxes", /\b(irs |franchise tax|dept of revenue|sales tax|modified business tax)\b/i],
  ];

  // ======================= SCHEMA ============================
  async function initTables() {
    // ---- the document ledger: one row per uploaded file -------------
    await dbRun(`CREATE TABLE IF NOT EXISTS fin_documents (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL,
      sha256 TEXT,
      byte_size INTEGER,
      doc_type TEXT,
      doc_type_confidence TEXT,
      account_label TEXT,
      period_start TEXT,
      period_end TEXT,
      source TEXT,
      uploaded_at TEXT,
      uploaded_by TEXT,
      processed_at TEXT,
      status TEXT,                  -- received | processed | failed | needs_review
      record_count INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      notes TEXT,
      raw_text TEXT
    )`).catch((e) => console.error("fin_documents:", e.message));
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_fin_docs_sha ON fin_documents(sha256)`).catch(() => {});

    // ---- normalized bank / card transactions ------------------------
    // Kept separate from the older fin_transactions table so the existing
    // Financial Center overview keeps working untouched while this is built.
    await dbRun(`CREATE TABLE IF NOT EXISTS fin_ledger_txns (
      id SERIAL PRIMARY KEY,
      document_id INTEGER,
      txn_date TEXT,
      month TEXT,
      description TEXT,
      vendor TEXT,
      amount NUMERIC,               -- positive = money in, negative = money out
      txn_type TEXT,                -- deposit | withdrawal | fee | transfer
      category TEXT,
      account_label TEXT,
      recurring BOOLEAN DEFAULT FALSE,
      confidence TEXT,
      source_row INTEGER,
      source_text TEXT,             -- the untouched original row
      created_at TEXT
    )`).catch((e) => console.error("fin_ledger_txns:", e.message));
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_fin_ltxn_month ON fin_ledger_txns(month)`).catch(() => {});
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_fin_ltxn_doc ON fin_ledger_txns(document_id)`).catch(() => {});

    // ---- statement period totals (for bank reconciliation) ----------
    await dbRun(`CREATE TABLE IF NOT EXISTS fin_statement_periods (
      id SERIAL PRIMARY KEY,
      document_id INTEGER,
      account_label TEXT,
      period_start TEXT,
      period_end TEXT,
      month TEXT,
      beginning_balance NUMERIC,
      ending_balance NUMERIC,
      stated_deposits NUMERIC,
      stated_withdrawals NUMERIC,
      stated_fees NUMERIC,
      created_at TEXT
    )`).catch((e) => console.error("fin_statement_periods:", e.message));

    // ---- normalized payroll lines -----------------------------------
    await dbRun(`CREATE TABLE IF NOT EXISTS fin_payroll_lines (
      id SERIAL PRIMARY KEY,
      document_id INTEGER,
      employee_name TEXT,
      employee_id INTEGER,
      pay_period_start TEXT,
      pay_period_end TEXT,
      pay_date TEXT,
      month TEXT,
      gross NUMERIC DEFAULT 0,
      net NUMERIC DEFAULT 0,
      employer_taxes NUMERIC DEFAULT 0,
      employee_taxes NUMERIC DEFAULT 0,
      benefits NUMERIC DEFAULT 0,
      reimbursements NUMERIC DEFAULT 0,
      deductions NUMERIC DEFAULT 0,
      payroll_fees NUMERIC DEFAULT 0,
      total_employer_cost NUMERIC DEFAULT 0,
      hours_total NUMERIC,
      hours_regular NUMERIC,
      hours_overtime NUMERIC,
      pay_rate NUMERIC,
      confidence TEXT,
      source_row INTEGER,
      source_text TEXT,
      created_at TEXT
    )`).catch((e) => console.error("fin_payroll_lines:", e.message));
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_fin_pay_month ON fin_payroll_lines(month)`).catch(() => {});

    // ---- normalized billing / claims lines --------------------------
    await dbRun(`CREATE TABLE IF NOT EXISTS fin_billing_lines (
      id SERIAL PRIMARY KEY,
      document_id INTEGER,
      client_name TEXT,
      provider_name TEXT,
      date_of_service TEXT,
      month TEXT,
      service_code TEXT,
      units NUMERIC,
      hours NUMERIC,
      amount_billed NUMERIC DEFAULT 0,
      expected_reimbursement NUMERIC DEFAULT 0,
      amount_paid NUMERIC DEFAULT 0,
      payer TEXT,
      claim_status TEXT,
      payment_date TEXT,
      outstanding NUMERIC DEFAULT 0,
      confidence TEXT,
      source_row INTEGER,
      source_text TEXT,
      created_at TEXT
    )`).catch((e) => console.error("fin_billing_lines:", e.message));
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_fin_bill_month ON fin_billing_lines(month)`).catch(() => {});

    // ---- anything we could not confidently interpret ----------------
    await dbRun(`CREATE TABLE IF NOT EXISTS fin_unrecognized (
      id SERIAL PRIMARY KEY,
      document_id INTEGER,
      source_row INTEGER,
      source_text TEXT,
      reason TEXT,
      resolved BOOLEAN DEFAULT FALSE,
      created_at TEXT
    )`).catch((e) => console.error("fin_unrecognized:", e.message));

    // ---- learned vendor rules ---------------------------------------
    await dbRun(`CREATE TABLE IF NOT EXISTS fin_vendor_rules (
      id SERIAL PRIMARY KEY,
      match_text TEXT UNIQUE,       -- lowercased substring taken from the description
      vendor TEXT,
      category TEXT,
      created_by TEXT,
      created_at TEXT,
      hit_count INTEGER DEFAULT 0
    )`).catch((e) => console.error("fin_vendor_rules:", e.message));

    // ---- reconciliation results -------------------------------------
    await dbRun(`CREATE TABLE IF NOT EXISTS fin_reconciliations (
      id SERIAL PRIMARY KEY,
      kind TEXT,                    -- bank | payroll
      period_key TEXT,              -- month, or pay-period key
      account_label TEXT,
      expected NUMERIC,
      actual NUMERIC,
      difference NUMERIC,
      status TEXT,                  -- MATCHED | DISCREPANCY | INCOMPLETE
      confidence TEXT,
      detail TEXT,                  -- JSON: components + evidence ids
      created_at TEXT
    )`).catch((e) => console.error("fin_reconciliations:", e.message));
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_fin_recon ON fin_reconciliations(kind, period_key)`).catch(() => {});
  }

  // ======================= SMALL HELPERS =====================
  function num(v) {
    if (v == null) return 0;
    let s = String(v).trim();
    if (!s) return 0;
    const neg = /^\(.*\)$/.test(s) || /-$/.test(s);
    s = s.replace(/[()$,\s]/g, "").replace(/-$/, "");
    const n = parseFloat(s);
    if (!isFinite(n)) return 0;
    return neg ? -Math.abs(n) : n;
  }
  function money(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  function isMoneyish(v) {
    const s = String(v == null ? "" : v).trim();
    if (!s) return false;
    return /^\(?-?\$?\d{1,3}(,\d{3})*(\.\d+)?\)?-?$/.test(s) || /^\(?-?\$?\d+(\.\d+)?\)?-?$/.test(s);
  }

  // Normalizes MM/DD/YYYY, YYYY-MM-DD, "Jan 5 2026" and 2-digit years into
  // YYYY-MM-DD, so every date in the system sorts and compares the same way.
  const MONTH_NAMES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  function normDate(v, fallbackYear) {
    if (!v) return "";
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (m) {
      let y = m[3];
      if (y.length === 2) y = (Number(y) > 70 ? "19" : "20") + y;
      return `${y}-${pad(m[1])}-${pad(m[2])}`;
    }
    m = s.match(/^(\d{1,2})\/(\d{1,2})$/);
    if (m && fallbackYear) return `${fallbackYear}-${pad(m[1])}-${pad(m[2])}`;
    m = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/);
    if (m && MONTH_NAMES[m[1].toLowerCase()]) {
      const y = m[3] || fallbackYear;
      if (y) return `${y}-${pad(MONTH_NAMES[m[1].toLowerCase()])}-${pad(m[2])}`;
    }
    // Excel serial dates (days since 1899-12-30).
    if (/^\d{5}$/.test(s)) {
      const d = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000);
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    }
    return "";
  }
  function pad(n) { return String(n).padStart(2, "0"); }
  function monthOf(isoDate) { return /^\d{4}-\d{2}/.test(String(isoDate || "")) ? String(isoDate).slice(0, 7) : ""; }
  function daysBetween(a, b) {
    const da = Date.parse(a + "T00:00:00Z"), db = Date.parse(b + "T00:00:00Z");
    if (isNaN(da) || isNaN(db)) return null;
    return Math.round((db - da) / 86400000);
  }

  // ======================= FILE READERS ======================
  function parseCsv(text) {
    const rows = []; let row = [], cur = "", q = false;
    const s = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === "," || c === "\t") { row.push(cur); cur = ""; }
      else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
      else cur += c;
    }
    if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
    return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
  }

  // Reads the first worksheet of an .xlsx into rows of strings.
  function parseXlsx(buffer) {
    const files = unzip(buffer);
    const dec = (b) => (b ? b.toString("utf8") : "");
    const shared = [];
    const sx = dec(files["xl/sharedStrings.xml"]);
    const sre = /<si>([\s\S]*?)<\/si>/g; let sm;
    while ((sm = sre.exec(sx))) {
      let str = ""; const t = /<t[^>]*>([\s\S]*?)<\/t>/g; let tm;
      while ((tm = t.exec(sm[1]))) str += tm[1];
      shared.push(str.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
    }
    // First sheet by relationship order.
    let sheetKey = Object.keys(files).find((k) => /^xl\/worksheets\/sheet1\.xml$/.test(k))
      || Object.keys(files).find((k) => /^xl\/worksheets\/.*\.xml$/.test(k));
    if (!sheetKey) throw new Error("No worksheet found in that .xlsx file.");
    const xml = dec(files[sheetKey]);
    const colIdx = (ref) => {
      const m = ref.match(/^([A-Z]+)/); let n = 0;
      for (const c of m[1]) n = n * 26 + (c.charCodeAt(0) - 64);
      return n - 1;
    };
    const rows = [];
    const rre = /<row[^>]*>([\s\S]*?)<\/row>/g; let rm;
    while ((rm = rre.exec(xml))) {
      const cells = [];
      const cre = /<c\s+r="([A-Z]+\d+)"([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g; let cm;
      while ((cm = cre.exec(rm[1]))) {
        const ci = colIdx(cm[1]);
        const attrs = cm[2] || "", inner = cm[3] || "";
        const t = (attrs.match(/t="([^"]+)"/) || [])[1] || "";
        let val = "";
        if (t === "inlineStr") { const is = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/); val = is ? is[1] : ""; }
        else {
          const v = inner.match(/<v>([\s\S]*?)<\/v>/);
          if (v) val = t === "s" ? (shared[Number(v[1])] || "") : v[1];
        }
        cells[ci] = val;
      }
      for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = "";
      rows.push(cells);
    }
    return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
  }

  // Turns any supported file into { kind, rows, lines, text }.
  function readDocument(filename, buffer) {
    const name = String(filename || "");
    const isPdf = /\.pdf$/i.test(name) || buffer.slice(0, 5).toString("latin1") === "%PDF-";
    const isXlsx = /\.xlsx$/i.test(name) || (buffer.slice(0, 2).toString("latin1") === "PK" && /\.xls[xm]?$/i.test(name));
    if (isPdf) {
      const lines = extractPdfLines(buffer);
      return { kind: "pdf", rows: null, lines, text: lines.join("\n") };
    }
    if (isXlsx) {
      const rows = parseXlsx(buffer);
      return { kind: "table", rows, lines: rows.map((r) => r.join("  ")), text: rows.map((r) => r.join(",")).join("\n") };
    }
    if (/\.(csv|tsv|txt)$/i.test(name) || !/\.[a-z0-9]+$/i.test(name)) {
      const text = buffer.toString("utf8");
      const rows = parseCsv(text);
      return { kind: "table", rows, lines: text.split("\n"), text };
    }
    throw new Error(`I can read PDF, CSV, TSV and Excel (.xlsx) files. "${name}" isn't one of those — if it's an old .xls, re-save it as .xlsx.`);
  }

  // ======================= DOCUMENT TYPE DETECTION ===========
  // Scored on the document's own words. Returns the winner plus its confidence,
  // and the runner-up so the UI can say "I think this is X, is it?".
  const TYPE_SIGNALS = [
    ["payroll", [/\bgross\s*(pay|wages)\b/i, /\bnet\s*pay\b/i, /\bemployee\b/i, /\bpay\s*period\b/i, /\bwithholding\b/i, /\btotal\s*pay\b/i, /\bfica\b/i, /\bhours\s*worked\b/i, /\bpayroll\b/i]],
    ["bank_statement", [/\bbeginning balance\b/i, /\bending balance\b/i, /\bdeposits?\s*(and|&)?\s*(credits|additions)?\b/i, /\bwithdrawals?\b/i, /\bstatement period\b/i, /\bavailable balance\b/i, /\bservice charge\b/i]],
    ["credit_card_statement", [/\bcredit card\b/i, /\bminimum payment\b/i, /\bpayment due date\b/i, /\bpurchases\b/i, /\bcredit limit\b/i, /\bnew balance\b/i]],
    ["profit_loss", [/\bprofit\s*(and|&)\s*loss\b/i, /\bincome statement\b/i, /\bcost of goods\b/i, /\bgross profit\b/i, /\btotal expenses\b/i, /\bnet (income|ordinary income)\b/i]],
    ["billing_export", [/\bcpt\b/i, /\bdate of service\b/i, /\bunits\b/i, /\bservice code\b/i, /\b9715[0-9]\b/, /\bbillable\b/i, /\brendering provider\b/i]],
    ["ar_aging", [/\baging\b/i, /\b0-30\b/, /\b31-60\b/, /\b61-90\b/, /\bover 90\b/i, /\baccounts receivable\b/i, /\boutstanding balance\b/i]],
    ["claims_report", [/\bclaim (number|id|status)\b/i, /\bdenied\b/i, /\badjudicat/i, /\bsubmitted claims\b/i]],
    ["remittance", [/\bremittance\b/i, /\bera\b/i, /\b835\b/, /\ballowed amount\b/i, /\bpatient responsibility\b/i, /\badjustment reason\b/i]],
    ["general_ledger", [/\bgeneral ledger\b/i, /\bjournal entry\b/i, /\bdebit\b.*\bcredit\b/i, /\baccount number\b/i, /\btrial balance\b/i]],
    ["merchant_statement", [/\bmerchant\b/i, /\binterchange\b/i, /\bchargeback\b/i, /\bbatch total\b/i]],
    ["expense_report", [/\bexpense report\b/i, /\breimbursement request\b/i, /\bmileage\b/i]],
    ["invoice", [/\binvoice\s*(number|#|date)\b/i, /\bbill to\b/i, /\bamount due\b/i, /\bterms\b/i]],
  ];

  function detectDocType(text, filename) {
    const hay = (String(filename || "") + "\n" + String(text || "")).slice(0, 20000);
    const scores = TYPE_SIGNALS.map(([type, sigs]) => {
      let hits = 0;
      for (const re of sigs) if (re.test(hay)) hits++;
      return { type, hits, ratio: hits / sigs.length };
    }).sort((a, b) => b.hits - a.hits || b.ratio - a.ratio);

    const top = scores[0], second = scores[1];
    if (!top || top.hits === 0) {
      return { doc_type: "unknown", confidence: CONFIDENCE.MISSING, runner_up: null, scores };
    }
    // Confident when it wins clearly and matched several distinct signals.
    let confidence = CONFIDENCE.REVIEW;
    if (top.hits >= 3 && top.hits >= (second ? second.hits + 2 : 0)) confidence = CONFIDENCE.VERIFIED;
    else if (top.hits >= 2 && top.hits > (second ? second.hits : 0)) confidence = CONFIDENCE.LIKELY;
    return {
      doc_type: top.type,
      confidence,
      runner_up: second && second.hits > 0 ? second.type : null,
      scores: scores.slice(0, 4),
    };
  }

  // Pulls "Statement period 01/01/2026 - 01/31/2026" style ranges out of text.
  function detectPeriod(text) {
    const t = String(text || "").slice(0, 20000);
    const patterns = [
      /(?:statement|pay|billing|report)\s*period[:\s]*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4}|\d{4}-\d{2}-\d{2})\s*(?:-|–|—|to|through)\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4}|\d{4}-\d{2}-\d{2})/i,
      /([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4}|\d{4}-\d{2}-\d{2})\s*(?:-|–|—|to|through)\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4}|\d{4}-\d{2}-\d{2})/,
    ];
    for (const re of patterns) {
      const m = t.match(re);
      if (m) {
        const a = normDate(m[1]), b = normDate(m[2]);
        if (a && b && a <= b) return { period_start: a, period_end: b };
      }
    }
    return { period_start: "", period_end: "" };
  }

  function yearHint(period, text) {
    if (period && period.period_start) return period.period_start.slice(0, 4);
    const m = String(text || "").match(/\b(20\d{2})\b/);
    return m ? m[1] : "";
  }

  // ======================= CATEGORIZATION ====================
  // Saved rules beat seeds, always. A rule is created whenever the owner
  // corrects a category, so the same vendor is never miscategorized twice.
  async function loadVendorRules() {
    try { return await dbAll("SELECT * FROM fin_vendor_rules ORDER BY length(match_text) DESC"); }
    catch (e) { return []; }
  }

  function guessVendor(description) {
    const d = String(description || "")
      .replace(/\b\d{4,}\b/g, " ")               // card/reference numbers
      .replace(/\b(pos|ach|debit|credit|purchase|payment|pmt|recurring|web|id:?)\b/gi, " ")
      .replace(/[*#]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    const words = d.split(" ").filter(Boolean).slice(0, 3).join(" ");
    return words.slice(0, 60);
  }

  function categorizeWith(rules, description, amount) {
    const d = String(description || "").toLowerCase();
    for (const r of rules) {
      if (r.match_text && d.includes(String(r.match_text).toLowerCase())) {
        return { category: r.category, vendor: r.vendor || guessVendor(description), confidence: CONFIDENCE.VERIFIED, rule_id: r.id };
      }
    }
    for (const [cat, re] of SEED_RULES) {
      if (cat === "Income" && amount <= 0) continue;
      if (cat !== "Income" && re.test(d)) {
        return { category: cat, vendor: guessVendor(description), confidence: CONFIDENCE.LIKELY, rule_id: null };
      }
      if (cat === "Income" && re.test(d)) {
        return { category: "Income", vendor: guessVendor(description), confidence: CONFIDENCE.LIKELY, rule_id: null };
      }
    }
    if (amount > 0) return { category: "Income", vendor: guessVendor(description), confidence: CONFIDENCE.REVIEW, rule_id: null };
    return { category: "Other", vendor: guessVendor(description), confidence: CONFIDENCE.REVIEW, rule_id: null };
  }

  // ======================= HEADER MAPPING ====================
  // Finds which column holds what, by looking for any of a set of aliases in
  // the header row. Returns -1 when a column genuinely isn't present, which
  // callers must handle rather than guessing.
  function headerIndex(header, aliases, opts) {
    const exact = (opts && opts.exact) || false;
    for (let i = 0; i < header.length; i++) {
      const h = String(header[i] || "").trim().toLowerCase().replace(/[^a-z0-9%/ ]/g, " ").replace(/\s+/g, " ").trim();
      if (!h) continue;
      for (const a of aliases) {
        const al = a.toLowerCase();
        if (exact ? h === al : (h === al || h.includes(al))) return i;
      }
    }
    return -1;
  }

  // Header rows aren't always row 0 -- exports often have a title and a blank
  // line first. Scan the first few rows for the one that looks most like a header.
  function findHeaderRow(rows, aliasGroups) {
    let best = { idx: -1, score: -1 };
    const limit = Math.min(rows.length, 12);
    for (let i = 0; i < limit; i++) {
      const r = rows[i] || [];
      let score = 0;
      for (const group of aliasGroups) if (headerIndex(r, group) >= 0) score++;
      // A header row is text, not numbers.
      const numeric = r.filter((c) => isMoneyish(c)).length;
      if (numeric > r.filter((c) => String(c).trim()).length / 2) score -= 2;
      if (score > best.score) best = { idx: i, score };
    }
    return best.score >= 2 ? best.idx : (rows.length ? 0 : -1);
  }

  // ======================= BANK PARSING ======================
  const BANK_ALIASES = {
    date: ["date", "posted date", "posting date", "transaction date", "post date", "effective date"],
    desc: ["description", "memo", "payee", "name", "detail", "transaction", "merchant", "narrative"],
    amount: ["amount", "transaction amount", "net amount", "value"],
    debit: ["debit", "withdrawal", "withdrawals", "money out", "payments", "charges", "amount debit"],
    credit: ["credit", "deposit", "deposits", "money in", "amount credit"],
    balance: ["balance", "running balance", "ending balance", "available balance"],
  };

  function parseBankTable(rows, yearGuess) {
    const hIdx = findHeaderRow(rows, [BANK_ALIASES.date, BANK_ALIASES.desc, BANK_ALIASES.amount.concat(BANK_ALIASES.debit, BANK_ALIASES.credit)]);
    if (hIdx < 0) return { txns: [], unrecognized: [], note: "No header row found." };
    const header = rows[hIdx];
    const cDate = headerIndex(header, BANK_ALIASES.date);
    const cDesc = headerIndex(header, BANK_ALIASES.desc);
    const cAmt = headerIndex(header, BANK_ALIASES.amount);
    const cDeb = headerIndex(header, BANK_ALIASES.debit);
    const cCred = headerIndex(header, BANK_ALIASES.credit);
    const cBal = headerIndex(header, BANK_ALIASES.balance);

    const txns = [], unrecognized = [];
    for (let i = hIdx + 1; i < rows.length; i++) {
      const r = rows[i];
      const rawText = r.join(" | ");
      const date = normDate(cDate >= 0 ? r[cDate] : "", yearGuess);
      let amount = null;
      if (cAmt >= 0 && String(r[cAmt] || "").trim() !== "") amount = num(r[cAmt]);
      else if (cDeb >= 0 || cCred >= 0) {
        const deb = cDeb >= 0 ? Math.abs(num(r[cDeb])) : 0;
        const cred = cCred >= 0 ? Math.abs(num(r[cCred])) : 0;
        if (deb || cred) amount = cred - deb;
      }
      const desc = String((cDesc >= 0 ? r[cDesc] : "") || "").trim();

      if (!date && amount == null) { continue; } // blank/spacer row, not data
      if (!date) { unrecognized.push({ source_row: i + 1, source_text: rawText, reason: "No readable date in this row." }); continue; }
      if (amount == null) { unrecognized.push({ source_row: i + 1, source_text: rawText, reason: "No readable amount in this row." }); continue; }
      if (!desc) { unrecognized.push({ source_row: i + 1, source_text: rawText, reason: "No description in this row." }); continue; }

      txns.push({
        txn_date: date, description: desc, amount: money(amount),
        balance: cBal >= 0 ? num(r[cBal]) : null,
        source_row: i + 1, source_text: rawText,
      });
    }
    return { txns, unrecognized, note: "" };
  }

  // PDF statements: one transaction per printed line.
  const MONEY_TOKEN = /\(?-?\$?\d{1,3}(?:,\d{3})*\.\d{2}\)?-?|\(?-?\$?\d+\.\d{2}\)?-?/g;
  const LINE_DATE = /^\s*(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,?\s+\d{4})?)/i;
  const CREDIT_WORDS = /\b(deposit|credit|refund|interest paid|transfer in|payment received|payment recv|zelle from|ach credit|remote dep|reversal|rebate|incoming)\b/i;

  function parseBankLines(lines, yearGuess) {
    const txns = [], unrecognized = [];
    lines.forEach((line, i) => {
      const text = String(line || "").trim();
      if (!text) return;
      const dm = text.match(LINE_DATE);
      if (!dm) return;                       // headers, addresses, page furniture
      const amounts = text.match(MONEY_TOKEN);
      if (!amounts || !amounts.length) {
        unrecognized.push({ source_row: i + 1, source_text: text, reason: "Looks like a transaction line (it starts with a date) but has no amount on it." });
        return;
      }
      // With 2+ figures the last is nearly always the running balance.
      const hasBalance = amounts.length >= 2;
      const amtRaw = hasBalance ? amounts[amounts.length - 2] : amounts[amounts.length - 1];
      const balRaw = hasBalance ? amounts[amounts.length - 1] : null;
      let magnitude = Math.abs(num(amtRaw));
      if (!magnitude) {
        unrecognized.push({ source_row: i + 1, source_text: text, reason: "Amount on this line read as zero." });
        return;
      }
      let desc = text.slice(dm[0].length);
      amounts.forEach((a) => { desc = desc.replace(a, " "); });
      desc = desc.replace(/\s{2,}/g, " ").trim();
      if (!desc) {
        unrecognized.push({ source_row: i + 1, source_text: text, reason: "No description left on this line after the date and amounts." });
        return;
      }
      const explicitNeg = /^\(.*\)$/.test(amtRaw.trim()) || /^-/.test(amtRaw.trim()) || /-$/.test(amtRaw.trim());
      const isCredit = !explicitNeg && CREDIT_WORDS.test(text);
      const amount = isCredit ? magnitude : -magnitude;
      const date = normDate(dm[0].trim(), yearGuess);
      if (!date) {
        unrecognized.push({ source_row: i + 1, source_text: text, reason: "Date on this line could not be read." });
        return;
      }
      txns.push({
        txn_date: date, description: desc.slice(0, 220), amount: money(amount),
        balance: balRaw != null ? num(balRaw) : null,
        source_row: i + 1, source_text: text,
        direction_confidence: explicitNeg || isCredit ? CONFIDENCE.LIKELY : CONFIDENCE.REVIEW,
      });
    });
    return { txns, unrecognized, note: "" };
  }

  // Beginning / ending balance and the bank's own stated totals, which are what
  // make a real reconciliation possible rather than just a sum of rows.
  function parseStatementTotals(text) {
    const t = String(text || "").replace(/\s+/g, " ");
    const grab = (re) => { const m = t.match(re); return m ? num(m[1]) : null; };
    const money$ = "\\(?-?\\$?[\\d,]+\\.\\d{2}\\)?-?";
    return {
      beginning_balance: grab(new RegExp(`(?:beginning|opening|previous statement|starting)\\s*(?:balance|bal)[^\\d\\-(]{0,20}(${money$})`, "i")),
      ending_balance: grab(new RegExp(`(?:ending|closing|new|current)\\s*(?:balance|bal)[^\\d\\-(]{0,20}(${money$})`, "i")),
      stated_deposits: grab(new RegExp(`(?:total\\s*)?deposits?(?:\\s*(?:and|&)\\s*(?:credits|additions|other credits))?[^\\d\\-(]{0,20}(${money$})`, "i")),
      stated_withdrawals: grab(new RegExp(`(?:total\\s*)?withdrawals?(?:\\s*(?:and|&)\\s*(?:debits|subtractions|other debits))?[^\\d\\-(]{0,20}(${money$})`, "i")),
      stated_fees: grab(new RegExp(`(?:total\\s*)?(?:service\\s*charges?|fees?)[^\\d\\-(]{0,20}(${money$})`, "i")),
    };
  }

  // ======================= PAYROLL PARSING ===================
  const PAY_ALIASES = {
    employee: ["employee", "employee name", "name", "worker", "staff", "employee id"],
    gross: ["gross pay", "gross wages", "gross", "total pay", "totalpay", "earnings"],
    net: ["net pay", "net", "take home", "net wages", "check amount"],
    ertax: ["employer taxes", "employer tax", "er taxes", "company taxes", "employer contributions", "employer fica"],
    eetax: ["employee taxes", "taxes withheld", "withholding", "ee taxes", "tax withheld", "total taxes"],
    benefits: ["benefits", "employer benefits", "benefit", "health", "insurance deduction"],
    reimb: ["reimbursement", "reimbursements", "expense reimbursement", "non taxable"],
    deduct: ["deductions", "deduction", "post tax deductions", "pre tax deductions"],
    fees: ["fees", "payroll fees", "processing fee", "service fee"],
    total: ["total employer cost", "total cost", "employer cost", "total company cost", "grand total"],
    hours: ["hours", "total hours", "hours worked"],
    regular: ["regular hours", "reg hours", "regular"],
    ot: ["overtime hours", "ot hours", "overtime"],
    rate: ["rate", "pay rate", "hourly rate"],
    payDate: ["pay date", "check date", "payment date"],
    periodStart: ["period start", "pay period start", "start date", "period begin"],
    periodEnd: ["period end", "pay period end", "end date"],
  };

  function parsePayrollTable(rows, yearGuess, docPeriod) {
    const hIdx = findHeaderRow(rows, [PAY_ALIASES.employee, PAY_ALIASES.gross, PAY_ALIASES.net.concat(PAY_ALIASES.hours)]);
    if (hIdx < 0) return { lines: [], unrecognized: [], note: "No header row found." };
    const h = rows[hIdx];
    const idx = {};
    for (const k of Object.keys(PAY_ALIASES)) idx[k] = headerIndex(h, PAY_ALIASES[k]);

    const lines = [], unrecognized = [];
    for (let i = hIdx + 1; i < rows.length; i++) {
      const r = rows[i];
      const rawText = r.join(" | ");
      const nameRaw = idx.employee >= 0 ? String(r[idx.employee] || "").trim() : "";
      const gross = idx.gross >= 0 ? Math.abs(num(r[idx.gross])) : 0;
      const net = idx.net >= 0 ? Math.abs(num(r[idx.net])) : 0;

      // Skip the export's own total row rather than treating it as an employee.
      if (/^(total|totals|grand total|sum)\b/i.test(nameRaw)) continue;
      if (!nameRaw && !gross && !net) continue;
      if (!nameRaw) { unrecognized.push({ source_row: i + 1, source_text: rawText, reason: "Payroll row has no employee name." }); continue; }
      if (!gross && !net) { unrecognized.push({ source_row: i + 1, source_text: rawText, reason: `No gross or net pay found for ${nameRaw}.` }); continue; }

      const g = (k) => (idx[k] >= 0 ? Math.abs(num(r[idx[k]])) : 0);
      const employerTaxes = g("ertax"), benefits = g("benefits"), fees = g("fees");
      const reimb = g("reimb");
      const statedTotal = idx.total >= 0 ? Math.abs(num(r[idx.total])) : 0;
      // Total employer cost: use the export's own figure when it gives one,
      // otherwise build it from the parts and mark it as derived.
      const derivedTotal = money(gross + employerTaxes + benefits + fees + reimb);
      const ps = idx.periodStart >= 0 ? normDate(r[idx.periodStart], yearGuess) : (docPeriod.period_start || "");
      const pe = idx.periodEnd >= 0 ? normDate(r[idx.periodEnd], yearGuess) : (docPeriod.period_end || "");
      const payDate = idx.payDate >= 0 ? normDate(r[idx.payDate], yearGuess) : "";

      lines.push({
        employee_name: nameRaw.slice(0, 120),
        pay_period_start: ps, pay_period_end: pe, pay_date: payDate,
        month: monthOf(payDate || pe || ps),
        gross: money(gross), net: money(net),
        employer_taxes: money(employerTaxes),
        employee_taxes: money(g("eetax")),
        benefits: money(benefits),
        reimbursements: money(reimb),
        deductions: money(g("deduct")),
        payroll_fees: money(fees),
        total_employer_cost: statedTotal ? money(statedTotal) : derivedTotal,
        total_is_stated: !!statedTotal,
        hours_total: idx.hours >= 0 ? num(r[idx.hours]) : null,
        hours_regular: idx.regular >= 0 ? num(r[idx.regular]) : null,
        hours_overtime: idx.ot >= 0 ? num(r[idx.ot]) : null,
        pay_rate: idx.rate >= 0 ? num(r[idx.rate]) : null,
        confidence: statedTotal ? CONFIDENCE.VERIFIED : (employerTaxes || benefits || fees ? CONFIDENCE.LIKELY : CONFIDENCE.REVIEW),
        source_row: i + 1, source_text: rawText,
      });
    }
    return { lines, unrecognized, note: "" };
  }

  // ======================= BILLING PARSING ===================
  const BILL_ALIASES = {
    client: ["client", "client name", "patient", "patient name", "member", "child"],
    provider: ["provider", "rendering provider", "therapist", "staff", "clinician"],
    dos: ["date of service", "dos", "service date", "date"],
    code: ["cpt", "cpt code", "service code", "procedure code", "code"],
    units: ["units", "unit", "qty", "quantity"],
    hours: ["hours", "billable hours", "session hours"],
    billed: ["billed", "amount billed", "charge", "charges", "billed amount", "total charge"],
    expected: ["expected", "expected reimbursement", "allowed", "allowed amount", "contracted rate"],
    paid: ["paid", "amount paid", "payment", "payments", "insurance paid", "paid amount"],
    payer: ["payer", "payor", "insurance", "plan", "carrier"],
    status: ["claim status", "status"],
    payDate: ["payment date", "paid date", "check date"],
    outstanding: ["outstanding", "balance", "open balance", "amount due", "ar balance"],
  };

  function parseBillingTable(rows, yearGuess) {
    const hIdx = findHeaderRow(rows, [BILL_ALIASES.client, BILL_ALIASES.dos, BILL_ALIASES.billed.concat(BILL_ALIASES.units, BILL_ALIASES.code)]);
    if (hIdx < 0) return { lines: [], unrecognized: [], note: "No header row found." };
    const h = rows[hIdx];
    const idx = {};
    for (const k of Object.keys(BILL_ALIASES)) idx[k] = headerIndex(h, BILL_ALIASES[k]);

    const lines = [], unrecognized = [];
    for (let i = hIdx + 1; i < rows.length; i++) {
      const r = rows[i];
      const rawText = r.join(" | ");
      const client = idx.client >= 0 ? String(r[idx.client] || "").trim() : "";
      const dos = idx.dos >= 0 ? normDate(r[idx.dos], yearGuess) : "";
      const billed = idx.billed >= 0 ? Math.abs(num(r[idx.billed])) : 0;
      const units = idx.units >= 0 ? num(r[idx.units]) : null;

      if (/^(total|totals|grand total)\b/i.test(client)) continue;
      if (!client && !dos && !billed) continue;
      if (!dos) { unrecognized.push({ source_row: i + 1, source_text: rawText, reason: "Billing row has no readable date of service." }); continue; }
      if (!billed && !units) { unrecognized.push({ source_row: i + 1, source_text: rawText, reason: "Billing row has neither an amount nor units." }); continue; }

      const paid = idx.paid >= 0 ? Math.abs(num(r[idx.paid])) : 0;
      const expected = idx.expected >= 0 ? Math.abs(num(r[idx.expected])) : 0;
      const outstanding = idx.outstanding >= 0 ? Math.abs(num(r[idx.outstanding])) : money(Math.max(0, (expected || billed) - paid));

      lines.push({
        client_name: client.slice(0, 120),
        provider_name: idx.provider >= 0 ? String(r[idx.provider] || "").trim().slice(0, 120) : "",
        date_of_service: dos, month: monthOf(dos),
        service_code: idx.code >= 0 ? String(r[idx.code] || "").trim().slice(0, 20) : "",
        units, hours: idx.hours >= 0 ? num(r[idx.hours]) : (units != null ? money(units * 0.25) : null),
        amount_billed: money(billed),
        expected_reimbursement: money(expected),
        amount_paid: money(paid),
        payer: idx.payer >= 0 ? String(r[idx.payer] || "").trim().slice(0, 80) : "",
        claim_status: idx.status >= 0 ? String(r[idx.status] || "").trim().slice(0, 40) : "",
        payment_date: idx.payDate >= 0 ? normDate(r[idx.payDate], yearGuess) : "",
        outstanding: money(outstanding),
        confidence: idx.hours >= 0 ? CONFIDENCE.VERIFIED : CONFIDENCE.LIKELY,
        source_row: i + 1, source_text: rawText,
      });
    }
    return { lines, unrecognized, note: idx.hours >= 0 ? "" : "No hours column found — hours were derived from units at 4 units per hour, the standard ABA 15-minute unit." };
  }

  // ======================= INGEST PIPELINE ===================
  // Takes an uploaded file all the way to normalized records. Everything it
  // could not interpret ends up in fin_unrecognized, never dropped.
  async function ingest({ filename, buffer, source, actorEmail, docTypeOverride, accountLabel }) {
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");

    // ---- duplicate protection ----
    const dupe = await dbGet("SELECT id, filename, uploaded_at, doc_type FROM fin_documents WHERE sha256 = ?", [sha256]);
    if (dupe) {
      return { duplicate: true, existing: dupe };
    }

    let read;
    try { read = readDocument(filename, buffer); }
    catch (e) {
      const row = await dbGet(
        `INSERT INTO fin_documents (filename, sha256, byte_size, doc_type, doc_type_confidence, source, uploaded_at, uploaded_by, status, notes)
         VALUES (?, ?, ?, 'unknown', ?, ?, ?, ?, 'failed', ?) RETURNING *`,
        [filename, sha256, buffer.length, CONFIDENCE.MISSING, source || "upload", nowISO(), actorEmail || null, e.message]
      );
      return { document: row, error: e.message };
    }

    const detected = docTypeOverride && DOC_TYPES.includes(docTypeOverride)
      ? { doc_type: docTypeOverride, confidence: CONFIDENCE.VERIFIED, runner_up: null }
      : detectDocType(read.text, filename);
    const period = detectPeriod(read.text);
    const year = yearHint(period, read.text);

    const doc = await dbGet(
      `INSERT INTO fin_documents
        (filename, sha256, byte_size, doc_type, doc_type_confidence, account_label, period_start, period_end,
         source, uploaded_at, uploaded_by, status, raw_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?) RETURNING *`,
      [filename, sha256, buffer.length, detected.doc_type, detected.confidence, accountLabel || null,
       period.period_start || null, period.period_end || null, source || "upload", nowISO(), actorEmail || null,
       read.text.slice(0, 400000)]
    );

    const result = { document: doc, detected, period, counts: {}, unrecognized: 0, notes: [] };
    const unrec = [];
    let records = 0;

    try {
      if (detected.doc_type === "bank_statement" || detected.doc_type === "credit_card_statement" || detected.doc_type === "merchant_statement") {
        const parsed = read.rows ? parseBankTable(read.rows, year) : parseBankLines(read.lines, year);
        unrec.push(...parsed.unrecognized);
        if (parsed.note) result.notes.push(parsed.note);
        const rules = await loadVendorRules();
        for (const t of parsed.txns) {
          const cat = categorizeWith(rules, t.description, t.amount);
          const type = t.amount > 0 ? "deposit" : (/\b(fee|service charge|overdraft|nsf)\b/i.test(t.description) ? "fee" : "withdrawal");
          await dbRun(
            `INSERT INTO fin_ledger_txns (document_id, txn_date, month, description, vendor, amount, txn_type,
              category, account_label, confidence, source_row, source_text, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [doc.id, t.txn_date, monthOf(t.txn_date), t.description, cat.vendor, t.amount, type,
             cat.category, accountLabel || null, t.direction_confidence || cat.confidence, t.source_row, t.source_text, nowISO()]
          );
          records++;
        }
        // Statement totals make a real reconciliation possible.
        const totals = parseStatementTotals(read.text);
        if (totals.beginning_balance != null || totals.ending_balance != null) {
          await dbRun(
            `INSERT INTO fin_statement_periods (document_id, account_label, period_start, period_end, month,
              beginning_balance, ending_balance, stated_deposits, stated_withdrawals, stated_fees, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [doc.id, accountLabel || null, period.period_start || null, period.period_end || null,
             monthOf(period.period_end || period.period_start || ""),
             totals.beginning_balance, totals.ending_balance, totals.stated_deposits,
             totals.stated_withdrawals, totals.stated_fees, nowISO()]
          );
        } else {
          result.notes.push("This statement didn't state a beginning and ending balance, so the balance check can't run on it. Transactions were still imported.");
        }
      } else if (detected.doc_type === "payroll") {
        if (!read.rows) {
          result.notes.push("Payroll came in as a PDF. Reading payroll reliably needs the CSV or Excel export — the figures matter too much to guess at from a PDF layout.");
        } else {
          const parsed = parsePayrollTable(read.rows, year, period);
          unrec.push(...parsed.unrecognized);
          for (const l of parsed.lines) {
            await dbRun(
              `INSERT INTO fin_payroll_lines (document_id, employee_name, pay_period_start, pay_period_end, pay_date, month,
                gross, net, employer_taxes, employee_taxes, benefits, reimbursements, deductions, payroll_fees,
                total_employer_cost, hours_total, hours_regular, hours_overtime, pay_rate, confidence, source_row, source_text, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [doc.id, l.employee_name, l.pay_period_start || null, l.pay_period_end || null, l.pay_date || null, l.month || null,
               l.gross, l.net, l.employer_taxes, l.employee_taxes, l.benefits, l.reimbursements, l.deductions, l.payroll_fees,
               l.total_employer_cost, l.hours_total, l.hours_regular, l.hours_overtime, l.pay_rate, l.confidence,
               l.source_row, l.source_text, nowISO()]
            );
            records++;
          }
          if (parsed.lines.length && !parsed.lines.some((l) => l.total_is_stated)) {
            result.notes.push("This export didn't include a total-employer-cost column, so that figure was built from gross + employer taxes + benefits + fees. It's marked as derived, not verified.");
          }
        }
      } else if (["billing_export", "claims_report", "remittance", "ar_aging"].includes(detected.doc_type)) {
        if (!read.rows) {
          result.notes.push("Billing data came in as a PDF. The CSV/Excel export gives reliable per-claim figures; a PDF can't be split into claim lines safely.");
        } else {
          const parsed = parseBillingTable(read.rows, year);
          unrec.push(...parsed.unrecognized);
          if (parsed.note) result.notes.push(parsed.note);
          for (const l of parsed.lines) {
            await dbRun(
              `INSERT INTO fin_billing_lines (document_id, client_name, provider_name, date_of_service, month, service_code,
                units, hours, amount_billed, expected_reimbursement, amount_paid, payer, claim_status, payment_date,
                outstanding, confidence, source_row, source_text, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [doc.id, l.client_name, l.provider_name, l.date_of_service, l.month, l.service_code,
               l.units, l.hours, l.amount_billed, l.expected_reimbursement, l.amount_paid, l.payer, l.claim_status,
               l.payment_date || null, l.outstanding, l.confidence, l.source_row, l.source_text, nowISO()]
            );
            records++;
          }
        }
      } else {
        result.notes.push(
          detected.doc_type === "unknown"
            ? "I couldn't tell what kind of document this is, so nothing was imported from it. It's saved here — tell me what it is and I'll read it."
            : `Recognised as a ${detected.doc_type.replace(/_/g, " ")}, which isn't wired up for automatic import yet. The file is stored and its text is searchable.`
        );
      }
    } catch (e) {
      await dbRun("UPDATE fin_documents SET status = 'failed', notes = ?, processed_at = ? WHERE id = ?",
        [String(e.message).slice(0, 500), nowISO(), doc.id]);
      return { document: doc, detected, error: e.message };
    }

    for (const u of unrec) {
      await dbRun(
        "INSERT INTO fin_unrecognized (document_id, source_row, source_text, reason, created_at) VALUES (?, ?, ?, ?, ?)",
        [doc.id, u.source_row, String(u.source_text || "").slice(0, 1000), u.reason, nowISO()]
      );
    }

    const status = unrec.length ? "needs_review" : (records ? "processed" : "needs_review");
    await dbRun(
      "UPDATE fin_documents SET status = ?, processed_at = ?, record_count = ?, error_count = ?, notes = ? WHERE id = ?",
      [status, nowISO(), records, unrec.length, result.notes.join(" ") || null, doc.id]
    );

    result.counts = { records, unrecognized: unrec.length };
    result.unrecognized = unrec.length;
    result.document = await dbGet("SELECT * FROM fin_documents WHERE id = ?", [doc.id]);
    return result;
  }

  // ======================= RECONCILIATION ====================
  // --- BANK -------------------------------------------------
  // Beginning + deposits - withdrawals - fees = ending. Anything else is a
  // discrepancy, and we say by how much and which rows produced our figures.
  async function reconcileBank(month) {
    const periods = await dbAll(
      "SELECT * FROM fin_statement_periods WHERE month = ? ORDER BY id", [month]
    );
    const txns = await dbAll(
      "SELECT id, txn_date, description, amount, txn_type, category FROM fin_ledger_txns WHERE month = ? ORDER BY txn_date, id", [month]
    );

    const deposits = txns.filter((t) => Number(t.amount) > 0);
    const fees = txns.filter((t) => t.txn_type === "fee");
    const withdrawals = txns.filter((t) => Number(t.amount) < 0 && t.txn_type !== "fee");
    const sum = (rows) => money(rows.reduce((s, r) => s + Math.abs(Number(r.amount) || 0), 0));

    const computed = {
      deposits: sum(deposits),
      withdrawals: sum(withdrawals),
      fees: sum(fees),
      transaction_count: txns.length,
    };

    if (!periods.length) {
      return {
        month, status: "INCOMPLETE", confidence: CONFIDENCE.MISSING,
        computed, statement: null,
        explanation: `I can add up ${txns.length} transactions for ${month}, but no statement for that month gave a beginning and ending balance — so I can't prove the month is complete. Upload the bank statement itself (not just a transaction export) and this check will run.`,
        missing: ["A bank statement for this month showing its beginning and ending balance"],
        evidence: { transaction_ids: txns.map((t) => t.id) },
      };
    }

    const p = periods[0];
    const beginning = Number(p.beginning_balance);
    const ending = Number(p.ending_balance);
    const expectedEnding = money(beginning + computed.deposits - computed.withdrawals - computed.fees);
    const difference = money(ending - expectedEnding);
    const matched = Math.abs(difference) < 0.01;

    let explanation;
    if (matched) {
      explanation = `${month} balances. Started at $${fmt(beginning)}, $${fmt(computed.deposits)} came in, $${fmt(computed.withdrawals)} went out, $${fmt(computed.fees)} in fees — which lands exactly on the statement's ending balance of $${fmt(ending)}. Every transaction on the statement is accounted for.`;
    } else {
      const dir = difference > 0 ? "more" : "less";
      explanation = `${month} doesn't balance. Working from the beginning balance of $${fmt(beginning)} and the transactions I read, the account should have ended at $${fmt(expectedEnding)} — but the statement says $${fmt(ending)}. That's $${fmt(Math.abs(difference))} ${dir} than the transactions explain. The usual cause is a transaction that didn't get read off the statement, so check the Unrecognized Data queue for this document first.`;
    }

    return {
      month, status: matched ? "MATCHED" : "DISCREPANCY",
      confidence: matched ? CONFIDENCE.VERIFIED : CONFIDENCE.REVIEW,
      computed,
      statement: {
        document_id: p.document_id,
        beginning_balance: money(beginning),
        ending_balance: money(ending),
        stated_deposits: p.stated_deposits == null ? null : money(p.stated_deposits),
        stated_withdrawals: p.stated_withdrawals == null ? null : money(p.stated_withdrawals),
        stated_fees: p.stated_fees == null ? null : money(p.stated_fees),
      },
      expected_ending: expectedEnding,
      difference,
      explanation,
      evidence: {
        transaction_ids: txns.map((t) => t.id),
        deposit_ids: deposits.map((t) => t.id),
        withdrawal_ids: withdrawals.map((t) => t.id),
        fee_ids: fees.map((t) => t.id),
        statement_period_id: p.id,
      },
    };
  }

  function fmt(n) {
    return (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // --- PAYROLL ----------------------------------------------
  // The important one. Compares the COMPLETE payroll cost against the money
  // that actually left the bank, allowing for payroll landing as several
  // separate withdrawals (net pay, taxes, fees) rather than one.
  const PAYROLL_TXN_RE = /\b(payroll|gusto|homebase|adp|rippling|paychex|justworks|wage|salary|direct dep|tax pmt|eftps|941|940|futa|suta)\b/i;

  async function reconcilePayroll(periodKey, opts) {
    const windowDays = (opts && opts.windowDays) || 7;
    const lines = await dbAll(
      "SELECT * FROM fin_payroll_lines WHERE month = ? OR pay_period_end LIKE ? ORDER BY id",
      [periodKey, periodKey + "%"]
    );
    if (!lines.length) {
      return {
        period: periodKey, status: "INCOMPLETE", confidence: CONFIDENCE.MISSING,
        explanation: `No payroll export has been uploaded for ${periodKey}, so there's nothing to check the bank against yet.`,
        missing: ["The payroll export (CSV or Excel) covering this period"],
      };
    }

    const totals = lines.reduce((a, l) => ({
      gross: a.gross + Number(l.gross || 0),
      net: a.net + Number(l.net || 0),
      employer_taxes: a.employer_taxes + Number(l.employer_taxes || 0),
      employee_taxes: a.employee_taxes + Number(l.employee_taxes || 0),
      benefits: a.benefits + Number(l.benefits || 0),
      reimbursements: a.reimbursements + Number(l.reimbursements || 0),
      deductions: a.deductions + Number(l.deductions || 0),
      fees: a.fees + Number(l.payroll_fees || 0),
      employer_cost: a.employer_cost + Number(l.total_employer_cost || 0),
      hours: a.hours + Number(l.hours_total || 0),
      overtime: a.overtime + Number(l.hours_overtime || 0),
    }), { gross: 0, net: 0, employer_taxes: 0, employee_taxes: 0, benefits: 0, reimbursements: 0, deductions: 0, fees: 0, employer_cost: 0, hours: 0, overtime: 0 });
    for (const k of Object.keys(totals)) totals[k] = money(totals[k]);

    // Expected cash out of the bank = everything the employer actually pays:
    // net pay to staff, all taxes remitted, benefits, reimbursements and fees.
    const expected = money(totals.net + totals.employer_taxes + totals.employee_taxes + totals.benefits + totals.reimbursements + totals.fees);

    // Look for the matching withdrawals in a window around the pay period, not
    // just inside the calendar month, because payroll often clears a few days
    // either side of the period end.
    const anchorEnd = lines.map((l) => l.pay_date || l.pay_period_end).filter(Boolean).sort().pop() || (periodKey + "-28");
    const anchorStart = lines.map((l) => l.pay_period_start).filter(Boolean).sort()[0] || (periodKey + "-01");
    const from = shiftDate(anchorStart, -windowDays), to = shiftDate(anchorEnd, windowDays);

    const candidates = await dbAll(
      `SELECT id, txn_date, description, amount, category FROM fin_ledger_txns
        WHERE amount < 0 AND txn_date >= ? AND txn_date <= ? ORDER BY txn_date, id`, [from, to]
    );
    const payrollTxns = candidates.filter(
      (t) => PAYROLL_TXN_RE.test(t.description) || ["Payroll", "Payroll Taxes", "Employee Benefits"].includes(t.category)
    );
    const actual = money(payrollTxns.reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0));
    const difference = money(actual - expected);
    const withinTolerance = Math.abs(difference) < 0.01;

    // Break the withdrawals down so the owner can see what each one was.
    const components = {
      net_pay: payrollTxns.filter((t) => /\b(payroll|gusto|homebase|adp|rippling|paychex|direct dep|wage|salary)\b/i.test(t.description) && !/\b(tax|941|940|eftps|fee)\b/i.test(t.description)),
      taxes: payrollTxns.filter((t) => /\b(tax|941|940|eftps|futa|suta)\b/i.test(t.description)),
      fees: payrollTxns.filter((t) => /\bfee\b/i.test(t.description)),
    };
    components.other = payrollTxns.filter((t) =>
      !components.net_pay.includes(t) && !components.taxes.includes(t) && !components.fees.includes(t));

    let status, confidence, explanation;
    if (!payrollTxns.length) {
      status = "INCOMPLETE"; confidence = CONFIDENCE.MISSING;
      explanation = `The payroll export says $${fmt(expected)} should have left the bank for ${periodKey}, but I can't find any payroll withdrawals between ${from} and ${to} to check it against. Either the bank statement covering those dates hasn't been uploaded, or payroll leaves the account under a description I don't recognise as payroll yet.`;
    } else if (withinTolerance) {
      status = "MATCHED"; confidence = CONFIDENCE.VERIFIED;
      explanation = `Payroll matches for ${periodKey}. The export accounts for $${fmt(expected)} of cash — $${fmt(totals.net)} in net pay, $${fmt(money(totals.employer_taxes + totals.employee_taxes))} in taxes${totals.benefits ? `, $${fmt(totals.benefits)} in benefits` : ""}${totals.fees ? `, $${fmt(totals.fees)} in fees` : ""} — and exactly $${fmt(actual)} left the bank across ${payrollTxns.length} withdrawal${payrollTxns.length === 1 ? "" : "s"}. Nothing unexplained.`;
    } else {
      status = "DISCREPANCY"; confidence = CONFIDENCE.REVIEW;
      const more = difference > 0;
      explanation = `We expected $${fmt(expected)} to leave the bank for ${periodKey} based on the payroll report, but $${fmt(actual)} actually left the account across ${payrollTxns.length} withdrawal${payrollTxns.length === 1 ? "" : "s"}. There is an unexplained $${fmt(Math.abs(difference))} difference that should be investigated — ${more ? "more money left than payroll accounts for, which can be an off-cycle run, a payroll correction, or a withdrawal that isn't payroll at all being counted here" : "less money left than payroll accounts for, which usually means a tax or fee withdrawal hasn't cleared yet or isn't on the statement you uploaded"}.`;
    }

    return {
      period: periodKey, status, confidence,
      expected, actual, difference,
      totals,
      employee_count: lines.length,
      search_window: { from, to },
      breakdown: {
        net_pay: sumAbs(components.net_pay), taxes: sumAbs(components.taxes),
        fees: sumAbs(components.fees), other: sumAbs(components.other),
      },
      matched_transactions: payrollTxns.map((t) => ({ id: t.id, date: t.txn_date, description: t.description, amount: money(t.amount) })),
      explanation,
      evidence: {
        payroll_line_ids: lines.map((l) => l.id),
        transaction_ids: payrollTxns.map((t) => t.id),
      },
    };
  }

  function sumAbs(rows) { return money((rows || []).reduce((s, r) => s + Math.abs(Number(r.amount) || 0), 0)); }
  function shiftDate(iso, days) {
    const t = Date.parse(String(iso) + "T00:00:00Z");
    if (isNaN(t)) return iso;
    const d = new Date(t + days * 86400000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }

  async function saveReconciliation(kind, periodKey, r) {
    await dbRun(
      `INSERT INTO fin_reconciliations (kind, period_key, expected, actual, difference, status, confidence, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [kind, periodKey,
       r.expected != null ? r.expected : (r.expected_ending != null ? r.expected_ending : null),
       r.actual != null ? r.actual : (r.statement ? r.statement.ending_balance : null),
       r.difference != null ? r.difference : null,
       r.status, r.confidence, JSON.stringify(r).slice(0, 200000), nowISO()]
    );
  }

  // ======================= API ===============================
  // Owner / Super Admin only. Enforced here on the server, not by hiding nav.
  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/fin/")) return false;
    // Only claim the routes this module owns, so the existing Financial
    // Center routes in financial-advisor.js keep working untouched.
    const OWNED = /^\/api\/fin\/(docs|documents|unrecognized|vendor-rules|reconcile|ledger|trace)\b/;
    if (!OWNED.test(pathname)) return false;

    if (!user) { json(res, 401, { error: "Not authenticated" }); return true; }
    if (!canView(user)) { json(res, 403, { error: "Financial data is owner-only." }); return true; }

    try {
      // ---- document ledger ----
      if (pathname === "/api/fin/documents" && method === "GET") {
        const rows = await dbAll(
          `SELECT id, filename, doc_type, doc_type_confidence, account_label, period_start, period_end,
                  source, uploaded_at, uploaded_by, processed_at, status, record_count, error_count, notes, byte_size
             FROM fin_documents ORDER BY id DESC LIMIT 200`
        );
        json(res, 200, { documents: rows, doc_types: DOC_TYPES });
        return true;
      }

      if (pathname === "/api/fin/documents/upload" && method === "POST") {
        const b = await readBody(req);
        if (!b.content_base64) { json(res, 400, { error: "No file provided." }); return true; }
        let buffer;
        try {
          let raw = String(b.content_base64);
          const ci = raw.indexOf(",");
          if (raw.startsWith("data:") && ci >= 0) raw = raw.slice(ci + 1);
          buffer = Buffer.from(raw, "base64");
        } catch (e) { json(res, 400, { error: "Could not read that file." }); return true; }

        const r = await ingest({
          filename: b.filename || "upload",
          buffer,
          source: b.source || "upload",
          actorEmail: user.email,
          docTypeOverride: b.doc_type,
          accountLabel: b.account_label,
        });
        if (r.duplicate) {
          json(res, 409, {
            duplicate: true, existing: r.existing,
            error: `This document appears to have already been uploaded — "${r.existing.filename}" on ${String(r.existing.uploaded_at || "").slice(0, 10)}. Nothing was imported again, so your numbers are safe.`,
          });
          return true;
        }
        json(res, r.error ? 400 : 201, r);
        return true;
      }

      const docMatch = pathname.match(/^\/api\/fin\/documents\/(\d+)$/);
      if (docMatch && method === "GET") {
        const id = Number(docMatch[1]);
        const doc = await dbGet("SELECT * FROM fin_documents WHERE id = ?", [id]);
        if (!doc) { json(res, 404, { error: "Not found" }); return true; }
        delete doc.raw_text;
        json(res, 200, {
          document: doc,
          transactions: await dbAll("SELECT * FROM fin_ledger_txns WHERE document_id = ? ORDER BY txn_date, source_row", [id]),
          payroll: await dbAll("SELECT * FROM fin_payroll_lines WHERE document_id = ? ORDER BY source_row", [id]),
          billing: await dbAll("SELECT * FROM fin_billing_lines WHERE document_id = ? ORDER BY source_row LIMIT 1000", [id]),
          unrecognized: await dbAll("SELECT * FROM fin_unrecognized WHERE document_id = ? ORDER BY source_row", [id]),
          statement_periods: await dbAll("SELECT * FROM fin_statement_periods WHERE document_id = ?", [id]),
        });
        return true;
      }

      if (docMatch && method === "DELETE") {
        const id = Number(docMatch[1]);
        // Removing a document removes everything derived from it, so a bad
        // import can be undone cleanly rather than leaving orphan numbers.
        await dbRun("DELETE FROM fin_ledger_txns WHERE document_id = ?", [id]);
        await dbRun("DELETE FROM fin_payroll_lines WHERE document_id = ?", [id]);
        await dbRun("DELETE FROM fin_billing_lines WHERE document_id = ?", [id]);
        await dbRun("DELETE FROM fin_unrecognized WHERE document_id = ?", [id]);
        await dbRun("DELETE FROM fin_statement_periods WHERE document_id = ?", [id]);
        await dbRun("DELETE FROM fin_documents WHERE id = ?", [id]);
        json(res, 200, { ok: true, deleted: id });
        return true;
      }

      // Re-classify a document the detector got wrong, then re-import it.
      const retypeMatch = pathname.match(/^\/api\/fin\/documents\/(\d+)\/doc-type$/);
      if (retypeMatch && method === "PATCH") {
        const id = Number(retypeMatch[1]);
        const b = await readBody(req);
        if (!DOC_TYPES.includes(b.doc_type)) { json(res, 400, { error: "Unknown document type." }); return true; }
        await dbRun("UPDATE fin_documents SET doc_type = ?, doc_type_confidence = ? WHERE id = ?", [b.doc_type, CONFIDENCE.VERIFIED, id]);
        json(res, 200, { ok: true, note: "Type updated. Delete and re-upload the file to re-import its rows with the new type." });
        return true;
      }

      // ---- unrecognized data queue ----
      if (pathname === "/api/fin/unrecognized" && method === "GET") {
        const rows = await dbAll(
          `SELECT u.*, d.filename FROM fin_unrecognized u
             LEFT JOIN fin_documents d ON d.id = u.document_id
            WHERE u.resolved = FALSE ORDER BY u.document_id DESC, u.source_row LIMIT 500`
        );
        json(res, 200, { rows, count: rows.length });
        return true;
      }
      const unrecMatch = pathname.match(/^\/api\/fin\/unrecognized\/(\d+)\/resolve$/);
      if (unrecMatch && method === "POST") {
        await dbRun("UPDATE fin_unrecognized SET resolved = TRUE WHERE id = ?", [Number(unrecMatch[1])]);
        json(res, 200, { ok: true });
        return true;
      }

      // ---- vendor rules (learned categorization) ----
      if (pathname === "/api/fin/vendor-rules" && method === "GET") {
        json(res, 200, { rules: await dbAll("SELECT * FROM fin_vendor_rules ORDER BY category, match_text"), categories: CATEGORIES });
        return true;
      }
      if (pathname === "/api/fin/vendor-rules" && method === "POST") {
        const b = await readBody(req);
        const match = String(b.match_text || "").trim().toLowerCase();
        if (!match) { json(res, 400, { error: "Give me some text from the description to match on." }); return true; }
        if (!CATEGORIES.includes(b.category)) { json(res, 400, { error: "Unknown category." }); return true; }
        await dbRun(
          `INSERT INTO fin_vendor_rules (match_text, vendor, category, created_by, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (match_text) DO UPDATE SET category = EXCLUDED.category, vendor = EXCLUDED.vendor`,
          [match, b.vendor || null, b.category, user.email, nowISO()]
        );
        // Apply it to everything already imported, so a correction is retroactive.
        const applied = await dbAll(
          "SELECT id FROM fin_ledger_txns WHERE LOWER(description) LIKE ?", ["%" + match + "%"]
        );
        for (const t of applied) {
          await dbRun("UPDATE fin_ledger_txns SET category = ?, confidence = ? WHERE id = ?", [b.category, CONFIDENCE.VERIFIED, t.id]);
        }
        json(res, 201, { ok: true, applied_to: applied.length });
        return true;
      }
      const ruleMatch = pathname.match(/^\/api\/fin\/vendor-rules\/(\d+)$/);
      if (ruleMatch && method === "DELETE") {
        await dbRun("DELETE FROM fin_vendor_rules WHERE id = ?", [Number(ruleMatch[1])]);
        json(res, 200, { ok: true });
        return true;
      }

      // ---- normalized ledger (with traceability) ----
      if (pathname === "/api/fin/ledger/transactions" && method === "GET") {
        const where = [], params = [];
        if (query.month) { where.push("month = ?"); params.push(query.month); }
        if (query.category) { where.push("category = ?"); params.push(query.category); }
        if (query.document_id) { where.push("document_id = ?"); params.push(Number(query.document_id)); }
        const sql = `SELECT * FROM fin_ledger_txns ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY txn_date, id LIMIT 2000`;
        json(res, 200, { transactions: await dbAll(sql, params), categories: CATEGORIES });
        return true;
      }
      const txnMatch = pathname.match(/^\/api\/fin\/ledger\/transactions\/(\d+)$/);
      if (txnMatch && method === "PATCH") {
        const b = await readBody(req);
        if (b.category && !CATEGORIES.includes(b.category)) { json(res, 400, { error: "Unknown category." }); return true; }
        if (b.category) {
          await dbRun("UPDATE fin_ledger_txns SET category = ?, confidence = ? WHERE id = ?", [b.category, CONFIDENCE.VERIFIED, Number(txnMatch[1])]);
        }
        json(res, 200, { ok: true });
        return true;
      }

      // Click any number, see the rows behind it.
      if (pathname === "/api/fin/trace" && method === "GET") {
        const ids = String(query.ids || "").split(",").map((n) => Number(n)).filter((n) => n > 0).slice(0, 2000);
        const kind = query.kind || "transactions";
        if (!ids.length) { json(res, 400, { error: "No ids given." }); return true; }
        const table = kind === "payroll" ? "fin_payroll_lines" : kind === "billing" ? "fin_billing_lines" : "fin_ledger_txns";
        const rows = await dbAll(
          `SELECT r.*, d.filename FROM ${table} r LEFT JOIN fin_documents d ON d.id = r.document_id
            WHERE r.id IN (${ids.map(() => "?").join(",")}) ORDER BY r.id`, ids
        );
        json(res, 200, { kind, rows });
        return true;
      }

      // ---- reconciliation ----
      if (pathname === "/api/fin/reconcile/bank" && method === "GET") {
        const month = String(query.month || "");
        if (!/^\d{4}-\d{2}$/.test(month)) { json(res, 400, { error: "Pass ?month=YYYY-MM" }); return true; }
        const r = await reconcileBank(month);
        await saveReconciliation("bank", month, r).catch(() => {});
        json(res, 200, r);
        return true;
      }
      if (pathname === "/api/fin/reconcile/payroll" && method === "GET") {
        const period = String(query.period || query.month || "");
        if (!/^\d{4}-\d{2}$/.test(period)) { json(res, 400, { error: "Pass ?period=YYYY-MM" }); return true; }
        const r = await reconcilePayroll(period);
        await saveReconciliation("payroll", period, r).catch(() => {});
        json(res, 200, r);
        return true;
      }
      // Everything at once, for the reconciliation page.
      if (pathname === "/api/fin/reconcile/overview" && method === "GET") {
        const months = await dbAll(
          `SELECT DISTINCT month FROM (
             SELECT month FROM fin_ledger_txns WHERE month <> ''
             UNION SELECT month FROM fin_payroll_lines WHERE month IS NOT NULL AND month <> ''
           ) m ORDER BY month DESC LIMIT 18`
        );
        const out = [];
        for (const row of months) {
          const month = row.month;
          if (!month) continue;
          const bank = await reconcileBank(month);
          const payroll = await reconcilePayroll(month);
          out.push({ month, bank, payroll });
        }
        json(res, 200, { months: out });
        return true;
      }

      return false;
    } catch (e) {
      console.error("fin-ledger error:", e);
      json(res, 500, { error: "Financial Center error: " + e.message });
      return true;
    }
  }

  return {
    initTables,
    handleApi,
    ingest,
    reconcileBank,
    reconcilePayroll,
    saveReconciliation,
    // exported for the routes file and for tests
    _lib: {
      headerIndex, findHeaderRow,
      ingest, reconcileBank, reconcilePayroll, fmt, shiftDate,
      parseBankTable, parseBankLines, parseStatementTotals,
      parsePayrollTable, parseBillingTable,
      CONFIDENCE, DOC_TYPES, CATEGORIES, SEED_RULES,
      num, money, isMoneyish, normDate, monthOf, pad, daysBetween,
      parseCsv, parseXlsx, readDocument,
      detectDocType, detectPeriod, yearHint,
      loadVendorRules, guessVendor, categorizeWith,
      canView, role,
    },
  };
};
