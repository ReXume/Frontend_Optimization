# PDF Canvas Memory Optimization

Next.js 기반 이력서 피드백 서비스에서 대용량 PDF 결과 화면의 브라우저 메모리 압박을 줄이는 방향으로 정리했다. 핵심은 PDF.js 자체를 빠르게 만드는 것이 아니라, **보이지 않는 페이지의 canvas 픽셀 버퍼를 계속 유지하지 않도록 하는 것**이다.

## 문제

기존 eager 렌더링은 PDF 로드 후 전체 페이지를 한 번에 mount한다.

```tsx
{Array.from({ length: numPages }, (_, index) => (
  <PDFPage key={index + 1} pdf={pdf} pageNumber={index + 1} />
))}
```

각 페이지는 mount 직후 `pdf.getPage()`와 `page.render()`를 실행하고, render scale 2 기준 canvas를 만든다. 화면에는 1-2페이지만 보여도 나머지 페이지의 canvas 픽셀 버퍼가 함께 유지되는 구조다.

배포 환경에서 50페이지 포트폴리오 PDF를 확인했을 때, 최적화 전 결과 화면은 Chrome 메모리 사용량이 약 2.7GB까지 증가했다. viewport windowing과 최근 5페이지 LRU 캐시, canvas size reset을 적용한 뒤에는 동일 시나리오에서 약 298MB 수준으로 내려갔다. 대표 관측값 기준으로 약 89.0% 감소다.

이 문서에서 사용하는 canvas memory는 Chrome 프로세스 전체 메모리가 아니다. canvas 픽셀 버퍼의 상대적인 변화를 비교하기 위해 `canvas.width * canvas.height * 4`로 계산한 추정 지표다. 실제 브라우저 메모리는 GPU 텍스처, 임시 버퍼, 메모리 풀링 등에 따라 달라질 수 있다. 따라서 `2.7GB -> 298MB`는 실제 Chrome 메모리 관측값, `1287.5MB -> 51.5MB`는 원인을 설명하기 위한 canvas 픽셀 버퍼 추정값으로 분리해서 본다.

## 개선

`/pdf-bench/cleanup-only` 라우트와 `/pdf-bench/viewport-memory` 라우트를 추가했다. 먼저 `cleanup-only`는 PDF.js 렌더링 lifecycle에서 기본적으로 챙겨야 하는 `RenderTask.cancel()`과 `PDFPageProxy.cleanup()`만 적용한 비교군이다. 이 버전은 eager 렌더링을 유지하고 canvas `width` / `height`를 비우지 않는다.

`viewport-memory`는 여기서 한 단계 더 나아가 PDF.js 내부 고급 스케줄러를 직접 다루지 않고, 브라우저 API 중심으로 화면 밖 canvas 픽셀 버퍼를 회수하도록 구현했다.

구현 포인트:

- `IntersectionObserver`로 viewport 주변 페이지 감지
- 감지된 페이지에만 `<canvas>`를 mount하고 `pdf.getPage()` / `page.render()` 실행
- LRU에서 밀린 페이지는 진행 중인 `RenderTask.cancel()` 호출
- 최근 본 페이지 최대 5개는 canvas backing store 유지
- LRU에서 밀린 canvas `width` / `height`를 `0`으로 비워 픽셀 버퍼 회수
- 취소/예외 경로에서도 `finally`에서 `PDFPageProxy.cleanup()` 호출
- placeholder는 `aspect-ratio`로 미리 공간을 잡아 layout shift 방지

핵심 코드는 `frontend/src/components/pdfViewportMemory/PDFPage.tsx`의 `releaseCanvas()`와 렌더링 effect다.

```tsx
const releaseCanvas = useCallback((resetState = true) => {
  if (renderTaskRef.current) {
    renderTaskRef.current.cancel();
    renderTaskRef.current = null;
  }

  const canvas = canvasRef.current;
  if (canvas && (canvas.width > 0 || canvas.height > 0)) {
    canvas.width = 0;
    canvas.height = 0;
  }

  if (resetState) {
    renderedRef.current = false;
    setShouldRender(false);
  }
}, []);
```

## 측정

측정 조건:

- 환경: production build, `next start -p 3124`
- 반복: 3회, median 사용
- 메모리 지표: canvas `width * height * 4` 추정값
- PDF page size: 1125x1500pt
- PDF.js render scale 2
- 각 테스트마다 새 Chrome을 실행하고 Chrome 프로세스 트리 RSS 측정
- CPU 4x throttling: scroll frame gap 보조 측정을 위한 조건이며, canvas 픽셀 버퍼 추정값에는 영향을 주지 않음
- 스크롤 시나리오: 문서 최상단에서 최하단까지 32단계로 이동 후 다시 최상단으로 복귀, 각 단계 45ms 대기, 이후 1초 대기
- 32ms 초과 frame: 30fps 이하로 떨어질 수 있는 구간을 보기 위한 보조 지표

50페이지 포트폴리오형 PDF 결과:

- 결과 파일: `frontend/bench/results/pdfjs-render-task-deep-dive-2026-07-13T01-47-52-791Z.json`

배포 환경 수동 관측:

| 버전 | Chrome 메모리 관측값 | 변화 |
| ---- | -------------------: | ---: |
| Basic eager PDF.js | 약 2.7GB | 기준 |
| Viewport Memory + LRU PDF.js | 약 298MB | 약 89.0% 감소 |

| 버전 | 초기 canvas | 초기 offscreen canvas | 초기 canvas 추정값 | offscreen canvas 추정값 | peak canvas 추정값 | 대표 canvas |
| ---- | ----------: | --------------------: | ------------------: | ----------------------: | -----------------: | ----------: |
| Basic eager PDF.js | 50 | 49 | 1287.5MB | 1261.7MB | 1287.5MB | 2250x3000 |
| Cleanup Only PDF.js | 50 | 49 | 1287.5MB | 1261.7MB | 1287.5MB | 2250x3000 |
| Viewport Memory + LRU PDF.js | 2 | 1 | 51.5MB | 25.7MB | 128.7MB | 2250x3000 |

개선폭:

- 배포 환경 Chrome 메모리 관측값: 약 2.7GB -> 298MB, 약 89.0% 감소
- Basic eager와 Cleanup Only는 초기 canvas 픽셀 버퍼 추정값이 동일했다: 1287.5MB
- Cleanup Only 대비 Viewport Memory 초기 canvas 픽셀 버퍼 추정값: 1287.5MB -> 51.5MB, 약 96.0% 감소
- Cleanup Only 대비 offscreen canvas 픽셀 버퍼 추정값: 1261.7MB -> 25.7MB, 약 98.0% 감소
- Cleanup Only 대비 전체 스크롤 중 peak canvas 추정값: 1287.5MB -> 128.7MB, 약 90.0% 감소
- 스크롤 중 32ms 초과 frame: 0개 -> 0개
- Basic 대비 Viewport Memory 초기 Chrome RSS 증가량: +1516.2MB -> +244.0MB
- Basic 대비 Viewport Memory 스크롤 후 Chrome RSS 증가량: +1514.7MB -> +281.9MB

50페이지 PDF는 원본 페이지 크기 1125x1500pt를 render scale 2로 렌더링해 대표 canvas가 2250x3000으로 측정됐다. 페이지당 약 25.7MB이므로 모든 페이지를 한 번에 canvas로 유지하면 페이지 수만큼 픽셀 버퍼 추정값이 누적된다.

Chrome RSS는 정확한 탭 단위 메모리는 아니며, 테스트마다 새로 실행한 Chrome 프로세스 트리의 실제 RSS를 합산한 근사 지표다. JS heap은 Basic eager 7.3MB, Viewport Memory 5.1MB 수준으로 작게 유지되어, 이번 차이는 JS 객체보다 canvas backing store 및 브라우저/GPU 계층 리소스에서 발생한 것으로 해석했다.

이 비교에서 중요한 점은 `RenderTask.cancel()`과 `page.cleanup()`만으로는 이미 렌더링이 끝난 canvas 픽셀 버퍼가 줄지 않았다는 것이다. 실제 메모리 회수 효과는 화면 밖 페이지를 렌더링 대상에서 제외하고, 최근 5페이지 LRU에서 밀린 canvas `width` / `height`를 `0`으로 reset한 지점에서 발생했다.

## 한계

- 빠른 스크롤에서는 페이지 진입, 렌더 시작, 이탈, cancel, 재진입이 반복될 수 있다.
- 향후 동시 렌더링 개수 제한, visible page 우선순위 큐, 빠른 스크롤 중 prewarm 지연 등을 추가할 수 있다.
- `width * height * 4`는 실제 Chrome 전체 메모리가 아니라 canvas 픽셀 버퍼 규모의 추정 지표다.
- 이미지가 많은 PDF는 디코딩 및 PDF.js 내부 리소스 비용을 키울 수 있지만, 현재 지표는 그 비용을 직접 측정하지 않는다.

## 해석

이 작업은 "PDF.js 자체를 빠르게 만들었다"가 아니다. 더 정확한 설명은 다음과 같다.

> 대용량 PDF 결과 화면에서 보이지 않는 페이지까지 canvas 픽셀 버퍼를 유지하던 구조를 개선했습니다. 기본 cleanup만 적용한 비교군에서는 초기 canvas 픽셀 버퍼가 1287.5MB로 유지되는 것을 확인했고, `IntersectionObserver`로 viewport 주변 페이지만 렌더링한 뒤 최근 5페이지 LRU에서 밀린 페이지는 `RenderTask.cancel()`과 canvas size reset으로 픽셀 버퍼를 회수했습니다. 50페이지 PDF 기준 배포 환경 Chrome 메모리 관측값은 약 2.7GB에서 298MB로 줄었고, 내부 원인 지표인 초기 canvas 픽셀 버퍼 추정값은 1287.5MB에서 51.5MB로 감소했습니다.

이력서 문장:

> PDF.js 기반 이력서/포트폴리오 결과 화면에서 전체 50페이지 canvas를 eager하게 유지해 Chrome 메모리 사용량이 약 2.7GB까지 증가하는 문제를 확인했습니다. `RenderTask.cancel()`과 `page.cleanup()`만 적용한 비교군으로 기본 cleanup의 한계를 확인한 뒤, `IntersectionObserver` 기반 viewport render, 최근 5페이지 LRU 캐시, canvas size reset을 적용해 동일 시나리오의 Chrome 메모리 사용량을 약 298MB 수준으로 낮췄습니다.
