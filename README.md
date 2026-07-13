# ReXume Frontend

이력서와 포트폴리오 공유 및 AI 피드백을 위한 Next.js 기반 프론트엔드입니다. 현재 README는 PDF.js 결과 화면에서 발생한 **브라우저 메모리 압박 문제와 canvas backing store 회수 과정**을 중심으로 정리합니다.

이전 OffscreenCanvas Worker 중심 정리는 [README_OLD.md](./archive/README_OLD.md)에 보존했습니다.

## 문제 정의

이력서 피드백 서비스에서는 업로드된 PDF를 결과 화면에서 다시 렌더링하고, 페이지 단위 좌표를 기준으로 피드백 영역을 표시해야 합니다. 특히 디자이너 포트폴리오처럼 페이지 수가 많고 렌더링 픽셀 크기가 큰 PDF에서는 전체 페이지를 한 번에 canvas로 유지할 경우 브라우저 탭 메모리 압박이 커집니다.

배포 환경에서 50페이지 포트폴리오 PDF를 확인했을 때, 최적화 전 결과 화면은 Chrome 메모리 사용량이 약 `2.7GB`까지 증가했습니다. 화면 주변 페이지만 렌더링하고 LRU에서 밀린 canvas backing store를 회수한 뒤에는 동일 시나리오에서 약 `298MB` 수준으로 내려갔습니다.

```text
2.7GB -> 298MB
약 89.0% 감소
약 9.1배 적은 메모리 사용
```

Chrome Task Manager에서 단일 worker/process 기준으로도 메모리 차이를 확인했습니다.

```text
1,488,704K -> 295,700K
약 80.1% 감소
약 5.0배 적은 메모리 사용
```

기존 eager 렌더링 구조는 PDF 로드 직후 모든 페이지 컴포넌트를 생성하고, 각 페이지에서 `pdf.getPage()`와 `page.render()`를 실행합니다.

```tsx
{Array.from({ length: numPages }, (_, index) => (
  <PDFPage key={index + 1} pdf={pdf} pageNumber={index + 1} />
))}
```

문제의 핵심은 PDF.js 자체가 느린 것이 아니라, **사용자가 동시에 볼 수 없는 페이지의 canvas backing store까지 계속 유지한다는 점**이었습니다.

## 핵심 개념

`<canvas>`는 화면에 보이는 CSS 크기와 별개로 실제 픽셀 데이터를 저장하는 내부 버퍼를 가집니다. 이를 canvas backing store로 볼 수 있습니다.

예를 들어 PDF 원본 페이지가 `1125 x 1500pt`이고, 선명한 피드백 좌표 표시를 위해 PDF.js render scale 2로 렌더링하면 실제 canvas backing store는 `2250 x 3000`이 됩니다. 이때 RGBA 기준 픽셀 버퍼 추정값은 다음과 같습니다.

```ts
2250 * 3000 * 4 // 약 25.7MB
```

50페이지가 모두 canvas backing store를 유지하면 약 `1287.5MB` 수준의 canvas 픽셀 버퍼가 누적됩니다. 이 값은 Chrome 프로세스 전체 메모리가 아니라, `canvas.width * canvas.height * 4`로 계산한 상대 비교용 추정값입니다.

실제 Chrome 메모리는 이 값보다 커질 수 있습니다. renderer/GPU 프로세스, 이미지 디코딩 버퍼, PDF.js 내부 캐시, 렌더링 임시 버퍼 등이 함께 잡히기 때문입니다. 그래서 이번 사례에서는 `2.7GB -> 298MB` 관측값을 대표 사용자 임팩트로 보고, canvas 픽셀 버퍼 추정값은 원인을 설명하는 보조 지표로 사용했습니다.

## 개선 방향

먼저 PDF.js lifecycle 정리만으로 문제가 해결되는지 확인하기 위해 `cleanup-only` 비교군을 만들었습니다.

- `RenderTask.cancel()` 적용
- `PDFPageProxy.cleanup()` 적용
- eager 렌더링 유지
- canvas `width` / `height` reset 없음

그 결과 기본 cleanup만으로는 이미 렌더링된 canvas backing store가 줄지 않았습니다. 따라서 이 문제는 한 페이지 렌더링 비용을 줄이는 문제가 아니라, **동시에 유지하는 canvas 개수를 제한하는 문제**로 보는 것이 더 정확했습니다.

최종 개선은 다음 방향으로 잡았습니다.

- `IntersectionObserver`로 viewport 주변 페이지만 렌더링
- 최근 본 페이지 최대 5개는 canvas backing store를 유지
- LRU 캐시에서 밀린 화면 밖 페이지의 진행 중인 `RenderTask` 취소
- LRU 캐시에서 밀린 canvas의 `width` / `height`를 `0`으로 reset
- 순간 이동 시 현재 viewport 안의 페이지는 release하지 않도록 보호
- LRU에서 밀린 페이지는 300ms grace period 후 reset해 짧은 되돌아가기 UX와 메모리 회수 균형 조정
- `aspect-ratio` placeholder로 스크롤 높이와 layout shift 안정화

핵심은 `page.cleanup()` 자체가 아니라, **전체 50페이지 canvas를 eager하게 유지하던 구조를 viewport 기반 windowing과 최근 5페이지 LRU 캐시 구조로 바꾼 것**입니다. 초기 진입에서는 viewport 주변 1~2페이지만 렌더링하고, 스크롤 중에는 최근 본 페이지를 최대 5개까지 유지한 뒤 캐시에서 밀린 canvas의 backing store를 비웠습니다.

`canvas.width = 0`, `canvas.height = 0`은 메모리 회수에는 효과적이지만, 너무 공격적으로 실행하면 페이지 순간 이동이나 짧은 되돌아가기에서 재렌더링 지연이 생길 수 있습니다. 이를 막기 위해 현재 viewport/rootMargin 안에 있는 페이지는 release 대상에서 제외하고, LRU에서 밀린 페이지도 300ms 후에만 backing store를 비우도록 조정했습니다.

## 구현 위치

```text
frontend/src/app/pdf-bench/
├── basic/               # 전체 페이지 eager 렌더링 기준선
├── cleanup-only/        # RenderTask.cancel + page.cleanup 비교군
└── viewport-memory/     # viewport render + LRU canvas backing store release

frontend/src/components/
├── pdfCleanupOnly/      # cleanup-only 비교군
└── pdfViewportMemory/   # 최종 메모리 개선 구현

frontend/bench/
└── pdfjs-render-task-deep-dive.js
```

메인 비교 페이지:

- `/pdf-bench/basic?url=/heavy-designer-portfolio-50p.pdf`
- `/pdf-bench/cleanup-only?url=/heavy-designer-portfolio-50p.pdf`
- `/pdf-bench/viewport-memory?url=/heavy-designer-portfolio-50p.pdf`

## 측정 결과

### 대표 결과

| 지표 | Basic eager PDF.js | Viewport Memory + LRU PDF.js | 변화 |
| --- | ---: | ---: | ---: |
| 배포 환경 Chrome 메모리 관측값 | 약 2.7GB | 약 298MB | 약 89.0% 감소 |
| Chrome Task Manager 단일 worker/process | 1,488,704K | 295,700K | 약 80.1% 감소 |
| 초기 canvas 픽셀 버퍼 추정값 | 1287.5MB | 51.5MB | 96.0% 감소 |
| scroll 중 peak canvas 추정값 | 1287.5MB | 128.7MB | 90.0% 감소 |
| Puppeteer Chrome RSS 초기 증가량 | +1516.2MB | +244.0MB | 83.9% 감소 |

대표 성과는 TBT가 아니라 **PDF 결과 화면 하나가 수 GB 단위의 브라우저 메모리를 점유하던 문제를 완화한 것**입니다. `2.7GB -> 298MB`는 배포 환경에서 본 전체 Chrome 메모리 관측값이고, `1,488,704K -> 295,700K`는 Chrome Task Manager에서 확인한 단일 worker/process 기준 관측값입니다. TBT와 frame gap은 함께 개선된 보조 지표로 해석했습니다.

측정 조건:

- production build
- `next start -p 3124`
- 50페이지 포트폴리오형 PDF
- PDF page size `1125 x 1500pt`
- PDF.js render scale 2
- CPU 4x throttling
- 3회 반복 후 median 사용
- Puppeteer 기반 자동 측정
- 각 테스트마다 새 Chrome을 실행하고, Chrome 프로세스 트리 RSS를 baseline/초기/스크롤 후에 측정

최신 결과 파일:

- `frontend/bench/results/pdfjs-render-task-deep-dive-2026-07-13T01-47-52-791Z.json`

### Canvas Memory

| 버전 | 초기 canvas | 초기 offscreen canvas | 초기 canvas 추정값 | offscreen canvas 추정값 | peak canvas 추정값 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Basic eager PDF.js | 50 | 49 | 1287.5MB | 1261.7MB | 1287.5MB |
| Cleanup Only PDF.js | 50 | 49 | 1287.5MB | 1261.7MB | 1287.5MB |
| Viewport Memory + LRU PDF.js | 2 | 1 | 51.5MB | 25.7MB | 128.7MB |

정리하면 다음과 같습니다.

- `page.cleanup()`만 추가한 Cleanup Only는 Basic과 거의 동일했습니다.
- Viewport Memory + LRU는 초기 유지 canvas 수를 50개에서 2개로 줄였습니다.
- 그 결과 초기 canvas 픽셀 버퍼 추정값은 `1287.5MB -> 51.5MB`가 되었습니다.
- 감소폭 `96.0%`는 유지 canvas 수가 `50개 -> 2개`로 줄어든 결과입니다.
- 스크롤 중에는 최근 본 페이지를 최대 5개까지 유지해 재방문 시 재렌더링 비용을 줄였고, peak canvas 추정값은 `128.7MB`로 측정되었습니다.

### 초기 진입 성능과 프레임 안정성

heavy PDF에서는 canvas backing store 수를 줄이면서 초기 진입 지표도 함께 개선되었습니다.

| 버전 | 초기 TBT 추정 | FCP | First canvas paint | Scroll TBT |
| --- | ---: | ---: | ---: | ---: |
| Basic eager PDF.js | 463ms | 216ms | 3456ms | 0ms |
| Cleanup Only PDF.js | 441ms | 248ms | 3122ms | 150ms |
| Viewport Memory + LRU PDF.js | 249ms | 224ms | 923ms | 0ms |

초기 프레임 안정성도 함께 개선되었습니다.

| 지표 | Basic eager | Viewport Memory |
| --- | ---: | ---: |
| 초기 p95 frame gap | 108ms | 9ms |
| 초기 32ms 초과 frame | 26개 | 6개 |
| 스크롤 p95 frame gap | 9ms | 9ms |
| 스크롤 32ms 초과 frame | 0개 | 0개 |

따라서 내부 원인은 **동시에 유지하는 canvas backing store 수를 제한한 것**으로 정리합니다. 사용자 임팩트는 배포 환경 관측 기준 `2.7GB -> 298MB` 메모리 감소가 더 직접적입니다.

### Chrome Process RSS

canvas 픽셀 버퍼 추정값과 별도로, 각 벤치 run마다 새로 실행한 Chrome 프로세스 트리의 RSS도 측정했습니다. 이 값은 정확한 탭 단위 메모리는 아니며, renderer/GPU/utility 프로세스를 포함한 **테스트 Chrome 인스턴스의 실제 프로세스 메모리 근사값**입니다.

| 버전 | 초기 Chrome RSS | 초기 RSS 증가량 | 스크롤 후 Chrome RSS | 스크롤 후 RSS 증가량 | JS heap |
| --- | ---: | ---: | ---: | ---: | ---: |
| Basic eager PDF.js | 2224.9MB | +1516.2MB | 2223.4MB | +1514.7MB | 7.3MB |
| Cleanup Only PDF.js | 2431.0MB | +1722.0MB | 2780.1MB | +2071.2MB | 6.6MB |
| Viewport Memory + LRU PDF.js | 953.5MB | +244.0MB | 989.9MB | +281.9MB | 5.1MB |

Basic 대비 Viewport Memory + LRU의 Chrome RSS 증가량은 초기 기준 `1516.2MB -> 244.0MB`, 스크롤 후 기준 `1514.7MB -> 281.9MB`로 줄었습니다. JS heap은 세 버전 모두 작게 유지되어, 병목이 React 상태나 JS 객체보다 canvas/GPU 계층 리소스에 가깝다는 해석을 보조합니다.

## 블로그 초안

성능 개선 과정은 [PDF_CANVAS_MEMORY_BLOG.md](./PDF_CANVAS_MEMORY_BLOG.md)에 정리했습니다.

핵심 문장:

> PDF.js 기반 결과 화면에서 전체 50페이지 canvas를 eager하게 유지하던 구조를 viewport windowing과 최근 5페이지 LRU 캐시 방식으로 변경했습니다. LRU에서 밀린 canvas의 backing store를 reset해 배포 환경 기준 Chrome 메모리 사용량을 약 2.7GB에서 298MB로 낮췄습니다.

## 기술 스택

- Next.js 15
- React 19
- TypeScript
- Tailwind CSS
- Zustand
- TanStack Query
- pdfjs-dist
- Puppeteer

## 실행

Node.js는 Next.js 15 요구사항에 맞춰 `20+` 또는 로컬 Node 22 사용을 권장합니다.

```bash
cd frontend
npm install
npm run dev
```

프로덕션 빌드:

```bash
cd frontend
npm run build
npm run start -- -p 3124
```

## 벤치마크

```bash
cd frontend
RUNS=3 CPU_THROTTLE=4 BASE_URL=http://127.0.0.1:3124 PDF_URL=/heavy-designer-portfolio-50p.pdf node bench/pdfjs-render-task-deep-dive.js
```

벤치마크 결과는 `frontend/bench/results/`에 JSON으로 저장됩니다.

## 이력서용 요약

> PDF.js 기반 이력서/포트폴리오 결과 화면에서 전체 50페이지 canvas를 eager하게 유지해 Chrome 메모리 사용량이 약 2.7GB까지 증가하는 문제를 확인했습니다. `RenderTask.cancel()`과 `page.cleanup()`만 적용한 비교군으로 기본 cleanup의 한계를 확인한 뒤, `IntersectionObserver` 기반 viewport windowing, 최근 5페이지 LRU 캐시, canvas size reset을 적용해 동일 시나리오의 Chrome 메모리 사용량을 약 298MB 수준으로 낮췄습니다. 단일 worker/process 기준으로도 1,488,704K에서 295,700K로 감소한 것을 확인했고, 현재 viewport 페이지 release 방지와 300ms grace period로 순간 이동/되돌아가기 UX 저하를 완화했습니다.
