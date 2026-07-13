#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const puppeteer = require("puppeteer");

const RUNS = Number(process.env.RUNS || 3);
const CPU_THROTTLE = Number(process.env.CPU_THROTTLE || 4);
const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3000";
const PDF_URL = process.env.PDF_URL || "/heavy-designer-portfolio-50p.pdf";
const VIEWPORT_WIDTH = Number(process.env.VIEWPORT_WIDTH || 1440);
const VIEWPORT_HEIGHT = Number(process.env.VIEWPORT_HEIGHT || 1000);
const PAINT_TIMEOUT_MS = Number(process.env.PAINT_TIMEOUT_MS || 60000);

const TESTS = [
  {
    name: "Basic eager PDF.js",
    shortName: "basic",
    url: `${BASE_URL}/pdf-bench/basic?url=${encodeURIComponent(PDF_URL)}`,
  },
  {
    name: "Cleanup Only PDF.js",
    shortName: "cleanup-only",
    url: `${BASE_URL}/pdf-bench/cleanup-only?url=${encodeURIComponent(
      PDF_URL
    )}`,
  },
  {
    name: "Viewport Memory PDF.js",
    shortName: "viewport-memory",
    url: `${BASE_URL}/pdf-bench/viewport-memory?url=${encodeURIComponent(
      PDF_URL
    )}`,
  },
];

const outDir = path.join(__dirname, "results");
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

function stats(values) {
  if (!values.length) return { avg: 0, median: 0, min: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    avg: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
    median: Math.round(
      sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
    ),
    min: Math.round(sorted[0]),
    max: Math.round(sorted[sorted.length - 1]),
  };
}

function percentReduction(before, after) {
  if (!before) return "0.0%";
  return `${(((before - after) / before) * 100).toFixed(1)}%`;
}

function mb(bytes) {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function mp(pixels) {
  return Math.round((pixels / 1_000_000) * 10) / 10;
}

function readProcessTreeMemory(rootPid) {
  if (!rootPid) {
    return { rootPid: 0, processCount: 0, rssBytes: 0, processes: [] };
  }

  try {
    const output = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,comm="], {
      encoding: "utf8",
    });
    const rows = output
      .trim()
      .split("\n")
      .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/))
      .filter(Boolean)
      .map((match) => ({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        rssBytes: Number(match[3]) * 1024,
        command: match[4],
      }));

    const childrenByParent = new Map();
    for (const row of rows) {
      const children = childrenByParent.get(row.ppid) ?? [];
      children.push(row);
      childrenByParent.set(row.ppid, children);
    }

    const byPid = new Map(rows.map((row) => [row.pid, row]));
    const processTree = [];
    const stack = [rootPid];
    const seen = new Set();

    while (stack.length) {
      const pid = stack.pop();
      if (!pid || seen.has(pid)) continue;
      seen.add(pid);

      const row = byPid.get(pid);
      if (row) processTree.push(row);

      for (const child of childrenByParent.get(pid) ?? []) {
        stack.push(child.pid);
      }
    }

    return {
      rootPid,
      processCount: processTree.length,
      rssBytes: processTree.reduce((sum, row) => sum + row.rssBytes, 0),
      processes: processTree,
    };
  } catch (error) {
    return {
      rootPid,
      processCount: 0,
      rssBytes: 0,
      processes: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function launchBrowser() {
  const launchOptions = {
    headless: "new",
    defaultViewport: {
      width: VIEWPORT_WIDTH,
      height: VIEWPORT_HEIGHT,
      deviceScaleFactor: 1,
    },
    args: ["--disable-dev-shm-usage", "--no-sandbox", "--crash-dumps-dir=/tmp"],
    protocolTimeout: 120000,
  };

  const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (fs.existsSync(chromePath)) {
    launchOptions.executablePath = chromePath;
  }

  return puppeteer.launch(launchOptions);
}

async function installObservers(page) {
  await page.evaluateOnNewDocument(() => {
    window.__pdfDeepDivePerf = {
      start: performance.now(),
      longTasks: [],
      frames: [],
      createdCanvasCount: 0,
      peakCanvasPixels: 0,
      peakCanvasBytes: 0,
    };

    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__pdfDeepDivePerf.longTasks.push({
            start: entry.startTime,
            dur: entry.duration,
          });
        }
      }).observe({ type: "longtask", buffered: true });
    } catch (_) {}

    const originalCreateElement = document.createElement.bind(document);
    document.createElement = function createElement(tagName, options) {
      const element = originalCreateElement(tagName, options);
      if (String(tagName).toLowerCase() === "canvas") {
        window.__pdfDeepDivePerf.createdCanvasCount += 1;
      }
      return element;
    };

    let lastFrame = performance.now();
    function tick(now) {
      window.__pdfDeepDivePerf.frames.push(now - lastFrame);
      lastFrame = now;
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
}

async function waitForPaintedCanvas(page) {
  await page.waitForFunction(
    () => {
      const canvases = Array.from(document.querySelectorAll("canvas"));
      return canvases.some((canvas) => {
        const rect = canvas.getBoundingClientRect();
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          canvas.width <= 0 ||
          canvas.height <= 0
        ) {
          return false;
        }

        try {
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) return false;
          const width = Math.max(1, canvas.width);
          const height = Math.max(1, canvas.height);
          const points = [
            [Math.floor(width * 0.5), Math.floor(height * 0.5)],
            [Math.floor(width * 0.25), Math.floor(height * 0.25)],
            [Math.floor(width * 0.75), Math.floor(height * 0.25)],
          ];
          return points.some(
            ([x, y]) => context.getImageData(x, y, 1, 1).data[3] > 0
          );
        } catch {
          return false;
        }
      });
    },
    { polling: "raf", timeout: PAINT_TIMEOUT_MS }
  );
}

async function collectSnapshot(page) {
  return page.evaluate(() => {
    const canvases = Array.from(document.querySelectorAll("canvas"));
    let totalPixels = 0;
    let visiblePixels = 0;
    let offscreenPixels = 0;
    let visibleCanvasCount = 0;
    let offscreenCanvasCount = 0;
    let backingStoreCanvasCount = 0;
    let maxCanvasPixels = 0;
    let maxCanvasWidth = 0;
    let maxCanvasHeight = 0;

    for (const canvas of canvases) {
      const rect = canvas.getBoundingClientRect();
      const pixels = canvas.width * canvas.height;
      const hasBackingStore = canvas.width > 0 && canvas.height > 0;
      const intersectsViewport =
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom >= 0 &&
        rect.top <= window.innerHeight;

      if (hasBackingStore) {
        backingStoreCanvasCount += 1;
        totalPixels += pixels;
        if (pixels > maxCanvasPixels) {
          maxCanvasPixels = pixels;
          maxCanvasWidth = canvas.width;
          maxCanvasHeight = canvas.height;
        }
        if (intersectsViewport) {
          visiblePixels += pixels;
          visibleCanvasCount += 1;
        } else {
          offscreenPixels += pixels;
          offscreenCanvasCount += 1;
        }
      }
    }

    const totalBytes = totalPixels * 4;
    const offscreenBytes = offscreenPixels * 4;
    const visibleBytes = visiblePixels * 4;
    window.__pdfDeepDivePerf.peakCanvasPixels = Math.max(
      window.__pdfDeepDivePerf.peakCanvasPixels,
      totalPixels
    );
    window.__pdfDeepDivePerf.peakCanvasBytes = Math.max(
      window.__pdfDeepDivePerf.peakCanvasBytes,
      totalBytes
    );

    return {
      canvasCount: canvases.length,
      visibleCanvasCount,
      offscreenCanvasCount,
      createdCanvasCount: window.__pdfDeepDivePerf.createdCanvasCount,
      totalCanvasPixels: totalPixels,
      visibleCanvasPixels: visiblePixels,
      offscreenCanvasPixels: offscreenPixels,
      averageCanvasPixels: backingStoreCanvasCount
        ? totalPixels / backingStoreCanvasCount
        : 0,
      maxCanvasPixels,
      maxCanvasWidth,
      maxCanvasHeight,
      totalCanvasBytes: totalBytes,
      visibleCanvasBytes: visibleBytes,
      offscreenCanvasBytes: offscreenBytes,
      averageCanvasBytes: backingStoreCanvasCount
        ? totalBytes / backingStoreCanvasCount
        : 0,
      domNodes: document.getElementsByTagName("*").length,
      scrollHeight: document.documentElement.scrollHeight,
      schedulerMetrics: window.__pdfRenderSchedulerMetrics || null,
      renderTaskMetrics: window.__pdfRenderTaskMetrics || null,
      viewportMemoryMetrics: window.__pdfViewportMemoryMetrics || null,
    };
  });
}

async function collectInitialPerf(page) {
  return page.evaluate(() => {
    const perf = window.__pdfDeepDivePerf;
    const frames = perf.frames;
    const sortedFrames = [...frames].sort((a, b) => a - b);
    const percentile = (p) =>
      sortedFrames[
        Math.min(sortedFrames.length - 1, Math.floor(sortedFrames.length * p))
      ] || 0;
    const tasks = perf.longTasks;
    const blocking = tasks.reduce(
      (sum, task) => sum + Math.max(0, task.dur - 50),
      0
    );
    const maxLongTask = tasks.reduce(
      (max, task) => Math.max(max, task.dur),
      0
    );
    const paints = Object.fromEntries(
      performance
        .getEntriesByType("paint")
        .map((entry) => [entry.name, Math.round(entry.startTime)])
    );
    const navigation = performance.getEntriesByType("navigation")[0];

    return {
      duration: Math.round(performance.now() - perf.start),
      blocking: Math.round(blocking),
      longTasks: tasks.length,
      maxLongTask: Math.round(maxLongTask),
      p95FrameGap: Math.round(percentile(0.95)),
      maxFrameGap: Math.round(Math.max(0, ...frames)),
      over32: frames.filter((gap) => gap > 32).length,
      over50: frames.filter((gap) => gap > 50).length,
      fcp: paints["first-contentful-paint"] ?? null,
      domContentLoaded: navigation
        ? Math.round(navigation.domContentLoadedEventEnd)
        : null,
      loadEventEnd: navigation ? Math.round(navigation.loadEventEnd) : null,
    };
  });
}

async function runScroll(page) {
  await page.evaluate(() => {
    const perf = window.__pdfDeepDivePerf;
    perf.scrollStart = performance.now();
    perf.longTaskStartIndex = perf.longTasks.length;
    perf.frameStartIndex = perf.frames.length;
  });

  await page.evaluate(async () => {
    function sampleCanvasPeak() {
      const pixels = Array.from(document.querySelectorAll("canvas")).reduce(
        (sum, canvas) => sum + canvas.width * canvas.height,
        0
      );
      window.__pdfDeepDivePerf.peakCanvasPixels = Math.max(
        window.__pdfDeepDivePerf.peakCanvasPixels,
        pixels
      );
      window.__pdfDeepDivePerf.peakCanvasBytes = Math.max(
        window.__pdfDeepDivePerf.peakCanvasBytes,
        pixels * 4
      );
    }

    const steps = 32;
    const maxScroll = Math.max(
      0,
      document.documentElement.scrollHeight - window.innerHeight
    );

    for (let index = 0; index <= steps; index += 1) {
      window.scrollTo(0, Math.round((maxScroll * index) / steps));
      sampleCanvasPeak();
      await new Promise((resolve) => setTimeout(resolve, 45));
    }
    for (let index = steps; index >= 0; index -= 1) {
      window.scrollTo(0, Math.round((maxScroll * index) / steps));
      sampleCanvasPeak();
      await new Promise((resolve) => setTimeout(resolve, 45));
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 1000));

  return page.evaluate(() => {
    const perf = window.__pdfDeepDivePerf;
    const frames = perf.frames.slice(perf.frameStartIndex);
    const sortedFrames = [...frames].sort((a, b) => a - b);
    const percentile = (p) =>
      sortedFrames[
        Math.min(sortedFrames.length - 1, Math.floor(sortedFrames.length * p))
      ] || 0;
    const tasks = perf.longTasks.slice(perf.longTaskStartIndex);
    const blocking = tasks.reduce(
      (sum, task) => sum + Math.max(0, task.dur - 50),
      0
    );

    return {
      duration: Math.round(performance.now() - perf.scrollStart),
      blocking: Math.round(blocking),
      longTasks: tasks.length,
      p95FrameGap: Math.round(percentile(0.95)),
      maxFrameGap: Math.round(Math.max(0, ...frames)),
      over32: frames.filter((gap) => gap > 32).length,
      over50: frames.filter((gap) => gap > 50).length,
      peakCanvasPixels: perf.peakCanvasPixels,
      peakCanvasBytes: perf.peakCanvasBytes,
    };
  });
}

async function measure(test, run) {
  const browser = await launchBrowser();
  try {
    const browserPid = browser.process()?.pid ?? 0;
    const baselineProcessMemory = readProcessTreeMemory(browserPid);
    const page = await browser.newPage();
    const client = await page.target().createCDPSession();
    const errors = [];

    page.setDefaultTimeout(120000);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });

    await client.send("Emulation.setCPUThrottlingRate", {
      rate: CPU_THROTTLE,
    });
    await installObservers(page);

    await page.goto(test.url, { waitUntil: "domcontentloaded", timeout: 60000 });

    let firstCanvasPaint = 0;
    let paintTimedOut = false;
    try {
      await waitForPaintedCanvas(page);
      firstCanvasPaint = await page.evaluate(() =>
        Math.round(performance.now() - window.__pdfDeepDivePerf.start)
      );
    } catch (error) {
      paintTimedOut = true;
      firstCanvasPaint = PAINT_TIMEOUT_MS;
      errors.push(`first canvas paint timeout >${PAINT_TIMEOUT_MS}ms`);
    }

    await new Promise((resolve) => setTimeout(resolve, 3000));
    const initial = await collectSnapshot(page);
    const initialPerf = await collectInitialPerf(page);
    const initialProcessMemory = readProcessTreeMemory(browserPid);
    const initialPageMetrics = await page.metrics().catch(() => null);
    const scroll = await runScroll(page);
    const afterScroll = await collectSnapshot(page);
    const afterScrollProcessMemory = readProcessTreeMemory(browserPid);
    const afterScrollPageMetrics = await page.metrics().catch(() => null);

    return {
      run,
      name: test.name,
      shortName: test.shortName,
      url: test.url,
      firstCanvasPaint,
      paintTimedOut,
      initialPerf,
      initial,
      scroll,
      afterScroll,
      processMemory: {
        baseline: baselineProcessMemory,
        initial: initialProcessMemory,
        afterScroll: afterScrollProcessMemory,
      },
      pageMetrics: {
        initial: initialPageMetrics,
        afterScroll: afterScrollPageMetrics,
      },
      errors,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

function summarize(results) {
  console.log("\nPDF.js Canvas Memory Deep Dive");
  console.log(`Runs: ${RUNS}, CPU throttle: ${CPU_THROTTLE}x, PDF: ${PDF_URL}`);

  const summaries = TESTS.map((test) => {
    const rows = results.filter((result) => result.shortName === test.shortName);
    return {
      ...test,
      firstCanvasPaint: stats(rows.map((row) => row.firstCanvasPaint)),
      paintTimeouts: rows.filter((row) => row.paintTimedOut).length,
      initialBlocking: stats(rows.map((row) => row.initialPerf.blocking)),
      initialLongTasks: stats(rows.map((row) => row.initialPerf.longTasks)),
      initialMaxLongTask: stats(rows.map((row) => row.initialPerf.maxLongTask)),
      initialFcp: stats(
        rows
          .map((row) => row.initialPerf.fcp)
          .filter((value) => typeof value === "number")
      ),
      initialP95: stats(rows.map((row) => row.initialPerf.p95FrameGap)),
      initialOver32: stats(rows.map((row) => row.initialPerf.over32)),
      canvasCount: stats(rows.map((row) => row.initial.canvasCount)),
      offscreenCanvasCount: stats(
        rows.map((row) => row.initial.offscreenCanvasCount)
      ),
      canvasBytes: stats(rows.map((row) => row.initial.totalCanvasBytes)),
      offscreenCanvasBytes: stats(
        rows.map((row) => row.initial.offscreenCanvasBytes)
      ),
      averageCanvasPixels: stats(
        rows.map((row) => row.initial.averageCanvasPixels)
      ),
      averageCanvasBytes: stats(
        rows.map((row) => row.initial.averageCanvasBytes)
      ),
      maxCanvasPixels: stats(rows.map((row) => row.initial.maxCanvasPixels)),
      maxCanvasWidth: stats(rows.map((row) => row.initial.maxCanvasWidth)),
      maxCanvasHeight: stats(rows.map((row) => row.initial.maxCanvasHeight)),
      domNodes: stats(rows.map((row) => row.initial.domNodes)),
      scrollP95: stats(rows.map((row) => row.scroll.p95FrameGap)),
      scrollBlocking: stats(rows.map((row) => row.scroll.blocking)),
      scrollLongTasks: stats(rows.map((row) => row.scroll.longTasks)),
      scrollOver32: stats(rows.map((row) => row.scroll.over32)),
      peakCanvasBytes: stats(rows.map((row) => row.scroll.peakCanvasBytes)),
      processBaselineRss: stats(
        rows.map((row) => row.processMemory?.baseline?.rssBytes ?? 0)
      ),
      processInitialRss: stats(
        rows.map((row) => row.processMemory?.initial?.rssBytes ?? 0)
      ),
      processInitialRssDelta: stats(
        rows.map(
          (row) =>
            (row.processMemory?.initial?.rssBytes ?? 0) -
            (row.processMemory?.baseline?.rssBytes ?? 0)
        )
      ),
      processAfterScrollRss: stats(
        rows.map((row) => row.processMemory?.afterScroll?.rssBytes ?? 0)
      ),
      processAfterScrollRssDelta: stats(
        rows.map(
          (row) =>
            (row.processMemory?.afterScroll?.rssBytes ?? 0) -
            (row.processMemory?.baseline?.rssBytes ?? 0)
        )
      ),
      jsHeapUsed: stats(
        rows.map((row) => row.pageMetrics?.initial?.JSHeapUsedSize ?? 0)
      ),
      viewportRenderStarted: stats(
        rows.map((row) => row.initial.viewportMemoryMetrics?.renderStarted ?? 0)
      ),
      viewportRenderCompleted: stats(
        rows.map((row) => row.initial.viewportMemoryMetrics?.renderCompleted ?? 0)
      ),
      viewportCanvasReleased: stats(
        rows.map((row) => row.afterScroll.viewportMemoryMetrics?.canvasReleased ?? 0)
      ),
    };
  });

  for (const summary of summaries) {
    console.log(`\n${summary.name}`);
    console.log(
      `  First canvas paint: ${summary.firstCanvasPaint.median}ms${
        summary.paintTimeouts ? ` (${summary.paintTimeouts}/${RUNS} timeout)` : ""
      }`
    );
    console.log(
      `  Initial TBT estimate: ${summary.initialBlocking.median}ms (${summary.initialLongTasks.median} long tasks, max ${summary.initialMaxLongTask.median}ms)`
    );
    console.log(`  FCP: ${summary.initialFcp.median}ms`);
    console.log(`  Initial p95 frame gap: ${summary.initialP95.median}ms`);
    console.log(`  Initial frames >32ms: ${summary.initialOver32.median}`);
    console.log(`  Initial canvas count: ${summary.canvasCount.median}`);
    console.log(
      `  Initial offscreen canvases: ${summary.offscreenCanvasCount.median}`
    );
    console.log(
      `  Initial canvas memory: ${mb(summary.canvasBytes.median)}MB`
    );
    console.log(
      `  Offscreen canvas memory: ${mb(
        summary.offscreenCanvasBytes.median
      )}MB`
    );
    console.log(
      `  Avg canvas pixel buffer: ${mp(
        summary.averageCanvasPixels.median
      )}MP (${mb(summary.averageCanvasBytes.median)}MB/page estimate)`
    );
    console.log(
      `  Largest canvas: ${summary.maxCanvasWidth.median}x${summary.maxCanvasHeight.median} (${mp(
        summary.maxCanvasPixels.median
      )}MP)`
    );
    console.log(`  DOM nodes: ${summary.domNodes.median}`);
    console.log(`  Scroll p95 frame gap: ${summary.scrollP95.median}ms`);
    console.log(`  Scroll TBT estimate: ${summary.scrollBlocking.median}ms`);
    console.log(`  Scroll frames >32ms: ${summary.scrollOver32.median}`);
    console.log(
      `  Peak canvas memory during scroll: ${mb(
        summary.peakCanvasBytes.median
      )}MB`
    );
    console.log(
      `  Chrome process RSS initial: ${mb(
        summary.processInitialRss.median
      )}MB (+${mb(summary.processInitialRssDelta.median)}MB from browser baseline)`
    );
    console.log(
      `  Chrome process RSS after scroll: ${mb(
        summary.processAfterScrollRss.median
      )}MB (+${mb(
        summary.processAfterScrollRssDelta.median
      )}MB from browser baseline)`
    );
    console.log(`  JS heap used: ${mb(summary.jsHeapUsed.median)}MB`);
    if (summary.shortName === "viewport-memory") {
      console.log(
        `  Viewport page renders started/completed: ${summary.viewportRenderStarted.median}/${summary.viewportRenderCompleted.median}`
      );
      console.log(
        `  Viewport canvases released after scroll: ${summary.viewportCanvasReleased.median}`
      );
    }
  }

  const basic = summaries.find((summary) => summary.shortName === "basic");
  const cleanupOnly = summaries.find(
    (summary) => summary.shortName === "cleanup-only"
  );
  const viewportMemory = summaries.find(
    (summary) => summary.shortName === "viewport-memory"
  );
  if (cleanupOnly && viewportMemory) {
    console.log("\nCleanup Only 대비 Viewport Memory");
    console.log(
      `  Canvas memory reduction: ${percentReduction(
        cleanupOnly.canvasBytes.median,
        viewportMemory.canvasBytes.median
      )}`
    );
    console.log(
      `  Offscreen canvas memory reduction: ${percentReduction(
        cleanupOnly.offscreenCanvasBytes.median,
        viewportMemory.offscreenCanvasBytes.median
      )}`
    );
    console.log(
      `  Peak canvas memory reduction: ${percentReduction(
        cleanupOnly.peakCanvasBytes.median,
        viewportMemory.peakCanvasBytes.median
      )}`
    );
  }
  if (basic && viewportMemory) {
    console.log("\nBasic 대비 Viewport Memory");
    console.log(
      `  Canvas memory reduction: ${percentReduction(
        basic.canvasBytes.median,
        viewportMemory.canvasBytes.median
      )}`
    );
    console.log(
      `  Offscreen canvas memory reduction: ${percentReduction(
        basic.offscreenCanvasBytes.median,
        viewportMemory.offscreenCanvasBytes.median
      )}`
    );
    console.log(
      `  Scroll p95 frame gap reduction: ${percentReduction(
        basic.scrollP95.median,
        viewportMemory.scrollP95.median
      )}`
    );
    console.log(
      `  Initial TBT estimate reduction: ${percentReduction(
        basic.initialBlocking.median,
        viewportMemory.initialBlocking.median
      )}`
    );
  }
}

(async () => {
  const results = [];

  for (const test of TESTS) {
    for (let run = 1; run <= RUNS; run += 1) {
      console.log(`[${test.shortName} ${run}/${RUNS}] ${test.url}`);
      results.push(await measure(test, run));
    }
  }

  summarize(results);

  const outPath = path.join(
    outDir,
    `pdfjs-render-task-deep-dive-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.json`
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      { meta: { RUNS, CPU_THROTTLE, PDF_URL, PAINT_TIMEOUT_MS }, results },
      null,
      2
    )
  );
  console.log(`\nSaved: ${outPath}`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
