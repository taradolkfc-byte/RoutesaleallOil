const SHEET_ID = "1NIsXwTi6tKmYtX8DoTUqvG4mxW-5Y5YVJB0EfmQMCvY";

// URL Apps Script ของคุณ
const WEB_APP_URL = "https://script.google.com/macros/s/AKfycbxu0zeUAfHU1YBI0KJRTFC97xRTsPvXPx8cbw-8iXKqzHomAy0T48reAcQouaS0Ob1A/exec";

const SHEET_NAMES = {
  pump: "ตารางปรับปรุงปั๊ม",
  repair: "ตารางซ่อม",
  market: "พื้นที่เซลล์ออกตลาด",
  sales: "รายงานยอดขาย",
  saved: "เก็บข้อมูล"
};

const START_POINTS = [
  { name: "สามทองบริการ", lat: 16.3811263508237, lng: 103.3487862676390, bu: "ST" },
  { name: "ปั๊ม เค.ซี.ปิโตรเลียม2006", alias: "เค.ซี.ปิโตรเลียม2006", lat: 16.7160212825713, lng: 103.0820493667620, bu: "KN" },
  { name: "ปั๊ม เค.ซี.จี.ปิโตรเลียม", alias: "เค.ซี.จี.ปิโตรเลียม", lat: 16.4359292973822, lng: 104.6162612319160, bu: "MUK" },
  { name: "ปั๊ม เค.ซี.กรีน เอ็นเนอร์จี", alias: "เค.ซี. กรีน เอ็นเนอร์จี", lat: 17.6294000000000, lng: 103.7675890000000, bu: "WNN" }
];

const START_POINT_BU_MAP = {
  "สามทองบริการ": "ST",
  "เค.ซี.ปิโตรเลียม2006": "KN",
  "ปั๊ม เค.ซี.ปิโตรเลียม2006": "KN",
  "เค.ซี.จี.ปิโตรเลียม": "MUK",
  "ปั๊ม เค.ซี.จี.ปิโตรเลียม": "MUK",
  "เค.ซี. กรีน เอ็นเนอร์จี": "WNN",
  "ปั๊ม เค.ซี.กรีน เอ็นเนอร์จี": "WNN"
};


const BU_BRANCH_NAME_MAP = {
  ST: "สามทองบริการ",
  KN: "เค.ซี.ปิโตรเลียม2006",
  MUK: "เค.ซี.จี.ปิโตรเลียม",
  KCG: "เค.ซี.จี.ปิโตรเลียม",
  WNN: "เค.ซี. กรีน เอ็นเนอร์จี"
};

function branchNameFromBU(bu) {
  const key = cleanText(bu).toUpperCase();
  return BU_BRANCH_NAME_MAP[key] || cleanText(bu);
}

function selectedRouteMeta() {
  const key = cleanText(selectedRouteKey);
  const m = key.match(/(?:^|\s)(ST|KN|MUK|KCG|WNN)\s+สาย\s+(\d{1,3})/i);
  if (!m) return { bu: "", meter: "" };
  return { bu: m[1].toUpperCase(), meter: `MT-${m[2]}` };
}

function applySelectedRouteToForm(form) {
  const meta = selectedRouteMeta();
  if (!form || (!meta.bu && !meta.meter)) return;
  if (meta.bu && form.elements.bu) form.elements.bu.value = branchNameFromBU(meta.bu);
  if (meta.meter && form.elements.meter) form.elements.meter.value = meta.meter;
}

const CHECKIN_RADIUS_METER = 100;
const MAX_PLAN_DAYS = 7;
const MAX_STOPS_PER_DAY = 16;
// จำกัดจำนวนจุดที่ส่งเข้า Map และ Google Maps ให้ตรงกัน ไม่เกิน 9 จุด ตามเงื่อนไขใช้งานจริง
const MAX_ROUTE_CUSTOMER_STOPS = 9;

let rawRows = [];
let plannedRows = [];
let currentRouteGroups = new Map();
let selectedRouteKey = "";
let routeCollapsedToSelected = false;
let routeMap = null;
let routeLayer = null;
let visitedSet = { ids: new Set(), names: new Set() };
let customerMasterRows = [];
let savedVisitRowsRaw = [];
let savedHeaderMap = {};

function cleanText(v) { return String(v ?? "").trim(); }
function norm(v) { return cleanText(v).toLowerCase().replace(/\s+/g, " "); }
function cell(row, index) { return row[index] ?? ""; }
function toNumber(v) {
  const n = Number(cleanText(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}
function validCoord(row) { return toNumber(row.lat) !== null && toNumber(row.lng) !== null; }

function headerMap_(rows) {
  const header = Array.isArray(rows) && rows.length ? rows[0] : [];
  const map = {};
  header.forEach((h, i) => {
    const k = norm(h);
    if (k) map[k] = i;
  });
  return map;
}

function cellByHeaders_(row, map, names, fallbackIndex) {
  for (const name of names) {
    const idx = map[norm(name)];
    if (idx !== undefined) {
      const v = cell(row, idx);
      if (cleanText(v) !== '') return v;
    }
  }
  return fallbackIndex === undefined ? '' : cell(row, fallbackIndex);
}


async function fetchSheetByIndex(sheetName, optional = false) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(sheetName)}&cachebust=${Date.now()}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    if (optional) return [];
    throw new Error(`โหลดชีต ${sheetName} ไม่ได้`);
  }
  const text = await res.text();
  const jsonText = text.substring(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const json = JSON.parse(jsonText);
  return json.table.rows.map(r => (r.c || []).map(c => c ? (c.f || c.v || "") : ""));
}



// ===== Robust dashboard saved-sheet reader =====
// ใช้สำหรับ Dashboard ย้อนหลังโดยเฉพาะ เพื่ออ่านชีต "เก็บข้อมูล" ให้ตรงคอลัมน์จริง
// สาเหตุที่ Dashboard ไม่ขึ้น: Google Visualization API มักส่ง "หัวตาราง" อยู่ใน json.table.cols
// ไม่ได้ส่งหัวตารางเป็นแถวแรก ถ้าใช้ rows.slice(1) จะตัดข้อมูลแถวแรกทิ้ง ทำให้มีข้อมูลในชีตแต่ Dashboard เป็น 0
const SAVED_EXPECTED_HEADERS = [
  "วันที่บันทึกระบบ",
  "วันที่ออกตลาด",
  "ประเภทงาน",
  "รหัสลูกค้า",
  "ชื่อลูกค้า/ชื่อปั๊ม",
  "BU/สังกัด",
  "สายมิเตอร์",
  "พื้นที่",
  "ผู้ประสานงาน",
  "เบอร์โทร",
  "ละติจูด",
  "ลองจิจูด",
  "หมายเหตุ",
  "สถานะเข้าพบ"
];

function gvizCellValue(c) {
  if (!c) return "";
  if (c.f !== undefined && c.f !== null && cleanText(c.f) !== "") return c.f;
  if (c.v !== undefined && c.v !== null) return c.v;
  return "";
}

function isLikelySavedHeaderRow(row) {
  const text = (row || []).map(normalizeHeaderNameForSaved).join("|");
  return text.includes(normalizeHeaderNameForSaved("วันที่บันทึกระบบ")) ||
         text.includes(normalizeHeaderNameForSaved("วันที่ออกตลาด")) ||
         text.includes(normalizeHeaderNameForSaved("ประเภทงาน"));
}

function parseSavedGvizTable(json) {
  const cols = ((json && json.table && json.table.cols) || []);
  const gvizHeaders = cols.map(c => cleanText(c.label || c.id || ""));
  const hasRealHeaders = gvizHeaders.some(h => normalizeHeaderNameForSaved(h) === normalizeHeaderNameForSaved("วันที่บันทึกระบบ")) ||
                         gvizHeaders.some(h => normalizeHeaderNameForSaved(h) === normalizeHeaderNameForSaved("ประเภทงาน"));
  const headers = hasRealHeaders ? gvizHeaders : SAVED_EXPECTED_HEADERS;

  let rows = (((json && json.table && json.table.rows) || [])).map(r => {
    const values = (r.c || []).map(gvizCellValue);
    while (values.length < headers.length) values.push("");
    return values;
  }).filter(r => r.some(v => cleanText(v) !== ""));

  // กันกรณี Google ส่งหัวตารางติดมาใน rows ด้วย
  if (rows.length && isLikelySavedHeaderRow(rows[0])) rows = rows.slice(1);

  return [headers, ...rows];
}

async function fetchSavedGvizByQuery(queryPart) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&${queryPart}&headers=1&cachebust=${Date.now()}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`โหลดชีตเก็บข้อมูลไม่ได้ (${res.status})`);
  const text = await res.text();
  const jsonText = text.substring(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const json = JSON.parse(jsonText);
  return parseSavedGvizTable(json);
}

async function fetchSavedSheetRowsRobust() {
  // วิธีหลัก: อ่านด้วยชื่อชีต "เก็บข้อมูล"
  try {
    const rows = await fetchSavedGvizByQuery(`sheet=${encodeURIComponent(SHEET_NAMES.saved)}`);
    if (rows && rows.length > 1) return rows;
  } catch (err) {}

  // วิธีสำรอง: อ่านด้วย gid ของชีต “เก็บข้อมูล” ตาม URL ที่ใช้งานจริง
  try {
    const rows = await fetchSavedGvizByQuery(`gid=352387367`);
    if (rows && rows.length > 1) return rows;
  } catch (err) {}

  // คืนหัวตารางไว้ก่อน เพื่อให้ Dashboard ไม่ error แม้ยังไม่มีข้อมูล
  return [SAVED_EXPECTED_HEADERS];
}

function normalizeHeaderNameForSaved(v) {
  return cleanText(v).replace(/[\s\u200B\u00A0]+/g, "").replace(/[“”"']/g, "");
}

function buildSavedHeaderMap(rows) {
  const header = (rows && rows[0]) ? rows[0] : [];
  const map = {};
  header.forEach((h, i) => {
    const key = cleanText(h);
    const normalizedKey = normalizeHeaderNameForSaved(h);
    if (key) map[key] = i;
    if (normalizedKey) map[normalizedKey] = i;
  });
  return map;
}

function savedCell(row, headerName, fallbackIndex) {
  const direct = headerName;
  const normalized = normalizeHeaderNameForSaved(headerName);
  const idx = savedHeaderMap && Object.prototype.hasOwnProperty.call(savedHeaderMap, direct)
    ? savedHeaderMap[direct]
    : (savedHeaderMap && Object.prototype.hasOwnProperty.call(savedHeaderMap, normalized)
      ? savedHeaderMap[normalized]
      : fallbackIndex);
  return cell(row, idx);
}

function parseDateTH(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const txt = cleanText(value).replace(/ปี/g, "").replace(/เดือน/g, "").trim();

  const gviz = txt.match(/Date\((\d+),(\d+),(\d+)/);
  if (gviz) return new Date(Number(gviz[1]), Number(gviz[2]), Number(gviz[3]));

  const parts = txt.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (parts) {
    let day = Number(parts[1]);
    let month = Number(parts[2]);
    let y = Number(parts[3]);
    if (y < 100) y += 2500;
    if (y > 2400) y -= 543;
    return new Date(y, month - 1, day);
  }

  const months = {
    "ม.ค.":0,"มค":0,"มกราคม":0,
    "ก.พ.":1,"กพ":1,"กุมภาพันธ์":1,
    "มี.ค.":2,"มีค":2,"มีนาคม":2,
    "เม.ย.":3,"เมย":3,"เมษายน":3,
    "พ.ค.":4,"พค":4,"พฤษภาคม":4,
    "มิ.ย.":5,"มิย":5,"มิถุนายน":5,
    "ก.ค.":6,"กค":6,"กรกฎาคม":6,
    "ส.ค.":7,"สค":7,"สิงหาคม":7,
    "ก.ย.":8,"กย":8,"กันยายน":8,
    "ต.ค.":9,"ตค":9,"ตุลาคม":9,
    "พ.ย.":10,"พย":10,"พฤศจิกายน":10,
    "ธ.ค.":11,"ธค":11,"ธันวาคม":11
  };

  const th = txt.split(/\s+/).filter(Boolean);
  if (th.length >= 3) {
    const day = Number(th[0]);
    const monthTxt = th[1].replace(/\s/g, "");
    let y = Number(th[2]);
    if (Number.isFinite(day) && months[monthTxt] !== undefined && Number.isFinite(y)) {
      if (y < 100) y += 2500;
      if (y > 2400) y -= 543;
      return new Date(y, months[monthTxt], day);
    }
  }
  return null;
}

function thaiNow() {
  const now = new Date();
  const th = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
  th.setHours(0, 0, 0, 0);
  return th;
}
function monthStart(d = thaiNow()) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function nextMonthStart(d = thaiNow()) { return new Date(d.getFullYear(), d.getMonth() + 1, 1); }
function inCurrentThaiMonth(d) {
  if (!d || Number.isNaN(d.getTime())) return false;
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return t >= monthStart() && t < nextMonthStart();
}
function dateSortValue(d) { return d ? d.getTime() : 9999999999999; }
function thaiMonthYearLabel() { return thaiNow().toLocaleDateString("th-TH", { month: "long", year: "numeric" }); }
function addDaysTH(d, days) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + days);
  return x;
}
function thaiDateLabel(d) {
  return d.toLocaleDateString("th-TH", { weekday:"short", day:"numeric", month:"long", year:"2-digit" });
}
function getPlanSettings() {
  const modeEl = document.getElementById("planMode");
  const daysEl = document.getElementById("planDays");
  const mode = modeEl ? modeEl.value : "pump";
  let days = daysEl ? Number(daysEl.value) : 1;
  if (!Number.isFinite(days)) days = 1;
  days = Math.max(1, Math.min(MAX_PLAN_DAYS, days));
  return { mode, days };
}

function getSelectedStartPointName() {
  const el = document.getElementById("startPointInput");
  const value = cleanText(el ? el.value : "");
  if (!value || value === "อัตโนมัติ") return "";
  return value;
}

function getSelectedStartPoint() {
  const selected = getSelectedStartPointName();
  if (!selected) return null;
  const key = norm(selected);
  return START_POINTS.find(p =>
    norm(p.name) === key ||
    norm(p.alias || "") === key ||
    key.includes(norm(p.alias || p.name)) ||
    norm(p.name).includes(key)
  ) || null;
}

function getSelectedStartBU() {
  const point = getSelectedStartPoint();
  if (point && point.bu) return point.bu;
  const selected = getSelectedStartPointName();
  return START_POINT_BU_MAP[selected] || "";
}

function startForRoute(points) {
  return getSelectedStartPoint() || bestStartForRoute(points);
}

function inferBU(customerId, fallback = "") {
  const id = cleanText(customerId).toUpperCase();
  if (id.startsWith("ST")) return "ST";
  if (id.startsWith("KN")) return "KN";
  if (id.startsWith("MUK")) return "MUK";
  if (id.startsWith("WNN")) return "WNN";
  if (id.startsWith("KCG")) return "KCG";
  return cleanText(fallback);
}

function inferBUFromAnyText(...values) {
  const text = values.map(v => cleanText(v).toUpperCase()).join(" ");

  // ตรวจจากรหัสลูกค้า / คำที่อยู่ในข้อความ
  if (/\bST\d+/.test(text) || text.includes(" ST ") || text.startsWith("ST") || text.includes("สามทอง")) return "ST";
  if (/\bKN\d+/.test(text) || text.includes(" KN ") || text.startsWith("KN")) return "KN";
  if (/\bMUK\d+/.test(text) || text.includes(" MUK ") || text.startsWith("MUK")) return "MUK";
  if (/\bWNN\d+/.test(text) || text.includes(" WNN ") || text.startsWith("WNN")) return "WNN";
  if (/\bKCG\d+/.test(text) || text.includes(" KCG ") || text.startsWith("KCG")) return "KCG";

  return "";
}
function normalizeMeter(v) {
  const s = cleanText(v).toUpperCase();
  const m = s.match(/(?:MT|TR)?\s*-?\s*(\d{1,3})/);
  return m ? m[1] : s;
}
function statusGroup(status) {
  const s = cleanText(status).toLowerCase();
  if (s.includes("lost customer") || s === "lost" || s.includes("lost")) return "ลูกค้าหาย";
  if (s.includes("dormant")) return "ลูกค้าหายเกิน 60 วัน";
  if (s.includes("risky")) return "ลูกค้าเสี่ยงหาย";
  if (s.includes("active")) return "ลูกค้าซื้อขายประจำ";
  if (s.includes("winback") || s.includes("new")) return "ลูกค้าใหม่/Winback";
  return "อื่นๆ";
}
function marketScore(status) {
  const g = statusGroup(status);
  if (g === "ลูกค้าหาย") return 1;
  if (g === "ลูกค้าหายเกิน 60 วัน") return 2;
  if (g === "ลูกค้าเสี่ยงหาย") return 3;
  if (g === "ลูกค้าใหม่/Winback") return 4;
  if (g === "ลูกค้าซื้อขายประจำ") return 5;
  return 9;
}

function getMarketStatusFilterValue() {
  const el = document.getElementById("marketStatusFilter");
  return el ? cleanText(el.value).toLowerCase() : "";
}
function marketStatusFilterMatch(row, filterValue) {
  // ใช้เฉพาะ Dropdown "เลือกสถานะ" สำหรับโหมดวันปกติ/ออกตลาดทั่วไป
  // เขียนให้เทียบได้ทั้งค่าภาษาอังกฤษใน Sheet และกลุ่มภาษาไทยจาก statusGroup()
  if (!filterValue) return true;
  const s = cleanText(row && row.status).toLowerCase();
  const g = statusGroup(row && row.status);
  if (filterValue === "lost") {
    return g === "ลูกค้าหาย" || (s.includes("lost") && !s.includes("dormant") && !s.includes(">60"));
  }
  if (filterValue === "risky") {
    return g === "ลูกค้าเสี่ยงหาย" || s.includes("risky");
  }
  if (filterValue === "active") {
    return g === "ลูกค้าซื้อขายประจำ" || s === "active" || s.includes("active");
  }
  if (filterValue === "winback") {
    return g === "ลูกค้าใหม่/Winback" || s.includes("winback") || s.includes("new");
  }
  if (filterValue === "dormant") {
    return g === "ลูกค้าหายเกิน 60 วัน" || s.includes("dormant") || s.includes(">60") || s.includes("60");
  }
  return true;
}

function hasMarketStatusFilterSelected() {
  return !!getMarketStatusFilterValue();
}

function angleFromCenter(center, p) {
  return Math.atan2(toNumber(p.lat) - center.lat, toNumber(p.lng) - center.lng);
}

function statusLoopRoutePenalty(start, route) {
  if (!route || route.length < 3) return 0;
  let penalty = 0;
  const ds = route.map(p => haversine(start, { lat: toNumber(p.lat), lng: toNumber(p.lng) }));
  const maxD = Math.max(...ds, 0);

  // ลดเคสวิ่งออกไปไกลแล้ววกกลับมาใกล้ฐานกลางทาง จากนั้นออกไปไกลอีกครั้ง
  for (let i = 1; i < ds.length - 1; i++) {
    if (maxD > 0 && ds[i] < maxD * 0.42 && ds[i - 1] > ds[i] + 5 && ds[i + 1] > ds[i] + 5) {
      penalty += 90;
    }
  }

  // ลดการหักกลับรุนแรง
  penalty += routeTurnPenalty(start, route) * 2.2;
  return penalty;
}


function orientation2D(a, b, c) {
  const val = (b.lng - a.lng) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lng - a.lng);
  if (Math.abs(val) < 1e-12) return 0;
  return val > 0 ? 1 : -1;
}

function segmentsCross2D(a, b, c, d) {
  const o1 = orientation2D(a, b, c);
  const o2 = orientation2D(a, b, d);
  const o3 = orientation2D(c, d, a);
  const o4 = orientation2D(c, d, b);
  return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4;
}

function routeCrossPenalty(start, route) {
  // ลงโทษเส้นที่ตัดกัน เพราะมักหมายถึงลำดับวิ่งวนกลับไปกลับมา ไม่เป็นวงกลม
  if (!route || route.length < 4) return 0;
  const pts = [{ lat: Number(start.lat), lng: Number(start.lng) }, ...route.map(p => ({ lat: toNumber(p.lat), lng: toNumber(p.lng) })), { lat: Number(start.lat), lng: Number(start.lng) }];
  let crosses = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    for (let j = i + 2; j < pts.length - 1; j++) {
      if (i === 0 && j === pts.length - 2) continue; // เส้นออกจากฐานกับเส้นกลับฐานเป็นเส้นติดกันของวง
      if (segmentsCross2D(pts[i], pts[i + 1], pts[j], pts[j + 1])) crosses++;
    }
  }
  return crosses * 160;
}

function routeDistanceWavePenalty(start, route) {
  // ลดการวิ่งใกล้ฐาน -> ไกล -> ใกล้ -> ไกล หลายรอบ
  // เส้นทางที่ดีควรไหลเป็นวง มีช่วงออกจากฐานและช่วงวนกลับ ไม่สลับขึ้นลงหลายครั้ง
  if (!route || route.length < 5) return 0;
  const ds = route.map(p => haversine(start, { lat: toNumber(p.lat), lng: toNumber(p.lng) }));
  const maxD = Math.max(...ds, 0);
  if (!maxD) return 0;
  let penalty = 0;
  let switches = 0;
  let lastSign = 0;
  for (let i = 1; i < ds.length; i++) {
    const diff = ds[i] - ds[i - 1];
    const sign = Math.abs(diff) < Math.max(1.5, maxD * 0.04) ? 0 : (diff > 0 ? 1 : -1);
    if (sign && lastSign && sign !== lastSign) switches++;
    if (sign) lastSign = sign;
  }
  if (switches > 2) penalty += (switches - 2) * 55;

  for (let i = 1; i < ds.length - 1; i++) {
    const isDeepValley = ds[i] < maxD * 0.45 && ds[i - 1] > ds[i] + maxD * 0.14 && ds[i + 1] > ds[i] + maxD * 0.14;
    if (isDeepValley) penalty += 95;
  }
  return penalty;
}

function statusRouteScore(start, route) {
  // คะแนนสำหรับ Dropdown “เลือกสถานะ” เท่านั้น
  // ระยะทางยังสำคัญ แต่เพิ่มน้ำหนักการไม่ตัดกัน/ไม่วกกลับ เพื่อให้เป็นวงกลมขึ้น
  return routeDistanceFromStart(start, route)
    + statusLoopRoutePenalty(start, route)
    + routeTurnPenalty(start, route) * 2.4
    + routeCrossPenalty(start, route)
    + routeDistanceWavePenalty(start, route);
}

function buildStatusLoopCandidates(start, valid) {
  const candidates = [];
  const add = (route) => {
    if (!route || route.length !== valid.length) return;
    candidates.push(route);
    candidates.push(pullPointsThatAreOnTheWay(start, route));
    if (route.length >= 5) candidates.push(twoOptClosedRoute(start, route));
  };

  const center = {
    lat: valid.reduce((sum, p) => sum + toNumber(p.lat), 0) / valid.length,
    lng: valid.reduce((sum, p) => sum + toNumber(p.lng), 0) / valid.length
  };

  const byCenterAsc = [...valid].sort((a, b) => angleFromCenter(center, a) - angleFromCenter(center, b));
  const byCenterDesc = [...byCenterAsc].reverse();
  const byStartAsc = [...valid].sort((a, b) => angleFromStart(start, a) - angleFromStart(start, b));
  const byStartDesc = [...byStartAsc].reverse();
  const farFirst = [...valid].sort((a, b) =>
    haversine(start, { lat: toNumber(b.lat), lng: toNumber(b.lng) }) -
    haversine(start, { lat: toNumber(a.lat), lng: toNumber(a.lng) })
  );

  [byCenterAsc, byCenterDesc, byStartAsc, byStartDesc, farFirst, [...farFirst].reverse()].forEach(base => {
    add(base);
    for (let i = 0; i < base.length; i++) {
      add([...base.slice(i), ...base.slice(0, i)]);
    }
  });

  // เพิ่ม candidate จากอัลกอริทึมเดิม/ทั่วไป เพื่อไม่ให้พลาดเคสที่ระยะสั้นจริง ๆ
  add(nearestNeighborOrder(start, valid));
  add(farthestInsertionOrder(start, valid));
  add(orderCircularRoute(start, valid));

  const seen = new Set();
  return candidates.filter(route => {
    const key = uniqueRouteCandidateKey(route);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function statusLoopCenter_(start, pts) {
  // ใช้จุดเริ่มร่วมกับลูกค้า เพื่อให้วงกวาดกลับเข้าฐาน ไม่ใช่วงเฉพาะกลุ่มลูกค้าอย่างเดียว
  const all = [
    { lat: Number(start.lat), lng: Number(start.lng) },
    ...pts.map(p => ({ lat: toNumber(p.lat), lng: toNumber(p.lng) }))
  ].filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  return {
    lat: all.reduce((sum, p) => sum + p.lat, 0) / all.length,
    lng: all.reduce((sum, p) => sum + p.lng, 0) / all.length
  };
}

function normalizeAngle_(a) {
  while (a < 0) a += Math.PI * 2;
  while (a >= Math.PI * 2) a -= Math.PI * 2;
  return a;
}

function statusCircularityScore(start, route) {
  // คะแนนนี้ใช้เฉพาะ Dropdown "เลือกสถานะ"
  // ให้ความสำคัญกับ "วงกลมแบบรูปตัวอย่าง" มากกว่าการหาเส้นตรงสั้นสุดแบบ TSP
  // เพราะ TSP/2-opt บางครั้งทำให้ลำดับกระโดดข้ามโซนและดูไม่เป็นวง
  if (!route || !route.length) return Infinity;
  const dist = routeDistanceFromStart(start, route);
  const cross = routeCrossPenalty(start, route) * 2.6;
  const turn = routeTurnPenalty(start, route) * 2.8;
  const wave = routeDistanceWavePenalty(start, route) * 2.4;

  const ds = route.map(p => haversine(start, { lat: toNumber(p.lat), lng: toNumber(p.lng) }));
  const sortedDs = [...ds].sort((a, b) => a - b);
  const nearest = sortedDs[0] || 0;
  const maxD = sortedDs[sortedDs.length - 1] || 0;

  // จุดแรกควรเป็นจุดที่ออกจากฐานแล้วเริ่มเข้าวงได้ง่าย ไม่บังคับใกล้ที่สุด 100%
  // แต่ถ้าเลือกจุดไกลมากเป็นจุดแรก จะเกิดเส้นยาวพุ่งออกไปก่อน ดูไม่เป็นวง
  const firstD = ds[0] || 0;
  const firstPenalty = Math.max(0, firstD - Math.max(nearest * 1.45, 8)) * 5.5;

  // จุดสุดท้ายควรอยู่ในแนวกลับฐานพอสมควร ถ้าไกลเกินไปจะดูเหมือนเส้นไปกลับ
  const lastD = ds[ds.length - 1] || 0;
  const lastPenalty = maxD ? Math.max(0, lastD - maxD * 0.82) * 2.5 : 0;

  return dist + cross + turn + wave + firstPenalty + lastPenalty;
}

function buildStrictStatusCircleCandidates(start, valid) {
  const center = statusLoopCenter_(start, valid);
  const withAngle = valid.map(p => ({
    ...p,
    __angle: normalizeAngle_(Math.atan2(toNumber(p.lat) - center.lat, toNumber(p.lng) - center.lng))
  }));

  const asc = [...withAngle].sort((a, b) => a.__angle - b.__angle);
  const desc = [...asc].reverse();
  const candidates = [];

  const clean = (route) => route.map(({ __angle, ...p }) => p);
  const addRotations = (base) => {
    for (let i = 0; i < base.length; i++) {
      candidates.push(clean([...base.slice(i), ...base.slice(0, i)]));
    }
  };

  // วงกลมแท้: เรียงตามมุมรอบ centroid แล้วลองทุกจุดเป็นจุดเริ่ม และลองทั้งสองทิศทาง
  addRotations(asc);
  addRotations(desc);

  // เพิ่มอีกชุดโดยใช้ centroid เฉพาะลูกค้า เผื่อจุดเริ่มอยู่ไกลจนดึงวงเบี้ยวเกินไป
  const pureCenter = {
    lat: valid.reduce((sum, p) => sum + toNumber(p.lat), 0) / valid.length,
    lng: valid.reduce((sum, p) => sum + toNumber(p.lng), 0) / valid.length
  };
  const pure = valid.map(p => ({
    ...p,
    __angle: normalizeAngle_(Math.atan2(toNumber(p.lat) - pureCenter.lat, toNumber(p.lng) - pureCenter.lng))
  }));
  const pureAsc = [...pure].sort((a, b) => a.__angle - b.__angle);
  const pureDesc = [...pureAsc].reverse();
  addRotations(pureAsc);
  addRotations(pureDesc);

  const seen = new Set();
  return candidates.filter(route => {
    const key = uniqueRouteCandidateKey(route);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function orderStatusFilterRoute(start, points) {
  // ใช้เฉพาะเมื่อเลือก Dropdown "เลือกสถานะ" ทั้ง 5 สถานะเท่านั้น
  // หลักใหม่: ห้ามใช้ TSP/2-opt เป็นตัวหลัก เพราะแม้ระยะสั้น แต่ลำดับมักกระโดดและไม่เป็นวง
  // ให้เรียงแบบกวาดมุมรอบพื้นที่เป็นวงปิดเหมือนรูปตัวอย่าง แล้วเลือกทิศ/จุดเริ่มที่เสียระยะน้อยสุด
  const validAll = (points || []).filter(validCoord).map(p => ({ ...p }));
  const noCoord = (points || []).filter(p => !validCoord(p));
  const valid = validAll.slice(0, MAX_ROUTE_CUSTOMER_STOPS);
  if (valid.length <= 2) return [...valid, ...noCoord];

  const candidates = buildStrictStatusCircleCandidates(start, valid);
  let best = (candidates.length ? candidates : [valid])
    .sort((a, b) => statusCircularityScore(start, a) - statusCircularityScore(start, b))[0] || valid;

  // กันเส้นตัดกันแบบเบา ๆ เท่านั้น ห้าม 2-opt เพราะจะทำให้วงที่เรียงดีแล้วแตกเป็นลำดับกระโดด
  // ถ้ามีเส้นตัดกัน ให้ลองกลับทิศทั้งวง ไม่สลับจุดภายใน
  const rev = [...best].reverse();
  if (statusCircularityScore(start, rev) < statusCircularityScore(start, best) * 0.97) best = rev;

  return [...best, ...noCoord];
}
function getUrgencyScore(urgency, dateObj) {
  const u = cleanText(urgency);
  const d = dateObj ? Math.ceil((dateObj - thaiNow()) / 86400000) : 99999;
  if (u.includes("ยาก") || u.includes("เร่งด่วน")) return d <= 3 ? 1 : 2;
  if (u.includes("ปานกลาง")) return d <= 15 ? 2 : 3;
  if (u.includes("ง่าย")) return d <= 30 ? 3 : 4;
  return 4;
}

function isVisited(row) {
  const id = norm(row.customer_id);
  const name = norm(row.customer_name);
  return (id && visitedSet.ids.has(id)) || (name && visitedSet.names.has(name));
}
function isCompleted(row) {
  return isVisited(row);
}
function completedLabel(row) {
  return isCompleted(row) ? "✓ เข้าบริการแล้ว" : "รอเข้าบริการ";
}
function buildVisitedSet(savedRows) {
  const ids = new Set();
  const names = new Set();
  savedRows.slice(1).forEach(r => {
    const visitDate = parseDateTH(cell(r, 1)) || parseDateTH(cell(r, 0));
    if (visitDate && !inCurrentThaiMonth(visitDate)) return;

    // โครงสร้างชีตใหม่: 0 วันที่บันทึก, 1 วันที่ออกตลาด, 2 ประเภท, 3 รหัส, 4 ชื่อ, ... 14 สถานะเข้าพบ
    // ถ้าเป็นข้อมูลเก่าไม่มีคอลัมน์สถานะ ให้ถือว่า “สำเร็จ” เพื่อไม่ให้จุดเก่ากลับมาในแผน
    const visitStatus = cleanText(savedCell(r, "สถานะเข้าพบ", 13) || "สำเร็จ");
    if (visitStatus && visitStatus !== "สำเร็จ") return;

    const idCandidates = [cell(r, 3), cell(r, 2)];
    const nameCandidates = [cell(r, 4), cell(r, 3)];
    idCandidates.map(norm).filter(Boolean).forEach(x => ids.add(x));
    nameCandidates.map(norm).filter(Boolean).forEach(x => names.add(x));
  });
  return { ids, names };
}

function normalizePump(rows) {
  return rows.slice(1)
    .filter(r => cleanText(cell(r,5)) !== "เสร็จ")
    .filter(r => cleanText(cell(r,5)) === "ยังไม่เริ่ม" || cleanText(cell(r,5)) !== "")
    .map(r => {
      const dateObj = parseDateTH(cell(r,4));
      const customerId = cell(r,1);
      const meterRaw = cell(r,3);
      return {
        sourceRank: 1, priority: 100, priorityLabel: "1-ปรับปรุงปั๊ม", type: "ปรับปรุงปั๊ม",
        dateRaw: cell(r,4), dateObj, customer_id: customerId, customer_name: cell(r,2), status: cell(r,5),
        bu: inferBU(customerId), meter: meterRaw, meterKey: normalizeMeter(meterRaw), area: "", purpose: "ปรับปรุงปั๊ม",
        coordinator: "", phone: "", lat: cell(r,6), lng: cell(r,7), sales_litre: "", route_group: "", stop_no: "", start_name: ""
      };
    });
}
function isRepairOpenStatus(status) {
  const s = cleanText(status).toLowerCase();
  // ตารางซ่อมให้แสดงทุกงานที่มีข้อมูลในเดือนนั้น ยกเว้นเฉพาะ Column K = "แล้วเสร็จ" เท่านั้น
  // หมายเหตุ: บางครั้ง Google Sheets ส่งค่าดรอปดาวว่าง/อ่านค่าไม่ทัน จึงห้ามตัดทิ้งเพราะสถานะว่าง
  return !s.includes("แล้วเสร็จ");
}

function normalizeRepair(rows) {
  const hmap = headerMap_(rows);

  return rows.slice(1)
    // กันแถวว่าง แต่ไม่ตัดงานซ่อมที่สถานะว่าง เพราะเงื่อนไขคือ ตัดเฉพาะ "แล้วเสร็จ" เท่านั้น
    // อ่านตามชื่อหัวคอลัมน์ก่อน เพื่อป้องกันคอลัมน์เลื่อน/เพิ่มช่องว่างแล้วข้อมูลบางแถวหาย
    .filter(r => {
      const customerName = cellByHeaders_(r, hmap, ["ชื่อปั๊ม", "ชื่อลูกค้า/ชื่อปั๊ม", "ชื่อลูกค้า"], 1);
      const apptDate = cellByHeaders_(r, hmap, ["วันที่นัดหมาย", "วันที่ต้องเข้า", "วันที่เข้าซ่อม"], 8);
      const lat = cellByHeaders_(r, hmap, ["ละ", "ละติจูด", "lat", "latitude"], 11);
      const lng = cellByHeaders_(r, hmap, ["ลอง", "ลองจิจูด", "lng", "long", "longitude"], 12);
      return cleanText(customerName) || cleanText(apptDate) || cleanText(lat) || cleanText(lng);
    })
    .filter(r => {
      const status = cellByHeaders_(r, hmap, ["สถานะ", "สถานะซ่อม"], 10);
      return isRepairOpenStatus(status);
    })
    .map((r, repairRowIndex) => {
      const customerName = cellByHeaders_(r, hmap, ["ชื่อปั๊ม", "ชื่อลูกค้า/ชื่อปั๊ม", "ชื่อลูกค้า"], 1);
      const meterRaw = cellByHeaders_(r, hmap, ["สายมิเตอร์", "มิเตอร์", "สาย"], 2);
      const area = cellByHeaders_(r, hmap, ["เขตพื้นที่", "พื้นที่", "ตำบล/อำเภอ/จังหวัด"], 3);
      const repairWork = cellByHeaders_(r, hmap, ["ซ่อมบำรุง", "รายการซ่อม", "งานซ่อม"], 4);
      const coordinator = cellByHeaders_(r, hmap, ["ผู้ประสานงาน", "ผู้ติดต่อ"], 6);
      const phone = cellByHeaders_(r, hmap, ["เบอร์โทร", "โทร", "โทรศัพท์"], 7);
      const apptRaw = cellByHeaders_(r, hmap, ["วันที่นัดหมาย", "วันที่ต้องเข้า", "วันที่เข้าซ่อม"], 8);
      const urgency = cellByHeaders_(r, hmap, ["ความเร่งด่วน", "เร่งด่วน"], 9);
      const status = cellByHeaders_(r, hmap, ["สถานะ", "สถานะซ่อม"], 10);
      const lat = cellByHeaders_(r, hmap, ["ละ", "ละติจูด", "lat", "latitude"], 11);
      const lng = cellByHeaders_(r, hmap, ["ลอง", "ลองจิจูด", "lng", "long", "longitude"], 12);
      const dateObj = parseDateTH(apptRaw);

      return {
        sourceRank: 2,
        priority: 200 + getUrgencyScore(urgency, dateObj),
        priorityLabel: urgency || "ซ่อม",
        type: "ซ่อม",
        dateRaw: apptRaw,
        dateObj,
        customer_id: "",
        customer_name: customerName,
        status: status || "ยังไม่เข้าซ่อม",
        bu: inferBUFromAnyText(customerName, area, coordinator, meterRaw),
        meter: meterRaw,
        meterKey: normalizeMeter(meterRaw),
        area,
        purpose: repairWork,
        coordinator,
        phone,
        lat,
        lng,
        sales_litre: "",
        route_group: "",
        stop_no: "",
        start_name: "",
        __repairSourceRow: repairRowIndex + 2
      };
    });
}
function normalizeMarket(rows) {
  return rows.slice(1).map(r => {
    const status = cell(r,10);
    const meterRaw = cell(r,5);
    return {
      sourceRank: 3, priority: 300 + marketScore(status), priorityLabel: statusGroup(status), type: "พื้นที่ออกตลาด",
      dateRaw: "", dateObj: null, customer_id: cell(r,0), customer_name: cell(r,1), status, bu: cell(r,4),
      meter: meterRaw, meterKey: normalizeMeter(meterRaw), area: cell(r,4), purpose: "ติดตามสถานะลูกค้า", coordinator: "", phone: "",
      lat: cell(r,2), lng: cell(r,3), sales_litre: "", route_group: "", stop_no: "", start_name: ""
    };
  }).filter(r => r.customer_id || r.customer_name);
}
function buildSalesMap(rows) {
  const map = new Map();
  rows.slice(1).forEach(r => {
    const branch = cleanText(cell(r,1));
    const channel = cleanText(cell(r,2));
    const type = cleanText(cell(r,3));
    const litre = Number(String(cell(r,5)).replace(/,/g,"")) || 0;
    if (!["รถมิเตอร์", "รถเทรลเลอร์"].includes(channel)) return;
    if (!["MT", "TR"].includes(type)) return;
    map.set(`${branch}|${type}`.toLowerCase(), (map.get(`${branch}|${type}`.toLowerCase()) || 0) + litre);
    map.set(`${branch}`.toLowerCase(), (map.get(`${branch}`.toLowerCase()) || 0) + litre);
  });
  return map;
}
function enrichSales(rows, salesRows) {
  const salesMap = buildSalesMap(salesRows);
  return rows.map(r => {
    const meter = cleanText(r.meter);
    const type = meter.toUpperCase().includes("TR") ? "TR" : meter.toUpperCase().includes("MT") ? "MT" : "";
    const litre = salesMap.get(`${meter}|${type}`.toLowerCase()) || salesMap.get(`${meter}`.toLowerCase()) || "";
    return { ...r, sales_litre: litre ? litre.toLocaleString("th-TH") : "" };
  });
}

function chooseOnePumpPerMeterCurrentMonth(pumpRows) {
  const today = thaiNow();
  const monthRows = pumpRows
    .filter(r => inCurrentThaiMonth(r.dateObj))
    .filter(r => cleanText(r.status) !== "เสร็จ")
    /* แสดงจุดที่เช็คอินสำเร็จไว้ในแผน เพื่อให้ขึ้นเครื่องหมายถูก */;

  const groups = new Map();
  monthRows.forEach(r => {
    const key = `${r.bu || "ไม่ระบุ"}|${r.meterKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  });

  const selected = [];
  groups.forEach(list => {
    const upcoming = list.filter(x => x.dateObj && x.dateObj >= today).sort((a,b) => dateSortValue(a.dateObj) - dateSortValue(b.dateObj));
    const latest = [...list].sort((a,b) => dateSortValue(b.dateObj) - dateSortValue(a.dateObj));
    selected.push(upcoming[0] || latest[0]);
  });
  return selected.filter(Boolean).sort((a,b) => dateSortValue(a.dateObj) - dateSortValue(b.dateObj));
}

function haversine(a, b) {
  const R = 6371;
  const lat1 = Number(a.lat) * Math.PI / 180;
  const lat2 = Number(b.lat) * Math.PI / 180;
  const dLat = (Number(b.lat) - Number(a.lat)) * Math.PI / 180;
  const dLng = (Number(b.lng) - Number(a.lng)) * Math.PI / 180;
  const x = Math.sin(dLat/2)**2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
}
function bestStartForRoute(points) {
  const valid = points.filter(validCoord);
  if (!valid.length) return START_POINTS[0];

  // เลือกจุดเริ่มต้นที่ระยะเฉลี่ยใกล้ “ทุกจุดในแผน” ที่สุด ไม่ใช่ดูแค่ปั๊มปรับปรุงจุดเดียว
  return START_POINTS.map(s => {
    const avg = valid.reduce((sum, p) => sum + haversine(s, { lat: toNumber(p.lat), lng: toNumber(p.lng) }), 0) / valid.length;
    const nearest = Math.min(...valid.map(p => haversine(s, { lat: toNumber(p.lat), lng: toNumber(p.lng) })));
    return { ...s, score: avg + (nearest * 0.15) };
  }).sort((a,b) => a.score - b.score)[0];
}
function routeDistanceFromStart(start, order) {
  if (!order.length) return 0;
  let total = 0;
  let current = { lat: start.lat, lng: start.lng };
  order.forEach(p => {
    total += haversine(current, { lat: toNumber(p.lat), lng: toNumber(p.lng) });
    current = { lat: toNumber(p.lat), lng: toNumber(p.lng) };
  });
  total += haversine(current, { lat: start.lat, lng: start.lng });
  return total;
}

function nearestNeighborOrder(start, points) {
  const remaining = points.map(p => ({ ...p }));
  const ordered = [];
  let current = { lat: start.lat, lng: start.lng };
  while (remaining.length) {
    let bestIndex = 0;
    let bestDistance = Infinity;
    remaining.forEach((p, i) => {
      const d = haversine(current, { lat: toNumber(p.lat), lng: toNumber(p.lng) });
      if (d < bestDistance) {
        bestDistance = d;
        bestIndex = i;
      }
    });
    const next = remaining.splice(bestIndex, 1)[0];
    ordered.push(next);
    current = { lat: toNumber(next.lat), lng: toNumber(next.lng) };
  }
  return ordered;
}

function farthestInsertionOrder(start, points) {
  const remaining = points.map(p => ({ ...p }));
  if (remaining.length <= 2) return nearestNeighborOrder(start, remaining);

  remaining.sort((a, b) => haversine(start, { lat: toNumber(b.lat), lng: toNumber(b.lng) }) - haversine(start, { lat: toNumber(a.lat), lng: toNumber(a.lng) }));
  const ordered = [remaining.shift()];

  while (remaining.length) {
    let farIndex = 0;
    let farDistance = -1;
    remaining.forEach((p, i) => {
      const nearestInRoute = Math.min(
        haversine(start, { lat: toNumber(p.lat), lng: toNumber(p.lng) }),
        ...ordered.map(o => haversine(o, { lat: toNumber(p.lat), lng: toNumber(p.lng) }))
      );
      if (nearestInRoute > farDistance) {
        farDistance = nearestInRoute;
        farIndex = i;
      }
    });

    const point = remaining.splice(farIndex, 1)[0];
    let bestPos = 0;
    let bestDistance = Infinity;
    for (let pos = 0; pos <= ordered.length; pos++) {
      const candidate = [...ordered.slice(0, pos), point, ...ordered.slice(pos)];
      const d = routeDistanceFromStart(start, candidate);
      if (d < bestDistance) {
        bestDistance = d;
        bestPos = pos;
      }
    }
    ordered.splice(bestPos, 0, point);
  }
  return ordered;
}

function angularSweepOrders(points) {
  if (!points.length) return [[]];
  const center = {
    lat: points.reduce((sum, p) => sum + toNumber(p.lat), 0) / points.length,
    lng: points.reduce((sum, p) => sum + toNumber(p.lng), 0) / points.length
  };
  const withAngle = points.map(p => ({
    ...p,
    __angle: Math.atan2(toNumber(p.lat) - center.lat, toNumber(p.lng) - center.lng)
  }));
  const cw = [...withAngle].sort((a, b) => a.__angle - b.__angle);
  const ccw = [...cw].reverse();
  const variants = [];
  [cw, ccw].forEach(list => {
    for (let i = 0; i < list.length; i++) {
      variants.push([...list.slice(i), ...list.slice(0, i)].map(({ __angle, ...p }) => p));
    }
  });
  return variants;
}

function twoOptClosedRoute(start, order) {
  if (order.length < 4) return order;
  let best = order.map(p => ({ ...p }));
  let improved = true;
  let guard = 0;
  while (improved && guard < 120) {
    improved = false;
    guard++;
    const base = routeDistanceFromStart(start, best);
    outer:
    for (let i = 0; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const candidate = [
          ...best.slice(0, i),
          ...best.slice(i, k + 1).reverse(),
          ...best.slice(k + 1)
        ];
        const d = routeDistanceFromStart(start, candidate);
        if (d + 0.001 < base) {
          best = candidate;
          improved = true;
          break outer;
        }
      }
    }
  }
  return best;
}

function rowName(row) {
  return norm(`${row.customer_name || ""} ${row.customer_id || ""} ${row.area || ""} ${row.purpose || ""}`);
}
function hasAllKeywords(row, words) {
  const text = rowName(row);
  return words.every(w => text.includes(norm(w)));
}
function movePointAfter(order, anchorKeywords, movingKeywords) {
  const anchorIndex = order.findIndex(p => hasAllKeywords(p, anchorKeywords));
  const movingIndex = order.findIndex(p => hasAllKeywords(p, movingKeywords));
  if (anchorIndex < 0 || movingIndex < 0 || anchorIndex === movingIndex) return order;
  const next = [...order];
  const [moving] = next.splice(movingIndex, 1);
  const anchorNewIndex = next.findIndex(p => hasAllKeywords(p, anchorKeywords));
  next.splice(anchorNewIndex + 1, 0, moving);
  return next;
}
function movePointToEnd(order, movingKeywords) {
  const idx = order.findIndex(p => hasAllKeywords(p, movingKeywords));
  if (idx < 0 || idx === order.length - 1) return order;
  const next = [...order];
  const [moving] = next.splice(idx, 1);
  next.push(moving);
  return next;
}

function applyPreferredSequence(order, keywordGroups) {
  const remaining = [...order];
  const picked = [];
  keywordGroups.forEach(words => {
    const idx = remaining.findIndex(p => hasAllKeywords(p, words));
    if (idx >= 0) picked.push(remaining.splice(idx, 1)[0]);
  });
  // ใช้ลำดับเฉพาะเมื่อเจอจุดในกติกาอย่างน้อย 4 จุด เพื่อไม่ไปรบกวนสายอื่น
  if (picked.length < 4) return order;
  return [...picked, ...remaining];
}

function applyRouteBusinessRules(order) {
  // กติกาหน้างานเฉพาะพื้นที่ที่แจ้งมา เพื่อให้ไม่ย้อนกลับมาเก็บจุดเดิม
  let next = [...order];

  // ลำดับตัวอย่างที่ผู้ใช้ยืนยันว่าเหมาะสมสำหรับ ST สาย 55 / พื้นที่กมลาไสย-ร่องคำ-โพธิ์ชัย
  next = applyPreferredSequence(next, [
    ["กองทุน", "นาเรียง"],
    ["ปั้มสุดที"],
    ["เกษตรสมบูรณ์"],
    ["หจก", "สินธุ์ชัยไอซ์"],
    ["แม่พันธ์"],
    ["สมพอง"],
    ["บุญจันทร์"],
    ["พิมลรัตน์"],
    ["ยิ่งเจริญ"],
    ["เกียรติประภัส"],
    ["ด่านใต้"],
    ["โนนเมือง"],
    ["จอยบริการ"],
    ["บจก", "สินธุ์ชัยไอซ์"],
    ["หนองตอกแป้น"],
    ["กลุ่มทำนาหลักเมือง"]
  ]);

  // สินธุ์ชัยไอซ์ -> สถานีบริการน้ำมัน 6J9Q+RWF
  next = movePointAfter(next, ["สินธุ์ชัยไอซ์"], ["6J9Q"]);
  next = movePointAfter(next, ["สินธุ์ชัยไอซ์"], ["สถานีบริการน้ำมัน", "เจ้าท่า"]);

  // ที่ทำการผู้ใหญ่บ้าน/ทุ่งเจริญ -> ยิ่ง เจริญ -> เกียรติประภัสร์
  next = movePointAfter(next, ["ที่ทำการผู้ใหญ่บ้าน"], ["ยิ่ง", "เจริญ"]);
  next = movePointAfter(next, ["ทุ่งเจริญ"], ["ยิ่ง", "เจริญ"]);
  next = movePointAfter(next, ["ยิ่ง", "เจริญ"], ["เกียรติประภัสร์"]);
  next = movePointAfter(next, ["ยิ่ง", "เจริญ"], ["ปั้มดาบร่วม"]);

  // กลุ่มทำนาหลักเมืองให้เป็นจุดขากลับ: ถ้ามีสหกรณ์แก้มลิงให้ต่อหลังสหกรณ์ ไม่เช่นนั้นย้ายไปท้ายรายการ
  const before = next.map(rowName).join("|");
  next = movePointAfter(next, ["สหกรณ์การเกษตร", "แก้มลิง"], ["กลุ่มทำนาหลักเมือง"]);
  const after = next.map(rowName).join("|");
  if (before === after) next = movePointToEnd(next, ["กลุ่มทำนาหลักเมือง"]);

  return next;
}



function routeDistanceFast(start, order) {
  return routeDistanceFromStart(start, order);
}

function circularSweepClosedOrder(start, points) {
  // วางเส้นทางแบบ “วงกลม” รอบกลุ่มลูกค้า ไม่ใช้ TSP แบบกระโดดข้ามไปมา
  // เป้าหมาย: ลดการย้อนกลับมาเก็บจุดย้อนหลัง และให้ลำดับอ่านง่ายเหมือนวิ่งวนรอบพื้นที่
  const valid = points.filter(validCoord).map(p => ({ ...p }));
  if (valid.length <= 2) return valid;

  const center = {
    lat: valid.reduce((sum, p) => sum + toNumber(p.lat), 0) / valid.length,
    lng: valid.reduce((sum, p) => sum + toNumber(p.lng), 0) / valid.length
  };

  const withAngle = valid.map(p => ({
    ...p,
    __angle: Math.atan2(toNumber(p.lat) - center.lat, toNumber(p.lng) - center.lng)
  }));

  const clockwise = [...withAngle].sort((a, b) => a.__angle - b.__angle);
  const counterClockwise = [...clockwise].reverse();
  const candidates = [];

  [clockwise, counterClockwise].forEach(base => {
    for (let i = 0; i < base.length; i++) {
      const rotated = [...base.slice(i), ...base.slice(0, i)].map(({ __angle, ...p }) => p);
      candidates.push(rotated);
    }
  });

  // เลือกวงที่มีระยะรวมสั้นที่สุด แต่ยังรักษาลำดับแบบวนรอบพื้นที่
  return candidates.sort((a, b) => routeDistanceFromStart(start, a) - routeDistanceFromStart(start, b))[0] || valid;
}

function improveCircularRouteLight(start, order) {
  // ปรับเฉพาะเล็กน้อยแบบไม่ทำให้เส้นทางกระโดดแปลก: ลองกลับทิศทาง และหมุนจุดเริ่มในวงเท่านั้น
  if (order.length <= 2) return order;
  const variants = [];
  [order, [...order].reverse()].forEach(base => {
    for (let i = 0; i < base.length; i++) variants.push([...base.slice(i), ...base.slice(0, i)]);
  });
  return variants.sort((a, b) => routeDistanceFromStart(start, a) - routeDistanceFromStart(start, b))[0] || order;
}



function pointSegmentProjection(a, b, p) {
  // ประเมินว่าจุด p อยู่ “ระหว่างทาง” จาก a ไป b หรือไม่ (ใช้ระยะเชิงเรขาคณิตเป็นตัวช่วย)
  const ax = toNumber(a.lng), ay = toNumber(a.lat);
  const bx = toNumber(b.lng), by = toNumber(b.lat);
  const px = toNumber(p.lng), py = toNumber(p.lat);
  if (![ax, ay, bx, by, px, py].every(Number.isFinite)) return null;
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const vv = vx * vx + vy * vy;
  if (vv === 0) return null;
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / vv));
  const proj = { lng: ax + t * vx, lat: ay + t * vy };
  const distKm = haversine({ lat: py, lng: px }, proj);
  const alongKm = haversine(a, proj);
  return { t, distKm, alongKm };
}

function pullPointsThatAreOnTheWay(start, order) {
  // แก้ปัญหา “วิ่งผ่าน/ใกล้จุดหนึ่งแล้วไม่แวะ แต่ไปย้อนกลับมาเก็บทีหลัง”
  // หลักการ: ถ้าจุดถัด ๆ ไปอยู่ในแนวทางระหว่างจุดปัจจุบันกับจุดเป้าหมาย ให้ดึงมาแวะก่อน
  if (order.length < 4) return order;
  const result = [];
  const remaining = order.map(p => ({ ...p }));
  let current = { lat: start.lat, lng: start.lng };

  while (remaining.length) {
    const next = remaining.shift();
    const inPath = [];

    for (let i = remaining.length - 1; i >= 0; i--) {
      const candidate = remaining[i];
      const proj = pointSegmentProjection(current, next, candidate);
      if (!proj) continue;

      const currentToNext = haversine(current, next);
      const currentToCandidate = haversine(current, candidate);
      const candidateToNext = haversine(candidate, next);
      const detour = currentToCandidate + candidateToNext - currentToNext;

      // เกณฑ์แบบยืดหยุ่น: อยู่ตามแนวทางจริงพอสมควร และการแทรกไม่ทำให้ระยะอ้อมเพิ่มมาก
      const corridorKm = Math.max(2.5, Math.min(10, currentToNext * 0.22));
      const isBetween = proj.t > 0.08 && proj.t < 0.92;
      const isCloseToLine = proj.distKm <= corridorKm;
      const lowDetour = detour <= Math.max(4, currentToNext * 0.18);

      if (isBetween && isCloseToLine && lowDetour) {
        inPath.push({ index: i, point: candidate, alongKm: proj.alongKm });
      }
    }

    inPath.sort((a, b) => a.alongKm - b.alongKm);
    for (const item of inPath) {
      const idx = remaining.indexOf(item.point);
      if (idx >= 0) remaining.splice(idx, 1);
      result.push(item.point);
      current = { lat: toNumber(item.point.lat), lng: toNumber(item.point.lng) };
    }

    result.push(next);
    current = { lat: toNumber(next.lat), lng: toNumber(next.lng) };
  }

  return result;
}

function pushNearStartStopsToEnd(start, order) {
  // กติกาเสริม: จุดที่อยู่ใกล้จุดเริ่มมาก ๆ ไม่จำเป็นต้องเป็นจุดแรก
  // ให้เก็บไว้ช่วงท้ายของวง เพื่อไม่ให้วิ่งออกไปแล้ววกกลับมาเก็บจุดใกล้ฐานอีกครั้ง
  if (!order || order.length < 6) return order;
  const distances = order.map(p => haversine(start, { lat: toNumber(p.lat), lng: toNumber(p.lng) }));
  const maxD = Math.max(...distances);
  const threshold = Math.max(10, maxD * 0.38);
  const near = [];
  const far = [];
  order.forEach((p, idx) => {
    const d = distances[idx];
    if (d <= threshold) near.push({ p, d });
    else far.push(p);
  });
  // ถ้า near เยอะเกินไป แปลว่าทั้งกลุ่มอยู่ใกล้ฐาน ไม่ควรแยกไปท้าย
  if (near.length < 2 || near.length > Math.ceil(order.length * 0.45)) return order;
  near.sort((a, b) => b.d - a.d); // ไกลกว่าไปก่อน ใกล้ฐานที่สุดอยู่ท้ายสุดก่อนวนกลับ
  return [...far, ...near.map(x => x.p)];
}

function chooseBestCircularCandidate(start, validPoints) {
  // สร้าง candidate หลายแบบ แต่ยังคงแนวคิด “วงกลม ไม่เก็บย้อนหลัง”
  const candidates = [];
  const sweep = circularSweepClosedOrder(start, validPoints);
  candidates.push(sweep);
  candidates.push([...sweep].reverse());
  candidates.push(pullPointsThatAreOnTheWay(start, sweep));
  candidates.push(pullPointsThatAreOnTheWay(start, [...sweep].reverse()));

  // เพิ่ม candidate จากการหมุนวง เพื่อไม่ให้จุดใกล้จุดเริ่มถูกบังคับเป็นจุดแรกเสมอไป
  [sweep, [...sweep].reverse()].forEach(base => {
    for (let i = 0; i < base.length; i++) {
      const rotated = [...base.slice(i), ...base.slice(0, i)];
      candidates.push(rotated);
      candidates.push(pushNearStartStopsToEnd(start, rotated));
      candidates.push(pullPointsThatAreOnTheWay(start, rotated));
      candidates.push(pullPointsThatAreOnTheWay(start, pushNearStartStopsToEnd(start, rotated)));
    }
  });

  // เลือกเส้นทางที่ระยะสั้น แต่ลงโทษการตัดข้าม/ย้อนกลับแรง ๆ ด้วยการดูผลหลังดึงจุดระหว่างทาง
  const unique = [];
  const seen = new Set();
  for (const c of candidates) {
    const key = c.map(x => `${norm(x.customer_id)}:${norm(x.customer_name)}`).join('|');
    if (!seen.has(key)) { seen.add(key); unique.push(c); }
  }
  const scored = unique.map(route => {
    const nearFirstPenalty = route.slice(0, Math.min(2, route.length)).reduce((sum, p) => {
      const d = haversine(start, { lat: toNumber(p.lat), lng: toNumber(p.lng) });
      return sum + Math.max(0, 12 - d) * 8;
    }, 0);
    return { route, score: routeDistanceFromStart(start, route) + nearFirstPenalty };
  });
  return (scored.sort((a, b) => a.score - b.score)[0] || {}).route || validPoints;
}

function orderCircularRoute(start, points) {
  const validPoints = points.filter(validCoord).map(p => ({ ...p }));
  const noCoord = points.filter(p => !validCoord(p));
  if (validPoints.length <= 2) return [...validPoints, ...noCoord];

  // ใช้แนวคิด “วงกลม ไม่เก็บย้อนหลัง” แต่เพิ่มการดึงจุดที่อยู่ระหว่างทางมาแวะก่อน
  // ช่วยลดเคสที่ Google Maps/OSRM วิ่งผ่านจุด 4-5 แต่เลขลำดับกลับไปเก็บจุด 3 ก่อน
  let best = chooseBestCircularCandidate(start, validPoints);
  best = pushNearStartStopsToEnd(start, best);
  best = pullPointsThatAreOnTheWay(start, best);
  return [...best, ...noCoord];
}


function rowUniqueKey(row) {
  return `${norm(row.customer_id)}|${norm(row.customer_name)}|${cleanText(row.lat)}|${cleanText(row.lng)}|${cleanText(row.type)}`;
}

function isPumpRow(row) {
  return cleanText(row && row.type) === "ปรับปรุงปั๊ม";
}

function removeSameStop(rows, target) {
  const key = rowUniqueKey(target);
  return rows.filter(r => rowUniqueKey(r) !== key);
}

function orderPumpFirstRoute(start, pumpRow, otherRows) {
  // เงื่อนไขสำหรับ “ตามแผนปรับปรุงปั๊ม”:
  // จุดที่ 1 ต้องเป็นจุดปรับปรุงปั๊มเสมอ แล้วค่อยจัดจุดออกตลาดที่เหลือแบบวงกลม
  if (!pumpRow) return orderCircularRoute(start, otherRows || []);

  const pivot = validCoord(pumpRow)
    ? { lat: toNumber(pumpRow.lat), lng: toNumber(pumpRow.lng) }
    : start;

  const rest = removeSameStop(otherRows || [], pumpRow);
  const orderedRest = orderCircularRoute(pivot, rest);
  return [pumpRow, ...orderedRest];
}
function takeByStatusForMeter(marketRows, pump) {
  const selectedBU = getSelectedStartBU();
  const sameMeter = marketRows
    .filter(m => m.meterKey === pump.meterKey)
    .filter(m => !selectedBU || cleanText(m.bu).toUpperCase() === selectedBU.toUpperCase())
    /* แสดงจุดที่เช็คอินสำเร็จไว้ในแผน เพื่อให้ขึ้นเครื่องหมายถูก */
    .filter(m => {
      if (!pump.bu || pump.bu === "KCG") return true;
      return !m.bu || cleanText(m.bu).toUpperCase() === cleanText(pump.bu).toUpperCase();
    })
    .sort((a,b) => marketScore(a.status) - marketScore(b.status));

  const lost = sameMeter.filter(x => ["ลูกค้าหาย", "ลูกค้าหายเกิน 60 วัน"].includes(statusGroup(x.status))).slice(0, 5);
  const risky = sameMeter.filter(x => statusGroup(x.status) === "ลูกค้าเสี่ยงหาย").slice(0, 5);
  const active = sameMeter.filter(x => statusGroup(x.status) === "ลูกค้าซื้อขายประจำ").slice(0, 5);
  const winback = sameMeter.filter(x => statusGroup(x.status) === "ลูกค้าใหม่/Winback").slice(0, 5);
  return [...lost, ...risky, ...active, ...winback];
}
function buildPumpPlanRows(pumpRows, repairRows, marketRows) {
  const selectedBU = getSelectedStartBU();
  const selectedPumps = chooseOnePumpPerMeterCurrentMonth(pumpRows)
    .filter(p => !selectedBU || cleanText(p.bu).toUpperCase() === selectedBU.toUpperCase());
  const output = [];

  selectedPumps.forEach(pump => {
    const relatedMarkets = takeByStatusForMeter(marketRows, pump);
    const routeDate = pump.dateObj ? pump.dateObj.toLocaleDateString("th-TH", { day: "numeric", month: "long", year: "2-digit" }) : pump.dateRaw;
    const routeId = `${pump.bu || "BU-?"} สาย ${pump.meterKey} วันที่ ${routeDate}`;
    const routePoints = [pump, ...relatedMarkets];
    const start = startForRoute(routePoints);
    const ordered = orderPumpFirstRoute(start, pump, relatedMarkets);
    ordered.forEach((row, idx) => output.push({
      ...row,
      plan_day: 1,
      plan_date: pump.dateObj || thaiNow(),
      route_group: routeId,
      stop_no: `${idx + 1}/${ordered.length}`,
      start_name: start.name,
      priorityLabel: idx === 0 && row.type === "ปรับปรุงปั๊ม" ? "1-ปรับปรุงปั๊ม" : row.priorityLabel
    }));
  });

  const repairs = repairRows
    .filter(r => inCurrentThaiMonth(r.dateObj))
    /* แสดงจุดที่เช็คอินสำเร็จไว้ในแผน เพื่อให้ขึ้นเครื่องหมายถูก */
    .map(r => ({ ...r, plan_day: 1, plan_date: r.dateObj || thaiNow(), route_group: "ตารางซ่อมเดือนปัจจุบัน", stop_no: "-", start_name: "-" }));
  return [...output, ...repairs];
}


function stopNoValue(row, fallbackIndex = 0) {
  const raw = cleanText(row && row.stop_no);
  const m = raw.match(/^(\d+)/);
  return m ? Number(m[1]) : fallbackIndex + 1;
}

function sortRowsByPlannedStopNo(list) {
  return [...list].sort((a, b) => stopNoValue(a) - stopNoValue(b));
}

function routeTurnPenalty(start, order) {
  // ลงโทษการหักมุม/วกกลับแบบรุนแรง เพื่อให้เส้นทางเป็นวงไหลไปทางเดียวมากขึ้น
  const pts = [{ lat: start.lat, lng: start.lng }, ...order.map(p => ({ lat: toNumber(p.lat), lng: toNumber(p.lng) })), { lat: start.lat, lng: start.lng }];
  let penalty = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const v1 = { x: b.lng - a.lng, y: b.lat - a.lat };
    const v2 = { x: c.lng - b.lng, y: c.lat - b.lat };
    const l1 = Math.hypot(v1.x, v1.y);
    const l2 = Math.hypot(v2.x, v2.y);
    if (!l1 || !l2) continue;
    const cos = Math.max(-1, Math.min(1, (v1.x * v2.x + v1.y * v2.y) / (l1 * l2)));
    // cos ต่ำมาก = วกกลับ/หักกลับ เพิ่ม penalty
    if (cos < -0.35) penalty += (Math.abs(cos) * 18);
  }
  return penalty;
}

function angleFromStart(start, p) {
  return Math.atan2(toNumber(p.lat) - Number(start.lat), toNumber(p.lng) - Number(start.lng));
}

function angularDiff(a, b) {
  let d = Math.abs(a - b);
  while (d > Math.PI) d = Math.abs(d - Math.PI * 2);
  return d;
}

function normalMarketRouteScore(start, order) {
  if (!order.length) return 0;
  const baseDistance = routeDistanceFromStart(start, order);
  const turnPenalty = routeTurnPenalty(start, order) * 1.6;

  // ลงโทษการวิ่งย้อนกลับเข้าหาฐานเร็วเกินไปในช่วงกลางทาง
  // เพื่อให้เส้นทางเป็น “ออกไปก่อน แล้วค่อยวนกลับ” มากกว่า 1→2→วกกลับ→ออกไปใหม่
  const ds = order.map(p => haversine(start, { lat: toNumber(p.lat), lng: toNumber(p.lng) }));
  const maxD = Math.max(...ds, 0);
  let earlyReturnPenalty = 0;
  for (let i = 1; i < ds.length - 2; i++) {
    if (ds[i] < maxD * 0.55 && ds[i + 1] > ds[i] + 8) earlyReturnPenalty += 35;
  }

  // ลงโทษการกระโดดข้ามโซนมุม แล้วค่อยย้อนกลับมาเก็บมุมเดิม
  const angles = order.map(p => angleFromStart(start, p));
  let angleZigzagPenalty = 0;
  for (let i = 1; i < angles.length - 1; i++) {
    const d1 = angles[i] - angles[i - 1];
    const d2 = angles[i + 1] - angles[i];
    if (d1 * d2 < 0 && Math.abs(d1) > 0.25 && Math.abs(d2) > 0.25) angleZigzagPenalty += 25;
  }

  return baseDistance + turnPenalty + earlyReturnPenalty + angleZigzagPenalty;
}

function chooseFirstTwoForNormalRoute(start, valid) {
  // โหมดวันปกติ: อนุญาตให้เริ่มจากจุดใกล้ทางออก 1-2 จุดก่อน
  // จากนั้นค่อยวนออกโซนนอก เพื่อลดการ “วิ่งฟรี” กลับมาเก็บจุดใกล้ฐานในภายหลัง
  const sortedByStart = [...valid].sort((a, b) =>
    haversine(start, { lat: toNumber(a.lat), lng: toNumber(a.lng) }) -
    haversine(start, { lat: toNumber(b.lat), lng: toNumber(b.lng) })
  );
  const first = sortedByStart[0];
  if (!first || valid.length === 1) return { fixed: first ? [first] : [], remaining: first ? removeSameStop(valid, first) : valid };

  const firstD = haversine(start, { lat: toNumber(first.lat), lng: toNumber(first.lng) });
  const firstAngle = angleFromStart(start, first);
  const candidates = removeSameStop(valid, first)
    .map(p => {
      const dStart = haversine(start, { lat: toNumber(p.lat), lng: toNumber(p.lng) });
      const dFirst = haversine(first, { lat: toNumber(p.lat), lng: toNumber(p.lng) });
      const a = angleFromStart(start, p);
      // เลือกจุดที่ต่อเนื่องจากจุดแรก ไม่ใช่ย้อนกลับเข้าฐาน และไม่กระโดดข้ามคนละโซนมากเกินไป
      const score = dFirst + angularDiff(a, firstAngle) * 18 + Math.max(0, firstD - dStart) * 3;
      return { p, score, dStart };
    })
    .sort((a, b) => a.score - b.score);

  const second = candidates[0] && candidates[0].p;
  return second
    ? { fixed: [first, second], remaining: removeSameStop(removeSameStop(valid, first), second) }
    : { fixed: [first], remaining: removeSameStop(valid, first) };
}

function makeNormalSweepCandidates(start, fixed, remaining) {
  if (!remaining.length) return [fixed];
  const candidates = [];
  const anchor = fixed.length ? fixed[fixed.length - 1] : start;
  const anchorAngle = angleFromStart(start, anchor);

  const byAngleAsc = [...remaining].sort((a, b) => angleFromStart(start, a) - angleFromStart(start, b));
  const byAngleDesc = [...byAngleAsc].reverse();
  const bases = [byAngleAsc, byAngleDesc];

  bases.forEach(base => {
    // หมุนลำดับให้จุดแรกของกลุ่มที่เหลือ อยู่ใกล้มุมของจุดก่อนหน้า
    for (let i = 0; i < base.length; i++) {
      const rotated = [...base.slice(i), ...base.slice(0, i)];
      const firstAngle = angleFromStart(start, rotated[0]);
      const connectPenalty = angularDiff(anchorAngle, firstAngle);
      if (connectPenalty <= Math.PI * 0.85) {
        candidates.push([...fixed, ...rotated]);
        candidates.push(pullPointsThatAreOnTheWay(start, [...fixed, ...rotated]));
      }
    }
    candidates.push([...fixed, ...base]);
    candidates.push(pullPointsThatAreOnTheWay(start, [...fixed, ...base]));
  });

  // candidate แบบ “ออกโซนไกลก่อนแล้ววนกลับ” แต่ยังล็อก fixed 1-2 จุดแรกไว้
  const maxD = Math.max(...remaining.map(p => haversine(start, { lat: toNumber(p.lat), lng: toNumber(p.lng) })), 0);
  const farFirst = [...remaining].sort((a, b) => {
    const da = haversine(start, { lat: toNumber(a.lat), lng: toNumber(a.lng) });
    const db = haversine(start, { lat: toNumber(b.lat), lng: toNumber(b.lng) });
    return db - da;
  });
  if (maxD > 0) candidates.push([...fixed, ...pullPointsThatAreOnTheWay(start, farFirst)]);

  return candidates;
}

function orderNormalMarketRoute(start, points) {
  // โหมดวันปกติ/ออกตลาดทั่วไป:
  // 1) เก็บจุดออกจากฐานที่ต่อเนื่อง 1-2 จุดแรกได้
  // 2) หลังจากนั้นเรียงแบบกวาดเป็นวงตามมุมจากจุดเริ่ม ไม่กระโดดกลับไปมา
  // 3) เลือก candidate ที่ระยะรวม + การวกกลับต่ำที่สุด
  const valid = points.filter(validCoord).map(p => ({ ...p }));
  const noCoord = points.filter(p => !validCoord(p));
  if (valid.length <= 2) return [...valid, ...noCoord];

  const { fixed, remaining } = chooseFirstTwoForNormalRoute(start, valid);
  const candidates = makeNormalSweepCandidates(start, fixed, remaining);

  // สำหรับกรณีที่จุดแรกที่ใกล้ฐานทำให้ภาพรวมแย่ ให้ลองไม่ล็อก fixed ด้วย แต่ให้ penalty นิดหน่อย
  candidates.push(...makeNormalSweepCandidates(start, [], valid));

  const unique = [];
  const seen = new Set();
  candidates.forEach(c => {
    const key = c.map(x => `${norm(x.customer_id)}:${norm(x.customer_name)}:${cleanText(x.lat)}:${cleanText(x.lng)}`).join('|');
    if (!seen.has(key)) { seen.add(key); unique.push(c); }
  });

  let best = unique.sort((a, b) => normalMarketRouteScore(start, a) - normalMarketRouteScore(start, b))[0] || valid;

  // ถ้าจุดแรก/สองที่ระบบเลือกไว้ไม่ได้ทำให้ระยะพัง ให้คงไว้ตามที่ผู้ใช้ต้องการในเคส ST สาย 57
  if (fixed.length >= 2) {
    const bestWithFixed = unique
      .filter(c => rowUniqueKey(c[0]) === rowUniqueKey(fixed[0]) && rowUniqueKey(c[1]) === rowUniqueKey(fixed[1]))
      .sort((a, b) => normalMarketRouteScore(start, a) - normalMarketRouteScore(start, b))[0];
    if (bestWithFixed && normalMarketRouteScore(start, bestWithFixed) <= normalMarketRouteScore(start, best) * 1.12) {
      best = bestWithFixed;
    }
  }

  best = pullPointsThatAreOnTheWay(start, best);
  return [...best, ...noCoord];
}


function isNormalST55Route(points) {
  const valid = (points || []).filter(Boolean);
  if (!valid.length) return false;
  return valid.some(p => cleanText(p.bu).toUpperCase() === "ST") &&
         valid.some(p => normalizeMeter(p.meter || p.meterKey) === "55");
}


function isNormalST57Route(points) {
  const valid = (points || []).filter(Boolean);
  if (!valid.length) return false;
  return valid.some(p => cleanText(p.bu).toUpperCase() === "ST") &&
         valid.some(p => normalizeMeter(p.meter || p.meterKey) === "57");
}

function reorderByIndexPattern(order, pattern) {
  if (!order || order.length < pattern.length) return order;
  const out = [];
  const used = new Set();
  pattern.forEach(idx => {
    if (idx >= 0 && idx < order.length && !used.has(idx)) {
      out.push(order[idx]);
      used.add(idx);
    }
  });
  order.forEach((p, idx) => {
    if (!used.has(idx)) out.push(p);
  });
  return out;
}


function routeMeterKeyFromPoints(points) {
  const found = (points || []).find(p => normalizeMeter(p.meter || p.meterKey));
  return found ? normalizeMeter(found.meter || found.meterKey) : "";
}

function isTargetNormalLoopMeter(points) {
  // แก้เฉพาะสายที่แจ้งว่ายังควรปรับปรุงในโหมดวันปกติ/ออกตลาดทั่วไป
  return ["61", "72", "65", "71", "67"].includes(routeMeterKeyFromPoints(points));
}

function uniqueRouteCandidateKey(route) {
  return (route || []).map(x => `${norm(x.customer_id)}:${norm(x.customer_name)}:${cleanText(x.lat)}:${cleanText(x.lng)}`).join("|");
}

function loopBacktrackPenalty(start, route) {
  if (!route || route.length < 4) return 0;

  const pts = route.map(p => ({ lat: toNumber(p.lat), lng: toNumber(p.lng) }));
  const ds = pts.map(p => haversine(start, p));
  const maxD = Math.max(...ds, 0);
  let penalty = 0;

  // ลงโทษรูปแบบที่ออกจากฐานแล้ววกกลับเข้าใกล้ฐานกลางทาง แล้วค่อยออกไปไกลอีกครั้ง
  for (let i = 1; i < ds.length - 2; i++) {
    const returnedNearBase = ds[i] < maxD * 0.52;
    const goFarAgain = ds[i + 1] > ds[i] + Math.max(6, maxD * 0.18);
    if (returnedNearBase && goFarAgain) penalty += 90;
  }

  // ลงโทษการเปลี่ยนทิศซ้าย-ขวาสลับแรง ๆ หลายครั้ง เพราะมักเกิดจากการเก็บจุดย้อนหลัง
  const angles = pts.map(p => angleFromStart(start, p));
  for (let i = 1; i < angles.length - 1; i++) {
    const d1 = angles[i] - angles[i - 1];
    const d2 = angles[i + 1] - angles[i];
    if (d1 * d2 < 0 && Math.abs(d1) > 0.35 && Math.abs(d2) > 0.35) penalty += 45;
  }

  // ถ้าจุดแรกใกล้ฐานมากเกินไปในสายที่ควรวิ่งเป็นวง ให้ปรับคะแนนแย่ลง
  // เพื่อให้ระบบกล้าออกไปหัววงก่อน แล้วค่อยวนกลับมาจุดใกล้ฐานช่วงท้าย
  if (maxD > 0 && ds[0] < maxD * 0.40 && route.length >= 7) penalty += 70;

  return penalty;
}

function scoreTargetLoopRoute(start, route) {
  return routeDistanceFromStart(start, route) + (routeTurnPenalty(start, route) * 1.8) + loopBacktrackPenalty(start, route);
}

function rotateRoute(route, index) {
  return [...route.slice(index), ...route.slice(0, index)];
}

function buildTargetLoopCandidates(start, order) {
  const valid = (order || []).filter(validCoord).map(p => ({ ...p }));
  const candidates = [];
  const add = (route) => {
    if (!route || route.length !== valid.length) return;
    candidates.push(route);
    candidates.push(pullPointsThatAreOnTheWay(start, route));
  };

  add(valid);
  add([...valid].reverse());

  // ใช้ลำดับกวาดมุมรอบกลุ่มลูกค้า เพื่อทำให้เป็นวง ไม่เป็นเส้นตรงไป-กลับ
  const sweep = circularSweepClosedOrder(start, valid);
  add(sweep);
  add([...sweep].reverse());

  // หมุนวงทุกตำแหน่ง เพื่อหาหัววงที่เหมาะที่สุด ไม่บังคับว่าจุดใกล้ฐานต้องเป็นจุดแรก
  [valid, [...valid].reverse(), sweep, [...sweep].reverse()].forEach(base => {
    for (let i = 0; i < base.length; i++) add(rotateRoute(base, i));
  });

  // candidate แบบเรียงตามระยะไกลออกไปก่อน แล้ววนกลับฐาน
  const farFirst = [...valid].sort((a, b) =>
    haversine(start, { lat: toNumber(b.lat), lng: toNumber(b.lng) }) -
    haversine(start, { lat: toNumber(a.lat), lng: toNumber(a.lng) })
  );
  add(farFirst);
  add([...farFirst].reverse());

  // ตัด candidate ซ้ำ
  const seen = new Set();
  return candidates.filter(route => {
    const key = uniqueRouteCandidateKey(route);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function improveTargetNormalLoopRoute(start, order, sourcePoints) {
  // ใช้เฉพาะสาย 61,72,65,71,67 ตามที่ระบุ
  // ไม่แตะ ST55/ST57 ที่เป็นตัวอย่างดี และไม่แตะโหมดปรับปรุงปั๊ม/ตารางซ่อม
  if (!isTargetNormalLoopMeter(sourcePoints) || !order || order.length < 5) return order;

  const candidates = buildTargetLoopCandidates(start, order);
  if (!candidates.length) return order;

  const best = candidates.sort((a, b) => scoreTargetLoopRoute(start, a) - scoreTargetLoopRoute(start, b))[0] || order;

  // ถ้าเส้นใหม่ไม่ได้ดีขึ้นชัดเจน ให้คงเส้นเดิมไว้เพื่อลดความเสี่ยงข้อมูลสลับผิด
  const oldScore = scoreTargetLoopRoute(start, order);
  const newScore = scoreTargetLoopRoute(start, best);
  return newScore <= oldScore * 1.03 ? best : order;
}


function applyNormalRouteFieldFeedback(start, order, sourcePoints) {
  // กติกาหน้างานเฉพาะโหมด "วันปกติ / ออกตลาดทั่วไป"
  // ไม่กระทบสายอื่น เช่น ST สาย 65 ที่ผู้ใช้ยืนยันว่าเส้นทางเดิมดีอยู่แล้ว

  // เคสสามทองบริการ ST สาย 55:
  // ลำดับ 1,2,3 ดีแล้ว จากนั้นให้วิ่งต่อไปชุด 6,7,8,9 ก่อน แล้วค่อยกลับ 5,4
  if (isNormalST55Route(sourcePoints) && order.length >= 9) {
    return reorderByIndexPattern(order, [0, 1, 2, 5, 6, 7, 8, 4, 3]);
  }

  // เคสสามทองบริการ ST สาย 57:
  // ลำดับที่ต้องการจากภาพปัจจุบัน: 1 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 2
  // เพื่อไม่ต้องวกจากจุด 1 กลับมาจุด 2 แล้วค่อยออกไปไกลอีกครั้ง
  if (isNormalST57Route(sourcePoints) && order.length >= 9) {
    return reorderByIndexPattern(order, [0, 2, 3, 4, 5, 6, 7, 8, 1]);
  }

  // แก้เฉพาะ "วันปกติ / ออกตลาดทั่วไป" สำหรับสาย 61,72,65,71,67
  // ให้ระบบเลือกหัววงและทิศทางที่ลดการวกกลับ/เก็บย้อนหลัง โดยไม่แก้ข้อมูลหรือเมนูอื่น
  return improveTargetNormalLoopRoute(start, order, sourcePoints);
}

function buildNormalPlanRows(marketRows, planDays) {
  const today = thaiNow();
  const selectedBU = getSelectedStartBU();
  const selectedMarketStatus = getMarketStatusFilterValue();
  const candidates = marketRows
    .filter(r => !selectedBU || cleanText(r.bu).toUpperCase() === selectedBU.toUpperCase())
    /* ใช้เฉพาะ Dropdown "เลือกสถานะ" เท่านั้น ไม่กระทบโหมดวางแผนอื่น */
    .filter(r => marketStatusFilterMatch(r, selectedMarketStatus))
    /* แสดงจุดที่เช็คอินสำเร็จไว้ในแผน เพื่อให้ขึ้นเครื่องหมายถูก */
    .filter(validCoord)
    .sort((a,b) => (marketScore(a.status) - marketScore(b.status)) || cleanText(a.bu).localeCompare(cleanText(b.bu), "th") || cleanText(a.meterKey).localeCompare(cleanText(b.meterKey), "th"));

  const groups = new Map();
  candidates.forEach(r => {
    const key = `${r.bu || "ไม่ระบุ"}|${r.meterKey || "ไม่ระบุ"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  });

  const output = [];
  groups.forEach((list, key) => {
    const [bu, meterKey] = key.split("|");
    const chunkSize = selectedMarketStatus ? MAX_ROUTE_CUSTOMER_STOPS : MAX_STOPS_PER_DAY;
    const maxItems = Math.min(list.length, planDays * chunkSize);
    const usable = list.slice(0, maxItems);
    for (let dayIndex = 0; dayIndex < planDays; dayIndex++) {
      const chunk = usable.slice(dayIndex * chunkSize, (dayIndex + 1) * chunkSize);
      if (!chunk.length) continue;
      const planDate = addDaysTH(today, dayIndex);
      const routeId = `วันปกติ ${thaiDateLabel(planDate)} ${bu} สาย ${meterKey}`;
      const start = startForRoute(chunk);
      const orderedBase = hasMarketStatusFilterSelected()
        ? orderStatusFilterRoute(start, chunk)
        : orderNormalMarketRoute(start, chunk);
      const ordered = hasMarketStatusFilterSelected()
        ? orderedBase
        : applyNormalRouteFieldFeedback(start, orderedBase, chunk);
      ordered.forEach((row, idx) => output.push({
        ...row,
        plan_day: dayIndex + 1,
        plan_date: planDate,
        route_group: routeId,
        stop_no: `${idx + 1}/${ordered.length}`,
        start_name: start.name,
        priorityLabel: row.priorityLabel || statusGroup(row.status)
      }));
    }
  });
  return output;
}

function nearestStartPointForRow(row) {
  if (!validCoord(row)) return START_POINTS[0];
  return START_POINTS
    .map(s => ({ ...s, distance: haversine(s, { lat: toNumber(row.lat), lng: toNumber(row.lng) }) }))
    .sort((a,b) => a.distance - b.distance)[0];
}

function uniqueRowsByIdName(rows) {
  const seen = new Set();
  const out = [];
  rows.forEach(r => {
    const key = `${norm(r.customer_id)}|${norm(r.customer_name)}|${cleanText(r.lat)}|${cleanText(r.lng)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(r);
  });
  return out;
}

function buildRepairPlanRows(repairRows, marketRows, planDays) {
  const selectedBU = getSelectedStartBU();

  // ตารางซ่อม: แสดง “ทุกจุดซ่อมของเดือนปัจจุบัน” ที่ยังไม่ใช่สถานะ "แล้วเสร็จ"
  // ถ้าเลือกจุดเริ่ม จะกรองเฉพาะ BU ของจุดเริ่มนั้น เช่น สามทองบริการ = ST
  // 1 งานซ่อม = 1 แผน เพื่อให้ไม่ถูกตัดเหลือแค่รายการเดียว แม้อยู่ BU/สายเดียวกัน
  let candidates = repairRows
    // ห้ามกรองด้วยพิกัดในขั้นนี้: งานซ่อมบางแถวมีวันที่/สถานะถูกต้องแต่พิกัดยังไม่ครบ
    // ต้องแสดงในการ์ดและตารางก่อน ส่วนแผนที่/Google Maps จะใช้เฉพาะจุดที่มีพิกัด
    .filter(r => inCurrentThaiMonth(r.dateObj))
    .map(r => {
      const nearest = nearestStartPointForRow(r);
      const buFromText = inferBUFromAnyText(r.customer_name, r.area, r.coordinator, r.meter, r.customer_id);
      const bu = r.bu || buFromText || nearest.bu || "";
      return { ...r, bu, __nearestStartName: nearest.name, __nearestBU: bu };
    })
    .filter(r => !selectedBU || cleanText(r.__nearestBU).toUpperCase() === selectedBU.toUpperCase())
    .sort((a,b) =>
      dateSortValue(a.dateObj) - dateSortValue(b.dateObj) ||
      cleanText(a.bu).localeCompare(cleanText(b.bu), "th") ||
      cleanText(a.meterKey).localeCompare(cleanText(b.meterKey), "th") ||
      cleanText(a.customer_name).localeCompare(cleanText(b.customer_name), "th")
    );

  const output = [];

  candidates.forEach((repair, repairIndex) => {
    const relatedMarkets = uniqueRowsByIdName(takeByStatusForMeter(marketRows, repair));

    // จุดซ่อมต้องอยู่ในแผนเสมอ แล้วต่อด้วยจุดออกตลาดในสายเดียวกัน
    const routePoints = uniqueRowsByIdName([repair, ...relatedMarkets]);
    const start = startForRoute(routePoints);
    const ordered = orderCircularRoute(start, routePoints);
    const routeDate = repair.dateObj
      ? repair.dateObj.toLocaleDateString("th-TH", { day:"numeric", month:"long", year:"2-digit" })
      : thaiMonthYearLabel();
    // ให้ 1 แถวในชีตตารางซ่อม = 1 แผนเสมอ
    // เพื่อรองรับกรณีลูกค้ารายเดิมซ่อมไม่เสร็จ แล้วนัดเข้าใหม่อีกวัน/อีกแถว โดยไม่ถูกยุบรวมกับงานเดิม
    const repairUniqueName = cleanText(repair.customer_name || `แถว ${repair.__repairSourceRow || repairIndex + 1}`);
    const routeId = `ตารางซ่อม ${routeDate} ${repair.bu || selectedBU || "ทุก BU"} สาย ${repair.meterKey || "ไม่ระบุ"} • ${repairUniqueName}`;

    ordered.forEach((row, idx) => output.push({
      ...row,
      plan_day: 1,
      plan_date: repair.dateObj || thaiNow(),
      route_group: routeId,
      stop_no: `${idx + 1}/${ordered.length}`,
      start_name: start.name,
      priorityLabel: row.type === "ซ่อม" ? (row.priorityLabel || "ซ่อม") : row.priorityLabel,
      __repairIndex: repairIndex + 1
    }));
  });

  return output;
}

function buildPlannedRows(pumpRows, repairRows, marketRows) {
  const { mode, days } = getPlanSettings();
  if (mode === "normal") return buildNormalPlanRows(marketRows, days);
  if (mode === "repair") return buildRepairPlanRows(repairRows, marketRows, days);
  return buildPumpPlanRows(pumpRows, repairRows, marketRows);
}

async function loadData() {
  const tbody = document.getElementById("resultBody");
  if (tbody) tbody.innerHTML = `<tr><td colspan="18" class="loading">กำลังโหลดข้อมูล...</td></tr>`;
  const dashBody = document.getElementById("dashboardBody");
  if (dashBody) dashBody.innerHTML = `<tr><td colspan="9" class="loading">กำลังโหลด Dashboard...</td></tr>`;
  try {
    document.getElementById("currentMonthLabel").textContent = thaiMonthYearLabel();
    const [pumpRowsRaw, repairRowsRaw, marketRowsRaw, salesRows, savedRows] = await Promise.all([
      fetchSheetByIndex(SHEET_NAMES.pump),
      fetchSheetByIndex(SHEET_NAMES.repair),
      fetchSheetByIndex(SHEET_NAMES.market),
      fetchSheetByIndex(SHEET_NAMES.sales),
      fetchSavedSheetRowsRobust()
    ]);
    savedVisitRowsRaw = savedRows || [];
    savedHeaderMap = buildSavedHeaderMap(savedVisitRowsRaw);
    visitedSet = buildVisitedSet(savedRows);

    const pumpRows = normalizePump(pumpRowsRaw);
    const repairRows = normalizeRepair(repairRowsRaw);
    const marketRows = normalizeMarket(marketRowsRaw);

    customerMasterRows = buildCustomerMasterRows(pumpRows, repairRows, marketRows);

    rawRows = enrichSales([...pumpRows, ...repairRows, ...marketRows], salesRows)
      .sort((a,b) => (a.sourceRank - b.sourceRank) || dateSortValue(a.dateObj) - dateSortValue(b.dateObj));
    plannedRows = enrichSales(buildPlannedRows(pumpRows, repairRows, marketRows), salesRows);
    selectedRouteKey = "";
    routeCollapsedToSelected = false;
    renderTable();
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="18" class="loading">เกิดข้อผิดพลาด: ${escapeHtml(err.message)}</td></tr>`;
    if (dashBody) dashBody.innerHTML = `<tr><td colspan="9" class="loading">เกิดข้อผิดพลาด: ${escapeHtml(err.message)}</td></tr>`;
  }
}
function escapeHtml(str) {
  return cleanText(str).replace(/[&<>'"]/g, m => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[m]));
}
function priorityClass(row) {
  if (row.sourceRank === 1) return "p1";
  if (row.sourceRank === 2) return row.priority <= 202 ? "p1" : "p2";
  if (row.sourceRank === 3) {
    const g = statusGroup(row.status);
    if (g.includes("หาย")) return "p2";
    if (g.includes("เสี่ยง")) return "p3";
    return "p4";
  }
  return "p4";
}

function currentFocusType() {
  const mode = getPlanSettings().mode;
  if (mode === "repair") return "ซ่อม";
  if (mode === "pump") return "ปรับปรุงปั๊ม";
  return "พื้นที่ออกตลาด";
}
function isFocusStop(row) {
  const focusType = currentFocusType();
  return cleanText(row.type) === focusType;
}


function getRouteStartForList(list) {
  const valid = list.filter(validCoord);
  return START_POINTS.find(x => x.name === (list[0] && list[0].start_name)) || bestStartForRoute(valid);
}


function optimizeStopsForDisplay(list) {
  // Map และ Google Maps ใช้จุดชุดเดียวกัน และเรียงแบบวงกลมเหมือนตารางแผน
  const valid = list.filter(validCoord).slice(0, MAX_ROUTE_CUSTOMER_STOPS);
  if (!valid.length) return [];
  const start = getRouteStartForList(list);
  return orderCircularRoute(start, valid);
}
function routeDisplayStops(list) {
  // สำคัญ: ใช้ลำดับที่คำนวณไว้ตอนสร้างแผนแล้ว ไม่คำนวณซ้ำในหน้า Map
  // เพื่อให้การ์ดแผน / ตาราง / Map / Google Maps ตรงกัน และไม่เพิ่มจุดเกิน 9 จุด
  const sorted = sortRowsByPlannedStopNo(list).filter(validCoord);

  // โหมดปรับปรุงปั๊ม: บังคับให้จุดปรับปรุงปั๊มเป็นจุดที่ 1 ใน Map/Google Maps เสมอ
  // และจุดอื่น ๆ ยังคงไม่เกิน 8 จุด รวมทั้งหมดไม่เกิน 9 จุด
  if (getPlanSettings().mode === "pump") {
    const pump = sorted.find(isPumpRow);
    if (pump) {
      const rest = removeSameStop(sorted, pump);
      return [pump, ...rest].slice(0, MAX_ROUTE_CUSTOMER_STOPS);
    }
  }

  return sorted.slice(0, MAX_ROUTE_CUSTOMER_STOPS);
}
function routeNavPoints(list) {
  const valid = routeDisplayStops(list);
  if (!valid.length) return [];
  const start = getRouteStartForList(list);
  return [{ ...start, customer_name:start.name, type:"จุดเริ่มต้น", status:"เริ่ม/กลับ" }, ...valid, { ...start, customer_name:start.name, type:"จุดเริ่มต้น", status:"วนกลับ" }];
}

function routeToGoogleMapsUrl(list) {
  // ใช้รายการจุดชุดเดียวกับที่วาดบน Map ในหน้าเว็บ เพื่อให้จำนวนจุดและลำดับตรงกัน
  const stops = routeNavPoints(list);
  if (stops.length < 2) return "";
  const coords = stops.map(p => `${toNumber(p.lat)},${toNumber(p.lng)}`);
  const origin = coords[0];
  const destination = coords[coords.length - 1];
  const waypoints = coords.slice(1, -1).join("|");
  return `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&waypoints=${encodeURIComponent(waypoints)}&travelmode=driving`;
}
function renderRouteSummary(rows) {
  const box = document.getElementById("routeSummary");
  const groups = new Map();
  rows.filter(r => r.route_group && (getPlanSettings().mode === "repair" || !r.route_group.includes("ตารางซ่อม"))).forEach(r => {
    if (!groups.has(r.route_group)) groups.set(r.route_group, []);
    groups.get(r.route_group).push(r);
  });

  currentRouteGroups = groups;
  const keys = Array.from(groups.keys());
  if (!keys.length) {
    selectedRouteKey = "";
    box.innerHTML = `<div class="route-item">ยังไม่มีข้อมูลสำหรับวางแผนในเดือนนี้ หรือจุดถูกบันทึกสำเร็จแล้ว</div>`;
    renderRouteDetail([]);
    return;
  }
  if (!selectedRouteKey || !groups.has(selectedRouteKey)) selectedRouteKey = keys[0];

  const visibleKeys = routeCollapsedToSelected && groups.has(selectedRouteKey) ? [selectedRouteKey] : keys;
  const showAllBtn = routeCollapsedToSelected && keys.length > 1
    ? `<button id="showRouteCardsBtn" class="route-show-all" type="button">แสดงแผนทั้งหมด</button>`
    : "";

  box.innerHTML = showAllBtn + visibleKeys.map((name) => {
    const list = groups.get(name);
    const first = list[0];
    const idx = keys.indexOf(name);
    const routeNames = list.map(x => x.customer_name || x.customer_id).filter(Boolean).join(" → ");
    const active = name === selectedRouteKey ? " active" : "";
    return `<button class="route-item route-button${active}" data-route-key="${escapeHtml(name)}" type="button"><strong>${idx + 1}. ${escapeHtml(name)}</strong><br><span>เริ่ม/วนกลับ: ${escapeHtml(first.start_name || "-")}</span><br><small>${escapeHtml(routeNames)} → ${escapeHtml(first.start_name || "จุดเริ่มต้น")}</small></button>`;
  }).join("");

  const showAll = document.getElementById("showRouteCardsBtn");
  if (showAll) showAll.addEventListener("click", () => {
    routeCollapsedToSelected = false;
    renderRouteSummary(plannedRows);
  });

  box.querySelectorAll(".route-button").forEach(btn => btn.addEventListener("click", () => {
    selectedRouteKey = btn.dataset.routeKey;
    routeCollapsedToSelected = true;
    renderRouteSummary(plannedRows);
  }));
  renderRouteDetail(groups.get(selectedRouteKey) || []);
  const form = document.getElementById("planForm");
  if (form) applySelectedRouteToForm(form);
}
function renderRouteDetail(list) {
  const detail = document.getElementById("routeDetail");
  if (!list.length) {
    detail.innerHTML = "คลิกการ์ดแผนเส้นทางด้านบน เพื่อดูรายละเอียดและแผนที่";
    renderMap([]);
    return;
  }
  const start = START_POINTS.find(x => x.name === list[0].start_name) || bestStartForRoute(list);
  const googleUrl = routeToGoogleMapsUrl(list);
  const displayList = routeDisplayStops(list);
  const hiddenCount = Math.max(0, list.filter(validCoord).length - displayList.length);
  const doneCount = displayList.filter(isCompleted).length;
  const remainCount = Math.max(0, displayList.length - doneCount);
  const rows = displayList.map((r, i) => {
    const done = isCompleted(r);
    const areaCell = detailAreaHtml(r, i);
    return `<tr class="${done ? "done-row" : ""}"><td>${done ? "✓" : i + 1}</td><td>${escapeHtml(r.customer_name || "-")}</td><td>${escapeHtml(r.type || "-")}</td><td>${escapeHtml(r.status || "-")}<br><span class="visit-state ${done ? "done" : "pending"}">${completedLabel(r)}</span></td><td>${areaCell}</td></tr>`;
  }).join("");
  detail.innerHTML = `
    <div class="detail-head">
      <div>
        <h3>${escapeHtml(selectedRouteKey)}</h3>
        <p>จุดเริ่มต้น/วนกลับ: <strong>${escapeHtml(start.name)}</strong></p>
        <p class="route-check-summary">เข้ารับบริการแล้ว <strong>${doneCount}</strong> จุด • คงเหลือ <strong>${remainCount}</strong> จุด</p>
        <p id="routeMetrics" class="route-metrics">กำลังคำนวณเส้นทางตามถนนจริง...</p>
      </div>
      ${googleUrl ? `<a class="map-link" href="${googleUrl}" target="_blank" rel="noopener">เปิดเส้นทางจริง/เวลาที่ดีที่สุดใน Google Maps</a>` : ""}
    </div>
    <div class="detail-table-wrap"><table class="detail-table"><thead><tr><th>ลำดับ</th><th>ชื่อปั๊ม/ลูกค้า</th><th>ประเภท</th><th>สถานะ</th><th>ตำบล/อำเภอ/จังหวัด</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${hiddenCount ? `<p class="route-limit-note">แสดงใน Map/Google Maps ${MAX_ROUTE_CUSTOMER_STOPS} จุดแรก จากทั้งหมด ${hiddenCount + displayList.length} จุด เพื่อให้จำนวนจุดตรงกันและไม่สับสน</p>` : ""}`;
  hydrateDetailAreas();
  renderMap(list);
}
function isUsefulAreaText(v) {
  const a = cleanText(v);
  if (!a || ["ST", "KN", "MUK", "WNN", "KCG"].includes(a.toUpperCase())) return false;
  return a.length > 2;
}
function detailAreaHtml(row, index) {
  if (isUsefulAreaText(row.area)) return escapeHtml(row.area);
  if (!validCoord(row)) return "-";
  return `<span class="geo-area" data-lat="${escapeHtml(row.lat)}" data-lng="${escapeHtml(row.lng)}">กำลังค้นหาพื้นที่...</span>`;
}
async function hydrateDetailAreas() {
  const nodes = Array.from(document.querySelectorAll(".geo-area"));
  for (const node of nodes) {
    const lat = node.dataset.lat;
    const lng = node.dataset.lng;
    if (!lat || !lng) continue;
    const area = await reverseGeocode(lat, lng);
    node.textContent = area || "ไม่พบข้อมูลพื้นที่";
  }
}
function makeNumberIcon(number, variant = "normal") {
  const cls = variant === "focus" ? "route-number-icon route-focus-icon" : "route-number-icon";
  return L.divIcon({
    className: cls,
    html: `<span>${number}</span>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    popupAnchor: [0, -15]
  });
}
function makeDoneIcon() {
  return L.divIcon({
    className: "route-done-icon",
    html: `<span>✓</span>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    popupAnchor: [0, -16]
  });
}
function makeStartIcon(label) {
  return L.divIcon({
    className: "route-start-icon",
    html: `<span>${label}</span>`,
    iconSize: [46, 30],
    iconAnchor: [23, 15],
    popupAnchor: [0, -16]
  });
}


function formatKm(km) {
  if (!Number.isFinite(km)) return "-";
  return km >= 10 ? `${km.toFixed(1)} กม.` : `${km.toFixed(2)} กม.`;
}
function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "-";
  const min = Math.round(seconds / 60);
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h <= 0) return `${m} นาที`;
  return `${h} ชม. ${m} นาที`;
}
async function getOsrmRoute(points) {
  // ใช้ OSRM เพื่อวาดเส้นตามถนนจริงในแผนที่บนหน้าเว็บ
  // หมายเหตุ: OSRM ไม่มีข้อมูลจราจรแบบเรียลไทม์ ดังนั้นเวลา “ดีที่สุด” ให้กดปุ่ม Google Maps เพื่อใช้เวลาจราจรจริงบนมือถือ
  const valid = points.filter(p => Number.isFinite(toNumber(p.lat)) && Number.isFinite(toNumber(p.lng)));
  if (valid.length < 2 || valid.length > 25) return null;
  const coords = valid.map(p => `${toNumber(p.lng)},${toNumber(p.lat)}`).join(";");
  const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;
  const data = await res.json();
  const route = data.routes && data.routes[0];
  if (!route || !route.geometry || !route.geometry.coordinates) return null;
  return {
    latlngs: route.geometry.coordinates.map(c => [c[1], c[0]]),
    distanceKm: route.distance / 1000,
    durationSec: route.duration
  };
}

async function renderMap(list) {
  const mapEl = document.getElementById("routeMap");
  const metricsEl = document.getElementById("routeMetrics");
  if (!window.L) {
    mapEl.innerHTML = "ไม่สามารถโหลดแผนที่ได้ กรุณาตรวจสอบอินเทอร์เน็ต";
    if (metricsEl) metricsEl.textContent = "ไม่สามารถโหลดแผนที่ได้";
    return;
  }
  if (!routeMap) {
    routeMap = L.map("routeMap");
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap" }).addTo(routeMap);
  }
  if (routeLayer) routeLayer.remove();
  routeLayer = L.layerGroup().addTo(routeMap);

  const points = routeNavPoints(list);
  const validStops = routeDisplayStops(list);
  if (points.length < 2 || !validStops.length) {
    routeMap.setView([16.5, 103.8], 8);
    if (metricsEl) metricsEl.textContent = "ยังไม่มีพิกัดสำหรับคำนวณเส้นทาง";
    setTimeout(() => routeMap.invalidateSize(), 200);
    return;
  }

  const latlngs = points.map(p => [toNumber(p.lat), toNumber(p.lng)]);

  // Marker: จุดเริ่มต้นสีเขียว / จุดงานหลักตามโหมดวางแผนเป็นสีเขียว / จุดทั่วไปเป็นสีน้ำเงิน
  points.forEach((p, idx) => {
    const isStart = idx === 0 || idx === points.length - 1;
    const label = idx === 0 ? "เริ่ม" : idx === points.length - 1 ? "กลับ" : String(idx);
    const icon = isStart
      ? makeStartIcon(idx === 0 ? "เริ่ม" : "กลับ")
      : (isCompleted(p) ? makeDoneIcon() : makeNumberIcon(idx, isFocusStop(p) ? "focus" : "normal"));
    L.marker([toNumber(p.lat), toNumber(p.lng)], { icon }).addTo(routeLayer)
      .bindPopup(`<strong>${label}. ${escapeHtml(p.customer_name || p.name || "-")}</strong><br>${escapeHtml(p.type || "-")}<br>${escapeHtml(p.status || "-")}`);
  });

  routeMap.fitBounds(latlngs, { padding: [30, 30] });
  setTimeout(() => routeMap.invalidateSize(), 250);

  // วาดเส้นทางตามถนนจริงด้วย OSRM โดยใช้ points ชุดเดียวกับ Google Maps
  try {
    const routed = await getOsrmRoute(points);
    if (routeLayer && routed && routed.latlngs.length) {
      L.polyline(routed.latlngs, { weight: 5 }).addTo(routeLayer);
      routeMap.fitBounds(routed.latlngs, { padding: [30, 30] });
      if (metricsEl) {
        const done = validStops.filter(isCompleted).length;
        const remain = Math.max(0, validStops.length - done);
        metricsEl.textContent = `จัดลำดับแบบวงกลมและลดการเก็บย้อนหลัง ${validStops.length} จุด ตรงกับ Google Maps • สำเร็จ ${done} จุด • คงเหลือ ${remain} จุด • ระยะทางตามถนนประมาณ ${formatKm(routed.distanceKm)} • เวลาเดินทางประมาณ ${formatDuration(routed.durationSec)} (จำกัด Map/Google Maps ไม่เกิน ${MAX_ROUTE_CUSTOMER_STOPS} จุด)`;
      }
      return;
    }
  } catch (err) {
    // ไม่ต้องหยุดระบบ ถ้า OSRM ไม่ตอบกลับ
  }
  L.polyline(latlngs, { weight: 5, dashArray: "8,8" }).addTo(routeLayer);
  if (metricsEl) metricsEl.textContent = `จัดลำดับแบบวงกลมและลดการเก็บย้อนหลัง ${validStops.length} จุด ตรงกับ Google Maps • แสดงเส้นเชื่อมแบบประมาณการ กด Google Maps เพื่อดูเส้นทางจริงและเวลาที่ดีที่สุด`;
}

function parseSavedVisitDate(row) {
  const parseAny = (v) => {
    const txt = cleanText(v);
    if (!txt) return null;

    // Google Visualization บางครั้งส่ง Date(yyyy,m,d,...)
    const gviz = txt.match(/Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?/);
    if (gviz) {
      return new Date(
        Number(gviz[1]),
        Number(gviz[2]),
        Number(gviz[3]),
        Number(gviz[4] || 0),
        Number(gviz[5] || 0),
        Number(gviz[6] || 0)
      );
    }

    // รูปแบบ 2026-06-24 หรือ 2026/06/24
    const iso = txt.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
    if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));

    // รูปแบบ 24/6/2026, 9:44:45 หรือ 24/6/2569
    const dmy = txt.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
    if (dmy) {
      let y = Number(dmy[3]);
      if (y < 100) y += 2500;
      if (y > 2400) y -= 543;
      return new Date(y, Number(dmy[2]) - 1, Number(dmy[1]));
    }

    return parseDateTH(txt);
  };

  return parseAny(savedCell(row, "วันที่ออกตลาด", 1)) || parseAny(savedCell(row, "วันที่บันทึกระบบ", 0));
}

function savedVisitBU(row) {
  const raw = cleanText(savedCell(row, "BU/สังกัด", 5));
  const upper = raw.toUpperCase();
  if (upper === "ST" || raw.includes("สามทอง")) return "ST";
  if (upper === "KN" || raw.includes("เค.ซี.ปิโตรเลียม2006")) return "KN";
  if (upper === "MUK" || upper === "KCG" || raw.includes("เค.ซี.จี")) return "MUK";
  if (upper === "WNN" || raw.includes("กรีน")) return "WNN";
  return inferBUFromAnyText(raw, savedCell(row, "รหัสลูกค้า", 3), savedCell(row, "ชื่อลูกค้า/ชื่อปั๊ม", 4));
}

function findMasterForSavedVisit(row) {
  const id = norm(savedCell(row, "รหัสลูกค้า", 3));
  const name = norm(savedCell(row, "ชื่อลูกค้า/ชื่อปั๊ม", 4));
  if (id) {
    const hit = customerMasterRows.find(c => norm(c.customer_id) === id);
    if (hit) return hit;
  }
  if (name) {
    const exact = customerMasterRows.find(c => norm(c.customer_name) === name);
    if (exact) return exact;
    const compact = compactCustomerName(savedCell(row, "ชื่อลูกค้า/ชื่อปั๊ม", 4));
    const compactHit = customerMasterRows.find(c => compactCustomerName(c.customer_name) === compact && compact.length >= 4);
    if (compactHit) return compactHit;
  }
  return null;
}

function visitDashboardGroup(row) {
  const master = findMasterForSavedVisit(row);

  // สถานะลูกค้า ต้องอ้างอิงจากรายชื่อลูกค้าใน Master/พื้นที่เซลล์ออกตลาดก่อน
  // ถ้าเป็นลูกค้าที่กรอกเองและไม่มีใน Master ให้ fallback จากข้อมูลที่บันทึกไว้เท่านั้น
  const status = master ? master.status : cleanText(savedCell(row, "สถานะลูกค้า", 14) || savedCell(row, "กลุ่มลูกค้า", 14));
  const group = statusGroup(status);

  if (group === "ลูกค้าซื้อขายประจำ") return "ลูกค้าปัจจุบัน";
  if (group === "ลูกค้าใหม่/Winback") return "ลูกค้าใหม่";
  if (group && group !== "ไม่ระบุ") return group;

  return "ไม่ระบุ";
}

function normalizeSavedVisitRow(row) {
  const master = findMasterForSavedVisit(row) || {};
  const visitDate = parseSavedVisitDate(row);
  const bu = savedVisitBU(row) || master.bu || "";
  return {
    visitDate,
    visitDateLabel: visitDate ? visitDate.toLocaleDateString("th-TH", { day:"numeric", month:"short", year:"2-digit" }) : "-",
    jobType: cleanText(savedCell(row, "ประเภทงาน", 2)),
    customer_id: cleanText(savedCell(row, "รหัสลูกค้า", 3) || master.customer_id),
    customer_name: cleanText(savedCell(row, "ชื่อลูกค้า/ชื่อปั๊ม", 4) || master.customer_name),
    bu,
    buName: branchNameFromBU(bu) || bu || "-",
    meter: cleanText(savedCell(row, "สายมิเตอร์", 6) || master.meter),
    area: cleanText(savedCell(row, "พื้นที่", 7) || master.area),
    visit_status: cleanText(savedCell(row, "สถานะเข้าพบ", 13) || "สำเร็จ"),
    customer_group: visitDashboardGroup(row)
  };
}

function isVisitSuccess(v) {
  return cleanText(v.visit_status) === "สำเร็จ";
}

function normalizeDashboardJobType(v) {
  const s = cleanText(v);
  if (!s) return "ไม่ระบุ";
  if (s.includes("ใหม่") || s.includes("มุ่งหวัง")) return "ลูกค้าใหม่/มุ่งหวัง";
  if (s.includes("ปรับปรุง")) return "ปรับปรุงปั๊ม";
  if (s.includes("ซ่อม")) return "ซ่อม";
  if (s.includes("เยี่ยม") || s.includes("ติดตาม")) return "ออกเยี่ยมลูกค้า";
  return s;
}

function renderVisitDashboard() {
  const body = document.getElementById("dashboardBody");
  if (!body) return;
  const days = Math.max(1, Number(document.getElementById("dashboardDays")?.value || 7));
  const selectedBU = cleanText(document.getElementById("dashboardBU")?.value || "").toUpperCase();
  const today = thaiNow();
  today.setHours(23, 59, 59, 999);
  const start = addDaysTH(today, -(days - 1));
  start.setHours(0, 0, 0, 0);

  let rows = (savedVisitRowsRaw || [])
    .slice(1)
    .map(normalizeSavedVisitRow)
    .filter(r => r.visitDate && r.visitDate >= start && r.visitDate <= today)
    .filter(r => !selectedBU || cleanText(r.bu).toUpperCase() === selectedBU)
    .map(r => ({ ...r, jobTypeGroup: normalizeDashboardJobType(r.jobType) }))
    .sort((a, b) => b.visitDate - a.visitDate || cleanText(a.bu).localeCompare(cleanText(b.bu), "th"));

  const total = rows.length;
  const success = rows.filter(isVisitSuccess).length;
  const pct = total ? Math.round((success / total) * 100) : 0;
  const countGroup = (name) => rows.filter(r => r.customer_group === name).length;
  const countJob = (name) => rows.filter(r => r.jobTypeGroup === name).length;

  const setText = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
  setText("dashTotal", total);
  setText("dashSuccess", `${pct}%`);
  setText("dashSuccessText", `${success}/${total} จุด`);

  // Dashboard 1: ประเภทงานจากชีตเก็บข้อมูล
  const jobVisit = countJob("ออกเยี่ยมลูกค้า");
  const jobLead = countJob("ลูกค้าใหม่/มุ่งหวัง");
  const jobPump = countJob("ปรับปรุงปั๊ม");
  const jobRepair = countJob("ซ่อม");
  setText("dashJobVisit", jobVisit);
  setText("dashJobLead", jobLead);
  setText("dashJobPump", jobPump);
  setText("dashJobRepair", jobRepair);
  setText("dashJobVisitMini", jobVisit);
  setText("dashJobLeadMini", jobLead);
  setText("dashJobPumpMini", jobPump);
  setText("dashJobRepairMini", jobRepair);

  // Dashboard 2: สถานะลูกค้าจาก Master/พื้นที่เซลล์ที่ match กับชื่อลูกค้า/รหัสลูกค้า
  setText("dashLost", countGroup("ลูกค้าหาย"));
  setText("dashDormant", countGroup("ลูกค้าหายเกิน 60 วัน"));
  setText("dashRisky", countGroup("ลูกค้าเสี่ยงหาย"));
  setText("dashActive", countGroup("ลูกค้าปัจจุบัน"));
  setText("dashNew", countGroup("ลูกค้าใหม่"));

  renderVisitDashboardCharts(rows, { total, success, pct, days });

  const note = document.getElementById("dashboardListNote");
  if (note) note.textContent = `แสดง ${Math.min(rows.length, 80)} รายการล่าสุด จากทั้งหมด ${rows.length} จุด`;

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="6" class="loading">ยังไม่พบข้อมูลการออกตลาดในช่วง ${days} วันย้อนหลัง</td></tr>`;
    return;
  }
  body.innerHTML = rows.slice(0, 80).map((r, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(r.visitDateLabel)}</td>
      <td><strong>${escapeHtml(r.customer_name) || "-"}</strong><br><small>${escapeHtml(r.buName)} ${escapeHtml(r.meter) || ""}</small></td>
      <td><span class="badge ${dashboardJobClass(r.jobTypeGroup)}">${escapeHtml(r.jobTypeGroup || "-")}</span></td>
      <td><span class="badge ${dashboardGroupClass(r.customer_group)}">${escapeHtml(r.customer_group)}</span></td>
      <td><span class="visit-status-pill ${isVisitSuccess(r) ? "ok" : "warn"}">${escapeHtml(r.visit_status) || "-"}</span></td>
    </tr>`).join("");
}

function setDashboardDonut(donutId, centerId, legendId, defs, total) {
  const donut = document.getElementById(donutId);
  const donutCenter = document.getElementById(centerId);
  const legend = document.getElementById(legendId);
  if (donut) {
    if (!total) {
      donut.style.background = "#e5e7eb";
    } else {
      let cursor = 0;
      const parts = defs.filter(c => c.count > 0).map(c => {
        const startDeg = cursor;
        const deg = (c.count / total) * 360;
        cursor += deg;
        return `${c.color} ${startDeg}deg ${cursor}deg`;
      });
      donut.style.background = `conic-gradient(${parts.join(",") || "#e5e7eb 0deg 360deg"})`;
    }
  }
  if (donutCenter) donutCenter.innerHTML = `${total}<br><small>จุด</small>`;
  if (legend) {
    legend.innerHTML = defs.map(c => {
      const pct = total ? Math.round((c.count / total) * 100) : 0;
      return `<div class="legend-row"><span class="legend-dot" style="background:${c.color}"></span><span>${escapeHtml(c.label)}</span><strong>${c.count} จุด (${pct}%)</strong></div>`;
    }).join("");
  }
}

function setDashboardBars(containerId, rows, totalForPct = null) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const max = Math.max(1, ...rows.map(x => x.count));
  el.innerHTML = (rows.length ? rows : [{ label:"ไม่มีข้อมูล", count:0, color:"#94a3b8" }]).map(item => {
    const width = Math.round((item.count / max) * 100);
    const pct = totalForPct ? ` (${Math.round((item.count / totalForPct) * 100)}%)` : "";
    return `<div class="bar-row"><div class="bar-label"><span>${escapeHtml(item.label)}</span><strong>${item.count} จุด${pct}</strong></div><div class="bar-track"><div class="bar-fill" style="width:${width}%;background:${item.color || ""}"></div></div></div>`;
  }).join("");
}

function renderVisitDashboardCharts(rows, summary) {
  const total = summary.total || 0;
  const jobDefs = [
    { key:"ออกเยี่ยมลูกค้า", label:"ออกเยี่ยมลูกค้า", color:"#2563eb" },
    { key:"ลูกค้าใหม่/มุ่งหวัง", label:"ลูกค้าใหม่/มุ่งหวัง", color:"#16a34a" },
    { key:"ปรับปรุงปั๊ม", label:"ปรับปรุงปั๊ม", color:"#f97316" },
    { key:"ซ่อม", label:"ซ่อม", color:"#ef4444" }
  ].map(g => ({ ...g, count: rows.filter(r => r.jobTypeGroup === g.key).length }));

  const customerDefs = [
    { key:"ลูกค้าหาย", label:"ลูกค้าหาย", color:"#f97316" },
    { key:"ลูกค้าหายเกิน 60 วัน", label:"หายเกิน 60 วัน", color:"#7c3aed" },
    { key:"ลูกค้าเสี่ยงหาย", label:"เสี่ยงหาย", color:"#ef4444" },
    { key:"ลูกค้าปัจจุบัน", label:"ลูกค้าปัจจุบัน", color:"#16a34a" },
    { key:"ลูกค้าใหม่", label:"ลูกค้าใหม่", color:"#2563eb" }
  ].map(g => ({ ...g, count: rows.filter(r => r.customer_group === g.key).length }));

  setDashboardDonut("dashJobDonut", "dashJobDonutCenter", "dashJobLegend", jobDefs, total);
  setDashboardBars("dashJobBars", jobDefs, total);

  setDashboardDonut("dashDonut", "dashDonutCenter", "dashLegend", customerDefs, total);
  setDashboardBars("dashCustomerBars", customerDefs, total);

  const statusMap = new Map();
  rows.forEach(r => {
    const st = cleanText(r.visit_status || "ไม่ระบุ") || "ไม่ระบุ";
    statusMap.set(st, (statusMap.get(st) || 0) + 1);
  });
  const statusRows = Array.from(statusMap.entries()).sort((a,b)=>b[1]-a[1]).map(([label, count]) => ({ label, count, color: label === "สำเร็จ" ? "#16a34a" : "#f97316" }));
  setDashboardBars("dashStatusBars", statusRows, total);

  const strip = document.getElementById("dashboardSummaryStrip");
  if (strip) strip.textContent = `แผนที่วางไว้ ${total} จุด • เข้าพบสำเร็จ ${summary.success || 0} จุด • อัตราสำเร็จ ${summary.pct || 0}% • เฉลี่ย ${(total / Math.max(1, summary.days || 1)).toFixed(1)} จุด/วัน`;
}

function dashboardJobClass(job) {
  if (job === "ซ่อม") return "p2";
  if (job === "ปรับปรุงปั๊ม") return "p3";
  if (job === "ลูกค้าใหม่/มุ่งหวัง") return "p4";
  if (job === "ออกเยี่ยมลูกค้า") return "p4";
  return "p4";
}

function dashboardGroupClass(group) {
  if (group === "ลูกค้าหาย") return "p2";
  if (group === "ลูกค้าหายเกิน 60 วัน") return "p3";
  if (group === "ลูกค้าเสี่ยงหาย") return "p3";
  if (group === "ลูกค้าปัจจุบัน") return "p4";
  if (group === "ลูกค้าใหม่") return "p4";
  return "p4";
}

function renderTable() {
  const tbody = document.getElementById("resultBody");
  renderRouteSummary(plannedRows);
  renderVisitDashboard();
  if (!tbody) {
    const rows = plannedRows || [];
    document.getElementById("sumAll").textContent = rows.length;
    document.getElementById("sumPump").textContent = rows.filter(r => r.type === "ปรับปรุงปั๊ม").length;
    document.getElementById("sumRepair").textContent = rows.filter(r => r.type === "ซ่อม").length;
    document.getElementById("sumMarket").textContent = rows.filter(r => r.type === "พื้นที่ออกตลาด").length;
    return;
  }
  const search = cleanText(document.getElementById("searchBox")?.value || "").toLowerCase();
  const type = cleanText(document.getElementById("typeFilter")?.value || "");
  const status = cleanText(document.getElementById("statusFilter")?.value || "").toLowerCase();
  const showAll = !!document.getElementById("showAllToggle")?.checked;

  const selectedBU = getSelectedStartBU();
  let rows = showAll ? rawRows : plannedRows;
  rows = rows.filter(r => {
    const text = `${r.route_group} ${r.customer_id} ${r.customer_name} ${r.meter} ${r.area} ${r.status} ${r.bu}`.toLowerCase();
    const buOk = !selectedBU || cleanText(r.bu).toUpperCase() === selectedBU.toUpperCase() || cleanText(r.start_name);
    return buOk && (!type || r.type === type) && (!status || cleanText(r.status).toLowerCase().includes(status)) && (!search || text.includes(search));
  });

  document.getElementById("sumAll").textContent = rows.length;
  document.getElementById("sumPump").textContent = rows.filter(r => r.type === "ปรับปรุงปั๊ม").length;
  document.getElementById("sumRepair").textContent = rows.filter(r => r.type === "ซ่อม").length;
  document.getElementById("sumMarket").textContent = rows.filter(r => r.type === "พื้นที่ออกตลาด").length;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="18" class="loading">ไม่พบข้อมูลตามเงื่อนไข</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r,i) => `
    <tr class="${isCompleted(r) ? "done-row" : ""}">
      <td>${i + 1}</td><td>${isCompleted(r) ? "✓" : (escapeHtml(r.stop_no) || "-")}</td><td>${escapeHtml(r.start_name) || "-"}</td>
      <td><span class="badge ${priorityClass(r)}">${escapeHtml(r.priorityLabel)}</span></td><td>${escapeHtml(r.type)}</td><td>${escapeHtml(r.dateRaw) || "-"}</td>
      <td>${escapeHtml(r.customer_id) || "-"}</td><td>${escapeHtml(r.customer_name) || "-"}</td><td>${escapeHtml(r.status) || "-"}</td><td>${escapeHtml(r.bu) || "-"}</td>
      <td>${escapeHtml(r.meter) || "-"}</td><td>${escapeHtml(r.area) || "-"}</td><td>${escapeHtml(r.purpose) || "-"}</td><td>${escapeHtml(r.coordinator) || "-"}</td>
      <td>${escapeHtml(r.phone) || "-"}</td><td>${escapeHtml(r.sales_litre) || "-"}</td><td>${escapeHtml(r.lat) || "-"}</td><td>${escapeHtml(r.lng) || "-"}</td>
    </tr>`).join("");
}
function compactCustomerName(name) {
  return norm(name).replace(/\s+[a-z]{1,5}\d{3,}$/i, "").replace(/\s+st\d+$/i, "").trim();
}

function buildCustomerMasterRows(pumpRows, repairRows, marketRows) {
  const map = new Map();
  const add = (row) => {
    if (!row || (!row.customer_id && !row.customer_name)) return;
    const idKey = norm(row.customer_id);
    const nameKey = norm(row.customer_name);
    const key = idKey || nameKey;
    if (!key) return;
    const existing = map.get(key) || {};
    map.set(key, {
      ...existing,
      ...row,
      customer_id: row.customer_id || existing.customer_id || "",
      customer_name: row.customer_name || existing.customer_name || "",
      bu: row.bu || existing.bu || inferBU(row.customer_id, existing.bu),
      meter: row.meter || existing.meter || "",
      area: row.area || existing.area || "",
      lat: row.lat || existing.lat || "",
      lng: row.lng || existing.lng || "",
      purpose: row.purpose || existing.purpose || "ติดตามสถานะลูกค้า",
      coordinator: row.coordinator || existing.coordinator || "",
      phone: row.phone || existing.phone || "",
      type: row.type || existing.type || "พื้นที่ออกตลาด"
    });
  };
  marketRows.forEach(add);
  pumpRows.forEach(add);
  repairRows.forEach(add);
  return Array.from(map.values());
}

function findCustomerByIdOrName(customerId, customerName) {
  const id = norm(customerId);
  const name = norm(customerName);
  const compactName = compactCustomerName(customerName);

  if (id) {
    const exactId = customerMasterRows.find(c => norm(c.customer_id) === id);
    if (exactId) return exactId;
  }

  if (name) {
    let exactName = customerMasterRows.find(c => norm(c.customer_name) === name);
    if (exactName) return exactName;
    exactName = customerMasterRows.find(c => compactCustomerName(c.customer_name) === compactName && compactName.length >= 4);
    if (exactName) return exactName;
  }

  return null;
}

function fillFormFromMasterCustomer(customer, source = "manual") {
  if (!customer) return false;
  const form = document.getElementById("planForm");
  if (!form) return false;

  const currentVisitDate = form.elements.visit_date.value;
  const currentStatus = form.elements.visit_status ? form.elements.visit_status.value : "";

  form.elements.job_type.value = customer.type === "ซ่อม" ? "ซ่อม" : "ออกเยี่ยมลูกค้า";
  form.elements.customer_id.value = customer.customer_id || "";
  form.elements.customer_name.value = customer.customer_name || "";
  const routeMeta = selectedRouteMeta();
  const buCode = routeMeta.bu || customer.bu || inferBU(customer.customer_id, customer.bu);
  form.elements.bu.value = branchNameFromBU(buCode);
  form.elements.meter.value = routeMeta.meter || customer.meter || "";
  form.elements.area.value = customer.area || "";
  if (form.elements.purpose) form.elements.purpose.value = customer.purpose || (customer.type === "ซ่อม" ? "ซ่อม" : "ออกเยี่ยมลูกค้า");
  form.elements.coordinator.value = customer.coordinator || "";
  form.elements.phone.value = customer.phone || "";
  form.elements.lat.value = customer.lat || "";
  form.elements.lng.value = customer.lng || "";
  if (currentVisitDate) form.elements.visit_date.value = currentVisitDate;
  if (form.elements.visit_status && currentStatus) form.elements.visit_status.value = currentStatus;

  const status = document.getElementById("saveStatus");
  if (status) {
    status.textContent = source === "gps"
      ? `พบข้อมูลลูกค้าจาก GPS: ${customer.customer_name || customer.customer_id}`
      : `ดึงข้อมูลลูกค้าสำเร็จ: ${customer.customer_name || customer.customer_id}`;
    status.style.color = "#166534";
  }
  return true;
}

function autoFillCustomerFromInput() {
  const form = document.getElementById("planForm");
  if (!form) return;
  const customer = findCustomerByIdOrName(form.elements.customer_id.value, form.elements.customer_name.value);
  if (customer) fillFormFromMasterCustomer(customer, "manual");
}

async function saveForm(e) {
  e.preventDefault();
  const status = document.getElementById("saveStatus");
  const data = Object.fromEntries(new FormData(e.target).entries());
  if (WEB_APP_URL.includes("PUT_YOUR")) {
    status.textContent = "กรุณาใส่ Web App URL ในไฟล์ script.js ก่อน";
    status.style.color = "#dc2626";
    return;
  }
  status.textContent = "กำลังบันทึกข้อมูล...";
  status.style.color = "#92400e";
  try {
    await fetch(WEB_APP_URL, { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(data) });
    status.textContent = "บันทึกข้อมูลเรียบร้อยแล้ว: ถ้าสถานะเป็น “สำเร็จ” ระบบจะตัดจุดนี้ออกจากแผน แต่ถ้าไม่สำเร็จจะนำกลับมาวางแผนใหม่";
    status.style.color = "#166534";
    e.target.reset();
    setTimeout(loadData, 900);
  } catch (err) {
    status.textContent = `บันทึกไม่สำเร็จ: ${err.message}`;
    status.style.color = "#dc2626";
  }
}

function todayInputValue() {
  const d = thaiNow();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function cleanThaiPlace(v, prefixes = []) {
  let text = cleanText(v);
  prefixes.forEach(prefix => { text = text.replace(new RegExp(`^${prefix}\\s*`, "i"), ""); });
  return text.trim();
}

function isBadAreaPart(v) {
  const text = cleanText(v).toLowerCase();
  return !text ||
    text === "ประเทศไทย" ||
    text === "ประเทศ ไทย" ||
    text === "thailand" ||
    text === "kingdom of thailand" ||
    text === "ไทย";
}

function pickAreaPart(values = [], prefixes = []) {
  for (const v of values) {
    const cleaned = cleanThaiPlace(v, prefixes);
    if (!isBadAreaPart(cleaned)) return cleaned;
  }
  return "";
}

function buildAreaText(address = {}) {
  const province = pickAreaPart([
    address.state,
    address.province,
    address.principalSubdivision
  ], ["จังหวัด"]);

  const amphoe = pickAreaPart([
    address.county,
    address.city_district,
    address.district,
    address.municipality,
    address.city,
    address.town
  ], ["อำเภอ", "เขต"]);

  const tambon = pickAreaPart([
    address.suburb,
    address.subdistrict,
    address.quarter,
    address.village,
    address.hamlet,
    address.neighbourhood,
    address.locality
  ], ["ตำบล", "แขวง"]);

  const parts = [];
  if (tambon) parts.push(`ต.${tambon}`);
  if (amphoe) parts.push(`อ.${amphoe}`);
  if (province) parts.push(`จ.${province}`);
  return parts.join(" ");
}

function buildAreaTextFromBigDataCloud(data = {}) {
  const admin = (((data.localityInfo || {}).administrative) || [])
    .map(x => ({
      name: cleanThaiPlace(x.name || "", ["ตำบล", "แขวง", "อำเภอ", "เขต", "จังหวัด"]),
      level: Number(x.adminLevel || x.level || 0),
      desc: cleanText(x.description || x.isoName || "").toLowerCase()
    }))
    .filter(x => !isBadAreaPart(x.name));

  const province = pickAreaPart([
    data.principalSubdivision,
    ...admin.filter(x => x.desc.includes("province") || x.level === 4).map(x => x.name),
    ...admin.map(x => x.name)
  ], ["จังหวัด"]);

  const amphoe = pickAreaPart([
    ...admin.filter(x => x.desc.includes("district") || x.level === 6 || x.level === 7).map(x => x.name),
    data.city,
    data.locality
  ].filter(x => cleanThaiPlace(x, []) !== province), ["อำเภอ", "เขต"]);

  const tambon = pickAreaPart([
    data.locality,
    ...admin.filter(x => x.desc.includes("subdistrict") || x.level >= 8).map(x => x.name)
  ].filter(x => cleanThaiPlace(x, []) !== amphoe && cleanThaiPlace(x, []) !== province), ["ตำบล", "แขวง"]);

  const parts = [];
  if (tambon) parts.push(`ต.${tambon}`);
  if (amphoe) parts.push(`อ.${amphoe}`);
  if (province) parts.push(`จ.${province}`);
  return parts.join(" ");
}

function isValidAreaText(area) {
  const text = cleanText(area);
  if (!text || text === "ไม่พบข้อมูลพื้นที่") return false;
  if (/อ\.\s*(ประเทศไทย|ไทย|Thailand)/i.test(text)) return false;
  if (/ต\.\s*(ประเทศไทย|ไทย|Thailand)/i.test(text)) return false;
  return true;
}

async function reverseGeocode(lat, lng) {
  const key = `area_v2:${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`;
  try {
    const cached = localStorage.getItem(key);
    if (isValidAreaText(cached)) return cached;
  } catch (e) {}

  // Provider 1: Nominatim ให้โครงสร้างตำบล/อำเภอ/จังหวัดของไทยแม่นกว่า
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&zoom=18&addressdetails=1&accept-language=th`;
    const res = await fetch(url, { cache: "force-cache" });
    if (res.ok) {
      const data = await res.json();
      const area = buildAreaText(data.address || {});
      if (isValidAreaText(area)) { try { localStorage.setItem(key, area); } catch (e) {} return area; }
    }
  } catch (err) {}

  // Provider 2: BigDataCloud สำรอง และกรองคำว่า ประเทศไทย ไม่ให้เป็นอำเภอ/ตำบล
  try {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lng)}&localityLanguage=th`;
    const res = await fetch(url, { cache: "force-cache" });
    if (res.ok) {
      const data = await res.json();
      const area = buildAreaTextFromBigDataCloud(data);
      if (isValidAreaText(area)) { try { localStorage.setItem(key, area); } catch (e) {} return area; }
    }
  } catch (err) {}

  return "ไม่พบข้อมูลพื้นที่";
}
function distanceMeter(lat1, lng1, lat2, lng2) {
  return haversine({ lat: lat1, lng: lng1 }, { lat: lat2, lng: lng2 }) * 1000;
}

function findNearestCustomer(lat, lng) {
  const customers = rawRows.filter(validCoord);
  let nearest = null;
  customers.forEach(c => {
    const d = distanceMeter(lat, lng, toNumber(c.lat), toNumber(c.lng));
    if (d <= CHECKIN_RADIUS_METER && (!nearest || d < nearest.distance)) {
      nearest = { ...c, distance: d };
    }
  });
  return nearest;
}

function fillFormFromCustomer(form, customer) {
  fillFormFromMasterCustomer(customer, "gps");
  if (!form.elements.area.value && customer.area) form.elements.area.value = customer.area;
}

function unlockManualCustomerFields(form) {
  ["customer_id", "customer_name", "bu", "meter"].forEach(name => {
    if (form.elements[name]) form.elements[name].readOnly = false;
  });
}

async function checkInGps() {
  const status = document.getElementById("saveStatus");
  const btn = document.getElementById("checkinBtn");
  if (!navigator.geolocation) {
    status.textContent = "อุปกรณ์นี้ไม่รองรับ GPS / Location";
    status.style.color = "#dc2626";
    return;
  }
  status.textContent = "กำลังดึงพิกัด GPS กรุณาอนุญาตตำแหน่งบนโทรศัพท์...";
  status.style.color = "#92400e";
  btn.disabled = true;
  navigator.geolocation.getCurrentPosition(async pos => {
    const lat = pos.coords.latitude.toFixed(14);
    const lng = pos.coords.longitude.toFixed(14);
    const form = document.getElementById("planForm");
    form.elements.lat.value = lat;
    form.elements.lng.value = lng;
    form.elements.visit_date.value = todayInputValue();
    if (form.elements.visit_status && !form.elements.visit_status.value) form.elements.visit_status.value = "สำเร็จ";

    const area = await reverseGeocode(lat, lng);
    if (area) form.elements.area.value = area;

    const customer = findNearestCustomer(Number(lat), Number(lng));
    if (customer) {
      fillFormFromCustomer(form, customer);
      if (!form.elements.area.value && customer.area) form.elements.area.value = customer.area;
      applySelectedRouteToForm(form);
      status.textContent = `เช็คอินสำเร็จ: พบลูกค้าในรัศมี ${Math.round(customer.distance)} เมตร - ${customer.customer_name || customer.customer_id}`;
      status.style.color = "#166534";
    } else {
      unlockManualCustomerFields(form);
      applySelectedRouteToForm(form);
      status.textContent = `เช็คอินสำเร็จ: อยู่นอกเขตลูกค้า ${CHECKIN_RADIUS_METER} เมตร ระบบเติมพื้นที่/พิกัดให้แล้ว กรุณากรอกรหัสลูกค้า ชื่อปั๊ม BU และสายมิเตอร์เอง`;
      status.style.color = "#92400e";
    }
    btn.disabled = false;
  }, err => {
    let msg = "ไม่สามารถดึง GPS ได้";
    if (err.code === 1) msg = "กรุณาอนุญาต Location/GPS ในเบราว์เซอร์ก่อน";
    if (err.code === 2) msg = "ไม่พบตำแหน่ง GPS กรุณาเปิด Location บนโทรศัพท์";
    if (err.code === 3) msg = "ดึงตำแหน่งไม่ทันเวลา กรุณาลองใหม่";
    status.textContent = msg;
    status.style.color = "#dc2626";
    btn.disabled = false;
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
}

document.getElementById("planForm").addEventListener("submit", saveForm);
if (document.getElementById("searchBox")) document.getElementById("searchBox").addEventListener("input", renderTable);
if (document.getElementById("typeFilter")) document.getElementById("typeFilter").addEventListener("change", renderTable);
if (document.getElementById("statusFilter")) document.getElementById("statusFilter").addEventListener("change", renderTable);
if (document.getElementById("showAllToggle")) document.getElementById("showAllToggle").addEventListener("change", renderTable);
if (document.getElementById("dashboardDays")) document.getElementById("dashboardDays").addEventListener("change", renderVisitDashboard);
if (document.getElementById("dashboardBU")) document.getElementById("dashboardBU").addEventListener("change", renderVisitDashboard);
if (document.getElementById("startPointInput")) document.getElementById("startPointInput").addEventListener("change", () => { routeCollapsedToSelected = false; loadData(); });
if (document.getElementById("planMode")) document.getElementById("planMode").addEventListener("change", () => { routeCollapsedToSelected = false; loadData(); });
if (document.getElementById("planDays")) document.getElementById("planDays").addEventListener("change", () => { routeCollapsedToSelected = false; loadData(); });
if (document.getElementById("marketStatusFilter")) document.getElementById("marketStatusFilter").addEventListener("change", () => { routeCollapsedToSelected = false; loadData(); });
document.getElementById("reloadBtn").addEventListener("click", loadData);
document.getElementById("checkinBtn").addEventListener("click", checkInGps);
["customer_id", "customer_name"].forEach(name => {
  const el = document.querySelector(`#planForm [name="${name}"]`);
  if (el) {
    el.addEventListener("change", autoFillCustomerFromInput);
    el.addEventListener("blur", autoFillCustomerFromInput);
  }
});
loadData();

/* ===== Page switch: Page 1 planning / Page 2 dashboard ===== */
function showAppPage(pageNo) {
  const page1 = document.getElementById("page1");
  const page2 = document.getElementById("page2");
  const btn1 = document.getElementById("btnPage1");
  const btn2 = document.getElementById("btnPage2");
  const isPage2 = Number(pageNo) === 2;

  if (page1) page1.hidden = isPage2;
  if (page2) page2.hidden = !isPage2;
  if (btn1) btn1.classList.toggle("active", !isPage2);
  if (btn2) btn2.classList.toggle("active", isPage2);

  if (isPage2) renderVisitDashboard();
  if (!isPage2 && routeMap) setTimeout(() => routeMap.invalidateSize(), 150);
}

if (document.getElementById("btnPage1")) document.getElementById("btnPage1").addEventListener("click", () => showAppPage(1));
if (document.getElementById("btnPage2")) document.getElementById("btnPage2").addEventListener("click", () => showAppPage(2));
