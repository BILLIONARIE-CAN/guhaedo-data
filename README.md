# guhaedo-data — 실거래 사전적재 데이터

아구구 지도의 실거래 차트를 아실처럼 즉시 띄우기 위한 데이터 저장소.
GitHub Actions가 매일 새벽 3시 국토부 API에서 수집해 `trades/단지코드.json`으로 저장하고,
사이트는 jsDelivr CDN으로 이 파일을 읽는다.

```
https://cdn.jsdelivr.net/gh/BILLIONARIE-CAN/guhaedo-data@main/trades/{단지코드}.json
```

## 최초 설정 (한 번만)

1. **GitHub 레포 생성**: github.com 로그인 → New repository → 이름 `guhaedo-data` → **Public** → Create
   (README, .gitignore 추가하지 말 것 — 빈 레포로)

2. **Git Bash에서** (이 폴더에서):
   ```
   cd ~/Desktop/files/guhaedo-data
   git init
   git add -A
   git commit -m "init"
   git branch -M main
   git remote add origin https://github.com/BILLIONARIE-CAN/guhaedo-data.git
   git push -u origin main
   ```

3. **API 키 등록**: 레포 페이지 → Settings → Secrets and variables → Actions →
   **New repository secret** → Name: `SERVICE_KEY` / Value: 공공데이터포털 키 → Add secret

4. **첫 실행**: 레포 → Actions 탭 → `update-data` → Run workflow 버튼
   (이후 매일 새벽 3시 자동 실행 — 손댈 것 없음)

## 동작 방식

- 매 실행마다: 전 시군구 **최근 3개월 갱신**(신규 거래·계약해제 반영) → 남은 호출 예산으로 **과거 백필**(최근→2006년 방향)
- 하루 예산 기본 9,000콜. 전국 20년치 백필 완료까지 **약 2~3주** 자동 진행 (`progress.json`에서 진행률 확인, `done` = 완료)
- 공공데이터포털에서 **활용신청을 운영계정으로 승인**받으면 한도가 커짐 →
  레포 Settings → Secrets and variables → Actions → **Variables** 탭 → `BUDGET` = `50000` 등으로 올리면 며칠 안에 끝남
- 매일 push는 히스토리를 안 쌓는 스냅샷 방식(force push)이라 레포 용량은 항상 최신 데이터 크기만 유지

## 파일 형식 (compact)

```json
{ "n": "단지명", "u": "2026-06-11",
  "b": [[202605, 14, 35000, 84.97, "12"], [202604, 3, 36000, 84.97, "8", 1]],
  "j": [[202605, 2, 25000, 84.97, "5"]],
  "m": [[202605, 9, 3000, 70, 59.9, "3"]] }
```
- `b` 매매 `[년월, 일, 가격(만원), 전용㎡, 층, (1=분양권 2=입주권)]`
- `j` 전세 `[년월, 일, 보증금, 전용㎡, 층]`
- `m` 월세 `[년월, 일, 보증금, 월세, 전용㎡, 층]`

수집·매칭 로직은 사이트의 `api/trade.js` 매칭 v4와 동일.
