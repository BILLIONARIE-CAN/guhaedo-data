// 실거래 사전적재 빌더 (guhaedo-data)
// - 매 실행: ① 전 시군구 최근 3개월 갱신(증분) ② 남은 호출예산으로 과거 백필(최근→과거)
// - 산출물: trades/{단지코드}.json  (compact 배열: b=매매, j=전세, m=월세)
// - 상태: progress.json (시군구별 백필 커서) — 완료되면 증분만 수행
// 환경변수: SERVICE_KEY(필수), BUDGET(국토부 호출 예산, 기본 9000), START_YM(백필 한계, 기본 200601)

import fs from 'fs';
import path from 'path';

const KEY = encodeURIComponent(process.env.SERVICE_KEY || '');
const BUDGET = parseInt(process.env.BUDGET || '3000'); // 프록시 1콜=국토부 3콜이므로 3000=9000콜/일
const START_YM = parseInt(process.env.START_YM || '200601');
const COORDS_BASE = process.env.COORDS_BASE || 'https://guhaedo.kr/split_output/coords_apt_';
const OUT = path.join(process.cwd(), 'trades');
const PROG = path.join(process.cwd(), 'progress.json');
if (!process.env.SERVICE_KEY) { console.error('SERVICE_KEY 환경변수 필요'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

// 전국 시군구 LAWD_CD (split_output 파일 기준 250개)
const LAWDS = ("11110 11140 11170 11200 11215 11230 11260 11290 11305 11320 11350 11380 11410 11440 11470 11500 11530 11545 11560 11590 11620 11650 11680 11710 11740 " +
"26110 26140 26170 26200 26230 26260 26290 26320 26350 26380 26410 26440 26470 26500 26530 26710 " +
"27110 27140 27170 27200 27230 27260 27290 27710 27720 " +
"28110 28140 28177 28185 28200 28237 28245 28260 28710 28720 " +
"29110 29140 29155 29170 29200 30110 30140 30170 30200 30230 31110 31140 31170 31200 31710 36110 " +
"41111 41113 41115 41117 41131 41133 41135 41150 41171 41173 41192 41194 41196 41210 41220 41250 41271 41273 41281 41285 41287 41310 41360 41370 41390 41410 41430 41450 41461 41463 41465 41480 41500 41550 41551 41570 41571 41591 41592 41593 41594 41610 41630 41631 41650 41670 41830 " +
"43111 43112 43113 43114 43130 43150 43720 43730 43740 43745 43750 43760 43770 43800 " +
"44131 44133 44150 44180 44200 44210 44230 44250 44270 44710 44760 44770 44790 44800 44810 44825 " +
"46110 46130 46150 46170 46230 46710 46720 46730 46770 46780 46790 46800 46810 46820 46830 46840 46860 46870 46880 46890 46900 " +
"47111 47113 47130 47150 47170 47190 47210 47230 47250 47280 47290 47730 47750 47760 47770 47820 47830 47840 47850 47920 47940 " +
"48121 48123 48125 48127 48129 48170 48220 48240 48250 48270 48310 48330 48720 48730 48740 48820 48840 48850 48860 48870 48880 48890 " +
"50110 50130 " +
"51110 51130 51150 51170 51190 51210 51230 51720 51730 51750 51760 51770 51780 51790 51800 51810 51820 51830 " +
"52111 52113 52130 52140 52180 52190 52210 52710 52720 52730 52740 52750 52770 52790 52800").trim().split(/\s+/);

// ───────── 매칭 로직 v4 (사이트 api/trade.js와 동일) ─────────
function nrm(s) {
  let t = String(s || '').trim().replace(/[\s()（）·\-\/]/g, '').toUpperCase();
  for (let i = 0; i < 2; i++) t = t.replace(/(아파트|APT|맨션|관리사무소|관리동)$/, '');
  return t;
}
function parseJb(s) { const m = String(s || '').trim().match(/^산?(\d+)(?:-(\d+))?/); return m ? { bon: parseInt(m[1]), bu: m[2] != null ? parseInt(m[2]) : null } : null; }
function parseAddr(addr) {
  const parts = String(addr || '').trim().replace(/\s+/g, ' ').split(' ');
  let passed = false, jb = null; const dongs = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (/^산?\d+(-\d+)?(번지)?$/.test(p)) {
      if (i > 0 && /[로길]$/.test(parts[i - 1])) break;
      jb = parseJb(p.replace(/번지$/, '')); break;
    }
    if (!passed) { if (/[시군구]$/.test(p)) passed = true; continue; }
    if (/[동읍면리가]$/.test(p)) dongs.push(p);
  }
  return { dong: dongs.join(''), jb };
}
function buildCx(a) {
  const pa = parseAddr(a.jibunAddr || a.addr || '');
  return {
    code: a.code, name: a.name,
    nm: nrm(a.name),
    dong: pa.dong || String(a.emd || '').replace(/\s/g, ''),
    jb: pa.jb,
    by: parseInt(String(a.built || '').replace(/[^0-9]/g, '').substring(0, 4)) || 0
  };
}
function dongOk(cx, d) {
  if (!cx.dong) return true;
  const xd = String(d || '').replace(/\s/g, '');
  if (!xd) return true;
  return cx.dong.includes(xd) || xd.includes(cx.dong);
}
function jbOk(a, b) { return !!(a && b && a.bon === b.bon && (a.bu == null || b.bu == null || a.bu === b.bu)); }
// it: {n,d,j,by,c}
function matchItem(cx, it) {
  if (it.c) return false;
  if (cx.by && it.by && (it.by < cx.by - 1 || it.by > cx.by + 1)) return false;
  const xj = parseJb(it.j);
  if (cx.jb && cx.dong && xj && xj.bon === cx.jb.bon && (cx.jb.bu == null || xj.bu == null || xj.bu === cx.jb.bu) && dongOk(cx, it.d)) return true;
  const n = nrm(it.n);
  if (!n || !cx.nm) return false;
  if (n === cx.nm) {
    if (dongOk(cx, it.d)) { if (cx.dong) return true; return !xj || !cx.jb || xj.bon === cx.jb.bon; }
    return !!(xj && cx.jb && xj.bon === cx.jb.bon && xj.bu != null && cx.jb.bu != null && xj.bu === cx.jb.bu);
  }
  if (!dongOk(cx, it.d)) return false;
  const L = Math.min(n.length, cx.nm.length);
  if (L < 4) return false;
  if (!n.includes(cx.nm) && !cx.nm.includes(n)) return false;
  const big = n.length >= cx.nm.length ? n : cx.nm;
  const small = big === n ? cx.nm : n;
  const extra = big.replace(small, '');
  const bonOk = jbOk(xj, cx.jb);
  if (L >= 5) return bonOk || (!/\d/.test(extra) && extra.length <= 4);
  return bonOk;
}

// ───────── 수집 경로: guhaedo.kr(Vercel) 프록시 경유 ─────────
// GitHub Actions(해외 IP)에서 국토부 API 직접 호출이 차단되므로,
// 국내 호출이 검증된 자체 API(api/diag.js op=district)를 통해 받아온다.
// 프록시 1콜 = 국토부 3콜(매매/전월세/분양권) + Supabase 캐싱 부수효과.
const PROXY = process.env.PROXY_BASE || 'https://guhaedo.kr/api/diag';
let used = 0, apiErrors = 0;

// 한 시군구의 한 달 처리 → compact 거래 목록 (실패 시 null)
async function fetchMonth(lawd, ym) {
  for (let t = 0; t < 2; t++) {
    used++;
    try {
      const r = await fetch(`${PROXY}?op=district&lawdCd=${lawd}&ym=${ym}`, { signal: AbortSignal.timeout(25000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j.apiError) throw new Error('upstream');
      return { buy: j.buy || [], rent: j.rent || [], pre: j.pre || [] };
    } catch (e) {
      if (t === 1) { apiErrors++; return null; }
      await new Promise(r2 => setTimeout(r2, 1500));
    }
  }
}

// 단지 파일 로드/저장
function loadAptFile(code) {
  const f = path.join(OUT, code + '.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return { n: '', u: '', b: [], j: [], m: [] }; }
}
const dirty = new Map();
function applyMonth(cx, ymInt, deals) {
  const key = cx.code;
  const file = dirty.get(key) || loadAptFile(key);
  file.n = cx.name;
  // 해당 월 기존 행 제거 후 재삽입 (해제/정정 반영)
  ['b', 'j', 'm'].forEach(k => { file[k] = (file[k] || []).filter(row => row[0] !== ymInt); });
  for (const it of deals.buy) if (matchItem(cx, it)) {
    file.b.push([ymInt, it.dy || 0, it.p || 0, it.a || 0, it.f || '']);
  }
  for (const it of deals.pre) if (matchItem(cx, it)) {
    file.b.push([ymInt, it.dy || 0, it.p || 0, it.a || 0, it.f || '', it.own === 2 ? 2 : 1]);
  }
  for (const it of deals.rent) if (matchItem(cx, it)) {
    if ((it.rent || 0) > 0) file.m.push([ymInt, it.dy || 0, it.dep || 0, it.rent, it.a || 0, it.f || '']);
    else file.j.push([ymInt, it.dy || 0, it.dep || 0, it.a || 0, it.f || '']);
  }
  dirty.set(key, file);
}
function flushDirty() {
  const today = new Date().toISOString().slice(0, 10);
  for (const [code, file] of dirty) {
    file.u = today;
    ['b', 'j', 'm'].forEach(k => file[k].sort((a, b2) => b2[0] - a[0] || b2[1] - a[1]));
    fs.writeFileSync(path.join(OUT, code + '.json'), JSON.stringify(file));
  }
  console.log(`  저장: ${dirty.size}개 단지 파일`);
  dirty.clear();
}

// coords 캐시
const coordsCache = new Map();
async function getCxList(lawd) {
  if (coordsCache.has(lawd)) return coordsCache.get(lawd);
  try {
    const r = await fetch(COORDS_BASE + lawd + '.json', { signal: AbortSignal.timeout(15000) });
    const arr = await r.json();
    const list = (Array.isArray(arr) ? arr : []).map(buildCx).filter(c => c.code);
    coordsCache.set(lawd, list);
    return list;
  } catch { coordsCache.set(lawd, []); return []; }
}

// 월 유틸
function ymAdd(ymInt, delta) {
  let y = Math.floor(ymInt / 100), m = ymInt % 100 - 1 + delta;
  y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
  return y * 100 + m + 1;
}
function nowYm() { const d = new Date(); return d.getFullYear() * 100 + d.getMonth() + 1; }

// 시군구 하나에 월 목록 처리 (예산 내에서) → 처리한 월 수
async function processMonths(lawd, ymList) {
  const cxs = await getCxList(lawd);
  if (!cxs.length) return ymList.length; // 단지 없음 → 스킵 처리
  let done = 0;
  for (const ymInt of ymList) {
    if (used + 1 > BUDGET) break;
    const deals = await fetchMonth(lawd, String(ymInt));
    if (deals === null) { console.log(`  ⚠️ ${lawd} ${ymInt} 실패 — 다음 실행에서 재시도`); break; }
    for (const cx of cxs) applyMonth(cx, ymInt, deals);
    done++;
  }
  flushDirty();
  return done;
}

// ───────── 메인 ─────────
const prog = (() => { try { return JSON.parse(fs.readFileSync(PROG, 'utf8')); } catch { return { cursor: {} }; } })();
prog.cursor = prog.cursor || {};
const NOW = nowYm();

console.log(`시작 — 예산 ${BUDGET}콜, 백필 한계 ${START_YM}`);

// ① 증분: 백필을 시작한 모든 시군구의 최근 3개월 갱신
//    (백필이 몇 주 걸려도 신규 월·해제 반영이 누락되지 않도록)
for (const lawd of LAWDS) {
  if (used + 3 > BUDGET) { console.log('예산 소진 — 증분 중단'); break; }
  if (prog.cursor[lawd] == null) continue; // 백필 시작 전 → 백필 단계에서 최근부터 처리
  await processMonths(lawd, [NOW, ymAdd(NOW, -1), ymAdd(NOW, -2)]);
}
console.log(`증분 완료 — 사용 ${used}콜`);

// ② 백필: 커서에서 과거로 (최근 월부터 내려감)
for (const lawd of LAWDS) {
  if (used + 1 > BUDGET) break;
  let cur = prog.cursor[lawd];
  if (cur === 'done') continue;
  let next = cur == null ? NOW : ymAdd(parseInt(cur), -1); // 커서 = 마지막으로 완료한 월
  while (next >= START_YM && used + 1 <= BUDGET) {
    const months = [];
    for (let i = 0; i < 6 && next >= START_YM; i++) { months.push(next); next = ymAdd(next, -1); }
    const done = await processMonths(lawd, months);
    if (done < months.length) { next = months[done]; break; } // 실패/예산 → 커서 보존
  }
  prog.cursor[lawd] = next < START_YM ? 'done' : String(ymAdd(next, 1));
  fs.writeFileSync(PROG, JSON.stringify(prog, null, 1));
  if (prog.cursor[lawd] === 'done') console.log(`✅ ${lawd} 백필 완료`);
}

const doneCnt = LAWDS.filter(l => prog.cursor[l] === 'done').length;
console.log(`종료 — 호출 ${used}/${BUDGET}, 오류 ${apiErrors}, 백필 완료 ${doneCnt}/${LAWDS.length} 시군구`);
fs.writeFileSync(PROG, JSON.stringify(prog, null, 1));
