// ============================================================
// 사은품 입금 검증 시스템 - Google Apps Script
// 웨이브넷 유통사업부
// ============================================================

// ── 설정 ────────────────────────────────────────────────────
const CONFIG = {
  SPREADSHEET_ID: 'YOUR_SPREADSHEET_ID_HERE',  // ← 실제 스프레드시트 ID로 교체
  SHEET_PREFIX:   '입금내역_',   // 시트명: 입금내역_2026, 입금내역_2025 ...
  SETTING_SHEET:  '설정',
  DUP_MONTHS:     24,            // 중복 체크 기간 (개월) - 2025.01~
  SESSION_EXPIRE: 8 * 60 * 60 * 1000, // 세션 만료: 8시간
};

// ── 헤더 정의 (입금내역 시트 컬럼 순서) ─────────────────────
const DB_HEADERS = [
  '입금일자', '은행', '계좌번호', '금액', '수취인',
  '주민번호', '연락처', '받는분통장표시', '상부점',
  '소스', '고객명', '등록일시'
];
// 기존 DB(구글시트 직접입력)에서 없는 컬럼 위치 참고:
// col A=입금일자 B=은행 C=계좌번호 D=금액 E=수취인
// F=주민번호(공란) G=연락처(공란) H=받는분통장표시 I=상부점
// J=소스(공란) K=고객명 L=등록일시

// ============================================================
// 웹앱 진입점
// ============================================================
// GitHub Pages HTML에서 fetch로 호출하는 엔드포인트
// 배포 설정: 실행=나, 액세스=모든사용자(익명포함)
function doGet(e) {
  // GET 요청: ping 또는 단순 확인용
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, message: 'GAS API Server Running' }))
    .setMimeType(ContentService.MimeType.JSON);
}

// google.script.run 에서 호출하는 핸들러 (클라이언트 HTML에서 직접 호출)
function handleRequest(jsonStr) {
  try {
    const params = JSON.parse(jsonStr);
    const action = params.action;

    if (action === 'login') return JSON.stringify(login(params));

    if (!validateSession(params.sessionToken)) {
      return JSON.stringify({ ok: false, error: '세션이 만료됐습니다. 다시 로그인해주세요.' });
    }

    switch (action) {
      case 'checkDuplicate':    return JSON.stringify(checkDuplicate(params.payments, params.payDate));
      case 'savePayments':       return JSON.stringify(savePayments(params.payments, params.payDate));
      case 'saveBankFile':       return JSON.stringify(saveBankFile(params.rows, params.sangbu));
      case 'getHistory':         return JSON.stringify(getHistory(params.page, params.keyword));
      case 'getStats':           return JSON.stringify(getStats());
      default: return JSON.stringify({ ok: false, error: '알 수 없는 액션' });
    }
  } catch (err) {
    return JSON.stringify({ ok: false, error: err.message });
  }
}

// doPost - GitHub Pages HTML에서 fetch POST로 호출
function doPost(e) {
  try {
    const result = handleRequest(e.postData.contents);
    return ContentService
      .createTextOutput(result)
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function respond(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// 로그인 / 세션
// ============================================================
function login(params) {
  const { username, password } = params;
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const settingSheet = ss.getSheetByName(CONFIG.SETTING_SHEET);
  if (!settingSheet) return { ok: false, error: '설정 시트가 없습니다.' };

  // 설정 시트 A열=아이디, B열=비밀번호(해시), C열=권한
  const data = settingSheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const [id, pw] = data[i];
    if (id === username && pw === hashPassword(password)) {
      const token = generateToken();
      // 세션 저장 (PropertiesService)
      const props = PropertiesService.getScriptProperties();
      props.setProperty(`session_${token}`, JSON.stringify({
        username,
        expires: Date.now() + CONFIG.SESSION_EXPIRE
      }));
      return { ok: true, token, username };
    }
  }
  return { ok: false, error: '아이디 또는 비밀번호가 틀렸습니다.' };
}

function validateSession(token) {
  if (!token) return false;
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(`session_${token}`);
  if (!raw) return false;
  const session = JSON.parse(raw);
  if (Date.now() > session.expires) {
    props.deleteProperty(`session_${token}`);
    return false;
  }
  return true;
}

function generateToken() {
  return Utilities.getUuid().replace(/-/g, '');
}

function hashPassword(pw) {
  // SHA-256 해시
  const raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    pw,
    Utilities.Charset.UTF_8
  );
  return raw.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}

// ============================================================
// 고객명 특수기호 제거 (이름만 추출)
// ============================================================
function cleanName_(raw) {
  if (!raw) return '';
  // 슬래시 이후 부가정보 제거: "홍길동/OSS", "홍길동/동판/ㅇㄱ" → "홍길동"
  const slashIdx = String(raw).indexOf('/');
  const base = slashIdx >= 0 ? String(raw).slice(0, slashIdx) : String(raw);
  // 특수기호 제거 (한글/영문/숫자/공백만 유지)
  return base.replace(/[^가-힣a-zA-Z0-9\s]/g, '').trim();
}

// ============================================================
// 은행 대량이체 결과 파일 저장
// ============================================================
// rows: [{date, bank, acc, amt, name, memo, bankMemo}]
// sangbu: 내부메모에서 자동 추출되므로 rows 내 포함
function saveBankFile(rows, sangbuOverride) {
  if (!rows || !rows.length) return { ok: true, saved: 0 };

  // 동시 저장 직렬화 (savePayments와 동일)
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (e) {
    return { ok: false, error: '다른 저장이 진행 중입니다. 잠시 후 다시 시도해주세요.' };
  }

  try {
    const ss   = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const now  = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');

    // 연도별로 그룹핑하여 해당 시트에 저장
    const byYear = {};
    for (const r of rows) {
      const year = String(r.date || '').slice(0, 4) || new Date().getFullYear().toString();
      if (!byYear[year]) byYear[year] = [];
      byYear[year].push(r);
    }

    let totalSaved = 0;
    for (const [year, yearRows] of Object.entries(byYear)) {
      const sheetName = CONFIG.SHEET_PREFIX + year;
      let sheet = ss.getSheetByName(sheetName);
      if (!sheet) {
        sheet = ss.insertSheet(sheetName);
        sheet.appendRow(DB_HEADERS);
        const header = sheet.getRange(1, 1, 1, DB_HEADERS.length);
        header.setBackground('#4a4a6a').setFontColor('#ffffff').setFontWeight('bold');
        sheet.setFrozenRows(1);
      }
      const dbRows = yearRows.map(r => [
        r.date || '',
        r.bank || '',
        String(r.acc || '').replace(/[-\s]/g, ''),
        Number(r.amt) || 0,
        r.name || '',
        '',  // 주민번호
        '',  // 연락처
        r.bankMemo || '인터넷사은금',
        r.sangbu || sangbuOverride || '',
        '은행파일',  // 소스
        '',  // 고객명 (은행파일엔 없음)
        now,
      ]);
      sheet.getRange(sheet.getLastRow() + 1, 1, dbRows.length, DB_HEADERS.length).setValues(dbRows);
      totalSaved += dbRows.length;
    }
    SpreadsheetApp.flush();  // 응답 반환 전 쓰기 확정
    return { ok: true, saved: totalSaved };
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// checkDuplicate - 가족계좌 구분 로직 포함
// ============================================================

// payDate: 이체 날짜 (YYYY-MM-DD) - 이 날짜의 입금은 중복에서 제외 (같은날 다상품 허용)
function checkDuplicate(payments, payDate) {
  if (!payments || !payments.length) return { ok: true, results: [] };

  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - CONFIG.DUP_MONTHS);

  const sheets = getRecentSheets(ss, cutoffDate);

  // 조회할 계좌번호 Set (DB 전체 스캔 대신 필요한 것만 매핑)
  const targetAccs = new Set(
    payments.map(p => String(p.계좌번호 || p.계좌 || '').replace(/[-\s]/g, '').trim())
            .filter(Boolean)
  );

  // DB에서 계좌번호 맵 생성 {cleanAcc → [{date, amt, name, sangbu, bank}]}
  const accMap = {};
  for (const sheet of sheets) {
    const rows = sheet.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      const [date, bank, acc, amt, name,,,,sangbu] = rows[i];
      const cleanAcc = String(acc).replace(/[-\s]/g, '').trim();
      if (!cleanAcc || !targetAccs.has(cleanAcc)) continue;  // 대상 계좌만 처리
      const dateObj = new Date(date);
      if (isNaN(dateObj) || dateObj < cutoffDate) continue;
      const dateStr = Utilities.formatDate(dateObj, 'Asia/Seoul', 'yyyy-MM-dd');
      if (!accMap[cleanAcc]) accMap[cleanAcc] = [];
      const custName = rows[i][10] ? String(rows[i][10]) : '';
      accMap[cleanAcc].push({ date: dateStr, amt: Number(amt), name: String(name), custName, sangbu: String(sangbu), bank: String(bank) });
    }
  }

  // 제외할 날짜: 파라미터로 받은 이체날짜 (없으면 오늘)
  const excludeDate = payDate || Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');

  const results = payments.map(p => {
    const cleanAcc = String(p.계좌번호 || p.계좌 || '').replace(/[-\s]/g, '').trim();
    const history  = accMap[cleanAcc] || [];

    // 이체 날짜 제외 (같은 날 다상품 입금은 중복 아님)
    const prevHistory = history.filter(h => h.date !== excludeDate);

    // 가족계좌 구분:
    // 수취인(예금주)은 같은데 고객명이 다른 경우 = 가족계좌 정상 입금
    // 수취인도 같고 고객명도 같은 경우 = 진짜 중복
    const payeeName  = String(p.수취인 || '').trim();
    const custName   = cleanName_(p.고객명 || p.수취인 || '');

    const realDup = prevHistory.filter(h => {
      // 수취인이 다르면 중복 아님
      if (h.name && payeeName && h.name !== payeeName) return false;
      // 고객명이 둘 다 있고 다르면 → 가족계좌 → 중복 아님
      if (h.custName && custName && h.custName !== custName) return false;
      return true;
    });
    const familyHistory = prevHistory.filter(h =>
      h.custName && custName && h.custName !== custName
    );

    return {
      계좌번호:      cleanAcc,
      수취인:        p.수취인,
      금액:          p.금액,
      상부점:        p.상부점,
      고객명:        custName,
      isDuplicate:   realDup.length > 0,
      isFamilyAcct:  familyHistory.length > 0 && realDup.length === 0,
      history:       realDup,
      familyHistory,
    };
  });

  const dupCount = results.filter(r => r.isDuplicate).length;
  return { ok: true, results, dupCount, checkedCount: payments.length };
}

// ============================================================
// 입금 데이터 저장
// ============================================================
function savePayments(payments, payDate) {
  if (!payments || !payments.length) return { ok: true, saved: 0 };

  // 동시 저장 직렬화: getLastRow 경쟁·"too many simultaneous invocations" HTML 오류 방지
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (e) {
    return { ok: false, error: '다른 저장이 진행 중입니다. 잠시 후 다시 시도해주세요.' };
  }

  try {
    const ss   = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const year = payDate ? payDate.slice(0, 4) : new Date().getFullYear().toString();
    const sheetName = CONFIG.SHEET_PREFIX + year;

    // 시트 없으면 생성
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      sheet.appendRow(DB_HEADERS);
      // 헤더 스타일
      const header = sheet.getRange(1, 1, 1, DB_HEADERS.length);
      header.setBackground('#4a4a6a').setFontColor('#ffffff').setFontWeight('bold');
      sheet.setFrozenRows(1);
    }

    const now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
    const rows = payments.map(p => [
      payDate || Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd'),
      p.은행      || '',
      String(p.계좌번호 || p.계좌 || '').replace(/[-\s]/g, ''),
      Number(p.금액) || 0,
      p.수취인    || '',
      p.주민번호  || '',
      p.연락처    || '',
      p.받는분통장표시 || '인터넷사은금',
      p.상부점    || '',
      p.소스      || '',
      cleanName_(p.고객명 || p.수취인 || ''),  // 특수기호 제거한 이름
      now,
    ]);

    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, DB_HEADERS.length)
         .setValues(rows);
    SpreadsheetApp.flush();  // 응답 반환 전 쓰기 확정

    return { ok: true, saved: rows.length, sheet: sheetName };
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// 내역 조회 (페이지네이션)
// ============================================================
function getHistory(page = 1, keyword = '') {
  const PAGE_SIZE = 50;
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - CONFIG.DUP_MONTHS);

  const sheets = getRecentSheets(ss, cutoff);
  let allRows = [];

  for (const sheet of sheets) {
    const rows = sheet.getDataRange().getValues().slice(1); // 헤더 제외
    allRows = allRows.concat(rows);
  }

  // 키워드 필터
  if (keyword) {
    const kw = keyword.toLowerCase();
    allRows = allRows.filter(r =>
      r.some(cell => String(cell).toLowerCase().includes(kw))
    );
  }

  // 날짜 역순 정렬
  allRows.sort((a, b) => new Date(b[0]) - new Date(a[0]));

  const total = allRows.length;
  const start = (page - 1) * PAGE_SIZE;
  const pageData = allRows.slice(start, start + PAGE_SIZE);

  return {
    ok: true,
    total,
    page,
    pageSize: PAGE_SIZE,
    totalPages: Math.ceil(total / PAGE_SIZE),
    rows: pageData.map(r => ({
      입금일자: r[0] ? Utilities.formatDate(new Date(r[0]), 'Asia/Seoul', 'yyyy-MM-dd') : '',
      은행:     r[1], 계좌번호: r[2], 금액: r[3], 수취인: r[4],
      주민번호: r[5], 연락처:  r[6], 통장표시: r[7], 상부점: r[8],
      소스:    r[9], 고객명:  r[10], 등록일시: r[11],
    })),
  };
}

// ============================================================
// 통계
// ============================================================
function getStats() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 1); // 최근 1개월
  const sheets = getRecentSheets(ss, cutoff);

  let totalAmt = 0, totalCnt = 0;
  const byDate = {}, bySangbu = {};

  for (const sheet of sheets) {
    const rows = sheet.getDataRange().getValues().slice(1);
    for (const r of rows) {
      const date   = r[0] ? Utilities.formatDate(new Date(r[0]), 'Asia/Seoul', 'yyyy-MM-dd') : '';
      const amt    = Number(r[3]) || 0;
      const sangbu = String(r[8]) || '기타';
      totalAmt += amt;
      totalCnt++;
      byDate[date]     = (byDate[date]     || 0) + amt;
      bySangbu[sangbu] = (bySangbu[sangbu] || 0) + amt;
    }
  }

  return { ok: true, totalAmt, totalCnt, byDate, bySangbu };
}

// ============================================================
// 유틸 - 최근 시트 목록 (연도 기준)
// ============================================================
function getRecentSheets(ss, cutoffDate) {
  const cutoffYear = cutoffDate.getFullYear();
  const thisYear   = new Date().getFullYear();
  const result = [];
  for (let y = cutoffYear; y <= thisYear; y++) {
    const sheet = ss.getSheetByName(CONFIG.SHEET_PREFIX + y);
    if (sheet) result.push(sheet);
  }
  return result;
}

// ============================================================
// 초기 설정 (최초 1회 실행)
// ============================================================
function initializeSystem() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);

  // 설정 시트 생성
  let setting = ss.getSheetByName(CONFIG.SETTING_SHEET);
  if (!setting) {
    setting = ss.insertSheet(CONFIG.SETTING_SHEET);
    setting.appendRow(['아이디', '비밀번호(SHA256)', '권한', '이름']);
    // 기본 관리자 계정: admin / wavenet2024!
    setting.appendRow([
      'admin',
      hashPassword('wavenet2024!'),
      'admin',
      '관리자'
    ]);
    setting.getRange(1, 1, 1, 4).setBackground('#4a4a6a').setFontColor('#fff').setFontWeight('bold');
    Logger.log('설정 시트 생성 완료. 기본 계정: admin / wavenet2024!');
  }

  // 올해 입금내역 시트 생성
  const year = new Date().getFullYear().toString();
  if (!ss.getSheetByName(CONFIG.SHEET_PREFIX + year)) {
    const sheet = ss.insertSheet(CONFIG.SHEET_PREFIX + year);
    sheet.appendRow(DB_HEADERS);
    sheet.getRange(1, 1, 1, DB_HEADERS.length).setBackground('#4a4a6a').setFontColor('#fff').setFontWeight('bold');
    sheet.setFrozenRows(1);
    Logger.log('입금내역 시트 생성: ' + CONFIG.SHEET_PREFIX + year);
  }

  Logger.log('초기화 완료!');
}
