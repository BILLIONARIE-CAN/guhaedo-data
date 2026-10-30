// 분양 단지 수집 (청약홈 APT 분양정보 + 경쟁률) → presale.json
// 매 실행: 최근 N년 공고 목록 동기화, 신규 단지만 지오코딩/경쟁률 조회 (기존 값 재사용)
// env: SERVICE_KEY(필수, 청약홈 2종 활용신청 필요), KAKAO_KEY(선택), YEARS(기본 4)

import fs from 'fs';
import path from 'path';

const KAKAO_KEY = process.env.KAKAO_KEY || 'be82d140cac4386ee76d82cc16c65c3e';
const YEARS = parseInt(process.env.YEARS || '4');
const OUT = path.join(process.cwd(), 'presale.json');

// 청약홈도 guhaedo.kr(Vercel) 프록시 경유 — GitHub Actions 해외 IP 차단 우회
const PROXY = process.env.PROXY_BASE || 'https://guhaedo.kr/api/diag';

// 기존 데이터 (지오코딩/경쟁률 캐시 재사용)
let prev = {};
try {
  const old = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  (old.items || []).forEach(x => { prev[x.id] = x; });
  console.log(`기존 ${Object.keys(prev).length}건 로드 (좌표/경쟁률 재사용)`);
} catch {}

async function jget(url, tries = 2) {
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      if (t === tries - 1) { console.log('  ⚠️ 호출 실패: ' + e.message); return null; }
      await new Promise(r2 => setTimeout(r2, 1500));
    }
  }
}

// ── 1. 분양 공고 목록 (페이지 루프) ──
const since = new Date(); since.setFullYear(since.getFullYear() - YEARS);
const sinceStr = since.toISOString().slice(0, 10);
let rows = [];
for (let page = 1; page <= 60; page++) {
  const url = `${PROXY}?op=applyhome&svc=detail&page=${page}&perPage=100&since=${sinceStr}`;
  const j = await jget(url);
  if (!j || !Array.isArray(j.data)) break;
  rows = rows.concat(j.data);
  console.log(`공고 목록 p${page}: +${j.data.length} (누적 ${rows.length}/${j.totalCount ?? '?'})`);
  if (rows.length >= (j.totalCount || 0) || j.data.length < 100) break;
}
if (!rows.length) { console.error('청약홈 응답 0건 — 활용신청 승인 여부/키 확인 필요'); process.exit(1); }

// ── 2. 지오코딩 (카카오, 신규만) ──
async function geocode(addr, name) {
  // 주소 정리: 괄호·블록표기 제거
  const q = String(addr || '').replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();
  const call = async (u) => {
    try {
      const r = await fetch(u, { headers: { Authorization: 'KakaoAK ' + KAKAO_KEY }, signal: AbortSignal.timeout(8000) });
      return await r.json();
    } catch { return null; }
  };
  let j = q ? await call(`https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(q)}`) : null;
  let d = j?.documents?.[0];
  if (!d && name) { // 폴백: 키워드 검색 (단지명)
    j = await call(`https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(name)}`);
    d = j?.documents?.[0];
    if (d) return { lat: parseFloat(d.y), lng: parseFloat(d.x), bcode: '' };
    return null;
  }
  if (!d) return null;
  return { lat: parseFloat(d.y), lng: parseFloat(d.x), bcode: d.address?.b_code || d.road_address?.b_code || '' };
}

// ── 3. 경쟁률 (접수 마감 단지만, 신규만) ──
async function fetchCmpet(houseNo) {
  const url = `${PROXY}?op=applyhome&svc=cmpet&page=1&perPage=50&houseNo=${encodeURIComponent(houseNo)}`;
  const j = await jget(url, 1);
  if (!j || !Array.isArray(j.data) || !j.data.length) return null;
  // 주택형별 → 평균/최고 (숫자만 추출, "12.30" 또는 "(△5) 12.3" 형태 방어)
  // "(△2) 3.5" 같은 표기 방어: 괄호부 제거 후 숫자 추출
  const rates = j.data.map(x => parseFloat(String(x.CMPET_RATE || '').replace(/\(.*?\)/g, '').replace(/[^0-9.]/g, ''))).filter(v => v > 0);
  if (!rates.length) return null;
  return { avg: Math.round(rates.reduce((a, b) => a + b, 0) / rates.length * 10) / 10, max: Math.round(Math.max(...rates) * 10) / 10 };
}

// ── 4. 조립 ──
const items = [];
let geoNew = 0, geoFail = 0, cmpNew = 0;
const today = new Date().toISOString().slice(0, 10);
for (const r of rows) {
  const id = String(r.HOUSE_MANAGE_NO || r.PBLANC_NO || '');
  if (!id) continue;
  const old = prev[id] || {};
  const it = {
    id,
    n: String(r.HOUSE_NM || '').trim(),
    addr: String(r.HSSPLY_ADRES || '').trim(),
    units: parseInt(r.TOT_SUPLY_HSHLDCO || '0') || 0,
    notice: r.RCRIT_PBLANC_DE || '',
    rcptB: r.RCEPT_BGNDE || '',
    rcptE: r.RCEPT_ENDDE || '',
    prz: r.PRZWNER_PRESNATN_DE || '',
    mvn: String(r.MVN_PREARNGE_YM || ''),
    builder: String(r.CNSTRCT_ENTRPS_NM || '').trim(),
    tel: String(r.MDHS_TELNO || '').trim(),
    hmpg: String(r.HMPG_ADRES || '').trim(),
    area: String(r.SUBSCRPT_AREA_CODE_NM || '').trim(),
    lat: old.lat || 0, lng: old.lng || 0, lawd: old.lawd || '',
    cmp: old.cmp || null
  };
  // 입주예정 + 10개월 지난 건 제외 (K-apt 일반 핀으로 전환됐을 시기)
  if (it.mvn && /^\d{6}$/.test(it.mvn)) {
    const exp = new Date(parseInt(it.mvn.slice(0, 4)), parseInt(it.mvn.slice(4, 6)) - 1 + 10, 1);
    if (exp < new Date()) continue;
  }
  // 지오코딩 (신규만)
  if (!it.lat) {
    const g = await geocode(it.addr, it.n + ' ' + it.area);
    if (g) { it.lat = g.lat; it.lng = g.lng; if (g.bcode) it.lawd = g.bcode.substring(0, 5); geoNew++; }
    else { geoFail++; console.log('  📍 지오코딩 실패: ' + it.n + ' / ' + it.addr); }
  }
  // 경쟁률 (접수 마감 + 미보유만)
  if (!it.cmp && it.rcptE && it.rcptE <= today) {
    it.cmp = await fetchCmpet(id);
    if (it.cmp) cmpNew++;
  }
  items.push(it);
}

items.sort((a, b) => (b.notice || '').localeCompare(a.notice || ''));
fs.writeFileSync(OUT, JSON.stringify({ u: today, items }, null, 0));
console.log(`완료 — 총 ${items.length}건 (지오코딩 신규 ${geoNew}, 실패 ${geoFail}, 경쟁률 신규 ${cmpNew})`);
