#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const puppeteer = require("puppeteer");

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3124";
const PDF_URL = process.env.PDF_URL || "/heavy-designer-portfolio-50p.pdf";
const CYCLES = Number(process.env.CYCLES || 3);
const RECOVERY_WAIT_MS = Number(process.env.RECOVERY_WAIT_MS || 3000);
const VIEWPORT_WIDTH = Number(process.env.VIEWPORT_WIDTH || 1440);
const VIEWPORT_HEIGHT = Number(process.env.VIEWPORT_HEIGHT || 1000);
const PAINT_TIMEOUT_MS = Number(process.env.PAINT_TIMEOUT_MS || 60000);

const TESTS = [
  {
    name: "Basic eager PDF.js",
    shortName: "basic",
    hrefPrefix: "/pdf-bench/basic",
  },
  {
    name: "Cleanup Only PDF.js",
    shortName: "cleanup-only",
    hrefPrefix: "/pdf-bench/cleanup-only",
  },
  {
    name: "Viewport Memory + LRU PDF.js",
    shortName: "viewport-memory",
    hrefPrefix: "/pdf-bench/viewport-memory",
  },
];

const outDir = path.join(__dirname, "results");
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

function mb(bytes) {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
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
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "pdfjs-lifecycle-")),
    defaultViewport: {
      width: VIEWPORT_WIDTH,
      height: VIEWPORT_HEIGHT,
      deviceScaleFactor: 1,
    },
    args: [
      "--disable-dev-shm-usage",
      "--disable-breakpad",
      "--disable-crash-reporter",
      "--no-sandbox",
      "--crash-dumps-dir=/tmp",
    ],
    protocolTimeout: 120000,
  };

  const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (process.env.USE_SYSTEM_CHROME === "1" && fs.existsSync(chromePath)) {
    launchOptions.executablePath = chromePath;
  }

  return puppeteer.launch(launchOptions);
}

async function waitForCanvas(page) {
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll("canvas")).some(
        (canvas) => canvas.width > 0 && canvas.height > 0
      ),
    { polling: "raf", timeout: PAINT_TIMEOUT_MS }
  );
}

async function collectPageState(page) {
  return page.evaluate(() => {
    const canvases = Array.from(document.querySelectorAll("canvas"));
    const totalBytes = canvases.reduce(
      (sum, canvas) => sum + canvas.width * canvas.height * 4,
      0
    );
    return {
      path: location.pathname,
      canvasCount: canvases.length,
      nonZeroCanvasCount: canvases.filter(
        (canvas) => canvas.width > 0 && canvas.height > 0
      ).length,
      canvasBytes: totalBytes,
      domNodes: document.getElementsByTagName("*").length,
    };
  });
}

function countWorkerTargets(browser) {
  const targets = browser.targets();
  return {
    total: targets.length,
    workers: targets.filter((target) => target.type() === "worker").length,
    serviceWorkers: targets.filter((target) => target.type() === "service_worker")
      .length,
    pdfWorkers: targets.filter((target) => target.url().includes("pdf.worker"))
      .length,
    urls: targets.map((target) => ({
      type: target.type(),
      url: target.url(),
    })),
  };
}

async function scrollDocument(page) {
  await page.evaluate(async () => {
    const steps = 24;
    const maxScroll = Math.max(
      0,
      document.documentElement.scrollHeight - window.innerHeight
    );

    for (let index = 0; index <= steps; index += 1) {
      window.scrollTo(0, Math.round((maxScroll * index) / steps));
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

async function runTest(test) {
  const browser = await launchBrowser();
  const browserPid = browser.process()?.pid ?? 0;
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);

  const cycles = [];

  try {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const baseline = {
      page: await collectPageState(page),
      processMemory: readProcessTreeMemory(browserPid),
      targets: countWorkerTargets(browser),
    };

    for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
      const selector = `a[href^="${test.hrefPrefix}"]`;
      await page.click(selector);
      await page.waitForFunction(
        (hrefPrefix) => location.pathname.startsWith(hrefPrefix),
        { timeout: 60000 },
        test.hrefPrefix
      );
      await waitForCanvas(page);
      await scrollDocument(page);

      const afterOpen = {
        page: await collectPageState(page),
        processMemory: readProcessTreeMemory(browserPid),
        targets: countWorkerTargets(browser),
      };

      await page.goBack({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(
        () => {}
      );
      await page.waitForFunction(
        () => location.pathname === "/" && document.querySelectorAll("canvas").length === 0,
        { timeout: 60000 }
      );
      await new Promise((resolve) => setTimeout(resolve, RECOVERY_WAIT_MS));

      const afterLeave = {
        page: await collectPageState(page),
        processMemory: readProcessTreeMemory(browserPid),
        targets: countWorkerTargets(browser),
      };

      cycles.push({ cycle, afterOpen, afterLeave });
      console.log(
        `[${test.shortName} ${cycle}/${CYCLES}] open rss=${mb(
          afterOpen.processMemory.rssBytes
        )}MB canvas=${mb(afterOpen.page.canvasBytes)}MB workers=${
          afterOpen.targets.pdfWorkers
        } | leave rss=${mb(afterLeave.processMemory.rssBytes)}MB canvas=${mb(
          afterLeave.page.canvasBytes
        )}MB workers=${afterLeave.targets.pdfWorkers}`
      );
    }

    return {
      name: test.name,
      shortName: test.shortName,
      baseline,
      cycles,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

function summarize(results) {
  console.log("\nPDF.js lifecycle memory");
  console.log(`Cycles: ${CYCLES}, recovery wait: ${RECOVERY_WAIT_MS}ms, PDF: ${PDF_URL}`);

  for (const result of results) {
    const peakOpen = Math.max(
      ...result.cycles.map((cycle) => cycle.afterOpen.processMemory.rssBytes)
    );
    const lastLeave = result.cycles.at(-1)?.afterLeave.processMemory.rssBytes ?? 0;
    const baseline = result.baseline.processMemory.rssBytes;
    const peakCanvas = Math.max(
      ...result.cycles.map((cycle) => cycle.afterOpen.page.canvasBytes)
    );
    const maxLeavePdfWorkers = Math.max(
      ...result.cycles.map((cycle) => cycle.afterLeave.targets.pdfWorkers)
    );

    console.log(`\n${result.name}`);
    console.log(`  baseline RSS: ${mb(baseline)}MB`);
    console.log(`  peak open RSS: ${mb(peakOpen)}MB (+${mb(peakOpen - baseline)}MB)`);
    console.log(
      `  final leave RSS: ${mb(lastLeave)}MB (+${mb(lastLeave - baseline)}MB)`
    );
    console.log(`  peak canvas estimate: ${mb(peakCanvas)}MB`);
    console.log(`  max pdf.worker targets after leave: ${maxLeavePdfWorkers}`);
  }
}

(async () => {
  const results = [];

  for (const test of TESTS) {
    results.push(await runTest(test));
  }

  summarize(results);

  const outputPath = path.join(
    outDir,
    `pdfjs-lifecycle-memory-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );
  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      {
        env: {
          BASE_URL,
          PDF_URL,
          CYCLES,
          RECOVERY_WAIT_MS,
          VIEWPORT_WIDTH,
          VIEWPORT_HEIGHT,
        },
        results,
      },
      null,
      2
    )
  );
  console.log(`\nSaved: ${path.relative(process.cwd(), outputPath)}`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
