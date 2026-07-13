"use client";

import Link from "next/link";
import {
  ArrowRight,
  Database,
  Eye,
  FileText,
  Gauge,
  RefreshCcw,
} from "lucide-react";

const PDF_URL = "/heavy-designer-portfolio-50p.pdf";

const routes = [
  {
    title: "Basic eager",
    href: `/pdf-bench/basic?url=${PDF_URL}`,
    icon: FileText,
    border: "border-slate-200",
    label: "baseline",
    summary: "전체 50페이지를 진입 시점에 canvas로 유지",
    metrics: {
      memory: "2.7GB",
      canvas: "1287.5MB",
      offscreen: "1261.7MB",
      count: "50",
      tbt: "463ms",
    },
  },
  {
    title: "Cleanup Only",
    href: `/pdf-bench/cleanup-only?url=${PDF_URL}`,
    icon: RefreshCcw,
    border: "border-amber-200",
    label: "control",
    summary: "RenderTask.cancel + page.cleanup만 적용",
    metrics: {
      memory: "eager 유지",
      canvas: "1287.5MB",
      offscreen: "1261.7MB",
      count: "50",
      tbt: "441ms",
    },
  },
  {
    title: "Viewport Memory + LRU",
    href: `/pdf-bench/viewport-memory?url=${PDF_URL}`,
    icon: Eye,
    border: "border-cyan-300",
    label: "optimized",
    summary: "viewport render + 최근 5페이지 canvas cache",
    metrics: {
      memory: "298MB",
      canvas: "51.5MB",
      offscreen: "25.7MB",
      count: "2 / peak 5",
      tbt: "249ms",
    },
  },
];

const metricRows = [
  {
    metric: "Chrome 메모리 관측값",
    basic: "약 2.7GB",
    cleanup: "동일 eager 구조",
    optimized: "약 298MB",
    result: "89.0% 감소",
  },
  {
    metric: "초기 canvas 추정값",
    basic: "1287.5MB",
    cleanup: "1287.5MB",
    optimized: "51.5MB",
    result: "초기 2개",
  },
  {
    metric: "초기 offscreen 추정값",
    basic: "1261.7MB",
    cleanup: "1261.7MB",
    optimized: "25.7MB",
    result: "98.0% 감소",
  },
  {
    metric: "scroll 중 peak",
    basic: "1287.5MB",
    cleanup: "1287.5MB",
    optimized: "128.7MB",
    result: "최근 5개 유지",
  },
  {
    metric: "First canvas paint",
    basic: "3456ms",
    cleanup: "3122ms",
    optimized: "923ms",
    result: "73.3% 개선",
  },
  {
    metric: "초기 TBT 추정",
    basic: "463ms",
    cleanup: "441ms",
    optimized: "249ms",
    result: "46.2% 개선",
  },
  {
    metric: "초기 p95 frame gap",
    basic: "108ms",
    cleanup: "75ms",
    optimized: "9ms",
    result: "프레임 지연 완화",
  },
  {
    metric: "초기 32ms 초과 frame",
    basic: "26",
    cleanup: "23",
    optimized: "6",
    result: "초기 끊김 감소",
  },
  {
    metric: "Chrome RSS 초기 증가량",
    basic: "+1516.2MB",
    cleanup: "+1722.0MB",
    optimized: "+244.0MB",
    result: "83.9% 감소",
  },
  {
    metric: "Chrome RSS scroll 후 증가량",
    basic: "+1514.7MB",
    cleanup: "+2071.2MB",
    optimized: "+281.9MB",
    result: "81.4% 감소",
  },
];

export default function Page() {
  return (
    <main className="min-h-screen bg-slate-50 text-slate-950">
      <section className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-5 py-8 md:px-8">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <div className="mb-2 inline-flex items-center gap-2 rounded border border-cyan-200 bg-cyan-50 px-2 py-1 text-xs font-semibold text-cyan-800">
                <Database className="h-3.5 w-3.5" />
                PDF canvas memory benchmark
              </div>
              <h1 className="text-3xl font-bold tracking-normal text-slate-950 md:text-4xl">
                ReXume PDF Viewer
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                전체 PDF 페이지를 eager하게 canvas로 유지해 Chrome 메모리가
                약 2.7GB까지 증가하던 구조를 viewport 기반 렌더링, canvas
                backing store 해제, 최근 페이지 LRU 캐시로 비교합니다.
              </p>
            </div>
            <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
              50 pages · 1125x1500pt · render scale 2 · CPU 4x throttle
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                <FileText className="h-4 w-4" />
                Problem
              </div>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                화면에는 1-2페이지만 보이지만 50페이지 canvas backing store가
                모두 유지되어 Chrome 메모리가 약 2.7GB까지 증가했습니다.
              </p>
            </div>
            <div className="rounded border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                <RefreshCcw className="h-4 w-4" />
                Control
              </div>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                `RenderTask.cancel()`과 `page.cleanup()`만으로는 이미 렌더링된
                canvas 픽셀 버퍼가 줄지 않았습니다.
              </p>
            </div>
            <div className="rounded border border-cyan-200 bg-cyan-50 p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-cyan-900">
                <Eye className="h-4 w-4" />
                Solution
              </div>
              <p className="mt-2 text-sm leading-6 text-cyan-950/80">
                viewport 주변 페이지만 렌더링하고, 화면 밖 canvas는 최근
                5페이지 LRU에서 밀릴 때 `width/height`를 0으로 reset해 약
                298MB 수준으로 낮췄습니다.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-5 py-6 md:px-8">
        <div className="grid gap-4 lg:grid-cols-3">
          {routes.map((route) => {
            const Icon = route.icon;
            return (
              <Link
                key={route.title}
                href={route.href}
                className={`block rounded border-2 ${route.border} bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="flex h-9 w-9 items-center justify-center rounded border border-slate-200 bg-slate-50">
                      <Icon className="h-4 w-4" />
                    </span>
                    <div>
                      <div className="text-base font-bold text-slate-950">
                        {route.title}
                      </div>
                      <div className="mt-0.5 text-xs font-semibold uppercase text-slate-500">
                        {route.label}
                      </div>
                    </div>
                  </div>
                  <ArrowRight className="mt-1 h-4 w-4 text-slate-400" />
                </div>
                <p className="mt-3 min-h-10 text-sm leading-5 text-slate-600">
                  {route.summary}
                </p>
                <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
                  <div className="rounded border border-slate-100 bg-slate-50 p-2">
                    <dt className="text-xs text-slate-500">Chrome 메모리</dt>
                    <dd className="mt-1 font-semibold text-slate-950">
                      {route.metrics.memory}
                    </dd>
                  </div>
                  <div className="rounded border border-slate-100 bg-slate-50 p-2">
                    <dt className="text-xs text-slate-500">초기 canvas</dt>
                    <dd className="mt-1 font-semibold text-slate-950">
                      {route.metrics.canvas}
                    </dd>
                  </div>
                  <div className="rounded border border-slate-100 bg-slate-50 p-2">
                    <dt className="text-xs text-slate-500">canvas 수</dt>
                    <dd className="mt-1 font-semibold text-slate-950">
                      {route.metrics.count}
                    </dd>
                  </div>
                  <div className="rounded border border-slate-100 bg-slate-50 p-2">
                    <dt className="text-xs text-slate-500">TBT</dt>
                    <dd className="mt-1 font-semibold text-slate-950">
                      {route.metrics.tbt}
                    </dd>
                  </div>
                </dl>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-5 pb-8 md:px-8">
        <div className="grid gap-4 lg:grid-cols-[1.7fr_1fr]">
          <div className="rounded border border-slate-200 bg-white">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <div>
                <h2 className="text-base font-bold text-slate-950">
                  비교 결과
                </h2>
                <p className="mt-1 text-xs text-slate-500">
                  Chrome 메모리는 배포 환경 관측값, canvas memory는 `width *
                  height * 4` 기준 추정값입니다.
                </p>
              </div>
              <Gauge className="h-5 w-5 text-slate-400" />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
                    <th className="px-4 py-2 font-semibold">Metric</th>
                    <th className="px-3 py-2 text-right font-semibold">
                      Basic
                    </th>
                    <th className="px-3 py-2 text-right font-semibold">
                      Cleanup
                    </th>
                    <th className="px-3 py-2 text-right font-semibold">
                      Viewport + LRU
                    </th>
                    <th className="px-4 py-2 text-right font-semibold">
                      Result
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {metricRows.map((row) => (
                    <tr key={row.metric} className="border-b border-slate-100">
                      <td className="px-4 py-3 font-medium text-slate-800">
                        {row.metric}
                      </td>
                      <td className="px-3 py-3 text-right text-slate-600">
                        {row.basic}
                      </td>
                      <td className="px-3 py-3 text-right text-slate-600">
                        {row.cleanup}
                      </td>
                      <td className="px-3 py-3 text-right font-semibold text-cyan-800">
                        {row.optimized}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-slate-900">
                        {row.result}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded border border-slate-200 bg-white p-4">
            <h2 className="text-base font-bold text-slate-950">결론</h2>
            <div className="mt-4 space-y-3 text-sm leading-6 text-slate-600">
              <p>
                `page.cleanup()`은 PDF.js lifecycle 정리에 필요하지만, 이미
                렌더링된 canvas backing store를 줄이는 핵심 수단은 아니었습니다.
              </p>
              <p>
                실제 개선은 렌더링 엔진이 아니라, 동시에 유지하는 canvas
                backing store 개수를 제한하고 최근 페이지는 캐시하는 지점에서
                발생했습니다.
              </p>
              <p className="rounded border border-cyan-200 bg-cyan-50 p-3 font-semibold text-cyan-950">
                대표 성과: Chrome 메모리 2.7GB → 298MB, 초기 canvas 추정값 1287.5MB → 51.5MB
              </p>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
