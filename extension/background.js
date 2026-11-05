// 백그라운드: workline API를 쿠키와 함께 조회 (host_permissions 덕분에 인증된 요청 가능)
const WL = 'https://workline.kr';

function getJSON(u) {
  return fetch(u, { credentials: 'include', headers: { 'Accept': 'application/json' } }).then(r => r.json());
}
function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

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

  // 목록 조회 (필터별, 페이징)
  const buckets = { jajeom: [], hyeomnyeok: [], gaetong: [] };
  for (const def of defs) {
    let acc = [], page = 1;
    while (true) {
      const j = await getJSON(WL + '/api/orders?size=200&page=' + page + '&' + def.q);
      const d = (j && j.data) || {}; const it = d.items || []; acc = acc.concat(it);
      const p = d.pagination || {}; const tp = p.totalPages || 1; const tot = p.total || it.length;
      onProg(def.key + ' 조회 ' + acc.length + ' / ' + tot);
      if (page < tp && page < 30) { page++; continue; }
      break;
    }
    buckets[def.key] = acc;
  }

  // 중복 제거
  const uniq = [], seen = {};
  ['jajeom', 'hyeomnyeok', 'gaetong'].forEach(k => buckets[k].forEach(it => {
    if (it && it.id != null && !seen[it.id]) { seen[it.id] = 1; uniq.push(it); }
  }));

  // unmask (동시 6)
  const umap = {};
  let done = 0;
  async function worker(iter) {
    for (const it of iter) {
      try { const j = await getJSON(WL + '/api/orders/' + it.id + '/unmask?variant=a'); umap[it.id] = (j && j.data) || {}; }
      catch (e) { umap[it.id] = {}; }
      done++;
      if (done % 5 === 0 || done === uniq.length) onProg('상세조회 ' + done + ' / ' + uniq.length);
    }
  }
  const queues = [[], [], [], [], [], []];
  uniq.forEach((it, idx) => queues[idx % 6].push(it));
  await Promise.all(queues.map(q => worker(q)));

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
