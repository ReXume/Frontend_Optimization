# 프로젝트 성능 최적화 경험 : PDF 결과 화면 메모리 최적화

Next.js로 만든 이력서 피드백 시스템에서 PDF 결과 화면을 다루던 중, 포트폴리오형 PDF를 열었을 때 Chrome 메모리 사용량이 과도하게 증가하는 문제를 확인했습니다.

처음에는 PDF.js 렌더링 속도나 TBT를 중심으로 문제를 보고 있었습니다. 하지만 실제로 배포 환경에서 50페이지 포트폴리오 PDF를 확인해보니, 더 큰 문제는 초기 렌더링 시간이 아니라 **브라우저 메모리 압박**이었습니다.

최적화 전 페이지에서는 PDF를 넘겨볼수록 Chrome 메모리가 약 **2.7GB** 수준까지 증가했습니다. 상황에 따라서는 더 높게 튀는 케이스도 보였습니다. 반면 화면 주변 페이지만 렌더링하고, 화면 밖 canvas의 backing store를 회수하도록 변경한 뒤에는 동일 시나리오에서 약 **298MB** 수준으로 내려갔습니다.

즉, 대표 관측값 기준으로는 다음과 같은 차이가 있었습니다.

```txt
2.7GB -> 298MB
약 89.0% 감소
약 9.1배 적은 메모리 사용
```

이 정도 메모리 증가는 단순히 개발자 도구에서만 보이는 숫자가 아닙니다. 사용자가 여러 탭을 함께 열고 있거나, 8GB 메모리 노트북에서 브라우저를 사용하고 있다면 스왑 증가, 탭 반응 지연, 브라우저 탭 강제 종료로 이어질 수 있는 크기입니다.

이번 글에서는 이 문제를 어떻게 확인했고, 왜 `page.cleanup()`만으로 해결되지 않았는지, 그리고 최종적으로 어떤 방식으로 canvas 메모리를 줄였는지 정리해보았습니다.

## 1. 문제 상황

서비스에서는 사용자가 업로드한 이력서나 포트폴리오 PDF를 결과 화면에서 다시 확인할 수 있어야 했습니다. 특히 AI 피드백은 페이지와 좌표를 기준으로 표시될 수 있기 때문에, PDF의 페이지 단위와 좌표계를 유지하는 것이 중요했습니다.

예를 들어 "2페이지 상단 우측 영역"에 대한 피드백을 표시하려면, 사용자가 보는 화면과 피드백 좌표가 안정적으로 맞아야 합니다. 이 점 때문에 PDF를 이미지나 HTML로 단순 대체하기보다는, PDF.js를 기반으로 페이지를 렌더링하고 그 위에 피드백 레이어를 올리는 구조가 필요했습니다.

문제는 PDF 결과 화면이 전체 페이지를 한 번에 canvas로 렌더링하고 있었다는 점입니다.

첫 화면에서 사용자가 실제로 보는 페이지는 1~2장 정도입니다. 하지만 기존 구현에서는 PDF가 50페이지라면 50개의 canvas가 모두 생성되고, 화면 밖에 있는 49개 페이지도 픽셀 버퍼를 유지했습니다.

구조적으로는 다음과 같았습니다.

```tsx
{Array.from({ length: numPages }, (_, index) => (
  <PDFPage key={index + 1} pdf={pdf} pageNumber={index + 1} />
))}
```

각 `PDFPage`는 mount되면 바로 PDF.js 렌더링을 시작했습니다.

```tsx
const page = await pdf.getPage(pageNumber);
const viewport = page.getViewport({ scale: 2 });

canvas.width = Math.ceil(viewport.width);
canvas.height = Math.ceil(viewport.height);

await page.render({
  canvasContext: context,
  viewport,
}).promise;
```

이 구조에서는 화면에 보이지 않는 페이지도 렌더링이 완료되는 순간 canvas backing store를 갖습니다. 결과적으로 페이지 수가 늘어날수록 보이지 않는 canvas의 픽셀 버퍼가 함께 누적됩니다.

## 2. 왜 메모리가 크게 늘어났나

canvas는 단순한 DOM 요소가 아닙니다. canvas에는 실제 픽셀 데이터를 담는 backing store가 있습니다.

이번 테스트에 사용한 PDF는 50페이지 포트폴리오형 PDF였고, PDF page size는 `1125 × 1500pt`, PDF.js render scale은 `2`였습니다. 따라서 대표 페이지의 실제 canvas 크기는 다음과 같았습니다.

```txt
2250 × 3000 px
```

RGBA 픽셀 버퍼 기준으로 이론적 최소 크기를 계산하면 다음과 같습니다.

```txt
2250 × 3000 × 4 bytes
= 27,000,000 bytes
= 약 25.7MB / page
```

50페이지를 모두 canvas로 유지하면 canvas 픽셀 버퍼 추정값만으로도 다음 수준이 됩니다.

```txt
25.7MB × 50 pages
= 약 1287.5MB
```

여기서 중요한 점은 이 값이 Chrome 전체 메모리와 같다는 뜻은 아니라는 점입니다.

`width × height × 4`는 canvas 픽셀 버퍼의 상대적 변화를 비교하기 위한 추정 지표입니다. 실제 브라우저 메모리에는 GPU 텍스처, 이미지 디코딩 버퍼, PDF.js 내부 캐시, 렌더링 임시 버퍼, 프로세스 기본 메모리 등이 추가될 수 있습니다.

그래서 실제 Chrome에서 보이는 메모리는 이론적 canvas 추정값보다 더 커질 수 있습니다. 배포 환경에서 최적화 전 페이지가 약 **2.7GB**까지 증가한 것도 이 맥락에서 볼 수 있습니다.

정리하면 이 문제는 PDF 파일 용량이 크기 때문에 발생한 문제가 아니었습니다. 핵심은 **렌더링된 페이지 수만큼 canvas backing store가 유지되는 구조**였습니다.

## 3. 먼저 확인한 것: cleanup만으로 충분한가

처음에는 PDF.js lifecycle 정리를 먼저 의심했습니다.

PDF.js 렌더링에는 `RenderTask`가 있고, 페이지 객체에는 `cleanup()` 메서드가 있습니다. 그래서 렌더링 취소와 page cleanup을 명확하게 처리하면 메모리가 줄어들 수 있을지 확인했습니다.

이를 위해 비교군을 하나 만들었습니다.

- Basic eager PDF.js: 기존처럼 전체 페이지를 eager 렌더링
- Cleanup Only PDF.js: 전체 페이지 eager 렌더링은 유지하되 `RenderTask.cancel()`과 `page.cleanup()` 처리 추가
- Viewport Memory + LRU PDF.js: 화면 주변 페이지만 렌더링하고 오래된 canvas backing store 회수

cleanup-only 페이지에서는 렌더링 취소와 page cleanup을 다음처럼 처리했습니다.

```tsx
useEffect(() => {
  let cancelled = false;
  let page: PDFPageProxy | null = null;
  let task: RenderTask | null = null;

  (async () => {
    try {
      page = await pdf.getPage(pageNumber);
      if (cancelled || !canvasRef.current) return;

      const viewport = page.getViewport({ scale: 2 });
      const canvas = canvasRef.current;
      const context = canvas.getContext("2d");
      if (!context) return;

      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);

      task = page.render({ canvasContext: context, viewport });
      renderTaskRef.current = task;

      await task.promise;
    } catch (error) {
      const err = error as { name?: string };
      if (cancelled || err?.name === "RenderingCancelledException") return;
      console.error(error);
    } finally {
      if (renderTaskRef.current === task) {
        renderTaskRef.current = null;
      }

      page?.cleanup();
    }
  })();

  return () => {
    cancelled = true;
    renderTaskRef.current?.cancel();
  };
}, [pageNumber, pdf]);
```

이 처리는 PDF.js를 사용할 때 필요한 기본적인 lifecycle 정리에 가깝습니다. 렌더링 중인 작업이 취소되었을 때 promise rejection을 처리하고, 정상/취소/예외 경로에서 page cleanup을 유도할 수 있습니다.

하지만 측정 결과, 이것만으로는 핵심 문제가 해결되지 않았습니다.

왜냐하면 cleanup-only 방식도 여전히 **50개의 canvas를 모두 만들고 유지**하기 때문입니다. `page.cleanup()`은 PDF.js page 내부 리소스 정리를 유도할 수 있지만, 이미 canvas에 그려진 픽셀 버퍼 자체를 줄여주지는 않았습니다.

결국 이 문제의 핵심은 PDF.js page 객체가 아니라, DOM에 남아 있는 canvas backing store였습니다.

## 4. 최종 개선 방향

최종적으로는 PDF.js를 제거하지 않고, **동시에 유지하는 canvas 개수를 제한하는 방향**으로 개선했습니다.

구현의 목표는 단순했습니다.

1. 전체 페이지의 스크롤 위치와 높이는 유지합니다.
2. 실제 PDF.js 렌더링은 viewport 주변 페이지에만 수행합니다.
3. 사용자가 방금 본 페이지는 일부 캐시해 재방문 UX를 보존합니다.
4. 캐시에서 밀린 페이지는 canvas `width`와 `height`를 0으로 reset해 backing store를 회수합니다.

즉, 이 작업은 PDF.js 렌더링 엔진 자체를 빠르게 만든 최적화가 아닙니다. 더 정확히는 **PDF 결과 화면에서 canvas 리소스 생명주기를 관리하는 windowing 작업**입니다.

### Step 1. IntersectionObserver로 화면 주변 페이지만 렌더링

모든 페이지를 즉시 렌더링하지 않고, 각 페이지 placeholder가 viewport 주변에 들어왔을 때만 렌더링을 시작했습니다.

```tsx
useEffect(() => {
  const target = wrapperRef.current;
  if (!target || typeof IntersectionObserver === "undefined") {
    setShouldRender(true);
    return;
  }

  const observer = new IntersectionObserver(
    ([entry]) => {
      if (!entry) return;

      if (entry.isIntersecting) {
        onPageActive(pageNumber);
        setShouldRender(true);
      }
    },
    { rootMargin: "900px 0px", threshold: 0.01 }
  );

  observer.observe(target);
  return () => observer.disconnect();
}, [onPageActive, pageNumber]);
```

`rootMargin`을 둔 이유는 사용자가 페이지에 도달한 뒤에야 렌더링을 시작하면 빈 화면이 보일 수 있기 때문입니다. viewport 근처에 들어온 페이지를 조금 일찍 렌더링하고, 실제 유지 여부는 LRU 캐시에서 결정하도록 역할을 나눴습니다.

### Step 2. 최근 5페이지 LRU 캐시 유지

화면 밖으로 나간 페이지를 즉시 모두 해제하면 메모리 수치는 가장 낮아집니다. 하지만 사용자가 방금 지나온 페이지로 살짝 되돌아갈 때마다 다시 렌더링이 발생할 수 있습니다.

그래서 최근 본 페이지를 최대 5개까지 유지하는 LRU 캐시를 두었습니다.

```tsx
const RETAINED_PAGE_LIMIT = 5;

const markPageActive = useCallback((pageNumber: number) => {
  setRetainedPages((prev) => {
    const next = [pageNumber, ...prev.filter((item) => item !== pageNumber)];
    return next.slice(0, RETAINED_PAGE_LIMIT);
  });
}, []);
```

이렇게 하면 초기 진입 시에는 1~2페이지 수준만 canvas backing store를 만들고, 스크롤 중에는 최근 본 페이지 최대 5개까지만 유지합니다.

즉, `50페이지 전체 유지`가 아니라 `현재 주변 + 최근 페이지 일부 유지` 구조가 됩니다.

### Step 3. LRU에서 밀린 canvas backing store 회수

메모리 절감에서 가장 중요한 부분은 LRU에서 밀린 페이지를 정리할 때 canvas size를 reset하는 것입니다.

```tsx
const releaseCanvas = useCallback((resetState = true) => {
  if (renderTaskRef.current) {
    try {
      renderTaskRef.current.cancel();
    } catch {
      // ignore cancel error
    }
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

canvas는 CSS상의 표시 크기와 실제 픽셀 버퍼 크기가 분리되어 있습니다. `style.width`나 `style.height`를 줄이는 것만으로 이미 할당된 backing store가 줄어든다고 보기 어렵습니다.

반면 `canvas.width`와 `canvas.height`를 변경하면 canvas backing store가 다시 설정됩니다. 그래서 LRU에서 제외된 페이지의 픽셀 버퍼를 명시적으로 비우기 위해 `0`으로 reset했습니다.

이 지점이 이번 개선의 핵심입니다.

`page.cleanup()`은 PDF.js 내부 리소스 정리에 가깝고, `canvas.width = 0`, `canvas.height = 0`은 이미 브라우저가 들고 있는 canvas 픽셀 버퍼를 줄이는 처리입니다.

## 5. 측정 결과

측정은 두 가지 방식으로 봤습니다.

첫 번째는 배포 환경에서 직접 확인한 Chrome 메모리 관측값입니다. 이 값은 실제 사용자가 체감할 수 있는 메모리 압박을 설명하는 데 가장 직관적입니다.

두 번째는 Puppeteer 기반 벤치마크입니다. 이 벤치마크에서는 canvas 픽셀 버퍼 추정값, Chrome 프로세스 트리 RSS, 초기 TBT, frame gap 등을 자동으로 수집했습니다.

### 배포 환경 수동 관측

50페이지 포트폴리오 PDF를 기준으로 확인한 대표값은 다음과 같습니다.

| 버전 | Chrome 메모리 관측값 | 변화 |
| --- | ---: | ---: |
| Basic eager PDF.js | 약 2.7GB | 기준 |
| Viewport Memory + LRU PDF.js | 약 298MB | 약 89.0% 감소 |

계산하면 다음과 같습니다.

```txt
2.7GB = 2700MB
2700MB - 298MB = 2402MB
2402 / 2700 = 0.8896
```

즉, 약 **2.4GB**의 메모리 사용량이 줄었고, 최적화 후 메모리 사용량은 기존 대비 약 **11%** 수준이었습니다.

이 숫자가 이번 개선의 대표 성과에 가장 가깝다고 봤습니다. TBT나 렌더링 시간도 의미는 있지만, 이 케이스에서 사용자에게 더 큰 위험은 PDF 결과 화면 하나가 브라우저 메모리를 수 GB 단위로 점유하는 상황이었기 때문입니다.

### canvas 픽셀 버퍼 추정값

Puppeteer 벤치마크에서는 canvas의 `width`, `height`를 읽어 픽셀 버퍼 추정값을 계산했습니다.

```ts
const canvases = Array.from(document.querySelectorAll("canvas"));

const totalCanvasBytes = canvases.reduce((sum, canvas) => {
  return sum + canvas.width * canvas.height * 4;
}, 0);
```

측정 조건은 다음과 같습니다.

- production build
- `next start -p 3124`
- 3회 반복 후 median 사용
- PDF: 50페이지 포트폴리오형 PDF
- PDF page size: `1125 × 1500pt`
- PDF.js render scale: `2`
- 대표 canvas 크기: `2250 × 3000`

결과는 다음과 같습니다.

| 버전 | 초기 canvas | 초기 offscreen canvas | 초기 canvas 추정값 | offscreen canvas 추정값 | scroll 중 peak 추정값 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Basic eager PDF.js | 50 | 49 | 1287.5MB | 1261.7MB | 1287.5MB |
| Cleanup Only PDF.js | 50 | 49 | 1287.5MB | 1261.7MB | 1287.5MB |
| Viewport Memory + LRU PDF.js | 2 | 1 | 51.5MB | 25.7MB | 128.7MB |

여기서 중요한 점은 Cleanup Only도 Basic과 같은 수치가 나왔다는 점입니다.

이는 `RenderTask.cancel()`과 `page.cleanup()`이 필요 없다는 뜻이 아닙니다. PDF.js lifecycle을 안전하게 정리하기 위해 필요합니다. 다만 전체 50페이지 canvas를 그대로 유지한다면, 이미 만들어진 canvas backing store는 줄어들지 않습니다.

반면 Viewport Memory + LRU 방식은 초기 유지 canvas 수를 `50개 -> 2개`로 줄였고, 스크롤 중에도 최근 5페이지 수준으로 제한했습니다. 그래서 초기 canvas 픽셀 버퍼 추정값은 `1287.5MB -> 51.5MB`, scroll 중 peak 추정값은 `1287.5MB -> 128.7MB`로 줄었습니다.

이 결과는 메모리 감소가 마법처럼 발생한 것이 아니라는 점을 보여줍니다.

핵심은 단순합니다.

```txt
동시에 유지하는 canvas 개수를 줄였다.
그래서 canvas backing store 총량이 줄었다.
그 결과 실제 Chrome 메모리 압박도 줄었다.
```

### Chrome 프로세스 RSS 자동 측정

실제 브라우저 메모리에 조금 더 가까운 값을 보기 위해, 각 테스트마다 새 Chrome 인스턴스를 띄운 뒤 Chrome 프로세스 트리 RSS도 함께 측정했습니다.

이 값은 정확한 탭 단위 메모리는 아닙니다. Chrome은 renderer, GPU, utility process를 나누어 사용하고, OS와 브라우저의 메모리 회수 타이밍도 관여합니다. 따라서 절대값 하나를 맹신하기보다는, 같은 조건에서 비교한 상대 차이를 보는 용도로 사용했습니다.

| 버전 | 초기 RSS 증가량 | 스크롤 후 RSS 증가량 | JS heap |
| --- | ---: | ---: | ---: |
| Basic eager PDF.js | +1516.2MB | +1514.7MB | 7.3MB |
| Cleanup Only PDF.js | +1722.0MB | +2071.2MB | 6.6MB |
| Viewport Memory + LRU PDF.js | +244.0MB | +281.9MB | 5.1MB |

자동화 측정에서도 Viewport Memory + LRU 방식은 초기 RSS 증가량이 `+1516.2MB -> +244.0MB`로 줄었습니다. JS heap은 세 버전 모두 작게 유지되었습니다.

이 결과는 이번 병목이 React 상태나 JS 객체 누적이라기보다, canvas backing store와 브라우저/GPU 계층 리소스에 가까웠다는 해석을 보조합니다.

### TBT와 초기 렌더링 지표

초기 진입 성능도 함께 측정했습니다.

| 버전 | 초기 TBT 추정값 | First canvas paint | 초기 p95 frame gap |
| --- | ---: | ---: | ---: |
| Basic eager PDF.js | 463ms | 3456ms | 108ms |
| Cleanup Only PDF.js | 441ms | 3122ms | 75ms |
| Viewport Memory + LRU PDF.js | 249ms | 923ms | 9ms |

TBT도 줄었지만, 이번 개선을 TBT 개선으로만 설명하면 핵심을 놓치게 됩니다.

이 케이스의 주된 문제는 "초기 렌더링이 몇백 ms 느리다"가 아니라, **결과 화면 하나가 브라우저 메모리를 수 GB 단위로 점유할 수 있다**는 점이었습니다.

그래서 대표 성과는 TBT가 아니라 메모리 감소로 잡는 것이 맞다고 판단했습니다.

## 6. 사용자 경험 관점

단순히 수치만 보면 `50페이지를 전부 유지하던 것을 5페이지만 유지했으니 당연히 줄어든 것 아닌가?`라고 볼 수 있습니다.

맞습니다. 이번 개선은 렌더링 알고리즘을 복잡하게 바꾼 것이 아니라, 사용자가 동시에 볼 수 없는 리소스를 계속 유지하지 않도록 구조를 바꾼 작업입니다.

다만 웹 성능 개선에서 중요한 지점은 여기에 있었습니다.

사용자는 50페이지를 동시에 보지 않습니다. 하지만 기존 구현은 사용자가 보지 않는 49페이지 canvas까지 계속 메모리에 들고 있었습니다. 이 구조는 사용자에게 이득을 주지 않으면서 브라우저 메모리만 크게 사용합니다.

반대로 화면 주변 페이지와 최근 본 페이지 몇 장만 유지하면 다음 균형을 만들 수 있습니다.

- 현재 보고 있는 페이지는 즉시 표시
- 바로 앞뒤로 이동할 때는 최근 페이지 캐시로 재렌더링 감소
- 멀리 떨어진 페이지는 필요할 때 다시 렌더링
- 전체 브라우저 메모리 압박은 크게 감소

즉, 이번 개선은 모든 페이지를 항상 즉시 접근 가능하게 유지하는 방식에서, 실제 사용자 탐색 패턴에 맞게 리소스를 유지하는 방식으로 바꾼 것입니다.

## 7. 한계

이 방식에도 한계는 있습니다.

먼저, 오래전에 지나간 페이지로 다시 이동하면 해당 페이지는 다시 PDF.js 렌더링을 수행해야 합니다. 최근 5페이지 LRU 캐시로 바로 앞뒤 이동은 완화했지만, 전체 페이지를 모두 즉시 재방문 가능한 상태로 유지하는 방식은 아닙니다.

또한 매우 빠르게 스크롤할 경우 페이지가 `rootMargin`에 들어왔다가 바로 벗어나면서 렌더링 시작과 취소가 반복될 수 있습니다.

향후에는 다음 개선을 추가로 고려할 수 있습니다.

- 동시 렌더링 개수 제한
- visible page 우선순위 큐
- 빠른 스크롤 중 prewarm 지연
- 렌더링 취소 빈도 측정
- 실제 사용자 환경에서 Long Task, INP, canvas count를 함께 수집

또한 Chrome 메모리 수치는 측정 방식에 따라 달라질 수 있습니다. Chrome 작업 관리자, Activity Monitor, Puppeteer RSS 측정은 각각 포함하는 범위가 다릅니다. 따라서 글에서 절대값을 사용할 때는 “동일 시나리오에서 관측한 대표값”으로 설명하고, 내부 원리는 canvas 픽셀 버퍼 추정값으로 함께 보조하는 것이 적절하다고 판단했습니다.

## 8. 결론

이번 문제의 핵심은 PDF.js 자체가 느리다는 점이 아니었습니다.

정확히는 **PDF.js로 렌더링한 모든 페이지 canvas를 계속 유지하면서, 화면 밖 canvas backing store가 누적되는 구조**가 문제였습니다.

이를 해결하기 위해 먼저 `RenderTask.cancel()`과 `page.cleanup()`만 적용한 cleanup-only 비교군을 만들었습니다. 그 결과 기본 cleanup만으로는 이미 렌더링된 canvas 픽셀 버퍼가 줄어들지 않는다는 것을 확인했습니다.

이후 `IntersectionObserver`로 viewport 주변 페이지에 대해서만 PDF.js 렌더링을 수행하고, 최근 본 페이지를 최대 5개까지 LRU 캐시로 유지했습니다. 캐시에서 밀린 페이지는 진행 중인 `RenderTask`를 취소하고, canvas `width`와 `height`를 `0`으로 reset해 backing store를 회수했습니다.

그 결과 배포 환경에서 50페이지 포트폴리오 PDF 기준 Chrome 메모리 관측값은 약 **2.7GB에서 298MB**로 감소했습니다. 자동화 벤치마크에서도 초기 canvas 픽셀 버퍼 추정값은 **1287.5MB에서 51.5MB**, Chrome 프로세스 RSS 증가량은 **1516.2MB에서 244.0MB**로 줄었습니다.

이 개선은 PDF.js의 rasterizing 자체를 빠르게 만든 작업은 아닙니다. 하지만 PDF 결과 화면에서 실제 사용자에게 필요하지 않은 canvas backing store를 계속 유지하지 않도록 바꾸면서, 브라우저 메모리 압박을 크게 줄인 작업입니다.

정리하면 이번 작업의 핵심은 다음 한 문장으로 설명할 수 있습니다.

> PDF.js 기반 결과 화면에서 전체 50페이지 canvas를 eager하게 유지하던 구조를 viewport windowing과 최근 5페이지 LRU 캐시 방식으로 변경했습니다. LRU에서 밀린 canvas의 backing store를 reset해 배포 환경 기준 Chrome 메모리 사용량을 약 2.7GB에서 298MB로 낮췄습니다.
