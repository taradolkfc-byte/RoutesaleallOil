const SHEET_ID = "1NIsXwTi6tKmYtX8DoTUqvG4mxW-5Y5YVJB0EfmQMCvY";

// URL Apps Script ของคุณ
const WEB_APP_URL = "https://script.google.com/macros/s/AKfycbxu0zeUAfHU1YBI0KJRTFC97xRTsPvXPx8cbw-8iXKqzHomAy0T48reAcQouaS0Ob1A/exec";

const SHEET_NAMES = {
  pump: "ตารางปรับปรุงปั๊ม",
  repair: "ตารางซ่อม",
  market: "พื้นที่เซลล์ออกตลาด",
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
const MAX_STOPS_PER_DAY = 16;
// จำกัดจำนวนจุดที่ส่งเข้า Map และ Google Maps ให้ตรงกัน ไม่เกิน 9 จุด ตามเงื่อนไขใช้งานจริง
const MAX_ROUTE_CUSTOMER_STOPS = 9;
// โหมดปรับปรุงปั๊มและตารางซ่อมใช้วงหลัก 7 จุด เพื่อตัดจุด 8-9 ที่หลุดวง/ทำให้ย้อนกลับ
const TARGET_CORE_ROUTE_STOPS = 7;
const MIN_ROUTE_CUSTOMER_STOPS = 7;
const MAX_ROUTE_DISTANCE_KM = 350;
const ROAD_DISTANCE_FACTOR = 1.22;
// โหมดวันปกติ/ออกตลาดทั่วไป: ต้องคง 9 จุด และคัดจากวงเส้นทางที่ดีที่สุดโดยไม่ให้หนักจน Browser ค้าง
const NORMAL_ROUTE_TARGET_STOPS = 9;
const NORMAL_ROUTE_POOL_LIMIT = 36;

const COORDINATOR_PHONE_MAP = {
  "น้าฮ้อย": "082-1165845"
};

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

/* ===== Fast load optimization 20260713 =====
   คงเงื่อนไขเส้นทางเดิม แต่ลดงานซ้ำระหว่างโหลด/เปลี่ยนตัวกรอง
   - cache ข้อมูลชีตในหน่วยความจำระยะสั้น
   - cache ระยะทาง/คะแนนเส้นทางที่คำนวณซ้ำบ่อย
   - defer Dashboard/พื้นที่ reverse geocode ที่ไม่จำเป็นกับหน้าแรก
*/
const SHEET_MEMORY_CACHE_MS = 120000;
const SHEET_MEMORY_CACHE = new Map();
const DISTANCE_MEMORY_CACHE = new Map();
const ROUTE_SCORE_MEMORY_CACHE = new Map();
let isLoadingData = false;
let pendingLoadRequest = false;

function resetRouteComputeCache() {
  DISTANCE_MEMORY_CACHE.clear();
  ROUTE_SCORE_MEMORY_CACHE.clear();
}

function cloneSheetRows(rows) {
  return Array.isArray(rows) ? rows.map(r => Array.isArray(r) ? [...r] : r) : rows;
}

function coordCacheKey(point) {
  const lat = Number(point && point.lat);
  const lng = Number(point && point.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return "invalid";
  return `${lat.toFixed(8)},${lng.toFixed(8)}`;
}

function isDashboardPageVisible() {
  const page2 = document.getElementById("page2");
  return !!page2 && !page2.hidden;
}

function runWhenIdle(fn) {
  if (window.requestIdleCallback) {
    window.requestIdleCallback(fn, { timeout: 1500 });
  } else {
    setTimeout(fn, 60);
  }
}

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


async function fetchSheetByIndex(sheetName, optional = false, forceFresh = false) {
  const cacheKey = `sheet:${sheetName}`;
  const cached = SHEET_MEMORY_CACHE.get(cacheKey);
  if (!forceFresh && cached && (Date.now() - cached.ts) < SHEET_MEMORY_CACHE_MS) {
    return cloneSheetRows(cached.rows);
  }

  const cacheParam = forceFresh ? `&cachebust=${Date.now()}` : "";
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(sheetName)}${cacheParam}`;
  const res = await fetch(url, { cache: forceFresh ? "no-store" : "default" });
  if (!res.ok) {
    if (optional) return [];
    throw new Error(`โหลดชีต ${sheetName} ไม่ได้`);
  }
  const text = await res.text();
  const jsonText = text.substring(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const json = JSON.parse(jsonText);
  const rows = json.table.rows.map(r => (r.c || []).map(c => c ? (c.f || c.v || "") : ""));
  SHEET_MEMORY_CACHE.set(cacheKey, { ts: Date.now(), rows: cloneSheetRows(rows) });
  return rows;
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

async function fetchSavedGvizByQuery(queryPart, forceFresh = false) {
  const cacheKey = `saved:${queryPart}`;
  const cached = SHEET_MEMORY_CACHE.get(cacheKey);
  if (!forceFresh && cached && (Date.now() - cached.ts) < SHEET_MEMORY_CACHE_MS) {
    return cloneSheetRows(cached.rows);
  }

  const cacheParam = forceFresh ? `&cachebust=${Date.now()}` : "";
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&${queryPart}&headers=1${cacheParam}`;
  const res = await fetch(url, { cache: forceFresh ? "no-store" : "default" });
  if (!res.ok) throw new Error(`โหลดชีตเก็บข้อมูลไม่ได้ (${res.status})`);
  const text = await res.text();
  const jsonText = text.substring(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const json = JSON.parse(jsonText);
  const rows = parseSavedGvizTable(json);
  SHEET_MEMORY_CACHE.set(cacheKey, { ts: Date.now(), rows: cloneSheetRows(rows) });
  return rows;
}


async function fetchSavedSheetRowsRobust(forceFresh = false) {
  // วิธีหลัก: อ่านด้วยชื่อชีต "เก็บข้อมูล"
  try {
    const rows = await fetchSavedGvizByQuery(`sheet=${encodeURIComponent(SHEET_NAMES.saved)}`, forceFresh);
    if (rows && rows.length > 1) return rows;
  } catch (err) {}

  // วิธีสำรอง: อ่านด้วย gid ของชีต “เก็บข้อมูล” ตาม URL ที่ใช้งานจริง
  try {
    const rows = await fetchSavedGvizByQuery(`gid=352387367`, forceFresh);
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
  const mode = modeEl ? modeEl.value : "pump";
  // ยกเลิกการคำนวณ/เลือกวันล่วงหน้า: ระบบวางแผนเฉพาะวันปัจจุบันเท่านั้น
  return { mode, days: 1 };
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

function orderStatusFilterRoute(start, points) {
  // ใช้เฉพาะเมื่อเลือก Dropdown "เลือกสถานะ"
  // หลักคือเรียงแบบกวาดรอบกลุ่มลูกค้าเป็นวงกลม ไม่ใช้การหาจุดใกล้สุดที่มักทำให้วกกลับไปมา
  const valid = (points || []).filter(validCoord).map(p => ({ ...p }));
  const noCoord = (points || []).filter(p => !validCoord(p));
  if (valid.length <= 2) return [...valid, ...noCoord];

  const center = {
    lat: valid.reduce((sum, p) => sum + toNumber(p.lat), 0) / valid.length,
    lng: valid.reduce((sum, p) => sum + toNumber(p.lng), 0) / valid.length
  };

  const baseAsc = [...valid].sort((a, b) => angleFromCenter(center, a) - angleFromCenter(center, b));
  const baseDesc = [...baseAsc].reverse();
  const candidates = [];

  [baseAsc, baseDesc].forEach(base => {
    for (let i = 0; i < base.length; i++) {
      const rotated = [...base.slice(i), ...base.slice(0, i)];
      candidates.push(rotated);
      candidates.push(pullPointsThatAreOnTheWay(start, rotated));
    }
  });

  const seen = new Set();
  const unique = candidates.filter(route => {
    const key = uniqueRouteCandidateKey(route);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const best = (unique.length ? unique : [baseAsc])
    .sort((a, b) => {
      const sa = routeDistanceFromStart(start, a) + statusLoopRoutePenalty(start, a);
      const sb = routeDistanceFromStart(start, b) + statusLoopRoutePenalty(start, b);
      return sa - sb;
    })[0] || baseAsc;

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
    const visitDate = parseDateTH(savedCell(r, "วันที่ออกตลาด", 1)) || parseDateTH(savedCell(r, "วันที่บันทึกระบบ", 0));
    if (visitDate && !inCurrentThaiMonth(visitDate)) return;

    // โครงสร้างชีตใหม่: 0 วันที่บันทึก, 1 วันที่ออกตลาด, 2 ประเภท, 3 รหัส, 4 ชื่อ, ... 13 สถานะเข้าพบ
    // ถ้าเป็นข้อมูลเก่าไม่มีคอลัมน์สถานะ ให้ถือว่า “สำเร็จ” เพื่อไม่ให้จุดเก่ากลับมาในแผน
    const visitStatus = cleanText(savedCell(r, "สถานะเข้าพบ", 13) || "สำเร็จ");
    if (visitStatus && visitStatus !== "สำเร็จ") return;

    const idCandidates = [savedCell(r, "รหัสลูกค้า", 3), cell(r, 2)];
    const nameCandidates = [savedCell(r, "ชื่อลูกค้า/ชื่อปั๊ม", 4), cell(r, 3)];
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
        coordinator: "", phone: "", lat: cell(r,6), lng: cell(r,7), route_group: "", stop_no: "", start_name: ""
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
      lat: cell(r,2), lng: cell(r,3), route_group: "", stop_no: "", start_name: ""
    };
  }).filter(r => r.customer_id || r.customer_name);
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
  const aKey = coordCacheKey(a);
  const bKey = coordCacheKey(b);
  const key = aKey <= bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
  if (DISTANCE_MEMORY_CACHE.has(key)) return DISTANCE_MEMORY_CACHE.get(key);

  const R = 6371;
  const lat1 = Number(a.lat) * Math.PI / 180;
  const lat2 = Number(b.lat) * Math.PI / 180;
  const dLat = (Number(b.lat) - Number(a.lat)) * Math.PI / 180;
  const dLng = (Number(b.lng) - Number(a.lng)) * Math.PI / 180;
  const x = Math.sin(dLat/2)**2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng/2)**2;
  const km = R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
  if (DISTANCE_MEMORY_CACHE.size < 25000) DISTANCE_MEMORY_CACHE.set(key, km);
  return km;
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

function approxRoadDistanceKm(start, order) {
  // ใช้ระยะเส้นตรงคูณ factor เพื่อคัดแผนเบื้องต้นไม่ให้เกิน 350 กม.
  // ระยะจริงตามถนนยังคำนวณด้วย OSRM ตอนแสดงแผนที่
  return routeDistanceFromStart(start, (order || []).filter(validCoord)) * ROAD_DISTANCE_FACTOR;
}

function normalizeBUCode(v) {
  const key = cleanText(v).toUpperCase();
  if (key === "KCG") return "MUK";
  return key;
}

function buEquivalent(a, b) {
  const aa = normalizeBUCode(a);
  const bb = normalizeBUCode(b);
  return !!aa && !!bb && aa === bb;
}

function routeStopCount(rows) {
  return (rows || []).filter(validCoord).length;
}

function isSameStop(a, b) {
  return rowUniqueKey(a) === rowUniqueKey(b) ||
    (!!norm(a.customer_id) && norm(a.customer_id) === norm(b.customer_id)) ||
    (!!norm(a.customer_name) && norm(a.customer_name) === norm(b.customer_name) && cleanText(a.lat) === cleanText(b.lat) && cleanText(a.lng) === cleanText(b.lng));
}

function rankMarketCandidatesForTarget(marketRows, target, start) {
  const selectedBU = getSelectedStartBU();
  const targetBU = target && target.bu ? target.bu : "";
  const targetMeter = target ? normalizeMeter(target.meter || target.meterKey) : "";
  const targetPoint = validCoord(target) ? target : start;

  return uniqueRowsByIdName((marketRows || []).filter(validCoord))
    .filter(m => !isSameStop(m, target || {}))
    .filter(m => !selectedBU || buEquivalent(m.bu, selectedBU))
    .filter(m => !targetBU || buEquivalent(m.bu, targetBU))
    .map(m => {
      const sameMeter = targetMeter && normalizeMeter(m.meter || m.meterKey) === targetMeter ? 0 : 1;
      const sameBU = targetBU && buEquivalent(m.bu, targetBU) ? 0 : 1;
      const dTarget = validCoord(targetPoint) ? haversine(targetPoint, { lat: toNumber(m.lat), lng: toNumber(m.lng) }) : 9999;
      const dStart = start ? haversine(start, { lat: toNumber(m.lat), lng: toNumber(m.lng) }) : 9999;
      const score = (sameMeter * 1000) + (sameBU * 450) + (marketScore(m.status) * 20) + dTarget + (dStart * 0.15);
      return { ...m, __candidateScore: score };
    })
    .sort((a, b) => a.__candidateScore - b.__candidateScore);
}

function limitRouteByStopsAndDistance(start, requiredRows, candidateRows, orderBuilder, maxStops = MAX_ROUTE_CUSTOMER_STOPS) {
  const required = uniqueRowsByIdName(requiredRows || []);
  let selected = [...required];
  const pool = uniqueRowsByIdName(candidateRows || [])
    .filter(validCoord)
    .filter(c => !selected.some(s => isSameStop(s, c)));

  const buildOrdered = (rows) => orderBuilder ? orderBuilder(rows) : orderCircularRoute(start, rows);

  // เพิ่มจุดทีละจุด โดยคุมไม่เกิน 9 จุด และระยะประมาณไม่เกิน 350 กม.
  for (const candidate of pool) {
    if (routeStopCount(selected) >= maxStops) break;
    const trialRows = uniqueRowsByIdName([...selected, candidate]);
    const trialOrdered = buildOrdered(trialRows);
    const trialDistance = approxRoadDistanceKm(start, trialOrdered);
    if (trialDistance <= MAX_ROUTE_DISTANCE_KM) {
      selected = trialRows;
    }
  }

  // ถ้ายังไม่ถึง 7 จุด ให้ลองไล่จุดที่ใกล้ที่สุดอีกครั้ง แต่ยังไม่ฝืนเกิน 350 กม.
  if (routeStopCount(selected) < MIN_ROUTE_CUSTOMER_STOPS) {
    for (const candidate of pool) {
      if (routeStopCount(selected) >= MIN_ROUTE_CUSTOMER_STOPS || routeStopCount(selected) >= maxStops) break;
      if (selected.some(s => isSameStop(s, candidate))) continue;
      const trialRows = uniqueRowsByIdName([...selected, candidate]);
      const trialOrdered = buildOrdered(trialRows);
      if (approxRoadDistanceKm(start, trialOrdered) <= MAX_ROUTE_DISTANCE_KM) selected = trialRows;
    }
  }

  return buildOrdered(selected);
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

function removeSameStop(rows, target) {
  const key = rowUniqueKey(target);
  return rows.filter(r => rowUniqueKey(r) !== key);
}

/* ===== Loop-first route planner v2: เลือกจุดจากพิกัดก่อน แล้วค่อยเรียงเส้นทาง ===== */
function requiredRouteKeySet(requiredRows) {
  const set = new Set();
  (requiredRows || []).forEach(r => set.add(rowUniqueKey(r)));
  return set;
}

function coordPoint(row) {
  return { lat: toNumber(row.lat), lng: toNumber(row.lng) };
}

function routeCentroid(rows) {
  const valid = (rows || []).filter(validCoord);
  if (!valid.length) return { lat: 0, lng: 0 };
  return {
    lat: valid.reduce((sum, p) => sum + toNumber(p.lat), 0) / valid.length,
    lng: valid.reduce((sum, p) => sum + toNumber(p.lng), 0) / valid.length
  };
}

function geoBBoxKm(rows) {
  const valid = (rows || []).filter(validCoord);
  if (!valid.length) return { width: 0, height: 0, diag: 0 };
  const lats = valid.map(p => toNumber(p.lat));
  const lngs = valid.map(p => toNumber(p.lng));
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const midLat = (minLat + maxLat) / 2;
  const width = haversine({ lat: midLat, lng: minLng }, { lat: midLat, lng: maxLng });
  const height = haversine({ lat: minLat, lng: minLng }, { lat: maxLat, lng: minLng });
  return { width, height, diag: Math.hypot(width, height) };
}

function angleAround(center, row) {
  return Math.atan2(toNumber(row.lat) - center.lat, toNumber(row.lng) - center.lng);
}

function angleStatsForRows(center, rows) {
  const angles = (rows || []).filter(validCoord).map(p => angleAround(center, p)).sort((a, b) => a - b);
  if (angles.length <= 2) return { coverage: 0, maxGap: Math.PI * 2, gaps: [] };
  const gaps = [];
  for (let i = 0; i < angles.length; i++) {
    const next = i === angles.length - 1 ? angles[0] + Math.PI * 2 : angles[i + 1];
    gaps.push(next - angles[i]);
  }
  const maxGap = Math.max(...gaps);
  return { coverage: Math.PI * 2 - maxGap, maxGap, gaps };
}

function elongationRatio(rows) {
  const valid = (rows || []).filter(validCoord);
  if (valid.length < 3) return 1;
  const center = routeCentroid(valid);
  const latScale = 111;
  const lngScale = 111 * Math.cos(center.lat * Math.PI / 180);
  const pts = valid.map(p => ({
    x: (toNumber(p.lng) - center.lng) * lngScale,
    y: (toNumber(p.lat) - center.lat) * latScale
  }));
  let xx = 0, yy = 0, xy = 0;
  pts.forEach(p => { xx += p.x * p.x; yy += p.y * p.y; xy += p.x * p.y; });
  xx /= pts.length; yy /= pts.length; xy /= pts.length;
  const trace = xx + yy;
  const det = xx * yy - xy * xy;
  const disc = Math.max(0, trace * trace - 4 * det);
  const l1 = (trace + Math.sqrt(disc)) / 2;
  const l2 = (trace - Math.sqrt(disc)) / 2;
  if (l2 <= 0.000001) return 99;
  return Math.sqrt(l1 / l2);
}

function routeLegsKm(start, order) {
  const pts = [start, ...(order || []).filter(validCoord).map(coordPoint), start];
  const legs = [];
  for (let i = 0; i < pts.length - 1; i++) legs.push(haversine(pts[i], pts[i + 1]));
  return legs;
}

function routeSpikePenalty(start, order, requiredRows = []) {
  const rows = (order || []).filter(validCoord);
  if (rows.length < 4) return 0;
  const requiredKeys = requiredRouteKeySet(requiredRows);
  const base = routeDistanceFromStart(start, rows);
  const legs = routeLegsKm(start, rows);
  const avgLeg = legs.reduce((a, b) => a + b, 0) / Math.max(1, legs.length);
  let penalty = 0;

  rows.forEach((row, idx) => {
    if (requiredKeys.has(rowUniqueKey(row))) return;
    const without = rows.filter((_, i) => i !== idx);
    const saving = base - routeDistanceFromStart(start, without);
    if (saving > Math.max(10, avgLeg * 0.75)) penalty += (saving - Math.max(10, avgLeg * 0.75)) * 4.5;
  });

  legs.forEach(leg => {
    if (leg > Math.max(25, avgLeg * 2.15)) penalty += (leg - Math.max(25, avgLeg * 2.15)) * 3.5;
  });
  return penalty;
}


function revisitPassedPointPenalty(start, order) {
  // จับอาการ “วิ่งย้อนผ่านจุดที่เพิ่งเก็บแล้ว” เช่น 2 → 3 แล้วต้องย้อนผ่าน 2 เพื่อไปเก็บ 4-7
  // ใช้พิกัดเป็นตัววัดก่อนเรียกเส้นทางถนนจริง: ถ้าเส้นช่วงใหม่พาดผ่านจุดที่เคยเก็บแล้ว ให้ลงโทษสูง
  const rows = (order || []).filter(validCoord);
  if (rows.length < 4) return 0;
  let penalty = 0;
  const pts = rows.map(coordPoint);

  for (let segStartIndex = 1; segStartIndex < pts.length - 1; segStartIndex++) {
    const a = pts[segStartIndex];
    const b = pts[segStartIndex + 1];
    const segLen = haversine(a, b);
    if (!Number.isFinite(segLen) || segLen < 1.5) continue;

    for (let prevIndex = 0; prevIndex < segStartIndex; prevIndex++) {
      const prev = pts[prevIndex];
      const proj = pointSegmentProjection(a, b, prev);
      if (!proj) continue;

      const detour = haversine(a, prev) + haversine(prev, b) - segLen;
      const corridorKm = Math.max(1.2, Math.min(7.5, segLen * 0.18));
      const isBetween = proj.t > 0.10 && proj.t < 0.90;
      const nearOldStop = proj.distKm <= corridorKm;
      const likelyPassBack = detour <= Math.max(2.2, segLen * 0.16);

      if (isBetween && nearOldStop && likelyPassBack) {
        // ยิ่งย้อนผ่านจุดที่เพิ่งเก็บไม่นาน ยิ่งควรลงโทษมาก เพราะมักเกิดจากการเรียงลำดับผิดฝั่ง
        const recentWeight = Math.max(1, 4 - (segStartIndex - prevIndex));
        penalty += 260 * recentWeight + (corridorKm - proj.distKm) * 35 + Math.max(0, segLen - 10) * 5;
      }
    }
  }
  return penalty;
}

function anchoredServiceLoopOrder(start, serviceRow, restRows, requiredRows = []) {
  // สำหรับ “ตามแผนปรับปรุงปั๊ม” และ “ตารางซ่อม”:
  // ล็อกจุดบริการเป็นจุดที่ 1 แล้วหาเส้นทางหลังจากนั้นแบบวงกลมจริง
  // ไม่เลือกแบบที่ 2→3 แล้วต้องย้อนผ่าน 2 กลับไปเก็บกลุ่ม 4→5→6→7
  const service = serviceRow;
  const rest = uniqueRowsByIdName(restRows || []).filter(validCoord).filter(r => !isSameStop(r, service));
  if (!service || !validCoord(service)) return orderCircularRoute(start, rest);
  if (rest.length <= 2) return [service, ...rest];

  const candidates = [];
  const addRest = (route) => {
    if (!route || route.length !== rest.length) return;
    const cleaned = uniqueRowsByIdName(route).filter(validCoord);
    if (cleaned.length !== rest.length) return;
    candidates.push([service, ...cleaned]);
    const pulled = pullPointsThatAreOnTheWay(coordPoint(service), cleaned);
    if (pulled.length === rest.length) candidates.push([service, ...pulled]);
  };

  const centers = [
    routeCentroid([service, ...rest]),
    routeCentroid(rest),
    coordPoint(service),
    start
  ];
  const seenCenter = new Set();
  centers.filter(c => c && Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lng))).forEach(center => {
    const centerKey = `${Number(center.lat).toFixed(5)},${Number(center.lng).toFixed(5)}`;
    if (seenCenter.has(centerKey)) return;
    seenCenter.add(centerKey);
    const asc = [...rest].sort((a, b) => angleAround(center, a) - angleAround(center, b));
    const desc = [...asc].reverse();
    [asc, desc].forEach(base => {
      for (let i = 0; i < base.length; i++) {
        addRest([...base.slice(i), ...base.slice(0, i)]);
      }
    });
  });

  addRest(nearestNeighborOrder(coordPoint(service), rest));
  addRest(farthestInsertionOrder(coordPoint(service), rest));
  addRest([...rest].sort((a, b) => haversine(coordPoint(service), coordPoint(a)) - haversine(coordPoint(service), coordPoint(b))));
  addRest([...rest].sort((a, b) => haversine(coordPoint(service), coordPoint(b)) - haversine(coordPoint(service), coordPoint(a))));

  const seen = new Set();
  const unique = candidates.filter(route => {
    const key = uniqueRouteCandidateKey(route);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return (unique.length ? unique : [[service, ...rest]])
    .sort((a, b) => serviceRouteScore(start, a, service) - serviceRouteScore(start, b, service))[0];
}


function directionalStepAngle(fromAngle, toAngle, direction) {
  const full = Math.PI * 2;
  if (direction >= 0) return (toAngle - fromAngle + full) % full;
  return (fromAngle - toAngle + full) % full;
}

function serviceAngularSmoothPenalty(serviceRow, route) {
  // โหมดปรับปรุงปั๊ม/ตารางซ่อมต้องไม่เป็น “1→2→3 แล้วตัดย้อนกลับไปเก็บอีกฝั่ง”
  // วัดจากมุมรอบจุดบริการ ถ้ากระโดดข้ามฝั่งแรง ๆ กลางทางจะให้คะแนนแย่ลง
  const service = validCoord(serviceRow) ? serviceRow : (route || [])[0];
  const rest = (route || []).slice(1).filter(validCoord);
  if (!service || !validCoord(service) || rest.length < 3) return 0;
  const angles = rest.map(p => angleAround(service, p));
  let gapPenalty = 0;
  for (let i = 1; i < angles.length; i++) {
    const gap = angularDiff(angles[i - 1], angles[i]);
    if (gap > 1.85) gapPenalty += (gap - 1.85) * 190;
    if (gap > 2.45) gapPenalty += 260;
  }

  // เช็กทิศทางรวมทั้งตามเข็ม/ทวนเข็ม แล้วลงโทษถ้าลำดับสลับซ้ายขวาหลายครั้ง
  let cwBackward = 0, ccwBackward = 0;
  for (let i = 1; i < angles.length; i++) {
    const cw = directionalStepAngle(angles[i - 1], angles[i], 1);
    const ccw = directionalStepAngle(angles[i - 1], angles[i], -1);
    if (cw > Math.PI) cwBackward += cw - Math.PI;
    if (ccw > Math.PI) ccwBackward += ccw - Math.PI;
  }
  return gapPenalty + Math.min(cwBackward, ccwBackward) * 85;
}

function serviceRouteScore(start, route, serviceRow) {
  const required = serviceRow ? [serviceRow] : [];
  return routeSelectionScore(start, route, required)
    + serviceAngularSmoothPenalty(serviceRow, route) * 1.35
    + revisitPassedPointPenalty(start, route) * 1.65;
}

function buildDirectionalServiceChain(serviceRow, pool, targetOptionalCount, seed, direction) {
  const service = serviceRow;
  const selected = [];
  const available = uniqueRowsByIdName(pool || [])
    .filter(validCoord)
    .filter(p => !isSameStop(p, service));
  const first = seed && available.find(p => isSameStop(p, seed));
  if (!first) return [];
  selected.push(first);

  while (selected.length < targetOptionalCount) {
    const current = selected[selected.length - 1];
    const currentAngle = angleAround(service, current);
    let best = null;
    for (const p of available) {
      if (selected.some(s => isSameStop(s, p))) continue;
      const nextAngle = angleAround(service, p);
      const step = directionalStepAngle(currentAngle, nextAngle, direction);
      const jump = angularDiff(currentAngle, nextAngle);
      const dCurrent = haversine(coordPoint(current), coordPoint(p));
      const dService = haversine(coordPoint(service), coordPoint(p));
      const dStartLike = candidateBaseScore(p) * 0.025;
      let score = dCurrent * 1.15 + step * 9 + jump * 13 + dService * 0.08 + dStartLike;
      if (step < 0.04) score += 25;
      if (jump > 1.85) score += (jump - 1.85) * 180;
      if (jump > 2.45) score += 260;
      if (!best || score < best.score) best = { p, score };
    }
    if (!best) break;
    selected.push(best.p);
  }
  return selected;
}

function buildServiceAngularRoutes(start, serviceRow, pool, targetStops) {
  const service = serviceRow;
  const optionalCount = Math.max(0, targetStops - 1);
  const cleanPool = uniqueRowsByIdName(pool || [])
    .filter(validCoord)
    .filter(p => !isSameStop(p, service))
    .sort((a, b) => (candidateBaseScore(a) + candidateDepotSidePenalty(start, [service], a)) - (candidateBaseScore(b) + candidateDepotSidePenalty(start, [service], b)))
    .slice(0, 44);
  const routes = [];
  const add = (optional) => {
    const rest = uniqueRowsByIdName(optional || []).filter(validCoord).filter(p => !isSameStop(p, service)).slice(0, optionalCount);
    if (rest.length === optionalCount) routes.push([service, ...rest]);
  };

  // 1) สร้างเส้นทางจาก “หัววง” หลายจุด แล้วไล่ต่อในฝั่งเดียวกันก่อน ลดเคส 2→3 แล้วย้อนกลับไป 4-7
  cleanPool.slice(0, 18).forEach(seed => {
    add(buildDirectionalServiceChain(service, cleanPool, optionalCount, seed, 1));
    add(buildDirectionalServiceChain(service, cleanPool, optionalCount, seed, -1));
  });

  // 2) สร้าง route แบบกวาดมุมรอบ service และ centroid แต่จำกัดจำนวนเพื่อไม่ให้ค้าง
  [coordPoint(service), routeCentroid([service, ...cleanPool.slice(0, 18)]), start].forEach(center => {
    if (!center || !Number.isFinite(Number(center.lat)) || !Number.isFinite(Number(center.lng))) return;
    const asc = [...cleanPool].sort((a, b) => angleAround(center, a) - angleAround(center, b));
    const desc = [...asc].reverse();
    [asc, desc].forEach(base => {
      for (let i = 0; i < Math.min(base.length, 14); i++) {
        add([...base.slice(i), ...base.slice(0, i)]);
      }
    });
  });

  // 3) ชุดสำรอง: จุดคะแนนดีที่สุดและจุดใกล้ต่อเนื่องจาก service
  add(cleanPool);
  add(nearestNeighborOrder(coordPoint(service), cleanPool).slice(0, optionalCount));

  const seen = new Set();
  return routes.filter(route => {
    const key = uniqueRouteCandidateKey(route);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 80);
}

function buildServiceAnchoredPlanRoute(start, requiredRows, candidateRows, targetStops = TARGET_CORE_ROUTE_STOPS) {
  const service = uniqueRowsByIdName(requiredRows || []).filter(validCoord)[0];
  if (!service) return buildCircularMarketPlanRoute(start, requiredRows, candidateRows, targetStops, false);

  const required = [service];
  const cleanPool = uniqueRowsByIdName(candidateRows || [])
    .filter(validCoord)
    .filter(p => !isSameStop(p, service))
    .sort((a, b) => (candidateBaseScore(a) + candidateDepotSidePenalty(start, required, a)) - (candidateBaseScore(b) + candidateDepotSidePenalty(start, required, b)))
    .slice(0, 52);

  const routeCandidates = [];
  const addRoute = (route) => {
    const cleaned = uniqueRowsByIdName(route || []).filter(validCoord);
    if (!cleaned.length || !isSameStop(cleaned[0], service)) return;
    if (routeStopCount(cleaned) < Math.min(MIN_ROUTE_CUSTOMER_STOPS, targetStops)) return;
    routeCandidates.push(cleaned.slice(0, targetStops));
  };

  // candidate จากชุดเลือกจุดแบบ sector เดิม เพื่อรักษารูปวงกลม
  buildAngularSectorSets(start, required, cleanPool, targetStops).forEach(set => {
    addRoute(anchoredServiceLoopOrder(start, service, set.filter(p => !isSameStop(p, service)), required));
  });

  // candidate ใหม่: ล็อก service เป็น 1 แล้วเรียง/เลือกจุดในฝั่งต่อเนื่องก่อน
  buildServiceAngularRoutes(start, service, cleanPool, targetStops).forEach(addRoute);

  const unique = [];
  const seen = new Set();
  routeCandidates.forEach(route => {
    const key = uniqueRouteCandidateKey(route);
    if (!seen.has(key)) { seen.add(key); unique.push(route); }
  });

  let valid = unique.filter(route => approxRoadDistanceKm(start, route) <= MAX_ROUTE_DISTANCE_KM);
  if (!valid.length) valid = unique;
  if (!valid.length) return [service, ...cleanPool.slice(0, Math.max(0, targetStops - 1))];

  let best = valid.sort((a, b) => serviceRouteScore(start, a, service) - serviceRouteScore(start, b, service))[0];

  // ลองเปลี่ยนจุดที่ทำให้เกิดแขนยื่น/ย้อนผ่าน 1 จุด แต่จำกัดรอบเพื่อให้ยังโหลดเร็ว
  best = replaceSpikesWithBetterPoints(start, best, required, cleanPool, targetStops, true);
  if (!isSameStop(best[0], service)) best = [service, ...best.filter(p => !isSameStop(p, service))].slice(0, targetStops);
  return best;
}


function candidateDepotSidePenalty(start, requiredRows = [], row) {
  // ใช้กับโหมดที่มี “จุดงานหลัก” เช่น ปรับปรุงปั๊ม/ตารางซ่อม
  // ถ้าลูกค้าอยู่ฝั่งเดียวกับจุดเริ่มมากเกินไป มักกลายเป็นจุดแหย่ก่อนกลับฐาน
  // จึงลดโอกาสเลือกจุดลักษณะนี้ หากยังมีจุดอื่นที่อยู่ในวงหลักให้เลือกแทน
  const required = (requiredRows || []).filter(validCoord);
  if (!start || !validCoord(row) || !required.length) return 0;
  const ref = routeCentroid(required);
  const reqToDepot = haversine(ref, start);
  if (!Number.isFinite(reqToDepot) || reqToDepot < 8) return 0;

  const dStart = haversine(start, coordPoint(row));
  const dReq = haversine(ref, coordPoint(row));
  const depotAngle = Math.atan2(Number(start.lat) - ref.lat, Number(start.lng) - ref.lng);
  const rowAngle = angleAround(ref, row);
  const towardDepot = angularDiff(rowAngle, depotAngle);
  const depotSide = towardDepot < 0.95 && dStart < dReq * 0.95 && dReq > 8;
  if (!depotSide) return 0;

  let penalty = 140;
  penalty += (0.95 - towardDepot) * 70;
  penalty += Math.max(0, (dReq * 0.95) - dStart) * 3;
  // ถ้าใกล้ฐานมากเมื่อเทียบกับจุดงานหลัก ให้มองเป็นจุดก่อนกลับฐาน ไม่ใช่จุดในวงหลัก
  if (dStart < reqToDepot * 0.55) penalty += 120;
  return penalty;
}

function routeDepotSideSpurPenalty(start, order, requiredRows = []) {
  const rows = (order || []).filter(validCoord);
  const required = (requiredRows || []).filter(validCoord);
  if (!start || rows.length < 4 || !required.length) return 0;
  const requiredKeys = requiredRouteKeySet(requiredRows);
  const ref = routeCentroid(required);
  const reqToDepot = haversine(ref, start);
  if (!Number.isFinite(reqToDepot) || reqToDepot < 8) return 0;

  let penalty = 0;
  let depotSideCount = 0;
  const legs = routeLegsKm(start, rows);
  const avgLeg = legs.reduce((a, b) => a + b, 0) / Math.max(1, legs.length);

  rows.forEach((row, idx) => {
    if (requiredKeys.has(rowUniqueKey(row))) return;
    const singlePenalty = candidateDepotSidePenalty(start, required, row);
    if (singlePenalty > 0) {
      depotSideCount += 1;
      penalty += singlePenalty;
      // จุดฝั่งฐานที่ไปเก็บช่วงท้าย คืออาการ “แหย่ไปเก็บจุด 6-7 ก่อนกลับจุดเริ่ม”
      if (idx >= rows.length - 3) penalty += 180;
    }

    const prev = idx === 0 ? start : coordPoint(rows[idx - 1]);
    const next = idx === rows.length - 1 ? start : coordPoint(rows[idx + 1]);
    const detour = haversine(prev, coordPoint(row)) + haversine(coordPoint(row), next) - haversine(prev, next);
    if (detour > Math.max(3.5, avgLeg * 0.30)) penalty += (detour - Math.max(3.5, avgLeg * 0.30)) * 22;

    // ถ้าจุดนี้อยู่ท้ายแผน และการแวะจุดนี้ก่อนกลับฐานทำให้อ้อมมาก ให้ลงโทษเพิ่ม
    if (idx >= rows.length - 3) {
      const directBack = haversine(prev, start);
      const viaThisBack = haversine(prev, coordPoint(row)) + haversine(coordPoint(row), start);
      const extraBack = viaThisBack - directBack;
      if (extraBack > 2.5) penalty += extraBack * 28;
    }
  });

  // อนุญาตให้มีจุดฝั่งฐานได้บ้าง แต่ไม่ให้มีหลายจุดจนกลายเป็นแขนแหย่ก่อนกลับฐาน
  if (depotSideCount > 1) penalty += (depotSideCount - 1) * 260;
  return penalty;
}

function fastCircularRouteScore(start, route, requiredRows = []) {
  const valid = (route || []).filter(validCoord);
  if (!valid.length) return 999999;
  const km = approxRoadDistanceKm(start, valid);
  const countPenalty = valid.length < MIN_ROUTE_CUSTOMER_STOPS ? (MIN_ROUTE_CUSTOMER_STOPS - valid.length) * 700 : 0;
  const center = routeCentroid(valid);
  const stats = angleStatsForRows(center, valid);
  const coverageDeg = stats.coverage * 180 / Math.PI;
  const maxGapDeg = stats.maxGap * 180 / Math.PI;
  const elong = elongationRatio(valid);
  let shapePenalty = 0;
  if (coverageDeg < 205) shapePenalty += (205 - coverageDeg) * 1.7;
  if (maxGapDeg > 170) shapePenalty += (maxGapDeg - 170) * 1.9;
  if (elong > 2.25) shapePenalty += (elong - 2.25) * 48;
  if (km > MAX_ROUTE_DISTANCE_KM) shapePenalty += (km - MAX_ROUTE_DISTANCE_KM) * 18;
  return km + countPenalty + shapePenalty + routeTurnPenalty(start, valid) * 1.35 + loopBacktrackPenalty(start, valid) * 0.75 + revisitPassedPointPenalty(start, valid) * 1.2 + routeDepotSideSpurPenalty(start, valid, requiredRows) * 0.75;
}

function routeSelectionScore(start, rows, requiredRows = []) {
  const valid = (rows || []).filter(validCoord);
  const scoreKey = `${coordCacheKey(start)}::${uniqueRouteCandidateKey(valid)}::${routeKeyForSet(requiredRows || [])}`;
  if (ROUTE_SCORE_MEMORY_CACHE.has(scoreKey)) return ROUTE_SCORE_MEMORY_CACHE.get(scoreKey);
  const score = fastCircularRouteScore(start, valid, requiredRows);
  if (ROUTE_SCORE_MEMORY_CACHE.size < 12000) ROUTE_SCORE_MEMORY_CACHE.set(scoreKey, score);
  return score;
}



function candidateBaseScore(row) {
  return (Number(row.__candidateScore) || 0) + (marketScore(row.status) * 8);
}

function routeKeyForSet(rows) {
  return (rows || []).map(rowUniqueKey).sort().join("|");
}

function candidateCenters(start, requiredRows, pool) {
  const centers = [];
  const add = (c) => {
    if (c && Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lng))) centers.push({ lat: Number(c.lat), lng: Number(c.lng) });
  };
  (requiredRows || []).filter(validCoord).forEach(r => add(coordPoint(r)));
  add(start);
  add(routeCentroid([...(requiredRows || []), ...pool.slice(0, 12)]));
  add(routeCentroid(pool.slice(0, 20)));
  const seen = new Set();
  return centers.filter(c => {
    const key = `${c.lat.toFixed(5)},${c.lng.toFixed(5)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildAngularSectorSets(start, requiredRows, pool, targetStops) {
  const required = uniqueRowsByIdName(requiredRows || []).filter(validCoord);
  const need = Math.max(0, targetStops - required.length);
  if (need <= 0) return [required];

  const cleanPool = uniqueRowsByIdName(pool || [])
    .filter(validCoord)
    .filter(p => !required.some(r => isSameStop(r, p)))
    .sort((a, b) => (candidateBaseScore(a) + candidateDepotSidePenalty(start, required, a)) - (candidateBaseScore(b) + candidateDepotSidePenalty(start, required, b)))
    .slice(0, 42);

  const sets = [];
  const centers = candidateCenters(start, required, cleanPool).slice(0, 3);
  const offsets = [0, 0.5];

  centers.forEach(center => {
    offsets.forEach(offset => {
      const sectors = Array.from({ length: need }, () => []);
      cleanPool.forEach(p => {
        const angle = (angleAround(center, p) + Math.PI * 2 + (offset * Math.PI * 2 / Math.max(1, need))) % (Math.PI * 2);
        const sector = Math.min(need - 1, Math.floor(angle / (Math.PI * 2 / need)));
        const dCenter = haversine(center, coordPoint(p));
        const score = candidateBaseScore(p) + candidateDepotSidePenalty(start, required, p) * 0.75 + dCenter * 0.70;
        sectors[sector].push({ p, score });
      });
      sectors.forEach(sec => sec.sort((a, b) => a.score - b.score));

      const selected = [...required];
      for (let i = 0; i < sectors.length && selected.length < targetStops; i++) {
        const hit = sectors[i].find(x => !selected.some(s => isSameStop(s, x.p)));
        if (hit) selected.push(hit.p);
      }
      for (const p of cleanPool) {
        if (selected.length >= targetStops) break;
        if (!selected.some(s => isSameStop(s, p))) selected.push(p);
      }
      if (selected.length >= Math.min(MIN_ROUTE_CUSTOMER_STOPS, targetStops)) sets.push(selected);
    });
  });

  // ชุดสำรองแบบคะแนนดีที่สุด เพื่อกันกรณีข้อมูลบางสายกระจุกตัวจนแบ่ง sector ไม่ครบ
  const bestOnly = [...required];
  for (const p of cleanPool) {
    if (bestOnly.length >= targetStops) break;
    if (!bestOnly.some(s => isSameStop(s, p))) bestOnly.push(p);
  }
  if (bestOnly.length >= Math.min(MIN_ROUTE_CUSTOMER_STOPS, targetStops)) sets.push(bestOnly);

  const seen = new Set();
  return sets.filter(set => {
    const key = routeKeyForSet(set);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}


function orderLoopFromSet(start, rows, requiredRows = [], forceFirstRequired = false) {
  const required = (requiredRows || []).filter(validCoord);
  const valid = uniqueRowsByIdName(rows || []).filter(validCoord);
  if (!valid.length) return [];

  if (forceFirstRequired && required.length) {
    const first = valid.find(v => required.some(r => isSameStop(r, v))) || required[0];
    const rest = valid.filter(v => !isSameStop(v, first));
    return anchoredServiceLoopOrder(start, first, rest, requiredRows);
  }

  const center = routeCentroid(valid);
  const asc = [...valid].sort((a, b) => angleAround(center, a) - angleAround(center, b));
  const desc = [...asc].reverse();
  const candidates = [];
  [asc, desc].forEach(base => {
    for (let i = 0; i < base.length; i++) {
      const rotated = [...base.slice(i), ...base.slice(0, i)];
      candidates.push(rotated);
    }
  });
  candidates.push(nearestNeighborOrder(start, valid));

  const seen = new Set();
  const unique = candidates.filter(c => {
    const key = uniqueRouteCandidateKey(c);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.sort((a, b) => routeSelectionScore(start, a, requiredRows) - routeSelectionScore(start, b, requiredRows))[0] || orderCircularRoute(start, valid);
}


function replaceSpikesWithBetterPoints(start, orderedRows, requiredRows, pool, targetStops, forceFirstRequired = false) {
  const requiredKeys = requiredRouteKeySet(requiredRows);
  let current = orderLoopFromSet(start, orderedRows, requiredRows, forceFirstRequired).slice(0, targetStops);
  let currentScore = routeSelectionScore(start, current, requiredRows);
  const cleanPool = uniqueRowsByIdName(pool || [])
    .filter(validCoord)
    .filter(p => !requiredKeys.has(rowUniqueKey(p)))
    .filter(p => !current.some(r => isSameStop(r, p)))
    .sort((a, b) => (candidateBaseScore(a) + candidateDepotSidePenalty(start, requiredRows, a)) - (candidateBaseScore(b) + candidateDepotSidePenalty(start, requiredRows, b)))
    .slice(0, 24);

  // เปลี่ยนเฉพาะจุด optional ที่ทำให้เส้นทางแย่ที่สุด 1 รอบ เพื่อไม่ให้ Browser ค้าง
  let worstIndex = -1;
  let worstSaving = -Infinity;
  const baseKm = approxRoadDistanceKm(start, current);
  current.forEach((row, idx) => {
    if (requiredKeys.has(rowUniqueKey(row))) return;
    const trial = current.filter((_, i) => i !== idx);
    const saving = baseKm - approxRoadDistanceKm(start, trial);
    if (saving > worstSaving) { worstSaving = saving; worstIndex = idx; }
  });
  if (worstIndex < 0) return current;

  let best = null;
  for (const cand of cleanPool) {
    const seed = current.map((r, idx) => idx === worstIndex ? cand : r);
    const ordered = orderLoopFromSet(start, seed, requiredRows, forceFirstRequired).slice(0, targetStops);
    if (routeStopCount(ordered) !== routeStopCount(current)) continue;
    if (approxRoadDistanceKm(start, ordered) > MAX_ROUTE_DISTANCE_KM) continue;
    const score = routeSelectionScore(start, ordered, requiredRows);
    if (score + 0.5 < currentScore && (!best || score < best.score)) best = { ordered, score };
  }
  return best ? best.ordered : current;
}


function buildCircularMarketPlanRoute(start, requiredRows, candidateRows, targetStops = TARGET_CORE_ROUTE_STOPS, forceFirstRequired = false) {
  if (forceFirstRequired) return buildServiceAnchoredPlanRoute(start, requiredRows, candidateRows, targetStops);
  const required = uniqueRowsByIdName(requiredRows || []).filter(validCoord);
  const cleanPool = uniqueRowsByIdName(candidateRows || [])
    .filter(validCoord)
    .filter(p => !required.some(r => isSameStop(r, p)))
    .sort((a, b) => (candidateBaseScore(a) + candidateDepotSidePenalty(start, required, a)) - (candidateBaseScore(b) + candidateDepotSidePenalty(start, required, b)))
    .slice(0, 48);

  const sets = buildAngularSectorSets(start, required, cleanPool, targetStops);
  let best = null;
  sets.forEach(set => {
    const ordered = orderLoopFromSet(start, set, required, forceFirstRequired).slice(0, targetStops);
    if (routeStopCount(ordered) < Math.min(MIN_ROUTE_CUSTOMER_STOPS, targetStops)) return;
    if (approxRoadDistanceKm(start, ordered) > MAX_ROUTE_DISTANCE_KM) return;
    const score = routeSelectionScore(start, ordered, required);
    if (!best || score < best.score) best = { ordered, score };
  });

  let ordered = best ? best.ordered : limitRouteByStopsAndDistance(
    start,
    required,
    cleanPool,
    rows => orderLoopFromSet(start, rows, required, forceFirstRequired),
    targetStops
  );

  ordered = replaceSpikesWithBetterPoints(start, ordered, required, cleanPool, targetStops, forceFirstRequired);

  while (routeStopCount(ordered) > MIN_ROUTE_CUSTOMER_STOPS && approxRoadDistanceKm(start, ordered) > MAX_ROUTE_DISTANCE_KM) {
    const requiredKeys = requiredRouteKeySet(required);
    let removeIndex = -1;
    let bestSaving = -Infinity;
    const base = approxRoadDistanceKm(start, ordered);
    ordered.forEach((row, idx) => {
      if (requiredKeys.has(rowUniqueKey(row))) return;
      const trial = ordered.filter((_, i) => i !== idx);
      const saving = base - approxRoadDistanceKm(start, trial);
      if (saving > bestSaving) { bestSaving = saving; removeIndex = idx; }
    });
    if (removeIndex < 0) break;
    ordered.splice(removeIndex, 1);
  }
  return ordered;
}

function buildPumpPlanRows(pumpRows, repairRows, marketRows) {
  const selectedBU = getSelectedStartBU();
  const selectedPumps = chooseOnePumpPerMeterCurrentMonth(pumpRows)
    .filter(p => !selectedBU || buEquivalent(p.bu, selectedBU));
  const output = [];

  selectedPumps.forEach(pump => {
    const routeDate = pump.dateObj ? pump.dateObj.toLocaleDateString("th-TH", { day: "numeric", month: "long", year: "2-digit" }) : pump.dateRaw;
    const routeId = `${pump.bu || "BU-?"} สาย ${pump.meterKey} วันที่ ${routeDate}`;
    const start = startForRoute([pump]);
    const rankedMarkets = rankMarketCandidatesForTarget(marketRows, pump, start);
    const ordered = buildCircularMarketPlanRoute(
      start,
      [pump],
      rankedMarkets,
      TARGET_CORE_ROUTE_STOPS,
      true
    );

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

function normalLoopShapePenaltyQuick(start, order) {
  const valid = (order || []).filter(validCoord);
  if (valid.length < 4) return 0;
  const center = routeCentroid(valid);
  const stats = angleStatsForRows(center, valid);
  const elong = elongationRatio(valid);
  const bbox = geoBBoxKm(valid);
  const maxGapDeg = stats.maxGap * 180 / Math.PI;
  const coverageDeg = stats.coverage * 180 / Math.PI;
  let penalty = 0;

  // ให้เป็นวงมากกว่าเส้นยาว/วงรี แต่ไม่ลงโทษหนักเกินไปจนเลือกจุดใกล้ฐานกระจุกกัน
  if (coverageDeg < 205) penalty += (205 - coverageDeg) * 1.8;
  if (maxGapDeg > 170) penalty += (maxGapDeg - 170) * 1.8;
  if (elong > 2.35) penalty += (elong - 2.35) * 55;
  if (bbox.diag > 0) {
    const shortSide = Math.max(1, Math.min(bbox.width, bbox.height));
    const longSide = Math.max(bbox.width, bbox.height);
    if (longSide / shortSide > 2.65) penalty += ((longSide / shortSide) - 2.65) * 45;
  }
  return penalty;
}

function normalEndpointPenalty(start, order) {
  const rows = (order || []).filter(validCoord);
  if (rows.length < 3) return 0;
  const ds = rows.map(p => haversine(start, coordPoint(p))).sort((a, b) => a - b);
  const nearest = ds[0] || 0;
  const median = ds[Math.floor(ds.length / 2)] || nearest;
  const firstD = haversine(start, coordPoint(rows[0]));
  const lastD = haversine(start, coordPoint(rows[rows.length - 1]));
  const softLimit = Math.max(18, Math.min(45, median * 0.82));
  let penalty = 0;

  // เงื่อนไขวันปกติ: จุด 1 คือจุดลูกค้าหลังออกจากจุดเริ่ม และจุด 9 คือจุดสุดท้ายก่อนกลับฐาน
  // จึงให้คะแนนดีเมื่อหัว/ท้ายวงเชื่อมกับจุดเริ่มได้สั้นและต่อเนื่อง
  penalty += (firstD + lastD) * 0.55;
  if (firstD > softLimit) penalty += (firstD - softLimit) * 7.5;
  if (lastD > softLimit) penalty += (lastD - softLimit) * 7.5;

  const a1 = angleFromStart(start, rows[0]);
  const a2 = angleFromStart(start, rows[rows.length - 1]);
  const diff = angularDiff(a1, a2);
  if (diff < 0.45 && rows.length >= 7) penalty += (0.45 - diff) * 90;

  // ถ้าจุดที่ใกล้ฐานที่สุดถูกทิ้งไว้กลางเส้นทาง แปลว่ามีโอกาสวิ่งย้อนกลับมาเก็บจุด
  const minIndex = (order || []).findIndex(p => validCoord(p) && Math.abs(haversine(start, coordPoint(p)) - nearest) < 0.001);
  if (minIndex > 1 && minIndex < rows.length - 2) penalty += 65;
  return penalty;
}

function normalMarketRouteScore(start, order) {
  if (!order || !order.length) return 0;
  const valid = order.filter(validCoord);
  const roadKm = approxRoadDistanceKm(start, valid);
  let score = routeDistanceFromStart(start, valid);
  score += normalEndpointPenalty(start, valid);
  score += normalLoopShapePenaltyQuick(start, valid);
  score += routeTurnPenalty(start, valid) * 1.9;
  score += loopBacktrackPenalty(start, valid) * 1.65;
  score += revisitPassedPointPenalty(start, valid) * 1.1;
  score += routeSpikePenalty(start, valid, []) * 1.35;
  if (roadKm > MAX_ROUTE_DISTANCE_KM) score += (roadKm - MAX_ROUTE_DISTANCE_KM) * 18;
  if (valid.length < NORMAL_ROUTE_TARGET_STOPS) score += (NORMAL_ROUTE_TARGET_STOPS - valid.length) * 900;
  return score;
}

function normalPointPickScore(start, center, row) {
  const dStart = haversine(start, coordPoint(row));
  const dCenter = center ? haversine(center, coordPoint(row)) : 0;
  // ใช้สถานะลูกค้าเป็นคะแนนหลัก แต่ไม่ให้จุดไกลหลุดวงถูกเลือกง่ายเกินไป
  return candidateBaseScore(row) * 0.9 + dCenter * 0.42 + dStart * 0.06;
}

function normalRouteLightScore(start, order) {
  const valid = (order || []).filter(validCoord);
  if (!valid.length) return 999999;
  let score = routeDistanceFromStart(start, valid);
  score += normalEndpointPenalty(start, valid);
  score += normalLoopShapePenaltyQuick(start, valid);
  score += routeTurnPenalty(start, valid) * 1.15;
  score += loopBacktrackPenalty(start, valid) * 0.9;
  const road = approxRoadDistanceKm(start, valid);
  if (road > MAX_ROUTE_DISTANCE_KM) score += (road - MAX_ROUTE_DISTANCE_KM) * 22;
  return score;
}

function replaceWorstNormalStopLight(start, ordered, pool, targetStops = NORMAL_ROUTE_TARGET_STOPS) {
  const current = (ordered || []).filter(validCoord).slice(0, targetStops);
  if (current.length < Math.min(targetStops, MIN_ROUTE_CUSTOMER_STOPS)) return current;

  const baseScore = normalRouteLightScore(start, current);
  const baseKm = routeDistanceFromStart(start, current);
  let worstIndex = -1;
  let bestSaving = -Infinity;
  current.forEach((row, idx) => {
    const trial = current.filter((_, i) => i !== idx);
    const saving = baseKm - routeDistanceFromStart(start, trial);
    if (saving > bestSaving) { bestSaving = saving; worstIndex = idx; }
  });
  if (worstIndex < 0) return current;

  const center = routeCentroid(current);
  const candidates = uniqueRowsByIdName(pool || [])
    .filter(validCoord)
    .filter(p => !current.some(r => isSameStop(r, p)))
    .sort((a, b) => normalPointPickScore(start, center, a) - normalPointPickScore(start, center, b))
    .slice(0, 16);

  let best = { route: current, score: baseScore };
  for (const cand of candidates) {
    const trialSet = current.map((r, idx) => idx === worstIndex ? cand : r);
    const trial = orderNormalMarketRoute(start, trialSet).slice(0, targetStops);
    if (trial.length !== current.length) continue;
    const score = normalRouteLightScore(start, trial);
    if (score + 0.5 < best.score) best = { route: trial, score };
  }
  return best.route;
}

function orderNormalMarketRoute(start, points) {
  // วันปกติ/ออกตลาดทั่วไป: เรียงลำดับ 9 จุดแบบวงกลมโดยใช้วิธีเบาและเสถียร
  // จุดที่ 1 = ลูกค้าหลังออกจากฐาน, จุดสุดท้าย = ลูกค้าก่อนกลับฐาน
  const valid = uniqueRowsByIdName((points || []).filter(validCoord)).map(p => ({ ...p }));
  const noCoord = (points || []).filter(p => !validCoord(p));
  if (valid.length <= 2) return [...valid, ...noCoord];

  const center = routeCentroid(valid);
  const asc = [...valid].sort((a, b) => angleAround(center, a) - angleAround(center, b));
  const desc = [...asc].reverse();
  const candidates = [];
  const add = (route) => {
    if (!route || route.length !== valid.length) return;
    const key = uniqueRouteCandidateKey(route);
    if (!key || candidates.some(c => uniqueRouteCandidateKey(c) === key)) return;
    candidates.push(route);
  };

  [asc, desc].forEach(base => {
    for (let i = 0; i < base.length; i++) add([...base.slice(i), ...base.slice(0, i)]);
  });

  // candidate เสริม: ให้จุดหัว/ท้ายอยู่ใกล้ฐาน เพื่อให้วิ่งออกจากฐานและกลับฐานได้ต่อเนื่อง
  const nearBase = [...valid]
    .sort((a, b) => haversine(start, coordPoint(a)) - haversine(start, coordPoint(b)))
    .slice(0, Math.min(3, valid.length));
  nearBase.forEach(first => {
    const rest = valid.filter(p => !isSameStop(p, first));
    const c = routeCentroid(rest.length ? rest : valid);
    const rAsc = [...rest].sort((a, b) => angleAround(c, a) - angleAround(c, b));
    const rDesc = [...rAsc].reverse();
    [rAsc, rDesc].forEach(base => {
      for (let i = 0; i < base.length; i++) add([first, ...base.slice(i), ...base.slice(0, i)]);
    });
  });

  const best = (candidates.length ? candidates : [valid])
    .sort((a, b) => normalRouteLightScore(start, a) - normalRouteLightScore(start, b))[0] || valid;
  return [...best, ...noCoord];
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

function applyNormalRouteFieldFeedback(start, order, sourcePoints) {
  // วันปกติ/ออกตลาดทั่วไปทุกสายใช้กติกาเดียวกัน:
  // คัด 9 จุดให้เป็นวง, เรียงจุด 1 เป็นลูกค้าหลังออกจากฐาน และจุด 9 ก่อนกลับฐาน
  // ไม่ใช้ hard-code เฉพาะสาย เพื่อไม่ให้สายอื่นเสียรูปเส้นทาง
  return orderNormalMarketRoute(start, order || sourcePoints || []);
}


function scoreNormalCandidateForPool(start, center, row) {
  const dStart = haversine(start, coordPoint(row));
  const dCenter = center ? haversine(center, coordPoint(row)) : 0;
  return candidateBaseScore(row) * 0.75 + dStart * 0.08 + dCenter * 0.35;
}

function buildNormalSectorSets(start, pool, targetStops = NORMAL_ROUTE_TARGET_STOPS) {
  const cleanPool = uniqueRowsByIdName(pool || []).filter(validCoord)
    .sort((a, b) => (candidateBaseScore(a) + haversine(start, coordPoint(a)) * 0.06) - (candidateBaseScore(b) + haversine(start, coordPoint(b)) * 0.06))
    .slice(0, NORMAL_ROUTE_POOL_LIMIT);
  if (cleanPool.length <= targetStops) return [cleanPool];

  const centers = [routeCentroid(cleanPool.slice(0, Math.min(30, cleanPool.length))), routeCentroid(cleanPool), start];
  const offsets = [0, 0.38, 0.76];
  const sets = [];
  const addSet = (rows) => {
    const selected = uniqueRowsByIdName(rows || []).filter(validCoord).slice(0, targetStops);
    if (selected.length >= Math.min(targetStops, MIN_ROUTE_CUSTOMER_STOPS)) sets.push(selected);
  };

  centers.forEach(center => {
    if (!center || !Number.isFinite(Number(center.lat)) || !Number.isFinite(Number(center.lng))) return;
    offsets.forEach(offset => {
      const sectors = Array.from({ length: targetStops }, () => []);
      cleanPool.forEach(p => {
        const angle = (angleAround(center, p) + Math.PI * 2 + offset * Math.PI * 2 / targetStops) % (Math.PI * 2);
        const sector = Math.min(targetStops - 1, Math.floor(angle / (Math.PI * 2 / targetStops)));
        sectors[sector].push({ p, score: scoreNormalCandidateForPool(start, center, p) });
      });
      sectors.forEach(sec => sec.sort((a, b) => a.score - b.score));
      const picked = [];
      sectors.forEach(sec => {
        const hit = sec.find(x => !picked.some(s => isSameStop(s, x.p)));
        if (hit) picked.push(hit.p);
      });
      for (const p of cleanPool) {
        if (picked.length >= targetStops) break;
        if (!picked.some(s => isSameStop(s, p))) picked.push(p);
      }
      addSet(picked);
    });
  });

  // ชุดสำรอง: ใกล้ฐาน + คะแนนลูกค้าดี แต่ยังให้ orderNormalMarketRoute จัดเป็นวงอีกครั้ง
  addSet(cleanPool.slice(0, targetStops));

  const seen = new Set();
  return sets.filter(set => {
    const key = routeKeyForSet(set);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10);
}

function improveNormalRouteSetByReplacement(start, route, pool, targetStops = NORMAL_ROUTE_TARGET_STOPS) {
  let current = orderNormalMarketRoute(start, route).slice(0, targetStops);
  let currentScore = normalMarketRouteScore(start, current);
  const candidates = uniqueRowsByIdName(pool || [])
    .filter(validCoord)
    .filter(p => !current.some(r => isSameStop(r, p)))
    .sort((a, b) => (candidateBaseScore(a) + haversine(start, coordPoint(a)) * 0.06) - (candidateBaseScore(b) + haversine(start, coordPoint(b)) * 0.06))
    .slice(0, 24);

  // เปลี่ยนจุดที่ทำให้เส้นทางแย่ที่สุด 1 จุดพอ เพื่อคงความเร็ว
  let worstIndex = -1;
  let bestSaving = -Infinity;
  const base = routeDistanceFromStart(start, current);
  current.forEach((row, idx) => {
    const trial = current.filter((_, i) => i !== idx);
    const saving = base - routeDistanceFromStart(start, trial);
    if (saving > bestSaving) { bestSaving = saving; worstIndex = idx; }
  });
  if (worstIndex < 0) return current;

  let best = null;
  for (const cand of candidates) {
    const trialSet = current.map((r, idx) => idx === worstIndex ? cand : r);
    const ordered = orderNormalMarketRoute(start, trialSet).slice(0, targetStops);
    if (ordered.length !== current.length) continue;
    if (approxRoadDistanceKm(start, ordered) > MAX_ROUTE_DISTANCE_KM) continue;
    const score = normalMarketRouteScore(start, ordered);
    if (score + 0.5 < currentScore && (!best || score < best.score)) best = { ordered, score };
  }
  return best ? best.ordered : current;
}

function normalPercentile(values, q) {
  const nums = (values || []).filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return 0;
  const pos = Math.min(nums.length - 1, Math.max(0, (nums.length - 1) * q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const frac = pos - lo;
  return nums[lo] + ((nums[hi] - nums[lo]) * frac);
}

function normalRingPickScore(start, center, row, radiusInfo) {
  const dStart = haversine(start, coordPoint(row));
  const r = haversine(center, coordPoint(row));
  const target = radiusInfo && radiusInfo.target ? radiusInfo.target : r;
  const q90 = radiusInfo && radiusInfo.q90 ? radiusInfo.q90 : target;

  // วันปกติ: เลือกจุดรอบนอกของวงมากขึ้น ไม่เลือกจุดกลางวง/จุดไกลหลุดวงง่ายเกินไป
  // ภาพอ้างอิงที่ผู้ใช้ต้องการคือวิ่งวนรอบพื้นที่ 9 จุด ไม่ใช่จุดกระจุกตรงกลางแล้วแหย่ออกไปเก็บทีหลัง
  let score = candidateBaseScore(row) * 0.68;
  score += Math.abs(r - target) * 0.78;
  score -= Math.min(r, q90) * 0.20;
  score += dStart * 0.035;
  if (r < target * 0.45) score += (target * 0.45 - r) * 3.2;       // จุดกลางวงเกินไป
  if (q90 > 0 && r > q90 * 1.38) score += (r - q90 * 1.38) * 4.4;  // จุดหลุดวงไกลเกินไป
  return score;
}

function buildNormalRingSectorSets(start, poolAll, targetStops = NORMAL_ROUTE_TARGET_STOPS) {
  const all = uniqueRowsByIdName(poolAll || []).filter(validCoord);
  if (all.length <= targetStops) return [all];

  // ลดงานหนัก แต่ยังต้องเหลือจุดรอบวงเพียงพอ: เอาทั้งจุดคะแนนดี + จุดรอบนอกแต่ไม่ไกลหลุดวง
  const overallCenter = routeCentroid(all);
  const radiiAll = all.map(p => haversine(overallCenter, coordPoint(p))).filter(Number.isFinite);
  const q70All = normalPercentile(radiiAll, 0.70);
  const q90All = normalPercentile(radiiAll, 0.90);
  const candidateLimit = Math.min(all.length, Math.max(NORMAL_ROUTE_POOL_LIMIT, targetStops * 5));
  const limited = [...all]
    .sort((a, b) => normalRingPickScore(start, overallCenter, a, { target: q70All, q90: q90All }) - normalRingPickScore(start, overallCenter, b, { target: q70All, q90: q90All }))
    .slice(0, candidateLimit);

  const centers = [
    routeCentroid(limited),
    overallCenter,
    routeCentroid(limited.slice(0, Math.min(limited.length, 24))),
    { lat: (overallCenter.lat * 0.72) + (Number(start.lat) * 0.28), lng: (overallCenter.lng * 0.72) + (Number(start.lng) * 0.28) }
  ].filter(c => c && Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lng)));
  const offsets = [0, 0.33, 0.66];
  const sets = [];

  const addSet = (rows) => {
    const selected = uniqueRowsByIdName(rows || []).filter(validCoord).slice(0, targetStops);
    if (selected.length >= Math.min(targetStops, MIN_ROUTE_CUSTOMER_STOPS)) sets.push(selected);
  };

  centers.forEach(center => {
    const radii = limited.map(p => haversine(center, coordPoint(p))).filter(Number.isFinite);
    const radiusInfo = {
      target: Math.max(4, normalPercentile(radii, 0.74)),
      q90: Math.max(4, normalPercentile(radii, 0.90))
    };

    offsets.forEach(offset => {
      const sectors = Array.from({ length: targetStops }, () => []);
      limited.forEach(p => {
        const angle = (angleAround(center, p) + Math.PI * 2 + offset * Math.PI * 2 / targetStops) % (Math.PI * 2);
        const sector = Math.min(targetStops - 1, Math.floor(angle / (Math.PI * 2 / targetStops)));
        sectors[sector].push({ p, score: normalRingPickScore(start, center, p, radiusInfo) });
      });
      sectors.forEach(sec => sec.sort((a, b) => a.score - b.score));

      // ชุดหลัก: จุดอันดับดีที่สุดของแต่ละ sector
      const main = [];
      sectors.forEach(sec => {
        const hit = sec.find(x => !main.some(s => isSameStop(s, x.p)));
        if (hit) main.push(hit.p);
      });
      for (const p of limited) {
        if (main.length >= targetStops) break;
        if (!main.some(s => isSameStop(s, p))) main.push(p);
      }
      addSet(main);

      // ชุดสำรองแบบเปลี่ยน sector ทีละช่อง เพื่อหาจุดที่ต่อวงดีกว่า แต่จำกัดจำนวนไม่ให้ค้าง
      sectors.forEach((sec, idx) => {
        const alt = sec.slice(1, 3).find(x => !main.some(s => isSameStop(s, x.p)));
        if (!alt) return;
        const variant = [...main];
        if (idx < variant.length) variant[idx] = alt.p;
        addSet(variant);
      });
    });
  });

  // ชุด fallback: จุดที่อยู่รอบนอกตามคะแนน ring ดีที่สุด
  addSet(limited);

  const seen = new Set();
  return sets.filter(set => {
    const key = routeKeyForSet(set);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 30);
}

function normalReferenceLoopScore(start, ordered) {
  const valid = (ordered || []).filter(validCoord);
  if (!valid.length) return 999999;
  const km = approxRoadDistanceKm(start, valid);
  const center = routeCentroid(valid);
  const radii = valid.map(p => haversine(center, coordPoint(p))).filter(Number.isFinite);
  const rAvg = radii.reduce((sum, r) => sum + r, 0) / Math.max(1, radii.length);
  const rMin = Math.min(...radii, 0);
  const rMax = Math.max(...radii, 0);

  let score = normalMarketRouteScore(start, valid);
  // ภาพอ้างอิง: จุดควรอยู่บนวงรอบพื้นที่ ไม่ใช่กลางวงหลายจุดหรือจุดแหย่ไกลออกไป
  if (rAvg > 0 && rMin < rAvg * 0.42) score += (rAvg * 0.42 - rMin) * 45;
  if (rAvg > 0 && rMax > rAvg * 2.25) score += (rMax - rAvg * 2.25) * 36;
  const stats = angleStatsForRows(center, valid);
  const coverageDeg = stats.coverage * 180 / Math.PI;
  if (coverageDeg < 230) score += (230 - coverageDeg) * 2.8;
  if (km > MAX_ROUTE_DISTANCE_KM) score += (km - MAX_ROUTE_DISTANCE_KM) * 28;
  return score;
}

function buildNormalCircularMarketRoute(start, candidateRows, targetStops = NORMAL_ROUTE_TARGET_STOPS) {
  // วันปกติ/ออกตลาดทั่วไป: คง 9 จุดทุกสาย และออกแบบให้เหมือนภาพอ้างอิง
  // แนวคิดใหม่: เลือก “จุดรอบวง” ก่อน แล้วค่อยเรียงลำดับเป็นวง เพื่อลดจุดกลางวง/จุดแหย่/การย้อนเก็บจุด
  const poolAll = uniqueRowsByIdName(candidateRows || []).filter(validCoord);
  if (!poolAll.length) return [];
  if (poolAll.length <= targetStops) return orderNormalMarketRoute(start, poolAll).slice(0, targetStops);

  const sets = buildNormalRingSectorSets(start, poolAll, targetStops);
  let best = null;
  sets.forEach(set => {
    let ordered = orderNormalMarketRoute(start, set).slice(0, targetStops);
    if (ordered.length < Math.min(targetStops, MIN_ROUTE_CUSTOMER_STOPS)) return;
    for (let round = 0; round < 2 && approxRoadDistanceKm(start, ordered) > MAX_ROUTE_DISTANCE_KM; round++) {
      ordered = replaceWorstNormalStopLight(start, ordered, poolAll, targetStops);
    }
    const score = normalReferenceLoopScore(start, ordered);
    if (!best || score < best.score) best = { ordered, score };
  });

  let ordered = best ? best.ordered : orderNormalMarketRoute(start, poolAll.slice(0, targetStops)).slice(0, targetStops);

  // ปรับจุดหลุดวง/แหย่ 1 รอบ แม้ไม่เกิน 350 กม. เพื่อให้ทุกสายวนเหมือนภาพอ้างอิงขึ้น
  const improved = replaceWorstNormalStopLight(start, ordered, poolAll, targetStops);
  if (normalReferenceLoopScore(start, improved) + 0.5 < normalReferenceLoopScore(start, ordered)) ordered = improved;
  return ordered.slice(0, targetStops);
}

function buildNormalPlanRows(marketRows) {
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
    // ยกเลิกวันล่วงหน้า: คำนวณเฉพาะชุดแรกของวันปัจจุบัน
    // ใช้ pool ทั้งสายในการคัด 9 จุด ไม่ใช่ slice แค่ 16 จุดแรก เพื่อให้ระบบเลือกจุดที่อยู่ในวงได้ดีกว่า
    if (!list.length) return;
    const planDate = today;
    const routeId = `วันปกติ ${thaiDateLabel(planDate)} ${bu} สาย ${meterKey}`;
    const start = startForRoute(list);
    const ordered = buildNormalCircularMarketRoute(start, list, MAX_ROUTE_CUSTOMER_STOPS);
    ordered.forEach((row, idx) => output.push({
      ...row,
      plan_day: 1,
      plan_date: planDate,
      route_group: routeId,
      stop_no: `${idx + 1}/${ordered.length}`,
      start_name: start.name,
      priorityLabel: row.priorityLabel || statusGroup(row.status)
    }));
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

function buildRepairPlanRows(repairRows, marketRows) {
  const selectedBU = getSelectedStartBU();

  // ตารางซ่อม: แสดงทุกจุดซ่อมของเดือนปัจจุบันที่ยังไม่ใช่ "แล้วเสร็จ"
  // แต่ละงานซ่อมจะถูกเติมจุดออกตลาดใกล้เคียง/สายเดียวกัน ให้ได้ 7-9 จุดเท่าที่ทำได้ โดยคุมระยะไม่เกินประมาณ 350 กม.
  let candidates = repairRows
    .filter(r => inCurrentThaiMonth(r.dateObj))
    .map(r => {
      const nearest = nearestStartPointForRow(r);
      const buFromText = inferBUFromAnyText(r.customer_name, r.area, r.coordinator, r.meter, r.customer_id);
      const bu = r.bu || buFromText || nearest.bu || "";
      return { ...r, bu, __nearestStartName: nearest.name, __nearestBU: bu };
    })
    .filter(r => !selectedBU || buEquivalent(r.__nearestBU, selectedBU))
    .sort((a,b) =>
      dateSortValue(a.dateObj) - dateSortValue(b.dateObj) ||
      cleanText(a.bu).localeCompare(cleanText(b.bu), "th") ||
      cleanText(a.meterKey).localeCompare(cleanText(b.meterKey), "th") ||
      cleanText(a.customer_name).localeCompare(cleanText(b.customer_name), "th")
    );

  const output = [];

  candidates.forEach((repair, repairIndex) => {
    const start = startForRoute([repair]);
    const rankedMarkets = rankMarketCandidatesForTarget(marketRows, repair, start);
    const ordered = buildCircularMarketPlanRoute(
      start,
      [repair],
      rankedMarkets,
      TARGET_CORE_ROUTE_STOPS,
      true
    );
    const routeDate = repair.dateObj
      ? repair.dateObj.toLocaleDateString("th-TH", { day:"numeric", month:"long", year:"2-digit" })
      : thaiMonthYearLabel();
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
  const { mode } = getPlanSettings();
  if (mode === "normal") return buildNormalPlanRows(marketRows);
  if (mode === "repair") return buildRepairPlanRows(repairRows, marketRows);
  return buildPumpPlanRows(pumpRows, repairRows, marketRows);
}

async function loadData(forceFresh = false) {
  if (isLoadingData) {
    pendingLoadRequest = forceFresh || pendingLoadRequest;
    return;
  }
  isLoadingData = true;
  resetRouteComputeCache();

  const tbody = document.getElementById("resultBody");
  if (tbody) tbody.innerHTML = `<tr><td colspan="17" class="loading">กำลังโหลดข้อมูล...</td></tr>`;
  const dashBody = document.getElementById("dashboardBody");
  if (dashBody && isDashboardPageVisible()) dashBody.innerHTML = `<tr><td colspan="9" class="loading">กำลังโหลด Dashboard...</td></tr>`;
  try {
    document.getElementById("currentMonthLabel").textContent = thaiMonthYearLabel();

    // โหลดเฉพาะชีตที่จำเป็นต่อการสร้างแผนก่อน เพื่อให้หน้าแผนขึ้นเร็วขึ้น
    const [pumpRowsRaw, repairRowsRaw, marketRowsRaw, savedRows] = await Promise.all([
      fetchSheetByIndex(SHEET_NAMES.pump, false, forceFresh),
      fetchSheetByIndex(SHEET_NAMES.repair, false, forceFresh),
      fetchSheetByIndex(SHEET_NAMES.market, false, forceFresh),
      fetchSavedSheetRowsRobust(forceFresh)
    ]);
    savedVisitRowsRaw = savedRows || [];
    savedHeaderMap = buildSavedHeaderMap(savedVisitRowsRaw);
    visitedSet = buildVisitedSet(savedRows);

    const pumpRows = normalizePump(pumpRowsRaw);
    const repairRows = normalizeRepair(repairRowsRaw);
    const marketRows = normalizeMarket(marketRowsRaw);

    customerMasterRows = buildCustomerMasterRows(pumpRows, repairRows, marketRows);

    rawRows = [...pumpRows, ...repairRows, ...marketRows]
      .sort((a,b) => (a.sourceRank - b.sourceRank) || dateSortValue(a.dateObj) - dateSortValue(b.dateObj));
    plannedRows = buildPlannedRows(pumpRows, repairRows, marketRows);
    selectedRouteKey = "";
    routeCollapsedToSelected = false;
    renderTable();
  } catch (err) {
    const routeBox = document.getElementById("routeSummary");
    const routeDetail = document.getElementById("routeDetail");
    if (routeBox) routeBox.innerHTML = `<div class="route-item">โหลดข้อมูลไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
    if (routeDetail) routeDetail.innerHTML = `โหลดข้อมูลไม่สำเร็จ กรุณาตรวจสอบสิทธิ์ Google Sheet / ชื่อชีต / อินเทอร์เน็ต แล้วกดรีเฟรชข้อมูล`;
    if (tbody) tbody.innerHTML = `<tr><td colspan="17" class="loading">เกิดข้อผิดพลาด: ${escapeHtml(err.message)}</td></tr>`;
    if (dashBody) dashBody.innerHTML = `<tr><td colspan="9" class="loading">เกิดข้อผิดพลาด: ${escapeHtml(err.message)}</td></tr>`;
  } finally {
    isLoadingData = false;
    if (pendingLoadRequest) {
      const shouldForce = pendingLoadRequest;
      pendingLoadRequest = false;
      setTimeout(() => loadData(shouldForce), 80);
    }
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


function routeDisplayStops(list) {
  // สำคัญ: ใช้ลำดับที่คำนวณไว้ตอนสร้างแผนแล้ว ไม่คำนวณซ้ำในหน้า Map
  // เพื่อให้การ์ดแผน / ตาราง / Map / Google Maps ตรงกัน และไม่เพิ่มจุดเกิน 9 จุด
  const sorted = sortRowsByPlannedStopNo(list).filter(validCoord);

  // โหมดปรับปรุงปั๊ม/ตารางซ่อม: บังคับให้จุดรับบริการเป็นจุดที่ 1 ใน Map/Google Maps เสมอ
  // และจุดอื่น ๆ ใช้ลำดับเดียวกับตารางแผน
  const mode = getPlanSettings().mode;
  if (mode === "pump" || mode === "repair") {
    const focus = sorted.find(isFocusStop);
    if (focus) {
      const rest = removeSameStop(sorted, focus);
      return [focus, ...rest].slice(0, MAX_ROUTE_CUSTOMER_STOPS);
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
  runWhenIdle(async () => {
    const nodes = Array.from(document.querySelectorAll(".geo-area"));
    for (const node of nodes) {
      const lat = node.dataset.lat;
      const lng = node.dataset.lng;
      if (!lat || !lng) continue;
      const area = await reverseGeocode(lat, lng);
      node.textContent = area || "ไม่พบข้อมูลพื้นที่";
    }
  });
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
        metricsEl.textContent = `จัดลำดับแบบวงกลมและลดการเก็บย้อนหลัง ${validStops.length} จุด ตรงกับ Google Maps • สำเร็จ ${done} จุด • คงเหลือ ${remain} จุด • ระยะทางตามถนนประมาณ ${formatKm(routed.distanceKm)} • เวลาเดินทางประมาณ ${formatDuration(routed.durationSec)} (จำกัดแผน ${MIN_ROUTE_CUSTOMER_STOPS}-${MAX_ROUTE_CUSTOMER_STOPS} จุด และประมาณไม่เกิน ${MAX_ROUTE_DISTANCE_KM} กม.)`;
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
  if (!isDashboardPageVisible()) return;
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
  if (isDashboardPageVisible()) renderVisitDashboard();
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
    tbody.innerHTML = `<tr><td colspan="17" class="loading">ไม่พบข้อมูลตามเงื่อนไข</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r,i) => `
    <tr class="${isCompleted(r) ? "done-row" : ""}">
      <td>${i + 1}</td><td>${isCompleted(r) ? "✓" : (escapeHtml(r.stop_no) || "-")}</td><td>${escapeHtml(r.start_name) || "-"}</td>
      <td><span class="badge ${priorityClass(r)}">${escapeHtml(r.priorityLabel)}</span></td><td>${escapeHtml(r.type)}</td><td>${escapeHtml(r.dateRaw) || "-"}</td>
      <td>${escapeHtml(r.customer_id) || "-"}</td><td>${escapeHtml(r.customer_name) || "-"}</td><td>${escapeHtml(r.status) || "-"}</td><td>${escapeHtml(r.bu) || "-"}</td>
      <td>${escapeHtml(r.meter) || "-"}</td><td>${escapeHtml(r.area) || "-"}</td><td>${escapeHtml(r.purpose) || "-"}</td><td>${escapeHtml(r.coordinator) || "-"}</td>
      <td>${escapeHtml(r.phone) || "-"}</td><td>${escapeHtml(r.lat) || "-"}</td><td>${escapeHtml(r.lng) || "-"}</td>
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
  const currentArea = cleanText(form.elements.area.value);
  const masterArea = isUsefulAreaText(customer.area) ? customer.area : "";
  if (source === "gps") {
    if (!isValidAreaText(currentArea) && masterArea) form.elements.area.value = masterArea;
  } else {
    form.elements.area.value = masterArea || currentArea || "";
  }
  if (form.elements.purpose) form.elements.purpose.value = customer.purpose || (customer.type === "ซ่อม" ? "ซ่อม" : "ออกเยี่ยมลูกค้า");
  if (form.elements.coordinator && !form.elements.coordinator.value) form.elements.coordinator.value = customer.coordinator || "";
  if (form.elements.phone && !form.elements.phone.value) form.elements.phone.value = customer.phone || "";
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
  if (data.lat && data.lng && !isValidAreaText(data.area)) {
    const fixedArea = await reverseGeocode(data.lat, data.lng);
    if (isValidAreaText(fixedArea)) {
      data.area = fixedArea;
      if (e.target.elements.area) e.target.elements.area.value = fixedArea;
    }
  }
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
    setTimeout(() => loadData(true), 900);
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
  const currentArea = cleanText(form.elements.area.value);
  fillFormFromMasterCustomer(customer, "gps");
  if (isValidAreaText(currentArea)) {
    form.elements.area.value = currentArea;
  } else if (!isValidAreaText(form.elements.area.value) && isUsefulAreaText(customer.area)) {
    form.elements.area.value = customer.area;
  }
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
      if (isValidAreaText(area)) form.elements.area.value = area;
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

function resetVisitFormOnly() {
  const form = document.getElementById("planForm");
  if (form) form.reset();
  const status = document.getElementById("saveStatus");
  if (status) {
    status.textContent = "";
    status.style.color = "";
  }
}

function reloadDataAndResetForm() {
  resetVisitFormOnly();
  loadData(true);
}

function applyCoordinatorPhone() {
  const form = document.getElementById("planForm");
  const select = document.getElementById("coordinatorSelect");
  if (!form || !select || !form.elements.phone) return;
  const phone = COORDINATOR_PHONE_MAP[select.value] || "";
  if (phone) form.elements.phone.value = phone;
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
if (document.getElementById("marketStatusFilter")) document.getElementById("marketStatusFilter").addEventListener("change", () => { routeCollapsedToSelected = false; loadData(); });
document.getElementById("reloadBtn").addEventListener("click", reloadDataAndResetForm);
document.getElementById("checkinBtn").addEventListener("click", checkInGps);
if (document.getElementById("coordinatorSelect")) document.getElementById("coordinatorSelect").addEventListener("change", applyCoordinatorPhone);
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
