"use client";

import { useEffect, useRef } from "react";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";

interface PDFPageProps {
  pdf: PDFDocumentProxy;
  pageNumber: number;
}

const PAGE_RATIO = 1.414;
const RENDER_SCALE = 2;

export default function PDFPage({ pdf, pageNumber }: PDFPageProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);

  useEffect(() => {
    let cancelled = false;
    let page: PDFPageProxy | null = null;
    let task: RenderTask | null = null;

    (async () => {
      try {
        page = await pdf.getPage(pageNumber);
        if (cancelled || !canvasRef.current) return;

        const viewport = page.getViewport({ scale: RENDER_SCALE });
        const canvas = canvasRef.current;
        const context = canvas.getContext("2d");
        if (!context) return;

        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);

        task = page.render({ canvasContext: context, viewport });
        renderTaskRef.current = task;

        await task.promise;
      } catch (error: unknown) {
        const err = error as { name?: string };
        if (cancelled || err?.name === "RenderingCancelledException") return;

        console.error(`[CleanupOnlyPDFPage] page ${pageNumber} render failed`, err);
      } finally {
        if (renderTaskRef.current === task) {
          renderTaskRef.current = null;
        }

        if (page) {
          try {
            page.cleanup();
          } catch {
            // ignore cleanup error
          }
        }
      }
    })();

    return () => {
      cancelled = true;
      if (renderTaskRef.current) {
        try {
          renderTaskRef.current.cancel();
        } catch {
          // ignore cancel error
        }
        renderTaskRef.current = null;
      }
    };
  }, [pageNumber, pdf]);

  return (
    <div
      data-page-number={pageNumber}
      style={{
        position: "relative",
        margin: "0 auto 16px",
        maxWidth: 900,
        aspectRatio: `1 / ${PAGE_RATIO}`,
        background: "#f3f4f6",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          display: "block",
          width: "100%",
          height: "100%",
        }}
      />
    </div>
  );
}
