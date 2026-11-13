// 백그라운드: workline API를 쿠키와 함께 조회 (host_permissions 덕분에 인증된 요청 가능)
const WL = 'https://workline.kr';

// ── 봇 감지 회피용 요청 간격 (workline 제한: 상세 20건/10초, 목록 20번/5초) ──
// 고정 간격이라 어떤 10초(상세)·5초(목록) 구간에서도 한도 밑으로 보장됨.
const DETAIL_MS = 700;   // 상세조회 간격 → 약 14건/10초 (한도 20)
const LIST_MS   = 450;   // 목록조회 간격 → 약 12번/5초 (한도 20)
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getJSON(u) {
  return fetch(u, { credentials: 'include', headers: { 'Accept': 'application/json' } }).then(r => r.json());
}
function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

// 상세조회 없이 목록 데이터만으로 걸러낼 수 있는 조건 (대량이체 비대상 제거 → 상세조회 횟수 감소)
function eligible(L) {
  if ((L.openStatus || '') !== '개통완료') return false;
  if ((L.payTo || '') !== '웨이브넷 지급') return false;
  const pd = (L.payDone || '').trim();
  if (pd && pd !== '-' && pd !== '0') return false;
  return true;
}

async function collect(onProg) {
  onProg('workline 연결 확인...');
  let me;
  try { me = await getJSON(WL + '/api/auth/me'); }
  catch (e) { throw new Error('workline에 연결하지 못했습니다. (네트워크/권한 확인)'); }
  if (!me || me.success === false || !me.data) {
    throw new Error('workline 로그인이 필요합니다. 같은 브라우저에서 workline.kr에 로그인한 뒤 다시 눌러주세요.');
  }

  // 은행 코드맵
  const bankMap = {};
  try {
    const bj = await getJSON(WL + '/api/codes/bank');
    ((bj && bj.data) || []).forEach(b => {
      if (b == null) return;
      const nm = b.name || b.label || b.text || '';
      if (b.id != null) bankMap[String(b.id)] = nm;
      if (b.code != null) bankMap[String(b.code)] = nm;
    });
  } catch (e) {}
  const bankName = c => (c == null ? '' : (bankMap[String(c)] || ('코드' + c)));
  const tagPart = nm => { nm = nm || ''; const k = nm.indexOf('/'); return k >= 0 ? nm.slice(k) : ''; };

  // 날짜 자동 계산
  const now = new Date();
  const today = ymd(now);
  const sd = new Date(now); sd.setDate(now.getDate() + ((7 - now.getDay()) % 7)); const sunday = ymd(sd);
  const pm = new Date(now.getFullYear(), now.getMonth() - 1, 1); const prevM1 = ymd(pm);
  const yd = new Date(now); yd.setDate(now.getDate() - 1); const yesterday = ymd(yd);
  const common = '&variant=a&spPrice=A&spGiveType=B';
  const defs = [
    { key: 'jajeom', q: 'dateField=goods5&dateFrom=' + today + '&dateTo=' + today + common },
    { key: 'hyeomnyeok', q: 'dateField=goods5&dateFrom=' + sunday + '&dateTo=' + sunday + common },
    { key: 'gaetong', q: 'dateField=goods6&dateFrom=' + prevM1 + '&dateTo=' + yesterday + common + '&courseId=14' }
  ];

  // 목록 조회 (필터별, 페이징) — 목록 요청 사이에 간격을 둬 "목록 폭주" 회피
  const buckets = { jajeom: [], hyeomnyeok: [], gaetong: [] };
  let listCalls = 0;
  for (const def of defs) {
    let acc = [], page = 1;
    while (true) {
      if (listCalls > 0) await sleep(LIST_MS);
      const j = await getJSON(WL + '/api/orders?size=200&page=' + page + '&' + def.q);
      listCalls++;
      const d = (j && j.data) || {}; const it = d.items || []; acc = acc.concat(it);
      const p = d.pagination || {}; const tp = p.totalPages || 1; const tot = p.total || it.length;
      onProg(def.key + ' 조회 ' + acc.length + ' / ' + tot);
      if (page < tp && page < 30) { page++; continue; }
      break;
    }
    // 상세조회 전에 미리 거르기 (개통완료 + 웨이브넷지급 + 지급완료 없음)
    buckets[def.key] = acc.filter(eligible);
  }

  // 중복 제거 (상세조회 대상)
  const uniq = [], seen = {};
  ['jajeom', 'hyeomnyeok', 'gaetong'].forEach(k => buckets[k].forEach(it => {
    if (it && it.id != null && !seen[it.id]) { seen[it.id] = 1; uniq.push(it); }
  }));

  // unmask — "상세 폭주" 회피: 순차 처리 + 고정 간격(DETAIL_MS)
  const umap = {};
  for (let i = 0; i < uniq.length; i++) {
    const it = uniq[i];
    try { const j = await getJSON(WL + '/api/orders/' + it.id + '/unmask?variant=a'); umap[it.id] = (j && j.data) || {}; }
    catch (e) { umap[it.id] = {}; }
    const eta = Math.ceil((uniq.length - (i + 1)) * DETAIL_MS / 1000);
    onProg('상세조회 ' + (i + 1) + ' / ' + uniq.length + ' (과부하 방지 · 약 ' + eta + '초 남음)');
    if (i < uniq.length - 1) await sleep(DETAIL_MS);
  }

  // 행 생성 (앱 컬럼명)
  const build = list => list.map(L => {
    L = L || {}; const U = umap[L.id] || {}; const C = U.customer || {};
    const realName = C.name || ((L.customerName || '').split('/')[0]);
    const gg = realName + tagPart(L.customerName);
    const prod = (L.telecom === '모바일') ? '모바일' : (L.productName || L.telecom || '');
    return {
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
    };
  });

  return { _meta: { today, sunday }, jajeom: build(buckets.jajeom), hyeomnyeok: build(buckets.hyeomnyeok), gaetong: build(buckets.gaetong) };
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'saeumpum') return;
  port.onMessage.addListener(msg => {
    if (msg && msg.action === 'fetch') {
      collect(t => { try { port.postMessage({ type: 'progress', text: t }); } catch (e) {} })
        .then(payload => { try { port.postMessage({ type: 'done', payload }); } catch (e) {} })
        .catch(e => { try { port.postMessage({ type: 'error', error: e.message }); } catch (e) {} });
    }
  });
});
