"use client";

import React, { useCallback, useState, useRef, useEffect } from "react";
import CommentForm from "../../comment_old/CommentForm";
import { FeedbackPoint } from "@/types/FeedbackPointType";

import type { PDFPageProxy, PDFDocumentProxy, RenderTask } from "pdfjs-dist";


const PAGE_RATIO = 1.414;
const RENDER_SCALE = 2;

interface PDFProps {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  feedback: FeedbackPoint[];
  addFeedbackPoint: (point: {
    pageNumber: number;
    x1: number;
    x2: number;
    y1: number;
    y2: number;
    content: string;
  }) => void;
  feedbackPoints: FeedbackPoint[];
  // editFeedbackPoint: (item: FeedbackPoint) => void;
  hoveredCommentId: number | null;
  setHoveredCommentId: (id: number | null) => void;
  setClickedCommentId: (id: number | null) => void;
}

const PDF: React.FC<PDFProps> = ({
  pdf,
  pageNumber,
  // feedback,
  addFeedbackPoint,
  feedbackPoints,
  // editFeedbackPoint,
  hoveredCommentId,
  // setHoveredCommentId,
  // setClickedCommentId,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);

  const handleCanvasRef = useCallback((canvas: HTMLCanvasElement | null) => {
    const previousCanvas = canvasRef.current;
    if (previousCanvas && previousCanvas !== canvas) {
      previousCanvas.width = 0;
      previousCanvas.height = 0;
    }
    canvasRef.current = canvas;
  }, []);

  const releaseCanvas = useCallback(() => {
    const renderTask = renderTaskRef.current;
    renderTaskRef.current = null;
    if (renderTask) {
      try {
        renderTask.cancel();
      } catch {
        // ignore cancel error
      }
    }

    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }, []);

  const [selectedArea, setSelectedArea] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [startPos, setStartPos] = useState({ x: 0, y: 0 });
  const [addingFeedback, setAddingFeedback] = useState<{
    x1: number;
    x2: number;
    y1: number;
    y2: number;
    pageNumber: number;
  } | null>(null);
  const [editingFeedback] = useState<FeedbackPoint | null>(
    null
  );

  useEffect(() => {
    let cancelled = false;

    const loadPage = async () => {
      const t0 = performance.now();
      console.log(`PDF 렌더링 시작 (페이지 ${pageNumber}): 0.00초`);

      let page: PDFPageProxy | null = null;
      let task: RenderTask | null = null;

      try {
        page = await pdf.getPage(pageNumber);
        const t1 = performance.now();

        if (cancelled || !canvasRef.current) return;

        const viewport = page.getViewport({ scale: RENDER_SCALE, rotation: 0 });
        const canvas = canvasRef.current;
        const context = canvas.getContext("2d");
        if (!context) return;

        canvas.width = viewport.width;
        canvas.height = viewport.height;

        if (renderTaskRef.current) {
          renderTaskRef.current.cancel();
        }

        task = page.render({
          canvasContext: context,
          viewport,
        });
        renderTaskRef.current = task;

        await task.promise;
        const t2 = performance.now();
        
        if (cancelled) return;
        
        const metrics = {
          page: pageNumber,
          getPageMs: parseFloat((t1 - t0).toFixed(1)),
          renderMs: parseFloat((t2 - t1).toFixed(1)),
          totalMs: parseFloat((t2 - t0).toFixed(1)),
        };
        
        console.log(`[pdfOld] 페이지 ${pageNumber} 렌더링 완료: ${metrics.totalMs.toFixed(1)}ms`);
        
        // 벤치마크 메트릭 수집기에 전달
        if (typeof window !== "undefined") {
          const metricsCollector = (
            window as Window & {
              pdfRenderMetricsCollector?: { add: (value: typeof metrics) => void };
            }
          ).pdfRenderMetricsCollector;
          metricsCollector?.add(metrics);
        }
      } catch (err: unknown) {
        if (!cancelled && err instanceof Error && err.name !== "RenderingCancelledException") {
          console.error("PDF 렌더링 에러:", err);
        }
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
    };

    loadPage();

    return () => {
      cancelled = true;
      releaseCanvas();
    };
  }, [pdf, pageNumber, releaseCanvas]);

  // hover 핸들러 캡슐화: 콘솔 로그로 확인
  // const handleHover = (id: number | null) => {
  //   setHoveredCommentId(id);
  // };

  const handleMouseDown = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setStartPos({ x, y });
    setSelectedArea({ x, y, width: 0, height: 0 });
    setIsSelecting(true);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isSelecting || !selectedArea) return;
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const currentX = e.clientX - rect.left;
    const currentY = e.clientY - rect.top;
    setSelectedArea({
      x: Math.min(startPos.x, currentX),
      y: Math.min(startPos.y, currentY),
      width: Math.abs(currentX - startPos.x),
      height: Math.abs(currentY - startPos.y),
    });
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    setIsSelecting(false);
    if (selectedArea) {
      const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
      const percentX1 = (selectedArea.x / rect.width) * 100;
      const percentX2 =
        ((selectedArea.x + selectedArea.width) / rect.width) * 100;
      const percentY1 = (selectedArea.y / rect.height) * 100;
      const percentY2 =
        ((selectedArea.y + selectedArea.height) / rect.height) * 100;
      setAddingFeedback({
        x1: percentX1,
        x2: percentX2,
        y1: percentY1,
        y2: percentY2,
        pageNumber,
      });
    }
  };

  const handleAddSubmit = (comment: string) => {
    if (addingFeedback) {
      addFeedbackPoint({
        pageNumber: addingFeedback.pageNumber,
        x1: addingFeedback.x1,
        x2: addingFeedback.x2,
        y1: addingFeedback.y1,
        y2: addingFeedback.y2,
        content: comment,
      });
      setAddingFeedback(null);
    }
  };

  return (
    <div
      style={{
        position: "relative",
        margin: "0 auto 16px",
        maxWidth: 900,
        aspectRatio: `1 / ${PAGE_RATIO}`,
        background: "#f3f4f6",
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {/* 캔버스 표시 */}
      <canvas
        ref={handleCanvasRef}
        style={{ display: "block", width: "100%", height: "100%" }}
      />
      {/* 캔버스 표시 */}


      {/* 선택 영역 표시 */}
      {selectedArea && (
        <div
          style={{
            position: "absolute",
            left: selectedArea.x,
            top: selectedArea.y,
            width: selectedArea.width,
            height: selectedArea.height,
            border: "2px dashed blue",
            pointerEvents: "none",
          }}
        />
      )}

      {feedbackPoints
        .filter((item) => item.pageNumber === pageNumber)
        .map((item) => {
          const fp: FeedbackPoint = item as FeedbackPoint;
          const left = fp.x1 ?? fp.x1 ?? 0;
          const top = fp.y1 ?? fp.y1 ?? 0;
          const width = (fp.x2 ?? left) - left || 10;
          const height = (fp.y2 ?? top) - top || 10;
          const key = fp.id ?? fp.id;
          const isHovered = (fp.id ?? fp.id) === hoveredCommentId;
          return (
            <div
              key={key}
              style={{
                position: "absolute",
                left: `${left}%`,
                top: `${top}%`,
                width: `${width}%`,
                height: `${height}%`,
                border: isHovered ? "2px solid #3B82F6" : "2px solid #EF4444",
                background: isHovered
                  ? "rgba(59,130,246,0.3)"
                  : "rgba(255,0,0,0.3)",
                cursor: "pointer",
              }}
            />
          );
        })}

      {addingFeedback && (
        <CommentForm
          position={{ x1: addingFeedback.x1, y1: addingFeedback.y1 }}
          onSubmit={handleAddSubmit}
        />
      )}
      {editingFeedback && (
        <CommentForm
          position={{
            x1: editingFeedback.x1,
            y1: editingFeedback.y1,
          }}
          initialComment={editingFeedback.content}
        />
      )}
    </div>
  );
};

export default PDF;
