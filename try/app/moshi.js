// site/app/moshi.js : 教室長アプリの「模試」の画面（案内を作る・一覧。依頼-009 Task 7・8、2026-11-23 本人の直しで一覧を簡単に）
// 使う物：moshi-logic.js（Logic.gs の模試の計算の写し）と、index.html の window.StaffShell（通信・ログイン・保存のならび・生徒一覧）。
// 通信は今の {api:'staff'} の op（moshiList・moshiCreate・moshiText・moshiCancel・moshiSent・moshiBatch・moshiMatch・moshiAddStudent）。
//
// window.MoshiApp = {
//   mount(el, tabsEl)  el に画面を、tabsEl に「案内を作る」「一覧（確かめて 〇）」のタブを描く（はじめに1回）
//   onClass(cls)       教室が変わった（読み直す）
//   show(tab)          'make' か 'list' を出す（模試の枠を開いたとき・タブを押したとき）
//   refresh(quiet)     一覧を読み直す（上の「更新」・自動の読み直し）
// }
// 押した印（METIS ☑・請求しない・消した・メモ・返事）は、押した瞬間に画面を変え（moshi-logic.js で色を計算し直す）、
// 保存のならび（StaffShell.createSaveQueue。約0.8秒ためて案内ごとに moshiBatch 1回）で送る。
(function () {
  'use strict';

  var MSG_FAIL = 'うまくいきませんでした。少したってから、もう一度お試しください';
  var MSG_SAVE_FAIL = '保存できませんでした。もう一度押してください';
  var MSG_RELOGIN = 'ログインの期限が切れました。上の「ログイン」で入り直してから、もう一度押してください';
  var ANSWERS = ['受験', '未定', '辞退'];

  var SH = null;   // window.StaffShell
  var h, clear;
  var Q = null;    // 模試の保存のならび
  var M = {
    root: null, tabsEl: null, cls: '', tab: 'make', visible: false,
    data: null, loading: false, err: '', seq: 0, listTime: '',
    base: {},       // 案内番号 → サーバーから来た最後の GuideOut
    clock: 0, savedAt: {},
    showDone: false, filter: {}, match: '', matchQuery: '', busy: '', msg: {},
    draft: null, auto: true, createKey: null, created: null, createErr: '', creating: false,
    deferred: false
  };

  // ---- 小さな部品 ----
  function jaError(msg) { return typeof msg === 'string' && /[ぁ-んァ-ヶ一-龠]/.test(msg) ? msg : MSG_FAIL; }
  function copyObj(x) { return JSON.parse(JSON.stringify(x)); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function nowLabel() { var d = new Date(); return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + d.getHours() + ':' + pad2(d.getMinutes()); }
  function timeNow() { var d = new Date(); return d.getHours() + ':' + pad2(d.getMinutes()); }
  function todayKey() { return (M.data && M.data.todayKey) || moshiDateKey_(new Date()); }
  // MoshiApi.gs の moshiAnswerLabel_ と同じ言い方（保護者の画面とそろえる）
  function answerLabel(answer, dateKey) {
    if (answer === '受験') return '受験する ' + moshiDayLabel_(dateKey);
    if (answer === '未定') return '日を相談したい';
    if (answer === '辞退') return '辞退する';
    return '';
  }
  function msgEl(text, kind) { return text ? h('p', { class: 'msg ' + (kind || 'info'), text: text }) : null; }
  function field(label, control, note) {
    return h('div', { class: 'mo-field' }, [h('label', { class: 'mo-lab' }, [label, control]), note || null]);
  }
  function select(opts, value, onchange, aria, key) {
    var s = h('select', { 'aria-label': aria, 'data-k': key, onchange: function (e) { onchange(e.target.value); } });
    opts.forEach(function (o) { s.appendChild(h('option', { value: o[0], text: o[1] })); });
    s.value = value;
    if (s.value !== value) s.value = '';
    return s;
  }
  // 打っている途中（日本語の変換中もふくむ）なら、描き直しを後回しにする
  function typingIn(el) {
    var a = document.activeElement;
    if (!a || !el || !el.contains(a)) return false;
    return a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && /^(text|search|number)$/i.test(a.type || 'text'));
  }
  // 描き直しても、押していた所（data-k）にもどる
  function keepFocus(fn) {
    var a = document.activeElement;
    var k = a && a.getAttribute ? a.getAttribute('data-k') : null;
    fn();
    if (k) { var e = M.root.querySelector('[data-k="' + k + '"]'); if (e) e.focus(); }
  }
  function gradeOrder(g) {
    var m = /^(小|中|高)[^0-9０-９]*([0-9０-９]+)/.exec(g);
    if (!m) return 900;
    return { 小: 100, 中: 200, 高: 300 }[m[1]] + Number(moshiHalfWidth_(m[2]));
  }
  function gradeList() {
    var count = {}, out = [];
    (SH.students() || []).forEach(function (s) {
      var g = String(s.grade || '').trim();
      if (!g) return;
      if (!(g in count)) { count[g] = 0; out.push(g); }
      count[g] += 1;
    });
    out.sort(function (a, b) { return gradeOrder(a) - gradeOrder(b) || (a < b ? -1 : a > b ? 1 : 0); });
    return { list: out, count: count };
  }

  // ---- 案内の見え方（サーバーの最後の形＋まだ届いていない変更）----
  function guideIds() { return M.data ? M.data.guides.map(function (g) { return g.id; }) : []; }
  function viewGuide(id) {
    var g = M.base[id];
    if (!g) return null;
    var pend = Q ? Q.pendingFor(id) : null;
    if (!pend) return g;
    var d = copyObj(g);
    var cancelled = d.status === '取り消し';
    var deadlinePassed = !!d.deadlineKey && todayKey() > d.deadlineKey;
    var keys = d.dates.map(function (x) { return x.key; });
    var ch = pend.changes || {};
    d.rows.forEach(function (r) {
      var p = ch[r.row];
      if (!p) return;
      ['metis', 'noBill', 'cleaned'].forEach(function (k) { if (typeof p[k] === 'boolean') r[k] = p[k]; });
      if (typeof p.memo === 'string') r.memo = p.memo;
      if (p.answer) {
        // 教室長の返事はいつも勝つ（そのあとに保護者の違う内容は来ていないので「確かめて」は消える）
        r.st = { answer: p.answer, dateKey: p.answer === '受験' ? p.dateKey : '', by: '教室長', count: r.st.count, check: '' };
        r.history = r.history.concat([{ who: '教室長', answerLabel: answerLabel(p.answer, p.dateKey), atLabel: nowLabel() }]);
      }
      r.view = moshiRowView_(r.st, { metis: r.metis, noBill: r.noBill, cleaned: r.cleaned }, { cancelled: cancelled, deadlinePassed: deadlinePassed });
    });
    d.view = moshiGuideView_({ cancelled: cancelled, lastExamKey: keys.length ? keys[keys.length - 1] : '', deadlinePassed: deadlinePassed, grades: d.grades },
      d.rows, d.unmatched.length, todayKey());
    return d;
  }
  function visibleGuides() {
    return guideIds().map(viewGuide).filter(function (g) { return g && (M.showDone || !g.view.finished); });
  }
  function takeGuide(g) {
    M.base[g.id] = g;
    if (!M.data) return;
    var at = guideIds().indexOf(g.id);
    if (at >= 0) M.data.guides[at] = g; else M.data.guides.unshift(g);
  }

  // ---- 読み込み ----
  function load(quiet) {
    var my = ++M.seq;
    var cls = SH.cls();
    var start = 0;
    M.loading = !M.data;
    M.pending = true;
    if (!quiet || !M.data) render();
    return Q.flushNow().then(function () {
      start = M.clock;
      return SH.send('moshiList', {});
    }).then(function (res) {
      if (my !== M.seq || cls !== SH.cls()) return;
      M.loading = false;
      M.pending = false;
      if (res.ok && res.data && Array.isArray(res.data.guides)) {
        // 一覧を読みに出したあとに保存の答えが来た案内は、そちらの方が新しい
        var guides = res.data.guides.map(function (g) {
          return M.base[g.id] && (M.savedAt[g.id] || 0) > start ? M.base[g.id] : g;
        });
        M.data = res.data;
        M.data.guides = guides;
        M.base = {};
        guides.forEach(function (g) { M.base[g.id] = g; });
        M.err = '';
        M.listTime = timeNow();
        if (!M.draft) startDraft();
      } else if (!res.relogin) {
        M.err = '模試の一覧を読めませんでした：' + jaError(res.error);
      }
      render();
    });
  }

  // ---- 保存のならび ----
  function makeQueue() {
    Q = SH.createSaveQueue({
      send: function (id, cls, payload) { return SH.send('moshiBatch', payload, SH.newClientKey(), cls); },
      onState: SH.renderSaveState,
      onSaved: function (id, data) {
        M.savedAt[id] = ++M.clock;
        if (data && data.guide && data.guide.id === id) takeGuide(data.guide);
        if (M.msg[id] && M.msg[id].save) M.msg[id] = null;
        render();
      },
      onFailed: function (id, pend, res) {
        M.savedAt[id] = ++M.clock;
        var why = res && typeof res.error === 'string' && /[ぁ-んァ-ヶ一-龠]/.test(res.error) && !res.network ? '（' + res.error + '）' : '';
        M.msg[id] = { kind: 'error', text: MSG_SAVE_FAIL + why, save: true };
        render();
      }
    });
    SH.addQueue(Q);
  }
  function queue(gid, row, patch, later) {
    Q.add(gid, SH.cls(), row, patch);
    if (M.msg[gid] && M.msg[gid].save) M.msg[gid] = null;
    // メモは欄を離れたときに保存する。押した先のボタンが描き直しで消えないよう、少し待ってから描く
    if (later) setTimeout(render, 250); else render();
  }
  // 待つ op（子を選ぶ・生徒を足す・取り消す）。ためた保存を送り終えてから
  function waitOp(gid, busyKey, op, args, done) {
    if (M.busy) return;
    M.busy = busyKey;
    M.msg[gid] = null;
    render();
    Q.flushNow().then(function () { return SH.send(op, args, SH.newClientKey()); }).then(function (res) {
      M.busy = '';
      if (res.ok && res.data && res.data.guide) {
        takeGuide(res.data.guide);
        if (done) done(res.data);
      } else {
        M.msg[gid] = { kind: 'error', text: res.relogin ? MSG_RELOGIN : jaError(res.error) };
      }
      render();
    });
  }

  // ================= 描く =================
  function render() {
    if (!M.root) return;
    renderTabs();
    if (!M.visible) return;
    if (typingIn(M.root)) { M.deferred = true; renderTabs(); return; }
    M.deferred = false;
    keepFocus(function () {
      clear(M.root);
      if (!M.data && !M.err) { M.root.appendChild(h('section', { class: 'card' }, [h('p', { text: '読み込んでいます…' })])); return; }
      if (M.err && !M.data) {
        M.root.appendChild(h('section', { class: 'card' }, [msgEl(M.err, 'error'),
          h('p', null, [h('button', { type: 'button', class: 'btn', text: 'もう一度読む', onclick: function () { load(false); } })])]));
        return;
      }
      if (M.data && M.data.ready === false) {
        M.root.appendChild(h('section', { class: 'card' }, [h('h2', { text: 'この教室はまだ模試を使えません' }),
          h('p', { class: 'muted', text: 'この教室の表に、模試のシートがまだありません。本人に知らせてください。' })]));
        return;
      }
      if (M.tab === 'make') renderMake(); else renderList();
    });
  }
  function renderTabs() {
    if (!M.tabsEl) return;
    var checks = 0;
    if (M.data) visibleGuides().forEach(function (g) { checks += g.view.checks; });
    clear(M.tabsEl);
    M.tabsEl.appendChild(h('button', { type: 'button', class: 'tab' + (M.tab === 'make' ? ' on' : ''), text: '案内を作る',
      onclick: function () { show('make'); } }));
    M.tabsEl.appendChild(h('button', { type: 'button', class: 'tab' + (M.tab === 'list' ? ' on' : ''),
      onclick: function () { show('list'); } }, ['一覧（確かめて ', h('span', { class: checks ? 'mo-n' : '', text: String(checks) }), '）']));
  }

  // ================= 案内を作る =================
  function newDraft() {
    M.draft = { copyFrom: '', name: '', grades: [], targetText: '', venue: (M.data && M.data.venue) || '', dates: [{ key: '', time: '14:00' }],
      fee: '', withdraw: '', ret: '', deadlineKey: '', recommend: '', range: '', timetable: '' };
    M.auto = true;
    formChanged();
  }
  // 開いたときの下書き：いちばん新しい受付中の回（なければいちばん新しい回）を写した状態にする（基準①の2分のため）
  function startDraft() {
    var gs = (M.data && M.data.guides) || [];
    var open = gs.filter(function (g) { return g.status === '受付中'; })[0];
    var pick = open || gs[0];
    if (pick) applyCopy(pick.id); else newDraft();
  }
  function applyCopy(id) {
    var g = M.base[id];
    if (!g) { newDraft(); return; }
    var d = copyMoshiDraft_(g, (M.data && M.data.venue) || '');
    d.fee = d.fee === undefined || d.fee === null ? '' : String(d.fee);
    if (!d.dates.length) d.dates = [{ key: '', time: '14:00' }];
    d.dates.forEach(function (x) { if (MOSHI_TIME_OPTIONS.indexOf(x.time) < 0) x.time = '14:00'; });
    M.auto = d.targetText === '' || d.targetText === moshiTargetText_(d.grades);
    if (M.auto) d.targetText = moshiTargetText_(d.grades);
    M.draft = d;
    formChanged();
  }
  // 入力を変えた：前の送る文は消す（古い文を送らないように）。押すごとの印も新しくする
  function formChanged() {
    M.createKey = null;
    M.createInfo = '';
    M.redoAsk = false;
    M.createErr = '';
    M.created = null;
  }
  // ▼の日の文字。祝日は「（祝）」を付ける（見せ方だけ）
  function dayLabelH(k) {
    var d = moshiKeyDate_(k);
    return moshiDayLabel_(k) + (d && SH.isJapaneseHoliday && SH.isJapaneseHoliday(d) ? '（祝）' : '');
  }
  function firstExamKey() {
    var keys = M.draft.dates.map(function (x) { return x.key; }).filter(function (k) { return !!k; }).sort();
    return keys[0] || '';
  }
  function setDraft(k, v, redraw) {
    M.draft[k] = v;
    formChanged();
    if (redraw) render(); else renderMakeResult();
  }
  function step(n, title, kids, on) {
    return h('section', { class: 'card' }, [h('div', { class: 'step' + (on === false ? ' off' : '') }, [
      h('span', { class: 'num', text: String(n) }), h('div', { class: 'step-head' }, [h('h2', { text: title })]),
      h('div', { class: 'step-body' }, kids)])]);
  }

  function renderMake() {
    var d = M.draft;
    if (!d) { startDraft(); d = M.draft; }
    var tk = todayKey();
    var root = M.root;

    // 1 前の回から写す
    var copyOpts = [['', '写さない（はじめから作る）']];
    M.data.guides.forEach(function (g) {
      copyOpts.push([g.id, g.name + '（' + g.createdLabel + 'に作った' + (g.status === '取り消し' ? '・取り消し' : '') + '）']);
    });
    var locked = M.creating || !!M.created; // 作っている間・作ったあとは入力を止める（直すときは「直して作り直す」）
    var formStart = root.childNodes.length;
    root.appendChild(step(1, '前の回から写す', [
      h('div', { class: 'row' }, [select(copyOpts, d.copyFrom, function (v) { if (v) applyCopy(v); else newDraft(); render(); }, '前の回から写す', 'copy')]),
      M.created ? h('p', { class: 'warn', text: 'この案内は作りました。入力を直すときは、下の「直して作り直す」を押してください。' }) : null,
      h('p', { class: 'small muted', text: '前の回を選ぶと、下に写します。受験日・締切・引き落とし・返却は選び直してください。' })
    ]));

    // 2 回の名前・学年・対象・会場
    var names = [];
    M.data.guides.forEach(function (g) { var n = nextRoundName_(g.name); if (n && names.indexOf(n) < 0) names.push(n); });
    var dl = h('datalist', { id: 'mo-names' }, names.map(function (n) { return h('option', { value: n }); }));
    var gl = gradeList();
    var gradeBoxes = gl.list.slice();
    d.grades.forEach(function (g) { if (gradeBoxes.indexOf(g) < 0) gradeBoxes.push(g); }); // 写した回の学年が今の一覧にない
    var targetInput = h('input', { type: 'text', class: 'mo-wide', value: d.targetText, maxlength: 60, 'data-k': 'target',
      oninput: function (e) { M.auto = false; setDraft('targetText', e.target.value, false); autoBtn.hidden = false; } });
    var autoBtn = h('button', { type: 'button', class: 'btn btn-sm', text: '自動に戻す', hidden: M.auto, 'data-k': 'auto',
      onclick: function () { M.auto = true; setDraft('targetText', moshiTargetText_(d.grades), true); } });
    root.appendChild(step(2, '回の名前・学年', [
      field('回の名前', h('input', { type: 'text', class: 'mo-wide', value: d.name, list: 'mo-names', maxlength: 60, 'data-k': 'name',
        placeholder: '例 新・みやぎ模試・第4回10月号', oninput: function (e) { setDraft('name', e.target.value, false); } })), dl,
      h('div', { class: 'mo-field' }, [h('span', { class: 'mo-lab-t', text: '学年（送る学年に☑。いくつでも）' }),
        h('div', { class: 'mo-checks' }, gradeBoxes.map(function (g) {
          var on = d.grades.indexOf(g) >= 0;
          return h('label', { class: 'check mo-pick' + (on ? ' on' : '') }, [
            h('input', { type: 'checkbox', checked: on, 'data-k': 'grade-' + g, onchange: function (e) {
              var next = d.grades.filter(function (x) { return x !== g; });
              if (e.target.checked) next.push(g);
              next.sort(function (a, b) { return gradeOrder(a) - gradeOrder(b); });
              d.grades = next;
              if (M.auto) d.targetText = moshiTargetText_(next);
              setDraft('grades', next, true);
            } }), g + '（' + (gl.count[g] || 0) + '人）']);
        }))]),
      field('対象（保護者の画面と送る文に出る文字）', h('span', { class: 'row' }, [targetInput, autoBtn]),
        h('p', { class: 'small muted', text: 'ふだんは学年から自動で入ります。春休み号などは「新中学2・3年生」のように直せます。' })),
      field('会場', h('input', { type: 'text', class: 'mo-wide', value: d.venue, maxlength: 60, 'data-k': 'venue',
        oninput: function (e) { setDraft('venue', e.target.value, false); } }))
    ]));

    // 3 受験日
    var dayOpts = [['', '選んでください']].concat((M.data.examDays || []).map(function (k) { return [k, dayLabelH(k)]; }));
    var timeOpts = MOSHI_TIME_OPTIONS.map(function (t) { return [t, t + '〜']; });
    var dateRows = d.dates.map(function (x, i) {
      return h('div', { class: 'row mo-date' }, [
        h('span', { class: 'mo-lab-t', text: '受験日' + (i + 1) }),
        select(dayOpts, x.key, function (v) { x.key = v; fixDeadline(); setDraft('dates', d.dates, true); }, '受験日' + (i + 1), 'day-' + i),
        select(timeOpts, x.time, function (v) { x.time = v; setDraft('dates', d.dates, true); }, '受験日' + (i + 1) + 'の時刻', 'time-' + i),
        d.dates.length > 1 ? h('button', { type: 'button', class: 'x', 'aria-label': '受験日' + (i + 1) + 'を外す', text: '×', onclick: function () {
          d.dates.splice(i, 1); fixDeadline(); setDraft('dates', d.dates, true);
        } }) : null
      ]);
    });
    root.appendChild(step(3, '受験日', dateRows.concat([
      d.dates.length < 3 ? h('p', null, [h('button', { type: 'button', class: 'btn btn-sm', text: '＋ 受験日を足す', 'data-k': 'add-day', onclick: function () {
        d.dates.push({ key: '', time: d.dates.length ? d.dates[d.dates.length - 1].time : '14:00' });
        setDraft('dates', d.dates, true);
      } })]) : h('p', { class: 'small muted', text: '受験日は3つまでです。' }),
      h('p', { class: 'small muted', text: '土・日・祝日から選べます。保護者の画面には、受験日ごとに「受験する」のボタンが出ます。' })
    ])));

    // 4 受験料・引き落とし・返却・締切
    var dlOpts = [['', '選んでください']].concat(moshiDeadlineOptions_(tk, firstExamKey()).map(function (k) {
      return [k, dayLabelH(k) + (k === tk ? '（今日）' : '')];
    }));
    var wOpts = [['', '選んでください']].concat(moshiMonthOptions_(tk, 6, '末').map(function (m) { return [m, m]; }));
    var rOpts = [['', '選んでください']].concat(moshiMonthOptions_(tk, 6, '中旬').map(function (m) { return [m, m]; }));
    root.appendChild(step(4, '受験料・締切', [
      h('div', { class: 'mo-grid' }, [
        field('受験料（円・税込）', h('input', { type: 'text', inputmode: 'numeric', class: 'mo-fee', value: d.fee, 'data-k': 'fee', placeholder: '4200',
          oninput: function (e) { setDraft('fee', e.target.value, false); } })),
        field('引き落とし', select(wOpts, d.withdraw, function (v) { setDraft('withdraw', v, true); }, '引き落としの月', 'withdraw')),
        field('データ集計・本人返却', select(rOpts, d.ret, function (v) { setDraft('ret', v, true); }, '返却の時期', 'ret')),
        field('締切', select(dlOpts, d.deadlineKey, function (v) { setDraft('deadlineKey', v, true); }, '締切', 'deadline'),
          h('p', { class: 'small muted', text: '今日から最初の受験日まで。締切のあとも申し込めます（一覧で未提出が赤くなります）。' }))
      ])
    ]));

    // 5 すすめの一文・範囲・時間割
    var rec = (M.data && M.data.recommend) || {};
    root.appendChild(step(5, 'すすめの一文・範囲・時間割', [
      field('すすめの一文', select([['', '選んでください'], ['強くお勧め', '強くお勧め（中3向け）'], ['ご検討の上', 'ご検討の上（中1・2向け）']],
        d.recommend, function (v) { setDraft('recommend', v, true); }, 'すすめの一文', 'recommend')),
      d.recommend && rec[d.recommend] ? h('p', { class: 'help', text: rec[d.recommend] }) : null,
      field('範囲（500文字まで）', h('textarea', { rows: 2, maxlength: 500, 'data-k': 'range', value: d.range,
        oninput: function (e) { setDraft('range', e.target.value, false); } })),
      field('時間割（1000文字まで）', h('textarea', { rows: 7, maxlength: 1000, 'data-k': 'timetable', value: d.timetable,
        oninput: function (e) { setDraft('timetable', e.target.value, false); } }))
    ]));

    if (locked) {
      for (var ci = formStart; ci < root.childNodes.length; ci++) {
        root.childNodes[ci].querySelectorAll('input, select, textarea, button').forEach(function (e) { e.disabled = true; });
      }
    }

    // 6 作る → 送る文
    var box = h('div', { id: 'mo-result' });
    root.appendChild(step(6, '作る・送る文をコピー', [box]));
    renderMakeResult();
  }
  // 締切の候補からはずれたら選び直し
  function fixDeadline() {
    var d = M.draft;
    if (d.deadlineKey && moshiDeadlineOptions_(todayKey(), firstExamKey()).indexOf(d.deadlineKey) < 0) d.deadlineKey = '';
  }
  function draftForSend() {
    var d = copyObj(M.draft);
    return d;
  }
  function renderMakeResult() {
    var box = M.root && M.root.querySelector('#mo-result');
    if (!box) return;
    clear(box);
    if (M.createErr) box.appendChild(msgEl(M.createErr, 'error'));
    if (M.createInfo && !M.created) box.appendChild(msgEl(M.createInfo, 'ok'));
    if (!M.created) {
      box.appendChild(h('div', { class: 'row' }, [
        h('button', { type: 'button', class: 'btn-main', 'data-k': 'create', disabled: M.creating, text: M.creating ? '作っています…' : '作る', onclick: doCreate }),
        h('span', { class: 'muted', text: '押すと、保護者へ送る文が出ます。' })
      ]));
      return;
    }
    var g = viewGuide(M.created.guide.id) || M.created.guide;
    var ta = h('textarea', { rows: 14, readonly: true, class: 'mo-text', value: M.created.text });
    var cmsg = h('span', { class: 'msg ok', hidden: true });
    box.appendChild(h('div', { class: 'mo-made' }, [
      h('p', { class: 'result-sum' }, [h('b', { text: '「' + g.name + '」を作りました' }), '（対象 ' + g.rows.length + '人）']),
      ta,
      h('div', { class: 'row', style: 'margin-top:12px' }, [
        h('button', { type: 'button', class: 'btn-main', text: '送る文をコピー', 'data-k': 'copy', onclick: function () { SH.copyText(ta, cmsg); } }), cmsg]),
      h('p', { class: 'small muted', text: 'コピーした文を塾生アプリに貼り、学年を選んで保護者にまとめて送ります。' }),
      redoBox(g)
    ]));
  }
  // 送る前に見つけたまちがいを直す：前の案内を取り消してから、入力を戻して直せるようにする
  function redoBox(g) {
    var kids = [h('div', { class: 'd-actions' }, [
      h('button', { type: 'button', class: 'btn', 'data-k': 'redo', disabled: M.redoBusy || g.status !== '受付中', text: '直して作り直す（前の案内を取り消す）',
        onclick: function () { M.redoAsk = true; renderMakeResult(); } }),
      h('button', { type: 'button', class: 'btn', 'data-k': 'another', disabled: M.redoBusy, text: '別の案内を作る（今の案内はそのまま）',
        onclick: function () { M.redoAsk = false; M.createInfo = ''; startDraft(); render(); window.scrollTo(0, 0); } })
    ])];
    if (M.redoAsk) {
      kids.push(h('div', { class: 'confirm' }, [
        h('p', { text: '前の案内を取り消して、直した内容で作り直します。前のリンクは使えなくなります。' }),
        h('div', { class: 'row' }, [
          h('button', { type: 'button', class: 'btn btn-danger', 'data-k': 'redo-yes', disabled: M.redoBusy, text: M.redoBusy ? '取り消しています…' : '取り消して作り直す', onclick: function () { doRedo(g.id); } }),
          h('button', { type: 'button', class: 'btn', disabled: M.redoBusy, text: 'やめる', onclick: function () { M.redoAsk = false; renderMakeResult(); } })])]));
    }
    return h('div', { class: 'mo-redo' }, kids);
  }
  function doRedo(id) {
    if (M.redoBusy) return;
    M.redoBusy = true;
    M.createErr = '';
    renderMakeResult();
    Q.flushNow().then(function () { return SH.send('moshiCancel', { id: id }, SH.newClientKey()); }).then(function (res) {
      M.redoBusy = false;
      if (res.ok && res.data && res.data.guide) {
        takeGuide(res.data.guide);
        M.created = null;
        M.createKey = null;
        M.redoAsk = false;
        M.createInfo = '前の案内を取り消しました。上の入力を直してから「作る」を押してください。';
        render();
      } else {
        M.createErr = res.relogin ? MSG_RELOGIN : jaError(res.error);
        renderMakeResult();
      }
    });
  }
  function doCreate() {
    if (M.creating) return;
    var gl = gradeList();
    var chk = checkMoshiDraft_(draftForSend(), gl.list, todayKey());
    if (!chk.ok) { M.createErr = jaError(chk.error); renderMakeResult(); return; }
    if (!M.createKey) M.createKey = SH.newClientKey();
    M.creating = true;
    M.createErr = '';
    render(); // 作っている間は入力欄を止める
    var key = M.createKey;
    SH.send('moshiCreate', { draft: draftForSend() }, key).then(function (res) {
      M.creating = false;
      if (key !== M.createKey) { renderMakeResult(); return; } // 待っている間に入力を変えた
      if (res.ok && res.data && res.data.guide) {
        takeGuide(res.data.guide);
        M.created = { guide: res.data.guide, text: res.data.text || '' };
      } else {
        M.createErr = res.relogin ? MSG_RELOGIN : jaError(res.error);
      }
      render(); // 作ったら入力欄を止める
    });
  }
  // ================= 一覧（2026-11-23 本人の直し：数のタイル＋1人1行。行は開かない）=================
  function renderList() {
    var root = M.root;
    var all = guideIds().map(viewGuide).filter(Boolean);
    var hiddenN = all.filter(function (g) { return g.view.finished; }).length;
    var shown = visibleGuides();
    root.appendChild(h('section', { class: 'card' }, [
      h('div', { class: 'filters' }, [
        h('label', { class: 'check' }, [h('input', { type: 'checkbox', checked: M.showDone, 'data-k': 'show-done',
          onchange: function (e) { M.showDone = e.target.checked; render(); } }), '終わった回も出す']),
        hiddenN && !M.showDone ? h('span', { class: 'small muted', text: '（終わった回 ' + hiddenN + 'つを隠しています）' }) : null,
        h('span', { class: 'spacer' }),
        h('span', { class: 'small muted', text: M.listTime ? M.listTime + ' に読みました' : '' })
      ]),
      h('p', { class: 'small muted', style: 'margin:6px 0 0', text: '数のタイルを押すと、その人だけを出します（もう一度押すと全員）。返事は▼で直せます（紙・メッセージで来た分もここ）。メモは欄の外を押すと保存します。' }),
      msgEl(M.err, 'error')
    ]));
    if (!shown.length) {
      root.appendChild(h('section', { class: 'card' }, [h('p', { class: 'empty', text: all.length ? '出している回はありません（終わった回は「終わった回も出す」で見られます）。' : 'まだ案内がありません。「案内を作る」から作ります。' })]));
      return;
    }
    shown.forEach(function (g) { root.appendChild(card(g)); });
  }

  function tag(text, color) { return h('span', { class: 'mo-tag c-' + color, text: text }); }

  // 行がどのタイルに入るか：'d:受験日'・'未定'・'辞退'・''（未提出）
  function tileKeyOf(r) {
    var a = r.st.answer;
    if (a === '受験') return 'd:' + r.st.dateKey;
    return a === '未定' || a === '辞退' ? a : '';
  }

  function card(g) {
    var v = g.view;
    var cancelled = g.status === '取り消し';
    var deadlinePassed = !!g.deadlineKey && todayKey() > g.deadlineKey;
    var filter = M.filter[g.id];
    // 数のタイル（受験日ごと・日を相談・辞退・未提出）。押すとその人だけ
    var tiles = g.dates.map(function (d) { return { key: 'd:' + d.key, label: d.short, sub: d.time + '〜' }; })
      .concat([{ key: '未定', label: '日を相談' }, { key: '辞退', label: '辞退' }, { key: '', label: '未提出' }]);
    var count = {};
    g.rows.forEach(function (r) { var k = tileKeyOf(r); count[k] = (count[k] || 0) + 1; });
    var tileEls = tiles.map(function (t) {
      var on = filter === t.key;
      return h('button', { type: 'button', class: 'mo-tile' + (on ? ' on' : '') + (t.key === '' && deadlinePassed && !cancelled && count[''] ? ' late' : ''),
        'aria-pressed': on ? 'true' : 'false', 'data-k': 'tile-' + g.id + '-' + t.key,
        onclick: function () { if (on) delete M.filter[g.id]; else M.filter[g.id] = t.key; render(); } }, [
        h('span', { class: 'mo-tile-l', text: t.label }), t.sub ? h('span', { class: 'mo-tile-s', text: t.sub }) : null,
        h('span', { class: 'mo-tile-n' }, [h('b', { text: String(count[t.key] || 0) }), '人'])]);
    });
    var tags = [];
    if (v.checks) tags.push(tag('確かめて ' + v.checks, 'yellow'));
    if (v.unbilled) tags.push(tag('METIS未請求 ' + v.unbilled, 'red'));
    if (v.cleanup) tags.push(tag('METISの請求を消す ' + v.cleanup, 'red'));

    var rows = g.rows.filter(function (r) { return filter === undefined || tileKeyOf(r) === filter; });
    var kids = [
      h('div', { class: 'mo-head' }, [h('h2', { text: g.name }), cancelled ? tag('取り消し', 'gray') : null, v.finished ? tag('終わった回', 'gray') : null]),
      h('p', { class: 'mo-sub' }, [g.targetText + '／締切 ' + g.deadlineLabel,
        deadlinePassed && !cancelled ? h('b', { class: 'mo-late', text: '（すぎました）' }) : null]),
      h('div', { class: 'mo-counts' }, [h('b', { class: 'mo-big', text: '出した ' + v.submitted + '／' + v.total + '人' })]),
      h('div', { class: 'mo-tiles', role: 'group', 'aria-label': '数（押すとその人だけ出す）' }, tileEls),
      tags.length ? h('div', { class: 'mo-tags' }, tags) : null
    ];
    if (g.unmatched.length) kids.push(unmatchedBox(g));
    kids.push(h('div', { class: 'table-wrap' }, [h('table', { class: 'list mo-list' }, [
      h('thead', null, [h('tr', null, [h('th', { text: '生徒' }), h('th', { text: '返事' }), h('th', { class: 'hit-head', text: 'METIS' }),
        h('th', { class: 'hit-head', text: '請求しない' }), h('th', { text: 'メモ' }), h('th', { style: 'text-align:right', text: '次にやること' })])]),
      h('tbody', null, rowsOf(g, rows))
    ])]));
    if (filter !== undefined) {
      kids.push(h('p', null, [h('button', { type: 'button', class: 'btn btn-sm', text: '全員を出す', onclick: function () { delete M.filter[g.id]; render(); } })]));
    }
    if (M.msg[g.id]) kids.push(msgEl(M.msg[g.id].text, M.msg[g.id].kind));
    return h('section', { class: 'card mo-card' + (cancelled ? ' mo-cancelled' : ''), 'data-gid': g.id }, kids);
  }

  function rowsOf(g, rows) {
    var cancelled = g.status === '取り消し';
    var out = rows.map(function (r) {
      var key = g.id + '|' + r.row;
      // 返事の▼：受験〇日／日が未定／辞退（未提出のときは空）。選ぶと教室長の申込として保存（教室長の内容がいつも勝つ）
      var opts = r.st.answer ? [] : [['', '（未提出）']];
      g.dates.forEach(function (d) { opts.push(['受験|' + d.key, '受験 ' + d.short]); });
      opts.push(['未定', '日が未定'], ['辞退', '辞退']);
      var cur = r.st.answer === '受験' ? '受験|' + r.st.dateKey : r.st.answer;
      var ans = select(opts, cur, function (val) {
        if (!val) return;
        var p = val.split('|');
        queue(g.id, r.row, { answer: p[0], dateKey: p[1] || '' });
      }, r.student + 'の返事', 'ans-' + key);
      if (cancelled) ans.disabled = true;
      var check = function (k, label, patch) {
        return h('td', { class: 'hit-cell' }, [h('label', { class: 'hit', title: label }, [
          h('input', { type: 'checkbox', checked: !!r[k], 'aria-label': r.student + ' ' + label, 'data-k': k + '-' + key,
            onchange: function (e) { queue(g.id, r.row, patch(e.target.checked)); } })])]);
      };
      return h('tr', { class: 'r c-' + r.view.color }, [
        h('td', null, [h('b', { text: r.student }), h('span', { class: 'mo-grade-s', text: r.grade }),
          r.st.count >= 2 ? h('span', { class: 'mo-two', text: r.st.count + '回来た' }) : null]),
        h('td', { class: 'mo-ans-cell' }, [ans, r.st.by === '教室長' ? h('span', { class: 'mo-by', text: '教室長が入れた' }) : null]),
        // METIS を外したときは「消した」の印も外す（請求後に辞退なら赤の札 → METISで消したら ☑ を外す）
        check('metis', 'METISで請求を作った', function (on) { return on ? { metis: true } : { metis: false, cleaned: false }; }),
        check('noBill', '請求しない', function (on) { return { noBill: on }; }),
        h('td', { class: 'mo-memo-cell' }, [h('input', { type: 'text', maxlength: 200, value: r.memo || '', 'data-k': 'memo-' + key,
          'aria-label': r.student + 'のメモ', placeholder: 'メモ',
          onchange: function (e) { queue(g.id, r.row, { memo: e.target.value }, true); } })]),
        h('td', { class: 'next-cell' }, [h('span', { class: 'next', text: r.view.next })])
      ]);
    });
    if (!rows.length) out.push(h('tr', null, [h('td', { colspan: 6, class: 'muted', text: g.rows.length ? 'このタイルの人はいません。' : '対象の生徒がいません。' })]));
    return out;
  }

  // 名前が合わない申込：打った名前・選んだ内容・来た日時・「子を選ぶ」
  function unmatchedBox(g) {
    var items = g.unmatched.map(function (u) {
      var key = g.id + '|' + u.subRow;
      var open = M.match === key;
      var busy = M.busy === 'match-' + key;
      var kids = [h('div', { class: 'row' }, [
        h('b', { text: '「' + u.typed + '」' }), h('span', { text: u.answerLabel }), h('span', { class: 'muted', text: u.atLabel }),
        h('button', { type: 'button', class: 'btn btn-sm', 'data-k': 'match-' + key, 'aria-expanded': open ? 'true' : 'false', text: open ? '閉じる' : '子を選ぶ',
          disabled: !!M.busy, onclick: function () { M.match = open ? '' : key; M.matchQuery = ''; render(); } })
      ])];
      if (open) kids.push(matchPicker(g, u, busy));
      return h('li', null, kids);
    });
    return h('div', { class: 'mo-unmatched c-yellow' }, [
      h('h3', { text: '名前が合わない申込（' + g.unmatched.length + '）' }),
      h('p', { class: 'small', text: '保護者が打った名前が生徒一覧と合いませんでした。正しい子を選んでください。' }),
      h('ul', null, items)
    ]);
  }
  function matchPicker(g, u, busy) {
    var pick = function (name) {
      waitOp(g.id, 'match-' + g.id + '|' + u.subRow, 'moshiMatch', { id: g.id, subRow: u.subRow, student: name }, function () { M.match = ''; });
    };
    var cand = h('div', { class: 'd-actions' }, u.candidates.map(function (n) {
      return h('button', { type: 'button', class: 'btn', disabled: !!M.busy, text: n, onclick: function () { pick(n); } });
    }));
    var results = h('div', { class: 'd-actions mo-results' });
    var fill = function (q) {
      clear(results);
      var nq = normalizeName_(q);
      if (!nq) { results.appendChild(h('span', { class: 'small muted', text: '名前の一部を打つと、ここに出ます。' })); return; }
      var hits = (SH.students() || []).filter(function (s) { return normalizeName_(s.name).indexOf(nq) >= 0; }).slice(0, 12);
      if (!hits.length) results.appendChild(h('span', { class: 'small muted', text: '生徒一覧にいません。' }));
      hits.forEach(function (s) {
        results.appendChild(h('button', { type: 'button', class: 'btn btn-sm', disabled: !!M.busy, text: s.name + '（' + s.grade + '）', onclick: function () { pick(s.name); } }));
      });
    };
    fill(M.matchQuery);
    return h('div', { class: 'mo-picker' }, [
      busy ? h('p', { class: 'msg info', text: '合わせています…' }) : null,
      h('h3', { text: '近い名前' }), cand,
      h('h3', { text: 'ほかの生徒から選ぶ' }),
      h('input', { type: 'search', value: M.matchQuery, placeholder: '名前で探す', 'data-k': 'match-q-' + u.subRow, 'aria-label': 'ほかの生徒を名前で探す',
        oninput: function (e) { M.matchQuery = e.target.value; fill(e.target.value); } }),
      results,
      h('p', null, [h('button', { type: 'button', class: 'btn', disabled: !!M.busy, text: 'どの子でもない（いたずら・同じ申込がもう1つある）', onclick: function () { pick(''); } })]),
      h('p', { class: 'small muted', text: '「どの子でもない」にすると、一覧から隠します（表の記録は消しません）。対象にいない子を選ぶと、その子を対象に足します。' })
    ]);
  }

  // ================= 外から呼ぶ =================
  function show(tab) {
    if (tab === 'make' || tab === 'list') M.tab = tab;
    var first = !M.visible;
    M.visible = true;
    if (M.cls !== SH.cls()) { reset(SH.cls()); }
    render();
    if (!M.pending && (!M.data || M.tab === 'list' || first)) load(true);
  }
  function hide() { M.visible = false; Q.flushNow(); }
  function reset(cls) {
    M.cls = cls;
    M.data = null; M.base = {}; M.err = ''; M.filter = {}; M.match = ''; M.busy = ''; M.msg = {};
    M.draft = null; M.created = null; M.createErr = ''; M.creating = false; M.createKey = null; M.createInfo = ''; M.redoAsk = false; M.redoBusy = false;
    M.seq++;
    M.pending = false;
  }
  function onClass(cls) {
    if (cls === M.cls && M.data) return;
    reset(cls);
    if (M.visible) load(false); else renderTabs();
  }
  function mount(el, tabsEl) {
    SH = window.StaffShell;
    h = SH.h;
    clear = SH.clear;
    M.root = el;
    M.tabsEl = tabsEl;
    makeQueue();
    // 打ち終わったら、後回しにしていた描き直しをする
    var later = function () { setTimeout(function () { if (M.deferred && !typingIn(M.root)) render(); }, 0); };
    el.addEventListener('focusout', later);
    document.addEventListener('compositionend', later);
    renderTabs();
  }
  window.MoshiApp = { mount: mount, onClass: onClass, show: show, hide: hide, refresh: function (quiet) { if (M.visible) return load(quiet); } };
})();
