# Draw Pinball

핀볼이 장애물을 지나 떨어지는 **도착 순서**로 순위/추첨을 정하는 웹 도구입니다.
광고·외부 라이브러리·서버 없이 정적 파일(HTML/CSS/JS)만으로 동작합니다.

## 사용법
1. **Enter names** – 쉼표 또는 줄바꿈으로 구분해 입력합니다. `No1*3`처럼 `*n`을 붙이면 같은 이름(같은 색)의 공이 n개 생깁니다. (최대 200개) `Shuffle list`로 목록 순서를 섞을 수 있습니다.
2. **Winner** – `First`(1등), `Last`(꼴등), `Multiple`(예: `1-3, 7, 10~12` 처럼 순번/구간 지정)
3. **Recording** – 체크하면 Start와 함께 캔버스를 녹화하고, 결과 발표 후 `.webm` 영상을 저장합니다.
4. **Start** – 시작 후에는 관여할 수 없고 지켜보기만 합니다. 속도(1~8×)와 카메라(Follow / Full map)는 옵션에서 고릅니다.
5. 모두 도착하면 우승자를 화면 중앙과 우측 Results에 발표합니다.

## 우연성
- 시작 위치·초기 속도가 매번 랜덤, 충돌마다 미세한 무작위 요동
- 장애물 맵이 라운드마다 랜덤 생성 (페그, 회전 바, 경사판, 범퍼, 좌우로 움직이는 슬라이더, 깔때기 조합). `New map`으로 직접 다시 뽑기도 가능
- 한 곳에 멈춰 버린 공은 자동으로 살짝 밀어줍니다

## 로컬 실행
```
python3 -m http.server 8000   # 후 http://localhost:8000
node tests/sim.js             # 물리 엔진 헤드리스 테스트
```

## GitHub Pages 배포
저장소 Settings → Pages → Source: `Deploy from a branch` → 브랜치 선택, 폴더 `/ (root)`.

## 구조
- `index.html`, `css/style.css`
- `js/engine.js` – 물리/맵 생성/입력 파싱 (DOM 무관, Node에서도 실행)
- `js/app.js` – UI, 렌더링, 카메라, 녹화
