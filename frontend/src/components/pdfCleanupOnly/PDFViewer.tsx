"use client";

import { useEffect, useState } from "react";
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
} from "pdfjs-dist/build/pdf";
import PDFPage from "./PDFPage";

let workerReady = false;
function ensureWorker() {
  if (workerReady || typeof window === "undefined") return;
  GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";
  workerReady = true;
}

interface PDFViewerProps {
  url: string;
}

export default function PDFViewer({ url }: PDFViewerProps) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!url?.trim()) return;

    let cancelled = false;
    let task: ReturnType<typeof getDocument> | null = null;
    let loadedDoc: PDFDocumentProxy | null = null;

    setLoading(true);
    setError(null);
    setPdf(null);
    setNumPages(0);

    (async () => {
      try {
        ensureWorker();
        task = getDocument({
          url,
          cMapUrl: "/api/pdfjs/cmaps/",
          cMapPacked: true,
          standardFontDataUrl: "/api/pdfjs/fonts/",
        });
        const doc = await task.promise;
        loadedDoc = doc;

        if (cancelled) {
          await doc.destroy();
          return;
        }

        setPdf(doc);
        setNumPages(doc.numPages);
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "PDF 로딩 실패");
        }
      } finally {
        if (!cancelled) setLoading(false);
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
  }, [url]);

  if (error) {
    return <div className="p-4 text-red-500">오류: {error}</div>;
  }

  if (loading) {
    return <div className="p-4 text-gray-400">PDF 로딩 중...</div>;
  }

  if (!pdf) return null;

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      {Array.from({ length: numPages }, (_, index) => (
        <PDFPage key={index + 1} pdf={pdf} pageNumber={index + 1} />
      ))}
    </div>
  );
}
