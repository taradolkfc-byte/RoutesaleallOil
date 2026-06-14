const SHEET_ID = "1NIsXwTi6tKmYtX8DoTUqvG4mxW-5Y5YVJB0EfmQMCvY";

// หลัง Deploy Apps Script แล้ว ให้นำ Web App URL มาใส่แทนข้อความด้านล่าง
const WEB_APP_URL = "https://script.google.com/macros/s/AKfycbz_jybKjIdUFAt44LtRnea7llQ8RbzATZTQgRqlRdFot6TbuxKcOVbqm3qjrsO4Fcxg/exec";

const SHEET_NAMES = {
  pump: "ตารางปรับปรุงปั๊ม",
  repair: "ตารางซ่อม",
  market: "พื้นที่เซลล์ออกตลาด",
  sales: "รายงานยอดขาย"
};

let allRows = [];

function cleanText(v) { return String(v ?? "").trim(); }
function cell(row, index) { return row[index] ?? ""; }

async function fetchSheetByIndex(sheetName) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(sheetName)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`โหลดชีต ${sheetName} ไม่ได้`);
  const text = await res.text();
  const jsonText = text.substring(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const json = JSON.parse(jsonText);

  return json.table.rows.map(r => (r.c || []).map(c => c ? (c.f || c.v || "") : ""));
}

function parseDateTH(value) {
  if (!value) return null;
  const txt = cleanText(value);

  const gviz = txt.match(/Date\((\d+),(\d+),(\d+)/);
  if (gviz) return new Date(Number(gviz[1]), Number(gviz[2]), Number(gviz[3]));

  const parts = txt.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (parts) {
    let y = Number(parts[3]);
    if (y < 100) y += 2500;
    if (y > 2400) y -= 543;
    return new Date(y, Number(parts[2]) - 1, Number(parts[1]));
  }

  const months = {
    "ม.ค.":0,"มกราคม":0,"ก.พ.":1,"กุมภาพันธ์":1,"มี.ค.":2,"มีนาคม":2,"เม.ย.":3,"เมษายน":3,
    "พ.ค.":4,"พฤษภาคม":4,"มิ.ย.":5,"มิถุนายน":5,"ก.ค.":6,"กรกฎาคม":6,"ส.ค.":7,"สิงหาคม":7,
    "ก.ย.":8,"กันยายน":8,"ต.ค.":9,"ตุลาคม":9,"พ.ย.":10,"พฤศจิกายน":10,"ธ.ค.":11,"ธันวาคม":11
  };
  const th = txt.split(/\s+/);
  if (th.length >= 3 && months[th[1]] !== undefined) {
    let y = Number(th[2]);
    if (y < 100) y += 2500;
    if (y > 2400) y -= 543;
    return new Date(y, months[th[1]], Number(th[0]));
  }
  return null;
}

function dateSortValue(d) { return d ? d.getTime() : 9999999999999; }
function daysFromToday(d) {
  if (!d) return 99999;
  const today = new Date();
  today.setHours(0,0,0,0);
  d.setHours(0,0,0,0);
  return Math.ceil((d - today) / 86400000);
}

function getUrgencyScore(urgency, dateObj) {
  const u = cleanText(urgency);
  const d = daysFromToday(dateObj);
  if (u.includes("ยาก") || u.includes("เร่งด่วน")) return d <= 3 ? 1 : 2;
  if (u.includes("ปานกลาง")) return d <= 15 ? 2 : 3;
  if (u.includes("ง่าย")) return d <= 30 ? 3 : 4;
  return 4;
}

function getMarketScore(status) {
  const s = cleanText(status).toLowerCase();
  if (s.includes("risky")) return 1;
  if (s.includes("dormant")) return 2;
  if (s.includes("winback") || s.includes("new")) return 3;
  if (s.includes("lost")) return 4;
  if (s.includes("active")) return 5;
  return 6;
}

function normalizePump(rows) {
  // Column B=1 รหัสลูกค้า, C=2 รายชื่อลูกค้า, D=3 มิเตอร์สาย, E=4 วันนัดหมาย, F=5 สถานะ, G=6 ละ, H=7 ลอง
  return rows.slice(1)
    .filter(r => cleanText(cell(r,5)) !== "เสร็จ")
    .filter(r => cleanText(cell(r,5)) === "ยังไม่เริ่ม" || cleanText(cell(r,5)) !== "")
    .map(r => {
      const dateObj = parseDateTH(cell(r,4));
      return {
        sourceRank: 1,
        priority: 100,
        priorityLabel: "1-ปรับปรุงปั๊ม",
        type: "ปรับปรุงปั๊ม",
        dateRaw: cell(r,4),
        dateObj,
        customer_id: cell(r,1),
        customer_name: cell(r,2),
        status: cell(r,5),
        bu: "",
        meter: cell(r,3),
        area: "",
        purpose: "ปรับปรุงปั๊ม",
        coordinator: "",
        phone: "",
        lat: cell(r,6),
        lng: cell(r,7),
        sales_litre: ""
      };
    });
}

function normalizeRepair(rows) {
  // B=1 ชื่อปั๊ม, C=2 สายมิเตอร์, D=3 เขตพื้นที่, E=4 ซ่อมบำรุง, G=6 ผู้ประสานงาน, H=7 เบอร์โทร, I=8 วันนัดหมาย, J=9 ความเร่งด่วน, K=10 สถานะ, L=11 ละ, M=12 ลอง
  return rows.slice(1)
    .filter(r => cleanText(cell(r,10)) !== "เสร็จ")
    .filter(r => cleanText(cell(r,10)) === "ยังไม่เข้าซ่อม" || cleanText(cell(r,10)) !== "")
    .map(r => {
      const dateObj = parseDateTH(cell(r,8));
      const urgentScore = getUrgencyScore(cell(r,9), dateObj);
      return {
        sourceRank: 2,
        priority: 200 + urgentScore,
        priorityLabel: cell(r,9) || "ซ่อม",
        type: "ซ่อม",
        dateRaw: cell(r,8),
        dateObj,
        customer_id: "",
        customer_name: cell(r,1),
        status: cell(r,10),
        bu: "",
        meter: cell(r,2),
        area: cell(r,3),
        purpose: cell(r,4),
        coordinator: cell(r,6),
        phone: cell(r,7),
        lat: cell(r,11),
        lng: cell(r,12),
        sales_litre: ""
      };
    });
}

function normalizeMarket(rows) {
  // A=0 customer_id, B=1 customer_name, C=2 ละ, D=3 ลอง, E=4 BU/branch, F=5 สายมิเตอร์/branch, K=10 status
  return rows.slice(1).map(r => {
    const status = cell(r,10);
    return {
      sourceRank: 3,
      priority: 300 + getMarketScore(status),
      priorityLabel: status || "พื้นที่ออกตลาด",
      type: "พื้นที่ออกตลาด",
      dateRaw: "",
      dateObj: null,
      customer_id: cell(r,0),
      customer_name: cell(r,1),
      status,
      bu: cell(r,4),
      meter: cell(r,5),
      area: cell(r,4),
      purpose: "ติดตามสถานะลูกค้า",
      coordinator: "",
      phone: "",
      lat: cell(r,2),
      lng: cell(r,3),
      sales_litre: ""
    };
  }).filter(r => r.customer_id || r.customer_name);
}

function buildSalesMap(rows) {
  // B=1 branch, C=2 channel, D=3 channel_type, F=5 actual_litre
  const map = new Map();
  rows.slice(1).forEach(r => {
    const branch = cleanText(cell(r,1));
    const channel = cleanText(cell(r,2));
    const type = cleanText(cell(r,3));
    const litre = Number(String(cell(r,5)).replace(/,/g,"")) || 0;
    if (!["รถมิเตอร์", "รถเทรลเลอร์"].includes(channel)) return;
    if (!["MT", "TR"].includes(type)) return;
    const key1 = `${branch}|${type}`.toLowerCase();
    const key2 = `${branch}`.toLowerCase();
    map.set(key1, (map.get(key1) || 0) + litre);
    map.set(key2, (map.get(key2) || 0) + litre);
  });
  return map;
}

function enrichSales(rows, salesRows) {
  const salesMap = buildSalesMap(salesRows);
  return rows.map(r => {
    const meter = cleanText(r.meter);
    const type = meter.includes("TR") ? "TR" : meter.includes("MT") ? "MT" : "";
    const key1 = `${meter}|${type}`.toLowerCase();
    const key2 = `${meter}`.toLowerCase();
    const litre = salesMap.get(key1) || salesMap.get(key2) || "";
    return {...r, sales_litre: litre ? litre.toLocaleString("th-TH") : ""};
  });
}

async function loadData() {
  const tbody = document.getElementById("resultBody");
  tbody.innerHTML = `<tr><td colspan="16" class="loading">กำลังโหลดข้อมูล...</td></tr>`;
  try {
    const [pumpRows, repairRows, marketRows, salesRows] = await Promise.all([
      fetchSheetByIndex(SHEET_NAMES.pump),
      fetchSheetByIndex(SHEET_NAMES.repair),
      fetchSheetByIndex(SHEET_NAMES.market),
      fetchSheetByIndex(SHEET_NAMES.sales)
    ]);

    let rows = [...normalizePump(pumpRows), ...normalizeRepair(repairRows), ...normalizeMarket(marketRows)];
    rows = enrichSales(rows, salesRows);
    rows.sort((a,b) => (a.sourceRank - b.sourceRank) || (a.priority - b.priority) || (dateSortValue(a.dateObj) - dateSortValue(b.dateObj)) || cleanText(a.customer_name).localeCompare(cleanText(b.customer_name), "th"));
    allRows = rows;
    renderTable();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="16" class="loading">เกิดข้อผิดพลาด: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function escapeHtml(str) {
  return cleanText(str).replace(/[&<>'"]/g, m => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[m]));
}

function priorityClass(row) {
  if (row.sourceRank === 1) return "p1";
  if (row.sourceRank === 2) return row.priority <= 202 ? "p1" : "p2";
  if (row.sourceRank === 3) return row.priority <= 302 ? "p3" : "p4";
  return "p4";
}

function renderTable() {
  const search = cleanText(document.getElementById("searchBox").value).toLowerCase();
  const type = cleanText(document.getElementById("typeFilter").value);
  const status = cleanText(document.getElementById("statusFilter").value).toLowerCase();
  const tbody = document.getElementById("resultBody");

  const rows = allRows.filter(r => {
    const text = `${r.customer_id} ${r.customer_name} ${r.meter} ${r.area} ${r.status}`.toLowerCase();
    return (!type || r.type === type) && (!status || cleanText(r.status).toLowerCase().includes(status)) && (!search || text.includes(search));
  });

  document.getElementById("sumAll").textContent = rows.length;
  document.getElementById("sumPump").textContent = rows.filter(r => r.type === "ปรับปรุงปั๊ม").length;
  document.getElementById("sumRepair").textContent = rows.filter(r => r.type === "ซ่อม").length;
  document.getElementById("sumMarket").textContent = rows.filter(r => r.type === "พื้นที่ออกตลาด").length;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="16" class="loading">ไม่พบข้อมูลตามเงื่อนไข</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map((r,i) => `
    <tr>
      <td>${i + 1}</td>
      <td><span class="badge ${priorityClass(r)}">${escapeHtml(r.priorityLabel)}</span></td>
      <td>${escapeHtml(r.type)}</td>
      <td>${escapeHtml(r.dateRaw) || "-"}</td>
      <td>${escapeHtml(r.customer_id) || "-"}</td>
      <td>${escapeHtml(r.customer_name) || "-"}</td>
      <td>${escapeHtml(r.status) || "-"}</td>
      <td>${escapeHtml(r.bu) || "-"}</td>
      <td>${escapeHtml(r.meter) || "-"}</td>
      <td>${escapeHtml(r.area) || "-"}</td>
      <td>${escapeHtml(r.purpose) || "-"}</td>
      <td>${escapeHtml(r.coordinator) || "-"}</td>
      <td>${escapeHtml(r.phone) || "-"}</td>
      <td>${escapeHtml(r.sales_litre) || "-"}</td>
      <td>${escapeHtml(r.lat) || "-"}</td>
      <td>${escapeHtml(r.lng) || "-"}</td>
    </tr>
  `).join("");
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
    await fetch(WEB_APP_URL, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(data)
    });
    status.textContent = "บันทึกข้อมูลเรียบร้อยแล้ว";
    status.style.color = "#166534";
    e.target.reset();
  } catch (err) {
    status.textContent = `บันทึกไม่สำเร็จ: ${err.message}`;
    status.style.color = "#dc2626";
  }
}

document.getElementById("planForm").addEventListener("submit", saveForm);
document.getElementById("searchBox").addEventListener("input", renderTable);
document.getElementById("typeFilter").addEventListener("change", renderTable);
document.getElementById("statusFilter").addEventListener("change", renderTable);
document.getElementById("reloadBtn").addEventListener("click", loadData);

loadData();
