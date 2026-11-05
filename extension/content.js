// 앱 페이지(사은품 앱)에 "workline 가져오기" 버튼 주입 → 클릭 시 백그라운드가 수집 → 앱에 자동 입력
(function () {
  'use strict';
  if (window.__saeumpumExtBtn) return;
  window.__saeumpumExtBtn = true;

  function addBtn() {
    if (document.getElementById('saeumpum-ext-btn') || !document.body) return;
    var b = document.createElement('button');
    b.id = 'saeumpum-ext-btn';
    b.textContent = '📥 workline 가져오기';
    b.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;background:#0969da;color:#fff;border:0;border-radius:24px;padding:12px 20px;font:14px/1 sans-serif;font-weight:700;box-shadow:0 2px 10px rgba(0,0,0,.3);cursor:pointer;';
    b.onclick = start;
    document.body.appendChild(b);
  }
  addBtn();
  setInterval(addBtn, 3000);

  var prog;
  function sp(t) {
    if (!prog) {
      prog = document.createElement('div');
      prog.style.cssText = 'position:fixed;top:10px;right:10px;z-index:2147483647;background:#0969da;color:#fff;padding:10px 16px;border-radius:6px;font:13px sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3);';
      document.body.appendChild(prog);
    }
    prog.textContent = t;
  }
  function rp() { if (prog) { prog.remove(); prog = null; } }

  var running = false;
  function reset() {
    running = false;
    var b = document.getElementById('saeumpum-ext-btn');
    if (b) { b.disabled = false; b.style.opacity = '1'; }
  }

  function start() {
    if (running) return;
    running = true;
    var b = document.getElementById('saeumpum-ext-btn');
    if (b) { b.disabled = true; b.style.opacity = '0.5'; }
    sp('workline 연결 중...');

    var port;
    try { port = chrome.runtime.connect({ name: 'saeumpum' }); }
    catch (e) { rp(); alert('확장앱 연결 실패: ' + e.message); reset(); return; }

    var finished = false;
    port.onMessage.addListener(function (m) {
      if (m.type === 'progress') { sp(m.text); }
      else if (m.type === 'done') { finished = true; rp(); apply(m.payload); try { port.disconnect(); } catch (e) {} reset(); }
      else if (m.type === 'error') { finished = true; rp(); alert('workline 가져오기 오류:\n' + m.error); try { port.disconnect(); } catch (e) {} reset(); }
    });
    port.onDisconnect.addListener(function () { if (!finished) { rp(); alert('확장앱 연결이 끊겼어요. 다시 시도해주세요.'); reset(); } });
    port.postMessage({ action: 'fetch' });
  }

  function apply(payload) {
    var ta = document.getElementById('worklinePaste');
    var ab = document.querySelector('button[onclick="applyWorkline()"]');
    if (ta && ab) {
      ta.value = JSON.stringify(payload);
      ab.click(); // 앱의 applyWorkline() 실행 → 자점/협력/개통 자동 분배
    } else {
      alert('앱 입력칸을 찾지 못했어요.\n로그인 후 "사은품 파일 생성" 화면이 열린 상태인지 확인하고 다시 시도해주세요.');
    }
  }
})();
