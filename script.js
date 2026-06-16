const SHEET_ID = "1NIsXwTi6tKmYtX8DoTUqvG4mxW-5Y5YVJB0EfmQMCvY";

// URL Apps Script ของคุณ
const WEB_APP_URL = "https://script.google.com/macros/s/AKfycbz_jybKjIdUFAt44LtRnea7IIQ8RbzATZTQgRqIRdFot6TbuxKcOVbqm3qjrsO4Fcxg/exec";

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

const CHECKIN_RADIUS_METER = 100;
const MAX_PLAN_DAYS = 7;
const MAX_STOPS_PER_DAY = 16;

let rawRows = [];
let plannedRows = [];
let currentRouteGroups = new Map();
let selectedRouteKey = "";
let routeMap = null;
let routeLayer = null;
let visitedSet = { ids: new Set(), names: new Set() };

function cleanText(v) { return String(v ?? "").trim(); }
function norm(v) { return cleanText(v).toLowerCase().replace(/\s+/g, " "); }
function cell(row, index) { return row[index] ?? ""; }
function toNumber(v) {
  const n = Number(cleanText(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}
function validCoord(row) { return toNumber(row.lat) !== null && toNumber(row.lng) !== null; }

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
function buildVisitedSet(savedRows) {
  const ids = new Set();
  const names = new Set();
  savedRows.slice(1).forEach(r => {
    const visitDate = parseDateTH(cell(r, 1)) || parseDateTH(cell(r, 0));
    if (visitDate && !inCurrentThaiMonth(visitDate)) return;

    // โครงสร้างชีตใหม่: 0 วันที่บันทึก, 1 วันที่ออกตลาด, 2 ประเภท, 3 รหัส, 4 ชื่อ, ... 14 สถานะเข้าพบ
    // ถ้าเป็นข้อมูลเก่าไม่มีคอลัมน์สถานะ ให้ถือว่า “สำเร็จ” เพื่อไม่ให้จุดเก่ากลับมาในแผน
    const visitStatus = cleanText(cell(r, 14) || cell(r, 15) || "สำเร็จ");
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
function normalizeRepair(rows) {
  return rows.slice(1)
    .filter(r => cleanText(cell(r,10)) !== "เสร็จ")
    .filter(r => cleanText(cell(r,10)) === "ยังไม่เข้าซ่อม" || cleanText(cell(r,10)) !== "")
    .map(r => {
      const dateObj = parseDateTH(cell(r,8));
      const meterRaw = cell(r,2);
      return {
        sourceRank: 2, priority: 200 + getUrgencyScore(cell(r,9), dateObj), priorityLabel: cell(r,9) || "ซ่อม", type: "ซ่อม",
        dateRaw: cell(r,8), dateObj, customer_id: "", customer_name: cell(r,1), status: cell(r,10), bu: "",
        meter: meterRaw, meterKey: normalizeMeter(meterRaw), area: cell(r,3), purpose: cell(r,4), coordinator: cell(r,6), phone: cell(r,7),
        lat: cell(r,11), lng: cell(r,12), sales_litre: "", route_group: "", stop_no: "", start_name: ""
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
    .filter(r => !isVisited(r));

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
function orderCircularRoute(start, points) {
  const remaining = points.filter(validCoord).map(p => ({...p}));
  const noCoord = points.filter(p => !validCoord(p));
  const ordered = [];
  let current = { lat: start.lat, lng: start.lng };
  while (remaining.length) {
    let bestIndex = 0, bestDistance = Infinity;
    remaining.forEach((p, i) => {
      const d = haversine(current, { lat: toNumber(p.lat), lng: toNumber(p.lng) });
      if (d < bestDistance) { bestDistance = d; bestIndex = i; }
    });
    const next = remaining.splice(bestIndex, 1)[0];
    ordered.push(next);
    current = { lat: toNumber(next.lat), lng: toNumber(next.lng) };
  }
  return [...ordered, ...noCoord];
}
function takeByStatusForMeter(marketRows, pump) {
  const selectedBU = getSelectedStartBU();
  const sameMeter = marketRows
    .filter(m => m.meterKey === pump.meterKey)
    .filter(m => !selectedBU || cleanText(m.bu).toUpperCase() === selectedBU.toUpperCase())
    .filter(m => !isVisited(m))
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
    const ordered = orderCircularRoute(start, routePoints);
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
    .filter(r => !isVisited(r))
    .map(r => ({ ...r, plan_day: 1, plan_date: r.dateObj || thaiNow(), route_group: "ตารางซ่อมเดือนปัจจุบัน", stop_no: "-", start_name: "-" }));
  return [...output, ...repairs];
}

function buildNormalPlanRows(marketRows, planDays) {
  const today = thaiNow();
  const selectedBU = getSelectedStartBU();
  const candidates = marketRows
    .filter(r => !selectedBU || cleanText(r.bu).toUpperCase() === selectedBU.toUpperCase())
    .filter(r => !isVisited(r))
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
    const maxItems = Math.min(list.length, planDays * MAX_STOPS_PER_DAY);
    const usable = list.slice(0, maxItems);
    for (let dayIndex = 0; dayIndex < planDays; dayIndex++) {
      const chunk = usable.slice(dayIndex * MAX_STOPS_PER_DAY, (dayIndex + 1) * MAX_STOPS_PER_DAY);
      if (!chunk.length) continue;
      const planDate = addDaysTH(today, dayIndex);
      const routeId = `วันปกติ ${thaiDateLabel(planDate)} ${bu} สาย ${meterKey}`;
      const start = startForRoute(chunk);
      const ordered = orderCircularRoute(start, chunk);
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

function buildRepairPlanRows(repairRows, planDays) {
  const today = thaiNow();
  const selectedPoint = getSelectedStartPoint();
  const selectedBU = selectedPoint ? selectedPoint.bu : "";

  let candidates = repairRows
    .filter(r => !isVisited(r))
    .filter(validCoord)
    .filter(r => inCurrentThaiMonth(r.dateObj) || !r.dateObj)
    .map(r => {
      const nearest = nearestStartPointForRow(r);
      return { ...r, bu: r.bu || nearest.bu || "", __nearestStartName: nearest.name, __nearestBU: nearest.bu || "" };
    })
    .filter(r => !selectedBU || cleanText(r.__nearestBU).toUpperCase() === selectedBU.toUpperCase())
    .sort((a,b) => (a.priority - b.priority) || (dateSortValue(a.dateObj) - dateSortValue(b.dateObj)) || cleanText(a.meterKey).localeCompare(cleanText(b.meterKey), "th"));

  const output = [];
  const maxItems = Math.min(candidates.length, planDays * MAX_STOPS_PER_DAY);
  const usable = candidates.slice(0, maxItems);

  for (let dayIndex = 0; dayIndex < planDays; dayIndex++) {
    const chunk = usable.slice(dayIndex * MAX_STOPS_PER_DAY, (dayIndex + 1) * MAX_STOPS_PER_DAY);
    if (!chunk.length) continue;
    const planDate = addDaysTH(today, dayIndex);
    const start = startForRoute(chunk);
    const ordered = orderCircularRoute(start, chunk);
    const routeId = `ตารางซ่อม ${thaiDateLabel(planDate)} ${selectedBU || "ทุก BU"}`;
    ordered.forEach((row, idx) => output.push({
      ...row,
      plan_day: dayIndex + 1,
      plan_date: planDate,
      route_group: routeId,
      stop_no: `${idx + 1}/${ordered.length}`,
      start_name: start.name,
      priorityLabel: row.priorityLabel || "ซ่อม"
    }));
  }
  return output;
}

function buildPlannedRows(pumpRows, repairRows, marketRows) {
  const { mode, days } = getPlanSettings();
  if (mode === "normal") return buildNormalPlanRows(marketRows, days);
  if (mode === "repair") return buildRepairPlanRows(repairRows, days);
  return buildPumpPlanRows(pumpRows, repairRows, marketRows);
}

async function loadData() {
  const tbody = document.getElementById("resultBody");
  tbody.innerHTML = `<tr><td colspan="18" class="loading">กำลังโหลดข้อมูล...</td></tr>`;
  try {
    document.getElementById("currentMonthLabel").textContent = thaiMonthYearLabel();
    const [pumpRowsRaw, repairRowsRaw, marketRowsRaw, salesRows, savedRows] = await Promise.all([
      fetchSheetByIndex(SHEET_NAMES.pump),
      fetchSheetByIndex(SHEET_NAMES.repair),
      fetchSheetByIndex(SHEET_NAMES.market),
      fetchSheetByIndex(SHEET_NAMES.sales),
      fetchSheetByIndex(SHEET_NAMES.saved, true)
    ]);
    visitedSet = buildVisitedSet(savedRows);

    const pumpRows = normalizePump(pumpRowsRaw);
    const repairRows = normalizeRepair(repairRowsRaw);
    const marketRows = normalizeMarket(marketRowsRaw);

    rawRows = enrichSales([...pumpRows, ...repairRows, ...marketRows], salesRows)
      .sort((a,b) => (a.sourceRank - b.sourceRank) || dateSortValue(a.dateObj) - dateSortValue(b.dateObj));
    plannedRows = enrichSales(buildPlannedRows(pumpRows, repairRows, marketRows), salesRows);
    selectedRouteKey = "";
    renderTable();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="18" class="loading">เกิดข้อผิดพลาด: ${escapeHtml(err.message)}</td></tr>`;
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
function routeToGoogleMapsUrl(list) {
  const valid = list.filter(validCoord);
  if (!valid.length) return "";
  const start = START_POINTS.find(x => x.name === list[0].start_name) || bestStartForRoute(valid);
  const stops = [{ customer_name:start.name, lat:start.lat, lng:start.lng }, ...valid, { customer_name:start.name, lat:start.lat, lng:start.lng }];
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
    box.innerHTML = `<div class="route-item">ยังไม่มีข้อมูลสำหรับวางแผน หรือจุดถูกบันทึกสำเร็จแล้ว</div>`;
    renderRouteDetail([]);
    return;
  }
  if (!selectedRouteKey || !groups.has(selectedRouteKey)) selectedRouteKey = keys[0];
  box.innerHTML = keys.map((name, idx) => {
    const list = groups.get(name);
    const first = list[0];
    const routeNames = list.map(x => x.customer_name || x.customer_id).filter(Boolean).join(" → ");
    const active = name === selectedRouteKey ? " active" : "";
    return `<button class="route-item route-button${active}" data-route-key="${escapeHtml(name)}" type="button"><strong>${idx + 1}. ${escapeHtml(name)}</strong><br><span>เริ่ม/วนกลับ: ${escapeHtml(first.start_name || "-")}</span><br><small>${escapeHtml(routeNames)} → ${escapeHtml(first.start_name || "จุดเริ่มต้น")}</small></button>`;
  }).join("");
  box.querySelectorAll(".route-button").forEach(btn => btn.addEventListener("click", () => {
    selectedRouteKey = btn.dataset.routeKey;
    renderRouteSummary(plannedRows);
  }));
  renderRouteDetail(groups.get(selectedRouteKey) || []);
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
  const rows = list.map((r, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(r.customer_name || "-")}</td><td>${escapeHtml(r.type || "-")}</td><td>${escapeHtml(r.status || "-")}</td><td>${escapeHtml(r.lat || "-")}, ${escapeHtml(r.lng || "-")}</td></tr>`).join("");
  detail.innerHTML = `
    <div class="detail-head">
      <div>
        <h3>${escapeHtml(selectedRouteKey)}</h3>
        <p>จุดเริ่มต้น/วนกลับ: <strong>${escapeHtml(start.name)}</strong></p>
        <p id="routeMetrics" class="route-metrics">กำลังคำนวณเส้นทางตามถนนจริง...</p>
      </div>
      ${googleUrl ? `<a class="map-link" href="${googleUrl}" target="_blank" rel="noopener">เปิดเส้นทางจริง/เวลาที่ดีที่สุดใน Google Maps</a>` : ""}
    </div>
    <div class="detail-table-wrap"><table class="detail-table"><thead><tr><th>ลำดับ</th><th>ชื่อปั๊ม/ลูกค้า</th><th>ประเภท</th><th>สถานะ</th><th>พิกัด</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  renderMap(list);
}
function makeNumberIcon(number) {
  return L.divIcon({
    className: "route-number-icon",
    html: `<span>${number}</span>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    popupAnchor: [0, -15]
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
  const valid = list.filter(validCoord);
  if (!valid.length) {
    routeMap.setView([16.5, 103.8], 8);
    if (metricsEl) metricsEl.textContent = "ยังไม่มีพิกัดสำหรับคำนวณเส้นทาง";
    setTimeout(() => routeMap.invalidateSize(), 200);
    return;
  }
  const start = START_POINTS.find(x => x.name === list[0].start_name) || bestStartForRoute(valid);
  const points = [{ ...start, customer_name:start.name, type:"จุดเริ่มต้น", status:"เริ่ม/กลับ" }, ...valid, { ...start, customer_name:start.name, type:"จุดเริ่มต้น", status:"วนกลับ" }];
  const latlngs = points.map(p => [toNumber(p.lat), toNumber(p.lng)]);

  // Marker: จุดเริ่มต้นสีเขียว และจุดลูกค้าเป็นตัวเลขตามลำดับ
  points.forEach((p, idx) => {
    const isStart = idx === 0 || idx === points.length - 1;
    const label = idx === 0 ? "เริ่ม" : idx === points.length - 1 ? "กลับ" : String(idx);
    const icon = isStart ? makeStartIcon(idx === 0 ? "เริ่ม" : "กลับ") : makeNumberIcon(idx);
    L.marker([toNumber(p.lat), toNumber(p.lng)], { icon }).addTo(routeLayer)
      .bindPopup(`<strong>${label}. ${escapeHtml(p.customer_name || p.name || "-")}</strong><br>${escapeHtml(p.type || "-")}<br>${escapeHtml(p.status || "-")}`);
  });

  routeMap.fitBounds(latlngs, { padding: [30, 30] });
  setTimeout(() => routeMap.invalidateSize(), 250);

  // วาดเส้นทางตามถนนจริงด้วย OSRM ถ้าโหลดไม่ได้จะ fallback เป็นเส้นตรง
  try {
    const routed = await getOsrmRoute(points);
    if (routeLayer && routed && routed.latlngs.length) {
      L.polyline(routed.latlngs, { weight: 5 }).addTo(routeLayer);
      routeMap.fitBounds(routed.latlngs, { padding: [30, 30] });
      if (metricsEl) {
        metricsEl.textContent = `ระยะทางตามถนนประมาณ ${formatKm(routed.distanceKm)} • เวลาเดินทางประมาณ ${formatDuration(routed.durationSec)} (กด Google Maps เพื่อดูเวลาจราจรจริง/เส้นทางดีที่สุด)`;
      }
      return;
    }
  } catch (err) {
    // ไม่ต้องหยุดระบบ ถ้า OSRM ไม่ตอบกลับ
  }
  L.polyline(latlngs, { weight: 5, dashArray: "8,8" }).addTo(routeLayer);
  if (metricsEl) metricsEl.textContent = "แสดงเส้นเชื่อมแบบประมาณการ กด Google Maps เพื่อดูเส้นทางจริงและเวลาที่ดีที่สุด";
}
function renderTable() {
  const search = cleanText(document.getElementById("searchBox").value).toLowerCase();
  const type = cleanText(document.getElementById("typeFilter").value);
  const status = cleanText(document.getElementById("statusFilter").value).toLowerCase();
  const showAll = document.getElementById("showAllToggle").checked;
  const tbody = document.getElementById("resultBody");

  renderRouteSummary(plannedRows);

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
    <tr>
      <td>${i + 1}</td><td>${escapeHtml(r.stop_no) || "-"}</td><td>${escapeHtml(r.start_name) || "-"}</td>
      <td><span class="badge ${priorityClass(r)}">${escapeHtml(r.priorityLabel)}</span></td><td>${escapeHtml(r.type)}</td><td>${escapeHtml(r.dateRaw) || "-"}</td>
      <td>${escapeHtml(r.customer_id) || "-"}</td><td>${escapeHtml(r.customer_name) || "-"}</td><td>${escapeHtml(r.status) || "-"}</td><td>${escapeHtml(r.bu) || "-"}</td>
      <td>${escapeHtml(r.meter) || "-"}</td><td>${escapeHtml(r.area) || "-"}</td><td>${escapeHtml(r.purpose) || "-"}</td><td>${escapeHtml(r.coordinator) || "-"}</td>
      <td>${escapeHtml(r.phone) || "-"}</td><td>${escapeHtml(r.sales_litre) || "-"}</td><td>${escapeHtml(r.lat) || "-"}</td><td>${escapeHtml(r.lng) || "-"}</td>
    </tr>`).join("");
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
function buildAreaText(address = {}) {
  const tambon = address.suburb || address.quarter || address.village || address.hamlet || address.neighbourhood || "";
  const amphoe = address.city_district || address.county || address.city || address.town || address.municipality || "";
  const province = address.state || address.province || "";
  const parts = [];
  if (tambon) parts.push(`ต.${tambon.replace(/^ตำบล\s*/, "")}`);
  if (amphoe) parts.push(`อ.${amphoe.replace(/^อำเภอ\s*/, "")}`);
  if (province) parts.push(`จ.${province.replace(/^จังหวัด\s*/, "")}`);
  return parts.join(" ") || address.display_name || "";
}
async function reverseGeocode(lat, lng) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&zoom=18&addressdetails=1&accept-language=th`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("reverse geocode failed");
    const data = await res.json();
    return buildAreaText(data.address || {}) || data.display_name || "";
  } catch (err) {
    return "";
  }
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
  form.elements.job_type.value = "ออกตลาด";
  form.elements.customer_id.value = customer.customer_id || "";
  form.elements.customer_name.value = customer.customer_name || "";
  form.elements.bu.value = customer.bu || inferBU(customer.customer_id, customer.bu);
  form.elements.meter.value = customer.meter || "";
  form.elements.area.value = customer.area || form.elements.area.value || "";
  form.elements.purpose.value = customer.purpose || "ติดตามสถานะลูกค้า";
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
      status.textContent = `เช็คอินสำเร็จ: พบลูกค้าในรัศมี ${Math.round(customer.distance)} เมตร - ${customer.customer_name || customer.customer_id}`;
      status.style.color = "#166534";
    } else {
      unlockManualCustomerFields(form);
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
document.getElementById("searchBox").addEventListener("input", renderTable);
document.getElementById("typeFilter").addEventListener("change", renderTable);
document.getElementById("statusFilter").addEventListener("change", renderTable);
document.getElementById("showAllToggle").addEventListener("change", renderTable);
if (document.getElementById("startPointInput")) document.getElementById("startPointInput").addEventListener("change", loadData);
if (document.getElementById("planMode")) document.getElementById("planMode").addEventListener("change", loadData);
if (document.getElementById("planDays")) document.getElementById("planDays").addEventListener("change", loadData);
document.getElementById("reloadBtn").addEventListener("click", loadData);
document.getElementById("checkinBtn").addEventListener("click", checkInGps);
loadData();
