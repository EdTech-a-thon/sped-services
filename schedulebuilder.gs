const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
const START_MIN = 7*60 + 30;   // 7:30 AM
const END_MIN   = 15*60;       // 3:00 PM
const SLOT      = 15;
const RED   = '#f4c7c3';
const GREEN = '#b7e1cd';

function buildSchedules() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const students = readStudents(ss);
  const teacherSchedules = readTeacherSchedules(ss, students);
  const therapy = readTherapy(ss);   // {day: [{start,end,student,type}]}

  DAYS.forEach(day => buildDaySheet(ss, day, students, teacherSchedules, therapy[day] || []));
  SpreadsheetApp.getUi().alert('Done.');
}

/* ---------- helpers ---------- */

function toMin(v) {
  if (v === '' || v == null) return null;
  if (v instanceof Date) {
    const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
    const s = Utilities.formatDate(v, tz, 'HH:mm').split(':');
    return (+s[0])*60 + (+s[1]);
  }
  const m = String(v).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!m) return null;
  let h = +m[1];
  const min = +m[2];
  const ap = m[3] ? m[3].toUpperCase() : null;
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return h*60 + min;
}

function fmt(mins) {
  let h = Math.floor(mins/60), m = mins%60;
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return h + ':' + ('0'+m).slice(-2) + ' ' + ap;
}

function isTrue(v) {
  return v === true || String(v).trim().toUpperCase() === 'TRUE';
}

/* ---------- readers ---------- */

function readStudents(ss) {
  const rows = ss.getSheetByName('Students').getDataRange().getValues();
  const hdr = rows.shift().map(String);
  const iName = hdr.indexOf('Student');
  const iClass = hdr.indexOf('Class');
  return rows
    .filter(r => String(r[iName]).trim())
    .map(r => ({ name: String(r[iName]).trim(), cls: String(r[iClass]).trim() }));
}

function readTeacherSchedules(ss, students) {
  const out = {};
  const classes = [...new Set(students.map(s => s.cls))];
  classes.forEach(cls => {
    const sh = ss.getSheetByName(cls);
    if (!sh) { out[cls] = []; return; }
    const rows = sh.getDataRange().getValues();
    rows.shift();
    out[cls] = rows
      .map(r => ({ start: toMin(r[0]), end: toMin(r[1]), subject: String(r[3]).trim(), ok: isTrue(r[4]) }))
      .filter(b => b.start != null && b.end != null);
  });
  return out;
}

function readTherapy(ss) {
  const byDay = {};
  DAYS.forEach(d => byDay[d] = []);
  ['OT','PT'].forEach(type => {
    const sh = ss.getSheetByName(type);
    if (!sh) return;
    const v = sh.getDataRange().getValues();
    const dayRow = v[0];
    for (let c = 0; c < dayRow.length; c++) {
      const day = String(dayRow[c]).trim();
      if (DAYS.indexOf(day) === -1) continue;
      for (let r = 2; r < v.length; r++) {
        const s = toMin(v[r][c]), e = toMin(v[r][c+1]), stu = String(v[r][c+2] || '').trim();
        if (s == null || e == null || !stu) continue;
        byDay[day].push({ start: s, end: e, student: stu, type: type });
      }
    }
  });
  return byDay;
}

/* ---------- builder ---------- */

function buildDaySheet(ss, day, students, teacherSchedules, dayTherapy) {
  const name = day + ' Grid';
  let sh = ss.getSheetByName(name);
  if (sh) ss.deleteSheet(sh);
  sh = ss.insertSheet(name);

  const slots = [];
  for (let t = START_MIN; t < END_MIN; t += SLOT) slots.push(t);

  const header = ['Time'].concat(students.map(s => s.name));
  const values = [header];
  const colors = [new Array(header.length).fill(null)];

  slots.forEach(t => {
    const row = [fmt(t) + ' - ' + fmt(t + SLOT)];
    const crow = [null];
    students.forEach(stu => {
      const th = dayTherapy.find(x => x.student === stu.name && x.start <= t && x.end > t);
      if (th) { row.push(th.type); crow.push(RED); return; }
      const blocks = teacherSchedules[stu.cls] || [];
      const b = blocks.find(x => x.start <= t && x.end > t);
      if (!b) { row.push(''); crow.push(null); return; }
      row.push(b.subject);
      crow.push(b.ok ? GREEN : RED);
    });
    values.push(row);
    colors.push(crow);
  });

  const rng = sh.getRange(1, 1, values.length, header.length);
  rng.setValues(values);
  rng.setBackgrounds(colors);
  rng.setVerticalAlignment('middle');
  sh.getRange(1, 1, 1, header.length).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.setFrozenColumns(1);
  sh.setColumnWidth(1, 120);
  for (let c = 2; c <= header.length; c++) sh.setColumnWidth(c, 110);
}