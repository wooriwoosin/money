// 백그라운드: workline '엑셀 내보내기(export)'를 대신 실행 → xlsx 받아 파싱 → 앱에 전달
// 상세조회(unmask)/목록조회를 안 해서 봇 제한을 아예 안 거치고, 수동 엑셀과 동일한 데이터.
importScripts('xlsx.full.min.js');

const WL = 'https://workline.kr';
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function getJSON(u) { return fetch(u, { credentials: 'include', headers: { 'Accept': 'application/json' } }).then(r => r.json()); }
function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

// 엑셀 바이너리 → 행 배열 (앱의 parseNormalXls와 동일: type array, defval '', raw false, 헤더 trim)
function parseXlsxBuf(buf) {
  const wb = XLSX.read(buf, { type: 'array', cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
  return raw.map(row => { const o = {}; Object.keys(row).forEach(k => { o[String(k).trim()] = row[k]; }); return o; });
}

// 한 필터에 대해: 내보내기 생성 → 완료 대기 → 다운로드 → 파싱
async function exportFilter(def, onProg) {
  const c = await getJSON(WL + '/api/orders/export?size=10000&history=1&' + def.q);
  const jobId = c && c.job && c.job.jobId;
  if (!jobId) throw new Error(def.key + ' 내보내기 생성 실패');
  let job = (c && c.job) || {};
  for (let t = 0; t < 90 && !(job.status === 'done' && job.downloadable); t++) {
    await sleep(700);
    const pj = await getJSON(WL + '/api/orders/export-jobs/' + jobId);
    job = (pj && pj.job) || {};
    if (job.error) throw new Error(def.key + ' 내보내기 오류: ' + job.error);
    onProg(def.key + ' 내보내기 ' + (job.percent || 0) + '%');
  }
  if (!(job.status === 'done' && job.downloadable)) throw new Error(def.key + ' 내보내기 시간초과');
  onProg(def.key + ' 파일 받는 중...');
  const resp = await fetch(WL + '/api/orders/export-jobs/' + jobId + '/download', { credentials: 'include' });
  const buf = await resp.arrayBuffer();
  const rows = parseXlsxBuf(buf);
  onProg(def.key + ' 완료 (' + rows.length + '건)');
  return rows;
}

async function collect(onProg) {
  onProg('workline 연결 확인...');
  let me;
  try { me = await getJSON(WL + '/api/auth/me'); }
  catch (e) { throw new Error('workline에 연결하지 못했습니다. (네트워크/권한 확인)'); }
  if (!me || me.success === false || !me.data) {
    throw new Error('workline 로그인이 필요합니다. 같은 브라우저에서 workline.kr에 로그인한 뒤 다시 눌러주세요.');
  }

  // 날짜 자동 계산 (자점=오늘, 협력=이번주 일요일, 개통=전월1일~전일)
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

  const out = { _meta: { today, sunday }, jajeom: [], hyeomnyeok: [], gaetong: [] };
  for (const def of defs) {
    out[def.key] = await exportFilter(def, onProg);
  }
  return out;
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
