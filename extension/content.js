(function () {
  'use strict';
  if (window.__saeumpumLoaded) return;
  window.__saeumpumLoaded = true;

  var O = location.origin;
  var APP = 'https://wooriwoosin.github.io/money/';
  var APP_ORIGIN = 'https://wooriwoosin.github.io';

  // ── 플로팅 버튼 ──
  function ensureBtn() {
    if (document.getElementById('saeumpum-fetch-btn') || !document.body) return;
    var b = document.createElement('button');
    b.id = 'saeumpum-fetch-btn';
    b.textContent = '📥 사은품 가져오기';
    b.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;background:#0969da;color:#fff;border:0;border-radius:24px;padding:12px 20px;font:14px/1 "Noto Sans KR",sans-serif;font-weight:700;box-shadow:0 2px 10px rgba(0,0,0,.3);cursor:pointer;';
    b.onclick = run;
    document.body.appendChild(b);
  }
  ensureBtn();
  // SPA 화면 전환으로 버튼이 사라질 경우 대비해 주기적으로 복구
  setInterval(ensureBtn, 3000);

  // ── 진행 표시 ──
  var prog;
  function showProg() {
    prog = document.createElement('div');
    prog.style.cssText = 'position:fixed;top:10px;right:10px;z-index:2147483647;background:#0969da;color:#fff;padding:10px 16px;border-radius:6px;font:13px sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3);';
    prog.textContent = 'workline 준비 중...';
    document.body.appendChild(prog);
  }
  function setp(t) { if (prog) prog.textContent = t; }
  function rmProg() { if (prog && prog.remove) prog.remove(); prog = null; }

  function getJSON(u) {
    return fetch(u, { credentials: 'include', headers: { 'Accept': 'application/json' } }).then(function (r) { return r.json(); });
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

  var bankMap = {};
  function loadBanks() {
    return getJSON(O + '/api/codes/bank').then(function (j) {
      var arr = (j && j.data) || [];
      arr.forEach(function (b) {
        if (b == null) return;
        var nm = b.name || b.label || b.text || '';
        if (b.id != null) bankMap[String(b.id)] = nm;
        if (b.code != null) bankMap[String(b.code)] = nm;
      });
    }).catch(function () {});
  }
  function bankName(code) { if (code == null) return ''; return bankMap[String(code)] || ('코드' + code); }
  function tagPart(nm) { nm = nm || ''; var k = nm.indexOf('/'); return k >= 0 ? nm.slice(k) : ''; }

  var buckets = { jajeom: [], hyeomnyeok: [], gaetong: [] };
  function loadDef(def) {
    var acc = [];
    function pg(page) {
      return getJSON(O + '/api/orders?size=200&page=' + page + '&' + def.q).then(function (j) {
        var d = (j && j.data) || {}; var it = d.items || []; acc = acc.concat(it);
        var p = d.pagination || {}; var tp = p.totalPages || 1; var tot = p.total || it.length;
        setp(def.key + ' 조회 ' + acc.length + ' / ' + tot);
        if (page < tp && page < 30) return pg(page + 1);
        return acc;
      });
    }
    return pg(1).then(function (a) { buckets[def.key] = a; });
  }

  var umap = {};
  function unmaskAll(list) {
    var i = 0, done = 0, CONC = 6, n = list.length;
    function w() {
      if (i >= n) return Promise.resolve();
      var it = list[i++];
      return getJSON(O + '/api/orders/' + it.id + '/unmask?variant=a')
        .then(function (j) { umap[it.id] = (j && j.data) || {}; })
        .catch(function () { umap[it.id] = {}; })
        .then(function () { done++; if (done % 5 === 0 || done === n) setp('상세조회 ' + done + ' / ' + n); return w(); });
    }
    var ws = []; for (var k = 0; k < CONC; k++) ws.push(w());
    return Promise.all(ws);
  }

  function build(list) {
    var rows = [];
    for (var i = 0; i < list.length; i++) {
      var L = list[i] || {}; var U = umap[L.id] || {}; var C = U.customer || {};
      var realName = C.name || (L.customerName || '').split('/')[0];
      var gg = realName + tagPart(L.customerName);
      var prod = (L.telecom === '모바일') ? '모바일' : (L.productName || L.telecom || '');
      rows.push({
        '고객명': gg,
        '상품명': prod,
        '협력점': L.partner || '',
        '사은품은행': bankName(U.spBankCode),
        '사은품계좌': U.spBankAccount || '',
        '현금': (U.spPrice != null ? U.spPrice : (L.cash || '')),
        '사은품예금주': U.spBankName || '',
        '사은품주민번호': U.spBankJumin || '',
        '명의자 연락처': C.mobile || L.mobile || '',
        '상부점': L.upperPoint || '',
        '개통일': (L.openDate || '').slice(0, 10),
        '개통기한': (L.openDeadline || '').slice(0, 10),
        '개통상태': L.openStatus || '',
        '접수경로': L.receiptRoute || '',
        '지급예정': L.payAdjust || '',
        '지급완료': L.payDone || '',
        '사은품 지급처': L.payTo || '',
        '접점코드': L.contactCode || ''
      });
    }
    return rows;
  }

  function fallbackCopy(text, note) {
    try { navigator.clipboard.writeText(text); } catch (e) {}
    var ta = document.createElement('textarea'); ta.value = text;
    ta.style.cssText = 'position:fixed;top:40px;left:2%;width:96%;height:70%;z-index:2147483647;font:12px monospace;background:#fff;color:#000;border:2px solid #0969da;';
    document.body.appendChild(ta); ta.focus(); ta.select();
    var b = document.createElement('button'); b.textContent = '닫기 X';
    b.style.cssText = 'position:fixed;top:5px;left:2%;z-index:2147483647;padding:6px 14px;background:#cf222e;color:#fff;border:0;border-radius:4px;';
    b.onclick = function () { ta.remove(); b.remove(); };
    document.body.appendChild(b);
    alert((note || '복사됨!') + '\n사은품 앱 → 붙여넣기(Ctrl+V) → 적용');
  }

  function sendToApp(payload, cnt) {
    var text = JSON.stringify(payload);
    var win = null; try { win = window.open(APP, 'saeumpum'); } catch (e) { win = null; }
    if (!win) { rmProg(); fallbackCopy(text, '팝업이 차단돼 자동전송 실패. 클립보드에 복사했어요.'); return; }
    setp('앱으로 전송 중... (' + cnt + ')');
    var acked = false, tries = 0;
    function send() { try { win.postMessage({ type: 'saeumpum-workline', payload: payload }, APP_ORIGIN); } catch (e) {} }
    function onMsg(ev) {
      if (ev.origin !== APP_ORIGIN) return;
      if (ev.data && ev.data.type === 'saeumpum-ready') send();
      if (ev.data && ev.data.type === 'saeumpum-ack') {
        acked = true; window.removeEventListener('message', onMsg); rmProg();
        try { win.focus(); } catch (e) {}
        alert('앱으로 전송 완료! (' + cnt + ')\n앱 탭에서 ⚡필터링 & 미리보기를 누르세요.');
      }
    }
    window.addEventListener('message', onMsg);
    send();
    var iv = setInterval(function () {
      if (acked) { clearInterval(iv); return; }
      tries++;
      if (tries > 16) { clearInterval(iv); if (!acked) { window.removeEventListener('message', onMsg); rmProg(); fallbackCopy(text, '앱 응답이 없어 자동전송 실패. 클립보드에 복사했어요.'); } return; }
      send();
    }, 500);
  }

  var running = false;
  function run() {
    if (running) return; running = true;
    var btn = document.getElementById('saeumpum-fetch-btn');
    if (btn) { btn.disabled = true; btn.style.opacity = '.5'; }
    showProg();

    var now = new Date();
    var today = ymd(now);
    var sd = new Date(now); sd.setDate(now.getDate() + ((7 - now.getDay()) % 7)); var sunday = ymd(sd);
    var pm = new Date(now.getFullYear(), now.getMonth() - 1, 1); var prevM1 = ymd(pm);
    var yd = new Date(now); yd.setDate(now.getDate() - 1); var yesterday = ymd(yd);
    var common = '&variant=a&spPrice=A&spGiveType=B';
    var defs = [
      { key: 'jajeom', q: 'dateField=goods5&dateFrom=' + today + '&dateTo=' + today + common },
      { key: 'hyeomnyeok', q: 'dateField=goods5&dateFrom=' + sunday + '&dateTo=' + sunday + common },
      { key: 'gaetong', q: 'dateField=goods6&dateFrom=' + prevM1 + '&dateTo=' + yesterday + common + '&courseId=14' }
    ];

    function finish() { running = false; if (btn) { btn.disabled = false; btn.style.opacity = '1'; } }

    loadBanks()
      .then(function () { return loadDef(defs[0]); })
      .then(function () { return loadDef(defs[1]); })
      .then(function () { return loadDef(defs[2]); })
      .then(function () {
        var uniq = [], seen = {};
        ['jajeom', 'hyeomnyeok', 'gaetong'].forEach(function (k) {
          buckets[k].forEach(function (it) { if (it && it.id != null && !seen[it.id]) { seen[it.id] = 1; uniq.push(it); } });
        });
        if (!uniq.length) { rmProg(); alert('조회된 데이터가 없습니다 (자점/협력/개통 0건).'); finish(); return; }
        if (uniq.length > 400 && !confirm(uniq.length + '건을 상세조회(unmask)합니다. 계속할까요?')) { rmProg(); finish(); return; }
        return unmaskAll(uniq).then(function () {
          var payload = { _meta: { today: today, sunday: sunday }, jajeom: build(buckets.jajeom), hyeomnyeok: build(buckets.hyeomnyeok), gaetong: build(buckets.gaetong) };
          var cnt = '자점 ' + payload.jajeom.length + ' · 협력 ' + payload.hyeomnyeok.length + ' · 개통 ' + payload.gaetong.length;
          // buckets 초기화(다음 실행 대비)
          sendToApp(payload, cnt);
          buckets = { jajeom: [], hyeomnyeok: [], gaetong: [] }; umap = {};
          finish();
        });
      })
      .catch(function (e) { rmProg(); alert('오류: ' + e.message); finish(); });
  }
})();
