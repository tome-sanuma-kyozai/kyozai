// site/app/moshi-mock.js : 模試の偽API（教室長アプリを ?mock=1 で開いたときだけ読む。依頼-009 Task 7）
// MoshiApi.gs の教室長の op（moshiList・moshiCreate・moshiText・moshiCancel・moshiSent・moshiBatch・moshiMatch・moshiAddStudent）と
// 同じ形を返す。計算は moshi-logic.js（Logic.gs の写し）の関数を使う。生徒は架空の生徒だけ（本物の名前・表のIDは置かない）。
//
// MoshiMock.create({studentsOf(cls) → [{name, grade}] | null, className(cls) → string, today: Date,
//                   storage: {getItem, setItem}（localStorage。使えなければ null）, isHoliday?(Date) → boolean}) → {handle(body)}
//   handle(body)：body は {api:'staff', op, cls, args, clientKey}。{ok:true, data} ／ {ok:false, error}
//
// 保護者の偽の画面（site/moshi/index.html）とは localStorage 'moshiMock:v1' でつながる（形はそのファイルの先頭のコメント）。
//   ここは guides（保護者の画面に出す案内）を書き、subs（保護者が送った申込）を op のたびに読み直して申込に入れる
//   （名前は matchStudent_ で合わせる。subs は書きかえない）。
(function () {
  'use strict';

  var STORE_KEY = 'moshiMock:v1';
  var OPEN = '受付中';
  var CANCEL = '取り消し';
  var HOW_AUTO = '自動', HOW_STAFF = '教室長', HOW_NONE = 'どの子でもない';
  var WHO_PARENT = '保護者', WHO_STAFF = '教室長';
  var WRITE_OPS = ['moshiCreate', 'moshiCancel', 'moshiSent', 'moshiBatch', 'moshiMatch', 'moshiAddStudent'];
  var MSG_NO_CLASS = 'この教室は開けません';
  var MSG_NOT_FOUND = '案内が見つかりません';
  var MSG_NOT_STUDENT = '生徒一覧にいない生徒です';
  var MSG_NO_SHEET = '模試のシートがまだありません。本人に知らせてください';
  // Settings.gs の MOSHI_SEND_LINES・MOSHI_RECOMMEND と同じ（本物は設定シートの文を使う）
  var SEND_LINES = [
    '保護者の皆様・生徒の皆さんへ', '「{回}」のご案内です。', '',
    '■対象：{対象}', '■日時：{日時}', '■会場：{会場}', '■受験料：{受験料}（{引落}に引き落とし）', '■締切：{締切}', '',
    '{すすめ}', '',
    '▼お申し込み（おうちの方が入力してください）', '{リンク}', '受験しない場合も「辞退する」で送ってください。', '',
    '※生徒の皆さんは、このメッセージをおうちの方に見せてください。',
    'ご不明な点は、このメッセージでお問い合わせください。'
  ];
  var RECOMMEND = {
    '強くお勧め': '県内でいちばん信頼される模試です。原則、受験をお願いします。',
    'ご検討の上': '県内でいちばん信頼される模試です。ぜひご検討ください。'
  };
  var TIMETABLE = '14:00 受付\n14:10 英語（50分）\n15:10 数学（50分）\n16:10 社会（50分）\n17:10 国語（50分）\n18:10 理科（50分）\n19:00 自己採点（30分・希望者のみ）';

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function isDate(v) { return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime()); }
  // Apps Script の dateLabel_ と同じ形（'M月d日 H:mm'・'M月d日'）
  function atLabel(d) { return isDate(d) ? (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + d.getHours() + ':' + pad2(d.getMinutes()) : ''; }
  function dayOnly(d) { return isDate(d) ? (d.getMonth() + 1) + '月' + d.getDate() + '日' : ''; }
  // MoshiApi.gs の moshiAnswerLabel_ と同じ
  function answerLabel(answer, dateKey) {
    if (answer === '受験') return '受験する ' + moshiDayLabel_(dateKey);
    if (answer === '未定') return '日を相談したい';
    if (answer === '辞退') return '辞退する';
    return '';
  }
  function datesOut(dates) {
    return (dates || []).map(function (d) { return { key: d.key, time: d.time, label: moshiDayLabel_(d.key), short: moshiShortLabel_(d.key) }; });
  }
  function dupNames(names) {
    var count = {}, out = [];
    names.forEach(function (n) { count[n] = (count[n] || 0) + 1; if (count[n] === 2) out.push(n); });
    return out;
  }

  function create(o) {
    var today = o.today ? new Date(o.today.getFullYear(), o.today.getMonth(), o.today.getDate()) : new Date();
    var todayKey = moshiDateKey_(today);
    var storage = o.storage || null;
    var isHoliday = o.isHoliday || function () { return false; };
    var seed = 20261121;
    var rand = function () { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    var cache = {};
    var seenSubs = {};
    var nextRow = 2;
    var seeding = true;
    // 教室ごとの模試のデータ（表の3つのシートのかわり）。B は「まだ模試のシートがない」教室の見え方用
    var classes = { A: { ready: true, guides: [], targets: [], subs: [] }, B: { ready: false, guides: [], targets: [], subs: [] } };

    function keyAdd(n) { return moshiAddDays_(todayKey, n); }
    // 今日から n 日先の日か、その後の最初の土曜（受験日は土曜にする）。plus 週あと
    function sat(n, plus) {
      var d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + n);
      while (d.getDay() !== 6) d.setDate(d.getDate() + 1);
      return moshiAddDays_(moshiDateKey_(d), 7 * (plus || 0));
    }
    function dayAt(n, hh, mm) { return new Date(today.getFullYear(), today.getMonth(), today.getDate() + n, hh === undefined ? 10 : hh, mm || 0); }
    function urlOf(id) {
      try { return new URL('../moshi/?mock=1&id=' + id, location.href).href; } catch (e) { return '../moshi/?mock=1&id=' + id; }
    }
    function newId(cls) {
      var id;
      // はじめの架空の案内は毎回同じ番号（開き直しても保護者の偽の画面で送った分がつながる）、あとで作った案内はでたらめ
      do { id = makeMoshiId_(cls, seeding ? rand : Math.random); } while (findGuideAny(id));
      return id;
    }
    function findGuideAny(id) {
      for (var k in classes) for (var i = 0; i < classes[k].guides.length; i++) if (classes[k].guides[i].id === id) return { g: classes[k].guides[i], code: k };
      return null;
    }
    function targetsOf(c, id) { return c.targets.filter(function (t) { return t.id === id; }); }
    function subsOf(c, id) { return c.subs.filter(function (s) { return s.id === id; }); }
    function addGuide(c, cls, v, createdAt, status) {
      var g = { row: nextRow++, id: newId(cls), name: v.name, grades: v.grades.slice(), targetText: v.targetText, venue: v.venue,
        dates: v.dates.map(function (d) { return { key: d.key, time: d.time }; }), fee: v.fee, withdraw: v.withdraw, ret: v.ret,
        deadlineKey: v.deadlineKey, recommend: v.recommend, range: v.range, timetable: v.timetable, createdAt: createdAt,
        status: status || OPEN, sentGrades: [], copyFrom: v.copyFrom || '' };
      c.guides.push(g);
      return g;
    }
    function addTarget(c, id, student, grade, flags, addedAt) {
      flags = flags || {};
      var t = { row: nextRow++, id: id, student: student, grade: grade, metis: !!flags.metis, noBill: !!flags.noBill,
        cleaned: !!flags.cleaned, memo: flags.memo || '', addedAt: addedAt || '' };
      c.targets.push(t);
      return t;
    }
    function addSub(c, s) {
      var at = isDate(s.at) ? s.at : new Date();
      var sub = { row: nextRow++, id: s.id, typed: s.typed, matched: s.matched, how: s.how, answer: s.answer,
        dateKey: s.answer === '受験' ? s.dateKey : '', at: at, atKey: moshiDateKey_(at), who: s.who,
        way: '', decide: '', wish: '' };
      if (s.answer === '未定' && s.who === WHO_PARENT && s.wish && typeof s.wish === 'object') {
        sub.way = s.wish.way || ''; sub.decide = s.wish.decide || ''; sub.wish = s.wish.wish || '';
      }
      c.subs.push(sub);
      return sub;
    }
    // wish：日を相談したいときの {way, decide, wish}（なければ空）
    function parentSub(c, g, typed, answer, dateKey, at, wish) {
      var names = targetsOf(c, g.id).map(function (t) { return t.student; });
      var m = matchStudent_(typed, names);
      return addSub(c, { id: g.id, typed: typed, matched: m.kind === 'one' ? m.name : '', how: m.kind === 'one' ? HOW_AUTO : '',
        answer: answer, dateKey: dateKey, at: at, who: WHO_PARENT, wish: wish || null });
    }
    function studentsFor(cls) {
      var list = o.studentsOf ? o.studentsOf(cls) : null;
      return Array.isArray(list) ? list : null;
    }
    // 案内を作った時の学年の子で対象を固める（MoshiSheets.gs の createMoshiGuide_ と同じ）。同じ名前の子は印なしでは作れない
    function pickTargets(cls, grades, skipDup) {
      var out = [];
      (studentsFor(cls) || []).forEach(function (s) {
        var name = String(s.name || '').trim(), grade = String(s.grade || '').trim();
        if (name !== '' && grades.indexOf(grade) >= 0) out.push({ name: name, grade: grade });
      });
      if (skipDup) {
        var d = dupNames(out.map(function (x) { return x.name; }));
        out = out.filter(function (x) { return d.indexOf(x.name) < 0; });
      }
      return out;
    }

    // ---- はじめの架空の案内（今日から数えた日付）----
    (function seedA() {
      var c = classes.A;
      var base = { venue: (o.className && o.className('A')) || '架空教室', fee: 4200, recommend: '強くお勧め',
        range: '中学1年〜3年の既習範囲すべて', timetable: TIMETABLE };
      var ext = function (x) { var v = {}; for (var k in base) v[k] = base[k]; for (var j in x) v[j] = x[j]; return v; };
      var mon = function (n, suf) { var d = new Date(today.getFullYear(), today.getMonth() + n, 1); return (d.getMonth() + 1) + '月' + suf; };

      // 終わった回：受験日は先月、全員 METIS ☑（ふだんは隠れる）
      var done = addGuide(c, 'A', ext({ name: '新・みやぎ模試・第3回9月号', grades: ['中学3年'], targetText: '中学3年生',
        dates: [{ key: sat(-40), time: '14:00' }, { key: sat(-40, 1), time: '14:00' }], withdraw: mon(-1, '末'), ret: mon(0, '中旬'),
        deadlineKey: keyAdd(-47) }), dayAt(-55), OPEN);
      done.sentGrades = ['中学3年'];
      pickTargets('A', ['中学3年'], true).forEach(function (s, i) {
        addTarget(c, done.id, s.name, s.grade, { metis: true });
        parentSub(c, done, s.name, '受験', i % 2 ? done.dates[1].key : done.dates[0].key, dayAt(-50 + i, 20, 10));
      });

      // 取り消した回：日をまちがえて取り消し。METIS ☑ の子が1人いて、まだ請求を消していない（赤）
      var cancelled = addGuide(c, 'A', ext({ name: '新・みやぎ模試・第4回10月号', grades: ['中学3年'], targetText: '中学3年生',
        dates: [{ key: sat(4), time: '14:00' }, { key: sat(4, 1), time: '14:00' }], withdraw: mon(1, '末'), ret: mon(1, '中旬'),
        deadlineKey: keyAdd(-2), copyFrom: done.id }), dayAt(-14), CANCEL);
      pickTargets('A', ['中学3年'], true).forEach(function (s, i) {
        addTarget(c, cancelled.id, s.name, s.grade, { metis: i === 0 });
        if (i === 0) parentSub(c, cancelled, s.name, '受験', cancelled.dates[0].key, dayAt(-13, 21, 0));
      });

      // 春休み号（中1・中2、対象の文字は手で直した「新中学2・3年生」）：半分だけ申込
      var spring = addGuide(c, 'A', ext({ name: '新・みやぎ模試・春休み号', grades: ['中学1年', '中学2年'], targetText: '新中学2・3年生',
        dates: [{ key: sat(14), time: '13:00' }, { key: sat(14, 1), time: '13:00' }], withdraw: mon(1, '末'), ret: mon(2, '中旬'),
        deadlineKey: keyAdd(7), recommend: 'ご検討の上', range: '中学1年・2年の既習範囲すべて' }), dayAt(-6), OPEN);
      spring.sentGrades = ['中学1年'];
      var st = pickTargets('A', ['中学1年', '中学2年'], true); // 同じ名前の子（生徒G）は、作った時はまだいなかった形
      st.forEach(function (s) { addTarget(c, spring.id, s.name, s.grade, { metis: s.name === '生徒A' }); });
      parentSub(c, spring, '生徒A', '未定', '', dayAt(-5, 19, 30), { way: '別の日', decide: '書く', wish: '12月19日（土）14時から' });                       // 日を相談・METIS ☑（青）
      parentSub(c, spring, '生徒 B', '辞退', '', dayAt(-4, 20, 45));                      // 辞退（灰）。空白入りでも合う
      parentSub(c, spring, 'せいとF', '受験', spring.dates[0].key, dayAt(-3, 21, 5));    // ひらがなは合わない → 確かめて
      parentSub(c, spring, '生徒Ｆ', '受験', spring.dates[0].key, dayAt(-3, 21, 8));     // 全角は合う。受験・METIS なし（赤）

      // 第4回10月号（取り消した回を写して作り直した）：締切は昨日。行の色がひととおり出るように
      var oct = addGuide(c, 'A', ext({ name: '新・みやぎ模試・第4回10月号', grades: ['中学3年'], targetText: '中学3年生',
        dates: [{ key: sat(5), time: '14:00' }, { key: sat(5, 1), time: '14:00' }], withdraw: mon(1, '末'), ret: mon(1, '中旬'),
        deadlineKey: keyAdd(-1), copyFrom: cancelled.id }), dayAt(-12), OPEN);
      oct.sentGrades = ['中学3年'];
      pickTargets('A', ['中学3年'], true).forEach(function (s) {
        addTarget(c, oct.id, s.name, s.grade, { metis: s.name === '生徒C' || s.name === '生徒L', memo: s.name === '生徒L' ? '日は面談で決める' : '' });
      });
      parentSub(c, oct, '生徒C', '受験', oct.dates[0].key, dayAt(-11, 20, 12));          // 受験・METIS ☑（緑）
      parentSub(c, oct, '生徒C', '受験', oct.dates[0].key, dayAt(-7, 8, 0));            // 同じ内容の2回目（「2回来た」だけ。黄色にならない）
      parentSub(c, oct, '生徒K', '受験', oct.dates[1].key, dayAt(-10, 21, 40));
      parentSub(c, oct, '生徒K', '辞退', '', dayAt(-6, 22, 30));                         // 違う内容の2回目 → 確かめて（2回来て中身が違う）
      parentSub(c, oct, '生徒L', '未定', '', dayAt(-9, 19, 2), { way: '分けて', decide: '教室で相談' });                          // 日を相談・METIS ☑（青）
      parentSub(c, oct, '生徒M', '辞退', '', dayAt(-8, 18, 30));                         // 対象外（中1）の名前 → 確かめて
      parentSub(c, oct, 'せいとじぇい', '受験', oct.dates[0].key, dayAt(-2, 22, 15));    // 名前が合わない（生徒J に合わせる）。生徒J は未提出（締切すぎ・赤）
      // 同じ回の名前の受付中の案内をもう1つ（受験日を足して作り直した形）。一覧では1枚にまとめて数える。
      // 生徒C は両方にいて、こちらの方が新しい返事 → こちらの行を出す。生徒L はこちらでは未提出 → 前の案内の行を出す
      var oct2 = addGuide(c, 'A', ext({ name: '新・みやぎ模試・第4回10月号 ', grades: ['中学3年'], targetText: '中学3年生',
        dates: [{ key: sat(5, 2), time: '14:00' }], withdraw: mon(1, '末'), ret: mon(1, '中旬'),
        deadlineKey: keyAdd(2), copyFrom: oct.id }), dayAt(-4), OPEN);
      pickTargets('A', ['中学3年'], true).forEach(function (s) { addTarget(c, oct2.id, s.name, s.grade, { metis: s.name === '生徒C' }); });
      parentSub(c, oct2, '生徒C', '受験', oct2.dates[0].key, dayAt(-1, 20, 0));
      parentSub(c, oct2, 'せいとけー', '未定', '', dayAt(-1, 21, 10), { way: '自宅', decide: '書く', wish: '12月18日（金）16時以降に取りに行きます' }); // 名前が合わない・日を相談（希望つき）
    })();
    seeding = false;

    // ---- localStorage（保護者の偽の画面とつなぐ）----
    function storeRead() {
      if (!storage) return { guides: {}, subs: [] };
      try {
        var x = JSON.parse(storage.getItem(STORE_KEY) || 'null');
        if (!x || typeof x !== 'object') x = {};
        if (!x.guides || typeof x.guides !== 'object') x.guides = {};
        if (!Array.isArray(x.subs)) x.subs = [];
        return x;
      } catch (e) {
        return { guides: {}, subs: [] };
      }
    }
    function storeWrite(x) {
      if (!storage) return;
      try { storage.setItem(STORE_KEY, JSON.stringify(x)); } catch (e) { /* 書けなくても教室長の画面は動く */ }
    }
    // 保護者の画面に出す形（MoshiApi.gs の moshiApiGet_ の guide と cls）
    function parentGuide(g, cls) {
      return {
        guide: { name: g.name, targetText: g.targetText, venue: g.venue, dates: datesOut(g.dates), datesText: moshiDatesText_(g.dates),
          feeLabel: moshiYen_(g.fee), withdraw: g.withdraw, ret: g.ret, deadlineLabel: moshiDayLabel_(g.deadlineKey),
          range: g.range, timetable: g.timetable, recommendText: RECOMMEND[g.recommend] || '' },
        cls: { name: '明光義塾 ' + ((o.className && o.className(cls)) || '架空教室'), address: '（お試しの住所）', tel: '000-0000-0000' },
        status: g.status === CANCEL ? 'cancelled' : 'open'
      };
    }
    function syncStore() {
      var x = storeRead();
      // 保護者が送った分を入れる（まだ入れていない物だけ。名前は対象の子と合わせる）
      x.subs.forEach(function (s) {
        if (!s || typeof s !== 'object') return;
        var key = [s.id, s.clientKey, s.at].join('|');
        if (seenSubs[key]) return;
        var f = findGuideAny(String(s.id || ''));
        if (!f) return;
        seenSubs[key] = true;
        var chk = checkMoshiSubmit_({ name: s.name, answer: s.answer, dateKey: s.dateKey, way: s.way, decide: s.decide, wish: s.wish }, f.g.dates.map(function (d) { return d.key; }));
        if (!chk.ok) return;
        parentSub(classes[f.code], f.g, chk.value.name, chk.value.answer, chk.value.dateKey, new Date(Number(s.at) || Date.now()), { way: chk.value.way, decide: chk.value.decide, wish: chk.value.wish });
      });
      for (var k in classes) classes[k].guides.forEach(function (g) { x.guides[g.id] = parentGuide(g, k); });
      storeWrite(x);
    }

    // ---- 教室長の画面に出す形（MoshiApi.gs の moshiGuideOut_ と同じ）----
    function guideOut(c, g) {
      var cancelled = g.status === CANCEL;
      var keys = g.dates.map(function (d) { return d.key; });
      var lastExamKey = keys.length ? keys[keys.length - 1] : '';
      var deadlinePassed = !!g.deadlineKey && todayKey > g.deadlineKey;
      var targets = targetsOf(c, g.id);
      var byStudent = {}, unmatchedSubs = [];
      subsOf(c, g.id).forEach(function (s) {
        if (s.how === HOW_NONE) return;
        if (s.matched === '') { unmatchedSubs.push(s); return; }
        (byStudent[s.matched] = byStudent[s.matched] || []).push(s);
      });
      targets.sort(function (x, y) {
        if (x.grade !== y.grade) return x.grade < y.grade ? -1 : 1;
        if (x.student !== y.student) return x.student < y.student ? -1 : 1;
        return x.row - y.row;
      });
      var rows = targets.map(function (t) {
        var mine = (byStudent[t.student] || []).slice().sort(function (x, y) { return x.at - y.at || x.row - y.row; });
        var st = moshiStudentState_(mine.map(function (s) { return { who: s.who, answer: s.answer, dateKey: s.dateKey, atKey: s.atKey, at: s.at.getTime() }; }), lastExamKey);
        var lp = st.answer === '未定' ? latestParent(mine) : null; // 日が未定の子は、いちばん新しい保護者の受け方・決め方・希望
        return {
          row: t.row, student: t.student, grade: t.grade, st: st,
          view: moshiRowView_(st, { metis: t.metis, noBill: t.noBill, cleaned: t.cleaned }, { cancelled: cancelled, deadlinePassed: deadlinePassed }),
          metis: t.metis, noBill: t.noBill, cleaned: t.cleaned, memo: t.memo,
          history: mine.map(function (s) { return { who: s.who, answerLabel: answerLabel(s.answer, s.dateKey), atLabel: atLabel(s.at) }; }),
          way: lp ? lp.way : '', decide: lp ? lp.decide : '', wish: lp ? lp.wish : ''
        };
      });
      var names = targets.map(function (t) { return t.student; });
      var unmatched = unmatchedSubs.map(function (s) {
        return { subRow: s.row, typed: s.typed, answerLabel: answerLabel(s.answer, s.dateKey), atLabel: atLabel(s.at), candidates: rankByCloseness_(s.typed, names, 5),
          way: s.answer === '未定' ? s.way : '', decide: s.answer === '未定' ? s.decide : '', wish: s.answer === '未定' ? s.wish : '' };
      });
      return {
        id: g.id, url: urlOf(g.id), name: g.name, grades: g.grades.slice(), targetText: g.targetText, venue: g.venue,
        dates: datesOut(g.dates), fee: g.fee, feeLabel: moshiYen_(g.fee), withdraw: g.withdraw, ret: g.ret,
        deadlineKey: g.deadlineKey, deadlineLabel: moshiDayLabel_(g.deadlineKey), recommend: g.recommend,
        range: g.range, timetable: g.timetable, status: g.status, sentGrades: g.sentGrades.slice(),
        createdLabel: dayOnly(g.createdAt), copyFrom: g.copyFrom,
        view: moshiGuideView_({ cancelled: cancelled, lastExamKey: lastExamKey, deadlinePassed: deadlinePassed, grades: g.grades }, rows, unmatched.length, todayKey),
        rows: rows, unmatched: unmatched
      };
    }
    // いちばん新しい保護者の申込（MoshiApi.gs の moshiLatestParent_ と同じ）
    function latestParent(subs) {
      for (var i = subs.length - 1; i >= 0; i--) if (subs[i].who === WHO_PARENT) return subs[i];
      return null;
    }
    function textOf(g) {
      return buildMoshiMessage_(SEND_LINES, moshiMessageVals_(g, RECOMMEND[g.recommend] || '', urlOf(g.id)));
    }
    function findGuide(x, rawId) {
      var p = parseMoshiId_(typeof rawId === 'string' ? rawId : '');
      if (!p || p.classCode !== x.cls) return null;
      for (var i = 0; i < x.c.guides.length; i++) if (x.c.guides[i].id === p.id) return x.c.guides[i];
      return null;
    }
    function result(x, g) { return { ok: true, data: { guide: guideOut(x.c, g) } }; }
    function findStudent(cls, name) {
      var n = typeof name === 'string' ? name.trim() : '';
      if (n === '') return null;
      var list = studentsFor(cls) || [];
      for (var i = 0; i < list.length; i++) if (String(list[i].name).trim() === n) return { name: n, grade: String(list[i].grade || '').trim() };
      return null;
    }

    var OPS = {
      moshiList: function (x) {
        var guides = x.c.guides.slice().sort(function (a, b) { return b.createdAt - a.createdAt || b.row - a.row; });
        return { ok: true, data: {
          guides: x.c.ready ? guides.map(function (g) { return guideOut(x.c, g); }) : [],
          recommend: { '強くお勧め': RECOMMEND['強くお勧め'], 'ご検討の上': RECOMMEND['ご検討の上'] },
          todayKey: todayKey, venue: (o.className && o.className(x.cls)) || '',
          examDays: moshiExamDayOptions_(todayKey, 150, isHoliday), ready: !!x.c.ready
        } };
      },
      moshiCreate: function (x) {
        if (!x.c.ready) return { ok: false, error: MSG_NO_SHEET };
        var students = studentsFor(x.cls) || [];
        var grades = [];
        students.forEach(function (s) { var g = String(s.grade || '').trim(); if (g !== '' && grades.indexOf(g) < 0) grades.push(g); });
        var chk = checkMoshiDraft_(x.args.draft, grades, todayKey);
        if (!chk.ok) return { ok: false, error: chk.error };
        var targets = pickTargets(x.cls, chk.value.grades, false);
        if (!targets.length) return { ok: false, error: '選んだ学年の生徒がいません' };
        var dups = dupNames(targets.map(function (t) { return t.name; }));
        if (dups.length) return { ok: false, error: '同じ名前が2人います：' + dups.join('、') + '。片方の名前に印を付けて貼り直してください' };
        var g = addGuide(x.c, x.cls, chk.value, new Date(), OPEN);
        targets.forEach(function (t) { addTarget(x.c, g.id, t.name, t.grade); });
        var out = result(x, g);
        out.data.text = textOf(g);
        return out;
      },
      moshiText: function (x) {
        var g = findGuide(x, x.args.id);
        if (!g) return { ok: false, error: MSG_NOT_FOUND };
        if (g.status !== OPEN) return { ok: false, error: 'この案内は取り消してあります' };
        return { ok: true, data: { text: textOf(g) } };
      },
      moshiCancel: function (x) {
        var g = findGuide(x, x.args.id);
        if (!g) return { ok: false, error: MSG_NOT_FOUND };
        if (g.status !== OPEN) return { ok: false, error: 'この案内はもう取り消してあります' };
        g.status = CANCEL;
        return result(x, g);
      },
      moshiSent: function (x) {
        var a = x.args;
        if (typeof a.on !== 'boolean' || typeof a.grade !== 'string') return { ok: false, error: 'badrequest' };
        var g = findGuide(x, a.id);
        if (!g) return { ok: false, error: MSG_NOT_FOUND };
        if (g.grades.indexOf(a.grade) < 0) return { ok: false, error: 'この案内の学年ではありません' };
        g.sentGrades = g.grades.filter(function (gr) { return gr === a.grade ? a.on : g.sentGrades.indexOf(gr) >= 0; });
        return { ok: true, data: { sentGrades: g.sentGrades.slice() } };
      },
      moshiBatch: function (x) {
        var a = x.args;
        var g = findGuide(x, a.id);
        if (!g) return { ok: false, error: MSG_NOT_FOUND };
        var changes = a.changes === undefined ? [] : a.changes;
        if (!Array.isArray(changes) || changes.length > 100) return { ok: false, error: 'badrequest' };
        var keys = g.dates.map(function (d) { return d.key; });
        var targetOf = {};
        targetsOf(x.c, g.id).forEach(function (t) { targetOf[t.row] = t; });
        var byRow = {}, order = [];
        for (var i = 0; i < changes.length; i++) {
          var ch = changes[i] && typeof changes[i] === 'object' ? changes[i] : null;
          if (!ch || typeof ch.row !== 'number' || Math.floor(ch.row) !== ch.row) return { ok: false, error: 'badrequest' };
          if (!targetOf[ch.row]) return { ok: false, error: 'この生徒は見つかりません（一覧を読み直してください）' };
          if (!byRow[ch.row]) { byRow[ch.row] = {}; order.push(ch.row); }
          var m = byRow[ch.row];
          if (ch.answer !== undefined) {
            if (['受験', '未定', '辞退'].indexOf(ch.answer) < 0) return { ok: false, error: 'badrequest' };
            if (ch.answer === '受験' && keys.indexOf(ch.dateKey) < 0) return { ok: false, error: '受験日が正しくありません' };
            m.answer = ch.answer;
            m.dateKey = ch.answer === '受験' ? ch.dateKey : '';
          }
          var bools = ['metis', 'noBill', 'cleaned'];
          for (var k = 0; k < bools.length; k++) {
            if (ch[bools[k]] === undefined) continue;
            if (typeof ch[bools[k]] !== 'boolean') return { ok: false, error: 'badrequest' };
            m[bools[k]] = ch[bools[k]];
          }
          if (ch.memo !== undefined) {
            if (typeof ch.memo !== 'string') return { ok: false, error: 'badrequest' };
            if (ch.memo.length > 200) return { ok: false, error: 'メモは200文字までです' };
            m.memo = ch.memo;
          }
        }
        for (var j = 0; j < order.length; j++) {
          var mm = byRow[order[j]];
          var metisAfter = typeof mm.metis === 'boolean' ? mm.metis : targetOf[order[j]].metis;
          if (mm.cleaned === true && !metisAfter) return { ok: false, error: 'METISで請求を作った子だけ「請求を消した」にできます' };
        }
        var now = new Date();
        order.forEach(function (r) {
          var t = targetOf[r], w = byRow[r];
          if (w.answer) addSub(x.c, { id: g.id, typed: t.student, matched: t.student, how: HOW_STAFF, answer: w.answer, dateKey: w.dateKey, at: now, who: WHO_STAFF });
          ['metis', 'noBill', 'cleaned', 'memo'].forEach(function (k2) { if (w[k2] !== undefined) t[k2] = w[k2]; });
        });
        return result(x, g);
      },
      moshiMatch: function (x) {
        var a = x.args;
        var g = findGuide(x, a.id);
        if (!g) return { ok: false, error: MSG_NOT_FOUND };
        if (typeof a.student !== 'string' || typeof a.subRow !== 'number') return { ok: false, error: 'badrequest' };
        var sub = null;
        subsOf(x.c, g.id).forEach(function (s) { if (s.row === a.subRow) sub = s; });
        if (!sub) return { ok: false, error: 'この申込は見つかりません（一覧を読み直してください）' };
        var name = a.student.trim();
        if (name === '') { sub.matched = ''; sub.how = HOW_NONE; return result(x, g); }
        var inTarget = targetsOf(x.c, g.id).some(function (t) { return t.student === name; });
        if (!inTarget) {
          var st = findStudent(x.cls, name);
          if (!st) return { ok: false, error: MSG_NOT_STUDENT };
          addTarget(x.c, g.id, st.name, st.grade, null, new Date());
        }
        sub.matched = name;
        sub.how = HOW_STAFF;
        return result(x, g);
      },
      moshiAddStudent: function (x) {
        var g = findGuide(x, x.args.id);
        if (!g) return { ok: false, error: MSG_NOT_FOUND };
        var st = findStudent(x.cls, x.args.student);
        if (!st) return { ok: false, error: MSG_NOT_STUDENT };
        if (targetsOf(x.c, g.id).some(function (t) { return t.student === st.name; })) return { ok: false, error: 'この生徒はもう入っています' };
        addTarget(x.c, g.id, st.name, st.grade, null, new Date());
        return result(x, g);
      }
    };

    // 本文 {op, cls, args, clientKey} を受ける（ログインと教室の確かめは index.html の偽APIと同じ考え方）
    function handle(body) {
      body = body && typeof body === 'object' ? body : {};
      var op = typeof body.op === 'string' ? body.op : '';
      if (!Object.prototype.hasOwnProperty.call(OPS, op)) return { ok: false, error: 'badrequest' };
      var cls = typeof body.cls === 'string' ? body.cls.trim().toUpperCase() : '';
      if (!classes[cls] || !studentsFor(cls)) return { ok: false, error: MSG_NO_CLASS };
      var args = body.args && typeof body.args === 'object' ? body.args : {};
      var write = WRITE_OPS.indexOf(op) >= 0;
      var ck = write && typeof body.clientKey === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.clientKey) ? op + '|' + cls + '|' + body.clientKey : '';
      if (ck && cache[ck]) return JSON.parse(cache[ck]);
      syncStore();
      if (op !== 'moshiList' && !classes[cls].ready) return { ok: false, error: MSG_NO_SHEET };
      var res = OPS[op]({ cls: cls, c: classes[cls], args: args });
      if (write && res.ok) syncStore();
      var out = JSON.stringify(res); // 本物と同じく JSON で渡す（日付は持ち出さない）
      if (ck && res.ok === true) cache[ck] = out;
      return JSON.parse(out);
    }
    return { handle: handle, todayKey: todayKey };
  }

  window.MoshiMock = { create: create };
})();
