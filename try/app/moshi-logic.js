// site/app/moshi-logic.js : 模試の計算（教室長アプリの画面と偽APIで使う）
// Logic.gs の「模試の計算」の区切りを1文字も変えずに写したもの。直すときは Logic.gs を直してから写し直す
// （tests/moshi-copy.test.js が、2つの区切りの中身が同じかを確かめる）

// ==== 模試の計算 ここから ====
// 模試の案内（依頼-009）の計算。Googleのサービスも、この区切りの外の関数も使わない
// （site/app/moshi-logic.js に1文字も変えずに写して、教室長アプリの画面と偽APIでも使う）。
// 日付は 'YYYY-MM-DD' の文字（日付キー）、時刻は 'HH:MM' で比べる。名前は全部 _ で終わる（Webアプリから呼べないように）

var MOSHI_ID_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
var MOSHI_ID_LEN = 12;
var MOSHI_CLASS_CODES = ['A', 'B', 'C', 'D', 'T'];
var MOSHI_NAME_MAX = 40;
var MOSHI_WEEK = '日月火水木金土';
var MOSHI_TIME_OPTIONS = (function () {
  var out = [];
  for (var m = 9 * 60; m <= 17 * 60; m += 30) {
    var h = Math.floor(m / 60);
    var mm = m % 60;
    out.push((h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm);
  }
  return out;
})();

// 案内番号：'M'＋教室コード＋12文字（ハイフンなし。教材の申込番号「A-」と取り違えないように）
function makeMoshiId_(classCode, rand) {
  var s = '';
  for (var i = 0; i < MOSHI_ID_LEN; i++) {
    var idx = Math.floor(rand() * MOSHI_ID_CHARS.length);
    if (idx >= MOSHI_ID_CHARS.length) idx = MOSHI_ID_CHARS.length - 1;
    if (idx < 0) idx = 0;
    s += MOSHI_ID_CHARS.charAt(idx);
  }
  return 'M' + classCode + s;
}

// 全角の英数字を半角に
function moshiHalfWidth_(s) {
  return String(s).replace(/[！-～]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); });
}

// URLの id やコピーした文から案内番号を拾う（前後の「）」・空白・文は無視）。{id, classCode} か null
function parseMoshiId_(raw) {
  if (raw === null || raw === undefined || typeof raw === 'object') return null;
  var s = moshiHalfWidth_(raw);
  var re = /M([ABCDT])([abcdefghjkmnpqrstuvwxyz23456789]{12})(?![abcdefghjkmnpqrstuvwxyz23456789])/i;
  var m = re.exec(s);
  if (!m) return null;
  var code = m[1].toUpperCase();
  if (MOSHI_CLASS_CODES.indexOf(code) < 0) return null;
  return { id: 'M' + code + m[2].toLowerCase(), classCode: code };
}

// 名前をくらべる形にする：全角半角をそろえる（NFKC）→ 空白を全部取る → カタカナをひらがなに
function normalizeName_(s) {
  var t = String(s === null || s === undefined ? '' : s);
  if (typeof t.normalize === 'function') t = t.normalize('NFKC');
  t = t.replace(/[\s　]+/g, '');
  return t.replace(/[ァ-ヶ]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0x60); });
}

// 名前の後ろの「（2）」「(2)」（同じ名前の見分けの印）を取る
function stripNameMark_(name) {
  return String(name === null || name === undefined ? '' : name).replace(/[\s　]*[（(][0-9０-９]+[）)][\s　]*$/, '');
}

// 打った名前を生徒の名前の並びと合わせる。1人だけ合えば one（name はその子の名前のまま）、0人は none、2人以上は many
function matchStudent_(typed, names) {
  var want = normalizeName_(typed);
  if (want === '') return { kind: 'none', name: '' };
  var hits = [];
  for (var i = 0; i < (names || []).length; i++) {
    if (normalizeName_(stripNameMark_(names[i])) === want) hits.push(names[i]);
  }
  if (hits.length === 1) return { kind: 'one', name: hits[0] };
  return { kind: hits.length ? 'many' : 'none', name: '' };
}

// 2つの文字の編集距離（1文字ずつ足す・消す・替えるの数）
function moshiEditDistance_(a, b) {
  var prev = [];
  for (var j = 0; j <= b.length; j++) prev.push(j);
  for (var i = 1; i <= a.length; i++) {
    var cur = [i];
    for (var k = 1; k <= b.length; k++) {
      var cost = a.charAt(i - 1) === b.charAt(k - 1) ? 0 : 1;
      cur.push(Math.min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + cost));
    }
    prev = cur;
  }
  return prev[b.length];
}

// 打った名前に近い順の名前（limit 人まで。同じ近さなら元の順）
function rankByCloseness_(typed, names, limit) {
  var want = normalizeName_(typed);
  var list = (names || []).map(function (n, i) {
    return { name: n, i: i, d: moshiEditDistance_(want, normalizeName_(stripNameMark_(n))) };
  });
  list.sort(function (x, y) { return x.d !== y.d ? x.d - y.d : x.i - y.i; });
  return list.slice(0, limit).map(function (x) { return x.name; });
}

// 前の回の名前から次の回の名前の候補：「第N回」は N+1、「M月号」は M+1（12→1）。数字は全角でも読み、半角で書く
function nextRoundName_(name) {
  var s = String(name === null || name === undefined ? '' : name);
  s = s.replace(/第([0-9０-９]+)回/, function (all, n) { return '第' + (Number(moshiHalfWidth_(n)) + 1) + '回'; });
  s = s.replace(/([0-9０-９]+)月号/, function (all, n) {
    var m = Number(moshiHalfWidth_(n));
    return (m >= 12 ? 1 : m + 1) + '月号';
  });
  return s;
}

// 学年から「対象」の文字：中学の学年だけなら「中学1・2年生」、ほかが混ざれば「・」でつなぐ
function moshiTargetText_(grades) {
  var list = grades || [];
  var nums = [];
  var allChu = list.length > 0;
  for (var i = 0; i < list.length; i++) {
    var g = moshiHalfWidth_(String(list[i]).trim());
    var m = /^中(?:学)?([1-3])(?:年)?(?:生)?$/.exec(g);
    if (!m) { allChu = false; break; }
    if (nums.indexOf(m[1]) < 0) nums.push(m[1]);
  }
  if (allChu) return '中学' + nums.sort().join('・') + '年生';
  return list.map(function (x) { return String(x).trim(); }).join('・');
}

// 'YYYY-MM-DD' → Date（0時）。形がちがう・ない日なら null
function moshiKeyDate_(key) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key === null || key === undefined ? '' : key));
  if (!m) return null;
  var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  var date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date;
}

// Date → 'YYYY-MM-DD'（年月日だけ）
function moshiDateKey_(d) {
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// 日付キーに n 日足す
function moshiAddDays_(key, n) {
  var d = moshiKeyDate_(key);
  if (!d) return '';
  return moshiDateKey_(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
}

// '2026-09-19' → '9月19日（土）'
function moshiDayLabel_(key) {
  var d = moshiKeyDate_(key);
  if (!d) return '';
  return (d.getMonth() + 1) + '月' + d.getDate() + '日（' + MOSHI_WEEK.charAt(d.getDay()) + '）';
}

// '2026-09-19' → '9/19（土）'
function moshiShortLabel_(key) {
  var d = moshiKeyDate_(key);
  if (!d) return '';
  return (d.getMonth() + 1) + '/' + d.getDate() + '（' + MOSHI_WEEK.charAt(d.getDay()) + '）';
}

// 送る文と保護者の画面の「日時」。時刻がみな同じなら最後に1回、2つは「（どちらか1日）」、3つは「（いずれか1日）」
function moshiDatesText_(dates) {
  var list = dates || [];
  if (!list.length) return '';
  var at = function (t) { return t ? t + '〜' : ''; };
  var same = true;
  for (var i = 1; i < list.length; i++) if (list[i].time !== list[0].time) same = false;
  var text;
  if (same) {
    text = list.map(function (x) { return moshiDayLabel_(x.key); }).join('・') + at(list[0].time);
  } else {
    text = list.map(function (x) { return moshiDayLabel_(x.key) + at(x.time); }).join('・');
  }
  if (list.length === 2) text += '（どちらか1日）';
  if (list.length >= 3) text += '（いずれか1日）';
  return text;
}

// 受験日の候補：明日から days 日先までの土・日・祝日（isHoliday は Date を受ける）
function moshiExamDayOptions_(todayKey, days, isHoliday) {
  var out = [];
  var base = moshiKeyDate_(todayKey);
  if (!base) return out;
  for (var i = 1; i <= days; i++) {
    var d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
    if (d.getDay() === 0 || d.getDay() === 6 || (isHoliday && isHoliday(d))) out.push(moshiDateKey_(d));
  }
  return out;
}

// 締切の候補：今日から最初の受験日まで（最初の受験日が空なら今日から60日）
function moshiDeadlineOptions_(todayKey, firstExamKey) {
  var out = [];
  if (!moshiKeyDate_(todayKey)) return out;
  var last = moshiKeyDate_(firstExamKey) ? firstExamKey : moshiAddDays_(todayKey, 60);
  for (var k = todayKey; k <= last; k = moshiAddDays_(k, 1)) out.push(k);
  return out;
}

// 今月から n か月の「11月末」「11月中旬」
function moshiMonthOptions_(todayKey, n, suffix) {
  var out = [];
  var base = moshiKeyDate_(todayKey);
  if (!base) return out;
  for (var i = 0; i < n; i++) out.push(((base.getMonth() + i) % 12 + 1) + '月' + suffix);
  return out;
}

// ---- 申込の確かめ・生徒ごとの状態・一覧の色 ----

var MOSHI_ANSWERS = ['受験', '未定', '辞退'];
var MOSHI_RECOMMEND_KEYS = ['強くお勧め', 'ご検討の上'];
// 日を相談したいとき：ご希望の受け方・日時の決め方・ご希望の日時（「書く」のときだけ）
var MOSHI_WAYS = ['別の日', '分けて', '自宅'];
var MOSHI_DECIDES = ['書く', '教室で相談'];
var MOSHI_WISH_MAX = 100;

// 教室長の一覧に出す1行：「別の日／希望：12月20日（日）の午後」「分けて受ける／教室で本人と相談」
function moshiWishLine_(way, decide, wish) {
  var w = way === '別の日' ? '別の日' : way === '分けて' ? '分けて受ける' : way === '自宅' ? '自宅で受ける' : '';
  var d = decide === '書く' ? (wish ? '希望：' + wish : '') : decide === '教室で相談' ? '教室で本人と相談' : '';
  return [w, d].filter(function (x) { return x !== ''; }).join('／');
}

// 保護者の申込を確かめる。p {name, answer, dateKey, way, decide, wish}、dateKeys はその案内の受験日。{ok, error, value}
// （value の way・decide・wish は未定のときだけ。ほかは ''）
function checkMoshiSubmit_(p, dateKeys) {
  var bad = function (msg) { return { ok: false, error: msg, value: null }; };
  p = p && typeof p === 'object' ? p : {};
  var name = typeof p.name === 'string' ? p.name.replace(/^[\s　]+|[\s　]+$/g, '') : '';
  if (name === '') return bad('生徒のお名前を入力してください');
  if (name.length > MOSHI_NAME_MAX) return bad('お名前は40文字までです');
  var pick = '受験する日か、「日を相談したい」「辞退する」を選んでください';
  var answer = p.answer;
  var dateKey = '';
  if (answer === '受験') {
    if (typeof p.dateKey !== 'string' || (dateKeys || []).indexOf(p.dateKey) < 0) return bad(pick);
    dateKey = p.dateKey;
  } else if (answer !== '未定' && answer !== '辞退') {
    return bad(pick);
  }
  // 日を相談したいときだけ、受け方（way）・日時の決め方（decide）・ご希望の日時（wish。「書く」のときだけ 1〜100文字）を受け取る。
  // ほかの答えでは捨てる
  var way = '', decide = '', wish = '';
  if (answer === '未定') {
    way = p.way;
    if (MOSHI_WAYS.indexOf(way) < 0) return bad('ご希望の受け方を選んでください');
    decide = p.decide;
    if (MOSHI_DECIDES.indexOf(decide) < 0) return bad('日時の決め方を選んでください');
    if (decide === '書く') {
      wish = typeof p.wish === 'string' ? p.wish.replace(/^[\s　]+|[\s　]+$/g, '') : '';
      if (wish === '') return bad('ご希望の日時をご記入ください');
      if (wish.length > MOSHI_WISH_MAX) return bad('ご希望の日時は100文字までです');
    }
  }
  return { ok: true, error: null, value: { name: name, answer: answer, dateKey: dateKey, way: way, decide: decide, wish: wish } };
}

// 1人の子の申込の並び（保護者・教室長）から今の状態を決める。
// 教室長の行があれば、いちばん新しい教室長の行が答え（そのあとに保護者の違う内容が来たら「後から違う内容が来た」）。
// なければ、いちばん新しい保護者の行（保護者の行どうしで違えば「2回来て中身が違う」、受験日のあとに届いたら「受験日のあとに届いた」）
function moshiStudentState_(subs, lastExamKey) {
  var list = (subs || []).map(function (s, i) { return { s: s, i: i }; });
  list.sort(function (x, y) {
    var a = Number(x.s.at) || 0, b = Number(y.s.at) || 0;
    return a !== b ? a - b : x.i - y.i;
  });
  var out = { answer: '', dateKey: '', by: '', count: 0, check: '' };
  var lastStaff = -1;
  var lastParent = -1;
  for (var i = 0; i < list.length; i++) {
    if (list[i].s.who === '教室長') lastStaff = i;
    else { lastParent = i; out.count += 1; }
  }
  var same = function (a, b) { return a.answer === b.answer && (a.dateKey || '') === (b.dateKey || ''); };
  if (lastStaff >= 0) {
    var st = list[lastStaff].s;
    out.answer = st.answer; out.dateKey = st.dateKey || ''; out.by = '教室長';
    for (var j = lastStaff + 1; j < list.length; j++) {
      if (list[j].s.who !== '教室長' && !same(list[j].s, st)) out.check = '後から違う内容が来た';
    }
    return out;
  }
  if (lastParent < 0) return out;
  var p = list[lastParent].s;
  out.answer = p.answer; out.dateKey = p.dateKey || ''; out.by = '保護者';
  for (var k = 0; k < list.length; k++) {
    if (!same(list[k].s, p)) { out.check = '2回来て中身が違う'; return out; }
  }
  if (lastExamKey && p.atKey && p.atKey > lastExamKey) out.check = '受験日のあとに届いた';
  return out;
}

// 一覧の1行の見え方。f {metis, noBill, cleaned}、g {cancelled, deadlinePassed}。{label, color, next, done}
function moshiRowView_(st, f, g) {
  st = st || {};
  f = f || {};
  g = g || {};
  var a = st.answer || '';
  var label = a === '受験' ? '受験 ' + moshiShortLabel_(st.dateKey) : a === '未定' ? '日が未定' : a === '辞退' ? '辞退' : '未提出';
  var billLeft = f.metis === true && f.cleaned !== true;
  var color, next;
  if (g.cancelled) {
    if (billLeft) { color = 'red'; next = 'METISの請求を消す'; } else { color = 'gray'; next = '取り消し'; }
  } else if (st.check) { color = 'yellow'; next = '確かめて（' + st.check + '）'; }
  else if (a === '辞退' && billLeft) { color = 'red'; next = 'METISの請求を消す'; }
  else if ((a === '受験' || a === '未定') && f.metis !== true && f.noBill !== true) { color = 'red'; next = 'METISで請求を作る'; }
  else if (a === '未定') { color = 'blue'; next = '日を入れる'; }
  else if (a === '受験') { color = 'green'; next = '済み'; }
  else if (a === '辞退') { color = 'gray'; next = '辞退'; }
  else if (g.deadlinePassed) { color = 'red'; next = '未提出（締切すぎ）'; }
  else { color = 'none'; next = '返事待ち'; }
  return { label: label, color: color, next: next, done: color === 'green' || color === 'gray' };
}

// 1つの案内のまとめ。rows は対象の子 [{grade, st, view, ...}]、unmatched は名前が合わない申込の数
function moshiGuideView_(g, rows, unmatched, todayKey) {
  g = g || {};
  rows = rows || [];
  var out = { submitted: 0, total: rows.length, byGrade: [], checks: Number(unmatched) || 0,
    unbilled: 0, cleanup: 0, lateUnsubmitted: 0, finished: false };
  var at = {};
  var addGrade = function (grade) {
    if (!(grade in at)) { at[grade] = out.byGrade.length; out.byGrade.push({ grade: grade, submitted: 0, total: 0 }); }
    return out.byGrade[at[grade]];
  };
  for (var i = 0; i < (g.grades || []).length; i++) addGrade(g.grades[i]);
  var undecided = 0; // 青（日を入れる）の子。残っていたら終わった回にしない
  for (var j = 0; j < rows.length; j++) {
    var r = rows[j];
    var b = addGrade(r.grade);
    b.total += 1;
    var view = r.view || {};
    if (r.st && r.st.answer) { out.submitted += 1; b.submitted += 1; }
    if (view.color === 'yellow') out.checks += 1;
    if (view.next === 'METISで請求を作る') out.unbilled += 1;
    if (view.next === 'METISの請求を消す') out.cleanup += 1;
    if (view.next === '未提出（締切すぎ）') out.lateUnsubmitted += 1;
    if (view.color === 'blue') undecided += 1;
  }
  if (g.cancelled) out.finished = out.cleanup === 0;
  else out.finished = !!g.lastExamKey && !!todayKey && todayKey > g.lastExamKey &&
    out.checks === 0 && out.unbilled === 0 && out.cleanup === 0 && undecided === 0;
  return out;
}

// ---- 案内を作る ----

// 文字の欄を確かめる（前後の空白を取る）。{v} か {error}
function moshiField_(v, min, max, emptyMsg, longMsg) {
  var s = typeof v === 'string' ? v.replace(/^[\s　]+|[\s　]+$/g, '') : (typeof v === 'number' ? String(v) : '');
  if (s.length < min) return { error: emptyMsg };
  if (s.length > max) return { error: longMsg };
  return { v: s };
}

// 教室長が作る案内を確かめる。grades は今の生徒一覧の学年。{ok, error, value}（value の dates は日付順）
function checkMoshiDraft_(d, grades, todayKey) {
  var bad = function (msg) { return { ok: false, error: msg, value: null }; };
  if (!d || typeof d !== 'object') return bad('badrequest');
  var name = moshiField_(d.name, 1, 60, '回の名前を入れてください', '回の名前は60文字までです');
  if (name.error) return bad(name.error);
  if (!Array.isArray(d.grades) || d.grades.length === 0) return bad('学年を1つ以上選んでください');
  var gs = [];
  for (var i = 0; i < d.grades.length; i++) {
    var gr = typeof d.grades[i] === 'string' ? d.grades[i].trim() : '';
    if ((grades || []).indexOf(gr) < 0) return bad('生徒一覧にない学年があります');
    if (gs.indexOf(gr) < 0) gs.push(gr);
  }
  var target = moshiField_(d.targetText, 1, 60, '対象の文字を入れてください', '対象の文字は60文字までです');
  if (target.error) return bad(target.error);
  var venue = moshiField_(d.venue, 1, 60, '会場を入れてください', '会場は60文字までです');
  if (venue.error) return bad(venue.error);
  if (!Array.isArray(d.dates) || d.dates.length === 0) return bad('受験日を1つ以上選んでください');
  if (d.dates.length > 3) return bad('受験日は3つまでです');
  var dates = [];
  for (var j = 0; j < d.dates.length; j++) {
    var x = d.dates[j] && typeof d.dates[j] === 'object' ? d.dates[j] : {};
    if (!x.key) return bad('受験日を選んでください');
    if (!moshiKeyDate_(x.key)) return bad('受験日が正しくありません');
    if (x.key < todayKey) return bad('受験日は今日から先の日にしてください');
    if (MOSHI_TIME_OPTIONS.indexOf(x.time) < 0) return bad('受験の時刻を選んでください');
    for (var k = 0; k < dates.length; k++) if (dates[k].key === x.key) return bad('同じ受験日が2つあります');
    dates.push({ key: x.key, time: x.time });
  }
  dates.sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });
  var feeRaw = typeof d.fee === 'string' ? d.fee.replace(/[,，\s円]/g, '') : d.fee;
  var fee = typeof feeRaw === 'string' && /^\d+$/.test(feeRaw) ? Number(feeRaw) : feeRaw;
  if (typeof fee !== 'number' || !isFinite(fee) || Math.floor(fee) !== fee || fee < 0 || fee > 100000) {
    return bad('受験料は0〜100,000円の数で入れてください');
  }
  var withdraw = moshiField_(d.withdraw, 1, 20, '引き落としの月を選んでください', '引き落としは20文字までです');
  if (withdraw.error) return bad(withdraw.error);
  var ret = moshiField_(d.ret, 1, 20, '返却の時期を選んでください', '返却は20文字までです');
  if (ret.error) return bad(ret.error);
  var dl = typeof d.deadlineKey === 'string' ? d.deadlineKey : '';
  if (!moshiKeyDate_(dl) || dl < todayKey || dl > dates[0].key) return bad('締切は今日から最初の受験日までの日にしてください');
  if (MOSHI_RECOMMEND_KEYS.indexOf(d.recommend) < 0) return bad('すすめの一文を選んでください');
  var range = typeof d.range === 'string' ? d.range : '';
  if (range.length > 500) return bad('範囲は500文字までです');
  var timetable = typeof d.timetable === 'string' ? d.timetable : '';
  if (timetable.length > 1000) return bad('時間割は1000文字までです');
  var copyFrom = parseMoshiId_(typeof d.copyFrom === 'string' ? d.copyFrom : '');
  return { ok: true, error: null, value: {
    copyFrom: copyFrom ? copyFrom.id : '', name: name.v, grades: gs, targetText: target.v, venue: venue.v,
    dates: dates, fee: fee, withdraw: withdraw.v, ret: ret.v, deadlineKey: dl, recommend: d.recommend,
    range: range, timetable: timetable
  } };
}

// 前の回を写した下書き。日・締切・引落・返却は空（古い日のまま送らないように選び直す）。venue は今の教室名
function copyMoshiDraft_(prev, venue) {
  prev = prev || {};
  return {
    copyFrom: prev.id || '',
    name: nextRoundName_(prev.name || ''),
    grades: (prev.grades || []).slice(),
    targetText: prev.targetText || '',
    venue: venue || prev.venue || '',
    dates: (prev.dates || []).map(function (x) { return { key: '', time: x.time || '' }; }),
    fee: prev.fee,
    withdraw: '',
    ret: '',
    deadlineKey: '',
    recommend: prev.recommend || '',
    range: prev.range || '',
    timetable: prev.timetable || ''
  };
}

// 2200 → '2,200円'
function moshiYen_(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '円';
}

// 送る文の印に入れる値。g は案内（{name, targetText, venue, dates, fee, withdraw, deadlineKey}）
function moshiMessageVals_(g, recommendText, url) {
  g = g || {};
  return {
    '{回}': g.name || '',
    '{対象}': g.targetText || '',
    '{会場}': g.venue || '',
    '{日時}': moshiDatesText_(g.dates),
    '{受験料}': moshiYen_(g.fee),
    '{引落}': g.withdraw || '',
    '{締切}': moshiDayLabel_(g.deadlineKey),
    '{すすめ}': recommendText || '',
    '{リンク}': url || ''
  };
}

// {回} などの印を置きかえて、改行でつなぐ（buildMessage と同じ動き）
function buildMoshiMessage_(lines, vals) {
  return (lines || []).map(function (line) {
    for (var k in vals) line = String(line).split(k).join(vals[k]);
    return line;
  }).join('\n');
}

// 短い時間の連続送信を止める。windowMs より古い時刻を捨て、残りが limit 未満なら nowMs を足して ok
function moshiRateOk_(times, nowMs, limit, windowMs) {
  var kept = [];
  if (Array.isArray(times)) {
    for (var i = 0; i < times.length; i++) {
      var t = Number(times[i]);
      if (isFinite(t) && nowMs - t < windowMs) kept.push(t);
    }
  }
  if (kept.length >= limit) return { ok: false, times: kept };
  kept.push(nowMs);
  return { ok: true, times: kept };
}
// ==== 模試の計算 ここまで ====
