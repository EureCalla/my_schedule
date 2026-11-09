// 時間尺度：把「日序」換成畫面上的格子與 px 位置
//
// 三種檢視共用同一份以天為單位的資料，只是一格代表的長度不同：
//   day   一格＝一天；上層依月份分組，下層為日期
//   week  一格＝一週（週一開始）；上層依週一所在月份分組，下層為當年第幾週
//   month 一格＝一個月；上層依年份分組，下層為月份
// 每個尺度產生一串連續的格子 units（{ start, end } 皆為日序、含頭尾），
// 格內的日子按比例分配寬度，因此在週／月檢視也能看出排程落在格內的哪一段。

const SCALES = {
  day: { label: "日", cellW: 24 },
  week: { label: "週", cellW: 26 },
  month: { label: "月", cellW: 56 },
};

function monthLabel(year, month, first) {
  return first || month === 1 ? `${year}年 ${month}月` : `${month}月`;
}

// 依 key 把相鄰的格子分組，作為上層表頭與分隔線
function groupUnits(units, keyOf, labelOf) {
  const groups = [];
  units.forEach((u, i) => {
    const key = keyOf(u);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.span += 1;
    else groups.push({ key, from: i, span: 1, label: labelOf(u, groups.length === 0) });
  });
  return groups;
}

function buildUnits(scale, timeline) {
  const { startYear, startMonth, months } = timeline;
  const endIndex = startYear * 12 + (startMonth - 1) + months; // 範圍之後的第一個月
  const endYear = Math.floor(endIndex / 12);
  const endMonth = (endIndex % 12) + 1;
  const units = [];

  if (scale === "day") {
    const last = dayFromYmd(endYear, endMonth, 1) - 1;
    for (let d = dayFromYmd(startYear, startMonth, 1); d <= last; d += 1) {
      const ymd = ymdOf(d);
      units.push({
        start: d,
        end: d,
        label: String(ymd.date),
        tip: fmtDay(d),
        weekend: ymd.weekday === 0 || ymd.weekday === 6,
        group: ymd,
      });
    }
    return { units, groups: groupUnits(units, (u) => `${u.group.year}-${u.group.month}`, (u, f) => monthLabel(u.group.year, u.group.month, f)) };
  }

  if (scale === "week") {
    const last = firstMondayOfMonth(endYear, endMonth) - 1;
    for (let d = firstMondayOfMonth(startYear, startMonth); d <= last; d += 7) {
      const ymd = ymdOf(d);
      const week = weekNumber(d);
      units.push({ start: d, end: d + 6, label: String(week), tip: `${ymd.year} 第${week}週（${ymd.month}/${ymd.date} 起）`, group: ymd });
    }
    return { units, groups: groupUnits(units, (u) => `${u.group.year}-${u.group.month}`, (u, f) => monthLabel(u.group.year, u.group.month, f)) };
  }

  for (let i = 0; i < months; i += 1) {
    const index = startYear * 12 + (startMonth - 1) + i;
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    const next = index + 1;
    units.push({
      start: dayFromYmd(year, month, 1),
      end: dayFromYmd(Math.floor(next / 12), (next % 12) + 1, 1) - 1,
      label: `${month}月`,
      tip: `${year}年 ${month}月`,
      group: { year, month },
    });
  }
  return { units, groups: groupUnits(units, (u) => u.group.year, (u) => `${u.group.year}年`) };
}

class TimeScale {
  constructor(scale, timeline) {
    this.scale = scale;
    this.cellW = SCALES[scale].cellW;
    const { units, groups } = buildUnits(scale, timeline);
    this.units = units;
    this.groups = groups;
    this.width = units.length * this.cellW;
    this.first = units[0].start;
    this.last = units[units.length - 1].end;
  }

  // 日序所在的格子索引；不在範圍內回傳 -1
  indexOfDay(day) {
    if (day < this.first || day > this.last) return -1;
    let lo = 0;
    let hi = this.units.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.units[mid].start <= day) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  // 某一天「開始時」的 x 位置；範圍外的夾到兩端
  xOfDay(day) {
    if (day <= this.first) return 0;
    if (day > this.last) return this.width;
    const i = this.indexOfDay(day);
    const u = this.units[i];
    return (i + (day - u.start) / (u.end - u.start + 1)) * this.cellW;
  }

  // [start, end] 這段日子在列上的位置；完全落在範圍外回傳 null
  span(start, end) {
    if (end < this.first || start > this.last) return null;
    const left = this.xOfDay(start);
    return { left, width: Math.max(2, this.xOfDay(end + 1) - left) };
  }

  indexAtX(x) {
    return Math.min(this.units.length - 1, Math.max(0, Math.floor(x / this.cellW)));
  }
}
