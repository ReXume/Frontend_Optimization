"use client";

import { useEffect, useState } from "react";
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
} from "pdfjs-dist/build/pdf"; 

import PDF from "./PDF";
import { FeedbackPoint } from "@/types/FeedbackPointType";
import { AddFeedbackPoint } from "@/types/AddFeedbackPointType";

// 워커 파일 경로를 동적으로 설정
if (typeof window !== 'undefined') {
  GlobalWorkerOptions.workerSrc = `${window.location.origin}/pdf.worker.min.js`;
} else {
  GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";
}


interface PDFViewerProps {
  pdfSrc: string;
  pageNumber: number;
  addFeedbackPoint: (point: Omit<AddFeedbackPoint, "id">) => void;
  editFeedbackPoint: (point: FeedbackPoint) => void;
  feedbackPoints: FeedbackPoint[];
  hoveredCommentId: number | null;
  setHoveredCommentId: (id: number | null) => void;
  setClickedCommentId: (id: number | null) => void;
}

const PDFViewer = ({
  pdfSrc,
  // pageNumber,
  addFeedbackPoint,
  // editFeedbackPoint,
  feedbackPoints,
  hoveredCommentId,
  setHoveredCommentId,
  setClickedCommentId,
}: PDFViewerProps) => {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<typeof getDocument> | null = null;
    let loadedDoc: PDFDocumentProxy | null = null;

    setErr(null);
    setPdf(null);
    setNumPages(0);

    (async () => {
      if (!pdfSrc || typeof pdfSrc !== "string" || !pdfSrc.trim()) {
        setErr("PDF URL이 비어있습니다.");
        return;
      }
      try {
        task = getDocument({ url: pdfSrc });
        const loaded = await task.promise;
        loadedDoc = loaded;

        if (cancelled) {
          await loaded.destroy();
          return;
        }

        setPdf(loaded);
        setNumPages(loaded.numPages);
      } catch (e: unknown) {
        if (cancelled) return;
        console.error("Failed to load PDF:", e);
        setErr("PDF 로딩에 실패했습니다.");
      }
    })();

    return () => {
      cancelled = true;
      if (loadedDoc) {
        void loadedDoc.destroy().catch(() => {});
        return;
      }

      void task?.destroy().catch(() => {});
    };
  }, [pdfSrc]);


  if (err) return <div>{err}</div>;
  if (!pdf) return <div>PDF 로딩 중...</div>;


  return (
    <div
      style={{
        maxWidth: 900,
        width: "100%",
        margin: "0 auto",
        overflowY: "auto",
        maxHeight: "90vh",
      }}
    >
      {Array.from({ length: numPages }).map((_, idx) => (
        <PDF
          key={`page-${idx + 1}`}
          pdf={pdf}
          pageNumber={idx + 1}
          feedback={[]}
          addFeedbackPoint={addFeedbackPoint}
          feedbackPoints={feedbackPoints}
          hoveredCommentId={hoveredCommentId}
          setHoveredCommentId={setHoveredCommentId}
          setClickedCommentId={setClickedCommentId}
        />
      ))}
    </div>  
  );
};

export default PDFViewer;
