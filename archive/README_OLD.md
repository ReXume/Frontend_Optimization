# ReXume Frontend

이력서와 디자이너 포트폴리오를 위한 고성능 PDF 뷰어. Next.js 기반.

## 문제 발견

디자이너 포트폴리오 PDF(30-100페이지, 고해상도 이미지 포함)를 **모바일 환경**에서 렌더링 테스트하는 과정에서 심각한 성능 문제를 발견했다. PDF.js가 메인 스레드를 수백ms씩 점유하면서 스크롤, 버튼 클릭 등 모든 인터랙션이 먹통이 되는 현상이 반복됐다.

## 시도했던 접근들

### IntersectionObserver + requestAnimationFrame (v1-v12)

처음에는 메인 스레드 내에서 렌더링 효율을 개선하는 방향으로 접근했다:

- **IntersectionObserver**: 뷰포트 밖 페이지의 렌더링을 제거하고, 75vh 프리워밍으로 스크롤 전 미리 렌더링
- **requestAnimationFrame 배칭**: 렌더링 요청을 프레임 단위로 묶어 처리
- **동시성 제한 (K=2,3,5,8,16)**: 동시 렌더링 페이지 수를 제한하여 프레임 드롭 감소
- **RenderScheduler 우선순위 큐**: 뷰포트에 가까운 페이지를 먼저 렌더링

이 접근들은 렌더링 순서와 타이밍을 최적화했지만, **근본적인 문제를 해결하지 못했다.** PDF 파싱과 캔버스 렌더링 자체가 메인 스레드에서 실행되는 한, 무거운 작업이 UI를 블로킹하는 구조는 바뀌지 않았다.

### 벤치마크로 확인한 한계

| 버전 | TBT | LongTask | maxDur |
|------|-----|----------|--------|
| Basic (최적화 없음) | **350ms** | 4개 | **251ms** |
| IO + RAF (메인스레드 최적화) | **344ms** | 4개 | **267ms** |

IO + RAF를 적용해도 TBT는 거의 변하지 않았다. 메인 스레드에서 아무리 스케줄링을 개선해도, 렌더링 작업 자체의 무게는 줄일 수 없었다.

## 해결: OffscreenCanvas Worker (v13-v15)

문제의 본질은 **렌더링 작업이 메인 스레드를 점유하는 것**이었다. 이를 근본적으로 해결하기 위해 PDF 파싱과 캔버스 렌더링을 Web Worker로 완전히 분리했다.

```
[메인 스레드]                    [Web Worker]
   │                                │
   ├─ UI 렌더링, 이벤트 처리        ├─ PDF.js 초기화 & 파싱
   ├─ IntersectionObserver          ├─ OffscreenCanvas 렌더링
   ├─ 스크롤, 클릭 응답             ├─ ImageBitmap 생성
   │                                │
   └──── transferable ◄────────────┘
         (zero-copy GPU 전송)
```

- PDF 파싱과 캔버스 렌더링이 Worker에서 실행되므로 메인 스레드가 블로킹되지 않음
- `ImageBitmap`을 `transferable`로 전송하여 메모리 복사 없이 GPU에 직접 전달
- `bitmaprenderer` 컨텍스트로 zero-copy 캔버스 출력

### 결과

| 버전 | TBT | LongTask | maxDur |
|------|-----|----------|--------|
| Basic (최적화 없음) | 350ms | 4개 | 251ms |
| IO + RAF (메인스레드 최적화) | 344ms | 4개 | 267ms |
| **OffscreenCanvas Worker** | **129ms** | **3개** | **204ms** |

**TBT 63% 감소** (350ms → 129ms). 메인 스레드 블로킹이 줄어 렌더링 중에도 UI 인터랙션이 끊기지 않는다.

## Worker 환경에서의 브라우저 API 대응

OffscreenCanvas Worker로 전환하면서 새로운 문제가 발생했다. Web Worker는 브라우저의 DOM API를 제공하지 않는데, PDF.js는 내부적으로 이를 참조한다. Worker 환경에서 PDF.js를 안정적으로 실행하기 위해 다음을 대응했다:

| 문제 | 원인 | 해결 |
|------|------|------|
| `window is not defined` | PDF.js가 `window.location`으로 URL을 해석 | `self.window = self` 폴리필로 Worker의 location 활용 |
| `document is not defined` | PDF.js가 내부적으로 DOM 요소 생성 시도 | 최소한의 fake document 폴리필 제공 |
| 폰트 렌더링 깨짐 | Worker에는 CSS `@font-face` 주입 불가 | `disableFontFace: true`로 캔버스 기반 폰트 렌더링 전환 |
| cMap/Font 경로 해석 실패 | Worker URL이 webpack chunk 경로라 상대경로 불일치 | `self.location.origin` 기반 절대 URL로 변환 |

ES module의 `import`는 호이스팅되므로, 폴리필은 반드시 import 구문보다 먼저 실행되어야 한다. 이를 위해 폴리필 코드를 모듈 최상단에 배치했다.

## 15회 실험 요약

| 단계 | 최적화 기법 | 결과 |
|------|------------|------|
| v1-v3 | react-pdf 제거, pdfjs-dist 직접 사용 | 번들 크기 감소, 불필요한 추상화 제거 |
| v4-v6 | IntersectionObserver + 뷰포트 기반 렌더링 | 화면 밖 페이지 렌더링 제거 |
| v7-v9 | requestAnimationFrame 배칭 + 동시성 제한 (K=2,3,5,8,16) | 프레임 드롭 감소, K=3이 최적 |
| v10-v12 | RenderScheduler 우선순위 큐 | 뷰포트 근접 페이지 우선 렌더링 |
| v13 | 페이지 객체 캐싱 | getPage() 중복 호출 제거 |
| v14 | Worker 전환 (canvas 렌더링 오프로드) | TBT 개선 시작 |
| **v15** | **OffscreenCanvas + ImageBitmap transferable** | **TBT 63% 감소 달성** |

## 아키텍처

```
frontend/
├── src/
│   ├── app/
│   │   ├── feedback/[id]/       # 실서비스 피드백 페이지
│   │   ├── pdf-bench/           # 벤치마크용 각 버전 비교 페이지
│   │   │   ├── basic/           # 베이스라인 (메인스레드)
│   │   │   ├── simple-io/       # IO only
│   │   │   └── opt15/           # OffscreenCanvas Worker (최종)
│   │   └── api/                 # API 라우트 (cMap, Font, Worker 서빙)
│   ├── components/
│   │   ├── pdfOpt15-Worker/     # Worker 기반 PDF 뷰어 (최종)
│   │   │   ├── PDFViewer.tsx    # 뷰어 컨테이너, Worker 관리
│   │   │   ├── PDFPage.tsx      # 페이지 컴포넌트, bitmaprenderer
│   │   │   └── pdf-render.worker.ts  # Web Worker (OffscreenCanvas + 폴리필)
│   │   ├── pdfOptimized/        # RAF + 스케줄러 버전
│   │   └── pdfOld/              # 기본 버전 (베이스라인)
│   └── libs/
│       └── renderScheduler.ts   # 우선순위 큐 + 동시성 제한
├── bench/                       # Puppeteer 자동 벤치마크
│   ├── pc-pages12-basic-vs-worker.js  # 메인 비교 벤치마크
│   ├── tbt-*.js                 # TBT 측정
│   ├── inp-*.js                 # INP(인터랙션 응답성) 측정
│   └── results/                 # 벤치마크 결과 JSON
└── public/
    └── sample4.pdf              # 테스트용 대용량 포트폴리오 PDF
```

## 기술 스택

- **Framework**: Next.js 15, React 19
- **PDF 렌더링**: pdfjs-dist (직접 사용, react-pdf 미사용)
- **멀티스레딩**: Web Worker + OffscreenCanvas + ImageBitmap transferable
- **성능 측정**: Puppeteer (CPU throttle, Long Task 감지, Performance Timeline API)
- **UI**: Tailwind CSS
- **상태 관리**: Zustand
- **데이터 페칭**: TanStack Query

## 실행

```bash
cd frontend
npm install
npm run dev
```

### 벤치마크

```bash
cd frontend

# 기본 (CPU 4x throttle, 5회)
node bench/pc-pages12-basic-vs-worker.js

# CPU 쓰로틀링 변경
CPU_THROTTLE=6 node bench/pc-pages12-basic-vs-worker.js

# TBT 비교
node bench/tbt-basic-vs-worker.js

# INP 측정
node bench/inp-raf-batch.js
```

결과는 `bench/results/`에 JSON으로 저장된다.
