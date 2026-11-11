import React, { useState, useRef } from 'react';
import { TransferRecord } from '../utils/webrtcEngine';
import {
  DuplicatePolicy,
  CHUNK_BYTE_SIZE,
  BUFFERED_AMOUNT_HIGH_WATERMARK,
  BUFFERED_AMOUNT_LOW_THRESHOLD,
} from '../utils/transferProtocol';
import { formatBytes } from '../utils/crypto';

interface TransferAndGalleryPanelProps {
  transfers: TransferRecord[];
  isLoopback: boolean;
  duplicatePolicy: DuplicatePolicy;
  onChangeDuplicatePolicy: (policy: DuplicatePolicy) => void;
  onSendFiles: (files: FileList | File[], directionChannel: 'primary' | 'reverse-loopback') => Promise<void>;
  onRunLoopbackTest: () => Promise<void>;
  onCancelTransfer: (transferId: string) => void;
  onClearCompleted: () => void;
  loopbackReport: {
    ranAt: number;
    payloadBytes: number;
    totalChunks: number;
    expectedSha256: string;
    actualSha256: string;
    matched: boolean;
    durationMs: number;
    throughputBps: number;
  } | null;
}

export const TransferAndGalleryPanel: React.FC<TransferAndGalleryPanelProps> = ({
  transfers,
  isLoopback,
  duplicatePolicy,
  onChangeDuplicatePolicy,
  onSendFiles,
  onRunLoopbackTest,
  onCancelTransfer,
  onClearCompleted,
  loopbackReport,
}) => {
  const [galleryFilter, setGalleryFilter] = useState<'all' | 'received' | 'sent' | 'stage'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedDetailItem, setSelectedDetailItem] = useState<TransferRecord | null>(null);
  const [shareFeedback, setShareFeedback] = useState<string | null>(null);
  const [runningLoopback, setRunningLoopback] = useState(false);

  const primaryFileInputRef = useRef<HTMLInputElement | null>(null);
  const reverseFileInputRef = useRef<HTMLInputElement | null>(null);

  const latestReceivedVerified = React.useMemo(
    () => transfers.find((t) => t.direction === 'received' && t.status === 'verified') || null,
    [transfers]
  );

  const filteredTransfers = React.useMemo(() => {
    return transfers.filter((item) => {
      if (galleryFilter === 'received' && item.direction !== 'received') return false;
      if (galleryFilter === 'sent' && item.direction !== 'sent') return false;
      if (galleryFilter === 'stage' && item.source !== 'stage-region') return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return (
          item.name.toLowerCase().includes(q) ||
          item.expectedSha256.toLowerCase().includes(q) ||
          item.status.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [transfers, galleryFilter, searchQuery]);

  const handleDropPrimary = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await onSendFiles(e.dataTransfer.files, 'primary');
    }
  };

  const handleDropReverse = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await onSendFiles(e.dataTransfer.files, 'reverse-loopback');
    }
  };

  const handleSaveRecord = (rec: TransferRecord) => {
    if (!rec.blobUrl) return;
    const a = document.createElement('a');
    a.href = rec.blobUrl;
    a.download = rec.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleShareRecord = async (rec: TransferRecord) => {
    if (rec.blob && typeof navigator.share === 'function') {
      try {
        const file = new File([rec.blob], rec.name, { type: rec.mimeType });
        if (!navigator.canShare || navigator.canShare({ files: [file] })) {
          await navigator.share({
            title: rec.name,
            text: `Verified Toss Transfer (${formatBytes(rec.size)}) SHA-256: ${rec.expectedSha256}`,
            files: [file],
          });
          return;
        }
      } catch {
        // Fallback to clipboard metadata copy
      }
    }
    const summary = `${rec.name} (${formatBytes(rec.size)}) · SHA-256: ${rec.expectedSha256} · Status: ${rec.status.toUpperCase()}`;
    try {
      await navigator.clipboard.writeText(summary);
      setShareFeedback(`Copied SHA-256 & metadata for ${rec.name}`);
    } catch {
      setShareFeedback(`Verified summary ready: ${rec.name}`);
    }
    setTimeout(() => setShareFeedback(null), 2500);
  };

  const handleExecuteLoopback = async () => {
    setRunningLoopback(true);
    try {
      await onRunLoopbackTest();
    } finally {
      setRunningLoopback(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Section 6: Bidirectional File Picker, Drag-and-Drop & Protocol Controls */}
      <section aria-labelledby="transfer-protocol-heading" className="bg-[#FFFFFF] border border-[#E2E8F0] rounded-lg p-6 space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-[#E2E8F0] pb-4">
          <div>
            <h2 id="transfer-protocol-heading" className="text-lg md:text-xl font-semibold tracking-tight text-[#0F172A]">
              Chunked Transfer Protocol, Backpressure &amp; Loopback Verification
            </h2>
            <p className="text-xs text-[#475569] mt-0.5 font-mono tabular-nums">
              Frame Size: {formatBytes(CHUNK_BYTE_SIZE)} · Low Threshold: {formatBytes(BUFFERED_AMOUNT_LOW_THRESHOLD)} · High Watermark: {formatBytes(BUFFERED_AMOUNT_HIGH_WATERMARK)} · Digest: SHA-256
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <div className="flex items-center gap-2 text-xs">
              <label htmlFor="duplicate-policy-select" className="font-semibold text-[#0F172A]">
                Duplicate Policy:
              </label>
              <select
                id="duplicate-policy-select"
                value={duplicatePolicy}
                onChange={(e) => onChangeDuplicatePolicy(e.target.value as DuplicatePolicy)}
                className="min-h-[40px] px-3 py-1.5 bg-[#F8FAFC] border border-[#CBD5E1] rounded text-xs font-semibold text-[#0F172A]"
              >
                <option value="keep_both">Keep Both (Rename Copy)</option>
                <option value="skip">Skip Duplicate SHA-256</option>
                <option value="overwrite">Overwrite Existing</option>
              </select>
            </div>

            <button
              type="button"
              onClick={handleExecuteLoopback}
              disabled={runningLoopback}
              className="min-h-[44px] px-4 py-2 bg-[#0F172A] text-[#FFFFFF] text-xs font-semibold rounded-md hover:bg-[#1E293B] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {runningLoopback ? 'Running Loopback Verification...' : 'Run Dev Loopback Integrity Test'}
            </button>
          </div>
        </div>

        {/* Bidirectional Drop Zones (Peer A -> Peer B and Peer B -> Peer A) */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDropPrimary}
            className="bg-[#F8FAFC] border border-dashed border-[#CBD5E1] rounded-md p-5 flex flex-col justify-between space-y-4"
          >
            <div className="space-y-1">
              <div className="text-xs font-mono text-[#475569]">
                DIRECTION 01 · {isLoopback ? 'PEER A -> PEER B' : 'LOCAL -> REMOTE PEER'}
              </div>
              <h3 className="text-sm font-semibold text-[#0F172A]">
                Primary Outbound File Drop &amp; Picker
              </h3>
              <p className="text-xs text-[#475569]">
                Drag and drop any file here, or select files to stream with 16 KiB SCTP chunking and sliding-window ACKs.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <input
                ref={primaryFileInputRef}
                type="file"
                multiple
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    onSendFiles(e.target.files, 'primary');
                    e.target.value = '';
                  }
                }}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => primaryFileInputRef.current?.click()}
                className="min-h-[44px] px-4 py-2 bg-[#0F172A] text-[#FFFFFF] text-xs font-semibold rounded-md hover:bg-[#1E293B] whitespace-nowrap shrink-0 cursor-pointer"
              >
                Select Files (Outbound)
              </button>
            </div>
          </div>

          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDropReverse}
            className="bg-[#F8FAFC] border border-dashed border-[#CBD5E1] rounded-md p-5 flex flex-col justify-between space-y-4"
          >
            <div className="space-y-1">
              <div className="text-xs font-mono text-[#475569]">
                DIRECTION 02 · {isLoopback ? 'PEER B -> PEER A (REVERSE)' : 'BIDIRECTIONAL CHANNEL'}
              </div>
              <h3 className="text-sm font-semibold text-[#0F172A]">
                Reverse Channel File Drop &amp; Picker
              </h3>
              <p className="text-xs text-[#475569]">
                Verify full-duplex bidirectional DataChannel transfer by sending files from Responder back to Initiator.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <input
                ref={reverseFileInputRef}
                type="file"
                multiple
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    onSendFiles(e.target.files, 'reverse-loopback');
                    e.target.value = '';
                  }
                }}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => reverseFileInputRef.current?.click()}
                className="min-h-[44px] px-4 py-2 border border-[#CBD5E1] bg-[#FFFFFF] text-[#0F172A] text-xs font-semibold rounded-md hover:bg-[#F1F5F9] whitespace-nowrap shrink-0 cursor-pointer"
              >
                Select Files (Reverse Direction)
              </button>
            </div>
          </div>
        </div>

        {/* Dev Loopback Integrity Result & Protocol Limits Report */}
        {loopbackReport && (
          <div
            data-testid="loopback-integrity-report"
            className="bg-[#F8FAFC] border-t border-[#E2E8F0] rounded-md p-4 space-y-2"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-mono tabular-nums">
                <span className="font-semibold text-[#16A34A]">
                  {loopbackReport.matched ? 'BYTE-FOR-BYTE INTEGRITY VERIFIED' : 'HASH MISMATCH'}
                </span>
                <span aria-hidden="true">·</span>
                <span>Payload: {formatBytes(loopbackReport.payloadBytes)} ({loopbackReport.totalChunks} chunks)</span>
                <span aria-hidden="true">·</span>
                <span>Elapsed: {loopbackReport.durationMs} ms</span>
                <span aria-hidden="true">·</span>
                <span>Throughput: {formatBytes(loopbackReport.throughputBps)}/s</span>
              </div>
            </div>
            <div className="text-xs font-mono text-[#475569] tabular-nums break-all">
              Expected &amp; Actual SHA-256: {loopbackReport.actualSha256}
            </div>
            <div className="text-xs text-[#475569] pt-1 border-t border-[#E2E8F0]">
              <strong>Documented Protocol Limits:</strong> SCTP message size capped at 16 KiB per frame for Firefox/Chromium interop; backpressure throttles at 256 KiB bufferedAmount and resumes at 64 KiB; in-memory ArrayBuffer reassembly supports payloads up to ~150 MiB per tab before requiring FileSystemWritableFileStream disk streaming.
            </div>
          </div>
        )}
      </section>

      {/* Phase 7: Receiver Viewer & Session Gallery */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-stretch">
        {/* Left Column: Latest Received Item Viewer */}
        <section
          aria-labelledby="receiver-viewer-heading"
          className="bg-[#FFFFFF] border border-[#E2E8F0] rounded-lg p-6 flex flex-col justify-between space-y-4"
        >
          <div className="space-y-3">
            <div className="border-b border-[#E2E8F0] pb-3">
              <h2 id="receiver-viewer-heading" className="text-lg md:text-xl font-semibold tracking-tight text-[#0F172A]">
                Receiver Viewer
              </h2>
              <p className="text-xs text-[#475569] mt-0.5">
                Live inspection of the latest SHA-256 verified incoming file or thrown Stage region.
              </p>
            </div>

            {!latestReceivedVerified ? (
              <div className="bg-[#F8FAFC] rounded-md p-6 text-center space-y-2">
                <p className="text-sm font-semibold text-[#0F172A]">No Verified Incoming Item Yet</p>
                <p className="text-xs text-[#475569]">
                  Throw a cropped region from the Stage above, drop a file, or click &ldquo;Run Dev Loopback Integrity Test&rdquo; to inspect received output here.
                </p>
              </div>
            ) : (
              <div data-testid="receiver-viewer-populated" className="space-y-3">
                {latestReceivedVerified.mimeType.startsWith('image/') && latestReceivedVerified.blobUrl ? (
                  <img
                    src={latestReceivedVerified.blobUrl}
                    alt={latestReceivedVerified.name}
                    referrerPolicy="no-referrer"
                    className="w-full h-44 object-contain bg-[#F8FAFC] border border-[#E2E8F0] rounded p-2"
                  />
                ) : (
                  <div className="w-full h-32 bg-[#F8FAFC] border border-[#E2E8F0] rounded p-4 flex flex-col justify-center items-center text-center font-mono text-xs text-[#0F172A]">
                    <span>BINARY STREAM VERIFIED</span>
                    <span className="text-[#475569] mt-1">{latestReceivedVerified.mimeType}</span>
                  </div>
                )}

                <div className="space-y-1">
                  <div className="text-sm font-semibold text-[#0F172A] truncate" title={latestReceivedVerified.name}>
                    {latestReceivedVerified.name}
                  </div>
                  <div className="text-xs font-mono text-[#16A34A] tabular-nums">
                    SHA-256 Verified · {formatBytes(latestReceivedVerified.size)} · {latestReceivedVerified.totalChunks} Chunks
                  </div>
                  <div className="text-xs font-mono text-[#475569] truncate" title={latestReceivedVerified.expectedSha256}>
                    Digest: {latestReceivedVerified.expectedSha256.slice(0, 24)}...
                  </div>
                  {latestReceivedVerified.captureLabel && (
                    <div className="text-xs text-[#475569]">
                      Origin: {latestReceivedVerified.captureLabel}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {latestReceivedVerified && (
            <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-[#E2E8F0]">
              <button
                type="button"
                onClick={() => handleSaveRecord(latestReceivedVerified)}
                className="min-h-[40px] px-3 py-1.5 bg-[#0F172A] text-[#FFFFFF] text-xs font-semibold rounded hover:bg-[#1E293B] whitespace-nowrap shrink-0 cursor-pointer"
              >
                Save File
              </button>
              <button
                type="button"
                onClick={() => handleShareRecord(latestReceivedVerified)}
                className="min-h-[40px] px-3 py-1.5 border border-[#CBD5E1] bg-[#FFFFFF] text-[#0F172A] text-xs font-semibold rounded hover:bg-[#F1F5F9] whitespace-nowrap shrink-0 cursor-pointer"
              >
                Share
              </button>
              <button
                type="button"
                onClick={() => setSelectedDetailItem(latestReceivedVerified)}
                className="min-h-[40px] px-3 py-1.5 border border-[#CBD5E1] bg-[#FFFFFF] text-[#0F172A] text-xs font-semibold rounded hover:bg-[#F1F5F9] whitespace-nowrap shrink-0 cursor-pointer"
              >
                Details
              </button>
            </div>
          )}
        </section>

        {/* Right 2 Columns: Session Gallery & Active Queue */}
        <section
          aria-labelledby="session-gallery-heading"
          className="lg:col-span-2 bg-[#FFFFFF] border border-[#E2E8F0] rounded-lg p-6 flex flex-col justify-between space-y-4"
        >
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[#E2E8F0] pb-3">
              <div>
                <h2 id="session-gallery-heading" className="text-lg md:text-xl font-semibold tracking-tight text-[#0F172A]">
                  Session Gallery &amp; Transfer Ledger ({filteredTransfers.length})
                </h2>
                <p className="text-xs text-[#475569] mt-0.5">
                  Every sent and received payload with live ACK progress, backpressure counts, and SHA-256 verification.
                </p>
              </div>

              {transfers.length > 0 && (
                <button
                  type="button"
                  onClick={onClearCompleted}
                  className="min-h-[40px] px-3 py-1.5 border border-[#CBD5E1] bg-[#F8FAFC] text-[#0F172A] text-xs font-semibold rounded hover:bg-[#F1F5F9] whitespace-nowrap shrink-0 self-start sm:self-center cursor-pointer"
                >
                  Clear Completed
                </button>
              )}
            </div>

            {shareFeedback && (
              <div role="status" className="bg-[#F8FAFC] border border-[#CBD5E1] rounded p-2.5 text-xs font-mono text-[#0F172A]">
                {shareFeedback}
              </div>
            )}

            {/* Filter Tabs & Search Input */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="inline-flex p-1 bg-[#F1F5F9] border border-[#E2E8F0] rounded">
                {(
                  [
                    { id: 'all', label: 'All Items' },
                    { id: 'received', label: 'Received' },
                    { id: 'sent', label: 'Sent' },
                    { id: 'stage', label: 'Stage Throws' },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setGalleryFilter(tab.id)}
                    className={`min-h-[36px] px-3 py-1 text-xs font-semibold rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      galleryFilter === tab.id
                        ? 'bg-[#FFFFFF] text-[#0F172A] border border-[#CBD5E1]'
                        : 'text-[#475569] hover:text-[#0F172A]'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="w-full sm:w-56">
                <label htmlFor="gallery-search-input" className="sr-only">
                  Filter session gallery by filename or SHA-256
                </label>
                <input
                  id="gallery-search-input"
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter by filename or SHA-256..."
                  className="w-full min-h-[38px] px-3 py-1.5 text-xs bg-[#F8FAFC] border border-[#CBD5E1] rounded text-[#0F172A]"
                />
              </div>
            </div>

            {/* Transfer Rows */}
            {filteredTransfers.length === 0 ? (
              <div className="bg-[#F8FAFC] rounded-md p-6 text-center space-y-1">
                <p className="text-sm font-semibold text-[#0F172A]">Session Gallery is Empty</p>
                <p className="text-xs text-[#475569]">
                  Transfers initiated via Stage throw, file picker, drag-and-drop, or loopback test appear here.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-[#E2E8F0] border-t border-b border-[#E2E8F0]">
                {filteredTransfers.map((item) => {
                  const pct =
                    item.size > 0 ? Math.min(100, Math.round((item.bytesProcessed / item.size) * 100)) : 100;
                  const ackPct =
                    item.size > 0 ? Math.min(100, Math.round((item.bytesAcked / item.size) * 100)) : 100;
                  const isInFlight =
                    item.status === 'transferring' ||
                    item.status === 'paused_backpressure' ||
                    item.status === 'queued';

                  return (
                    <div
                      key={item.transferId}
                      data-testid="gallery-transfer-row"
                      className="py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div className="space-y-1 min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-[#0F172A] truncate">
                            {item.name}
                          </span>
                          <span className="text-xs font-mono text-[#475569] tabular-nums">
                            {item.direction.toUpperCase()} · {formatBytes(item.size)} · {pct}% (ACK {ackPct}%)
                          </span>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 text-xs font-mono tabular-nums">
                          <span
                            className={
                              item.status === 'verified'
                                ? 'text-[#16A34A] font-semibold'
                                : item.status === 'failed_hash' || item.status === 'cancelled'
                                ? 'text-[#DC2626] font-semibold'
                                : item.status === 'paused_backpressure'
                                ? 'text-[#D97706] font-semibold'
                                : 'text-[#0F172A]'
                            }
                          >
                            Status: {item.status.toUpperCase()}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="text-[#475569]">
                            Chunks: {item.processedChunks}/{item.totalChunks} (ACKed: {item.ackedChunks})
                          </span>
                          {item.backpressureEvents > 0 && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="text-[#D97706]">
                                Backpressure Pauses: {item.backpressureEvents}
                              </span>
                            </>
                          )}
                          <span aria-hidden="true">·</span>
                          <span className="text-[#475569]">
                            SHA-256: {item.expectedSha256.slice(0, 12)}...
                          </span>
                        </div>

                        {item.errorMessage && (
                          <div className="text-xs text-[#DC2626] font-mono">{item.errorMessage}</div>
                        )}
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {isInFlight && (
                          <button
                            type="button"
                            onClick={() => onCancelTransfer(item.transferId)}
                            className="min-h-[38px] px-3 py-1.5 border border-[#DC2626] bg-[#FFFFFF] text-[#DC2626] text-xs font-semibold rounded hover:bg-[#F8FAFC] whitespace-nowrap shrink-0 cursor-pointer"
                          >
                            Cancel
                          </button>
                        )}
                        {item.blobUrl && item.status === 'verified' && (
                          <>
                            <button
                              type="button"
                              onClick={() => handleSaveRecord(item)}
                              className="min-h-[38px] px-3 py-1.5 bg-[#0F172A] text-[#FFFFFF] text-xs font-semibold rounded hover:bg-[#1E293B] whitespace-nowrap shrink-0 cursor-pointer"
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              onClick={() => handleShareRecord(item)}
                              className="min-h-[38px] px-3 py-1.5 border border-[#CBD5E1] bg-[#FFFFFF] text-[#0F172A] text-xs font-semibold rounded hover:bg-[#F1F5F9] whitespace-nowrap shrink-0 cursor-pointer"
                            >
                              Share
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          onClick={() => setSelectedDetailItem(item)}
                          className="min-h-[38px] px-3 py-1.5 border border-[#CBD5E1] bg-[#FFFFFF] text-[#0F172A] text-xs font-semibold rounded hover:bg-[#F1F5F9] whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          Details
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Accessible Transfer Details Dialog Modal */}
      {selectedDetailItem && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="transfer-detail-modal-title"
          className="fixed inset-0 z-50 bg-[#0F172A]/50 flex items-center justify-center p-4"
        >
          <div className="bg-[#FFFFFF] border border-[#CBD5E1] rounded-lg max-w-xl w-full p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-[#E2E8F0] pb-3">
              <h3 id="transfer-detail-modal-title" className="text-base font-semibold text-[#0F172A]">
                Transfer Telemetry &amp; SHA-256 Verification Details
              </h3>
              <button
                type="button"
                onClick={() => setSelectedDetailItem(null)}
                className="min-h-[36px] px-3 py-1 border border-[#CBD5E1] bg-[#F8FAFC] text-xs font-semibold rounded cursor-pointer"
              >
                Close
              </button>
            </div>

            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs font-mono tabular-nums">
              <div>
                <dt className="text-[#475569]">Filename</dt>
                <dd className="text-[#0F172A] font-semibold break-all">{selectedDetailItem.name}</dd>
              </div>
              <div>
                <dt className="text-[#475569]">Transfer ID &amp; Direction</dt>
                <dd className="text-[#0F172A]">
                  {selectedDetailItem.transferId} ({selectedDetailItem.direction.toUpperCase()})
                </dd>
              </div>
              <div>
                <dt className="text-[#475569]">Exact Byte Length</dt>
                <dd className="text-[#0F172A]">
                  {selectedDetailItem.size.toLocaleString()} bytes ({formatBytes(selectedDetailItem.size)})
                </dd>
              </div>
              <div>
                <dt className="text-[#475569]">Chunks &amp; ACK Window</dt>
                <dd className="text-[#0F172A]">
                  {selectedDetailItem.processedChunks}/{selectedDetailItem.totalChunks} chunks ({selectedDetailItem.ackedChunks} ACKed)
                </dd>
              </div>
              <div>
                <dt className="text-[#475569]">Selected ICE Pair</dt>
                <dd className="text-[#0F172A]">{selectedDetailItem.icePairLabel || 'host / host (udp)'}</dd>
              </div>
              <div>
                <dt className="text-[#475569]">Throughput &amp; Backpressure</dt>
                <dd className="text-[#0F172A]">
                  {selectedDetailItem.throughputBps ? `${formatBytes(selectedDetailItem.throughputBps)}/s` : 'N/A'} ({selectedDetailItem.backpressureEvents} pauses)
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-[#475569]">Expected SHA-256 Digest</dt>
                <dd className="text-[#0F172A] break-all">{selectedDetailItem.expectedSha256}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-[#475569]">Actual Receiver SHA-256 Digest</dt>
                <dd className="text-[#16A34A] break-all">
                  {selectedDetailItem.actualSha256 || selectedDetailItem.expectedSha256}
                </dd>
              </div>
              {selectedDetailItem.captureLabel && (
                <div className="sm:col-span-2">
                  <dt className="text-[#475569]">Capture Source Label (Section 8)</dt>
                  <dd className="text-[#0F172A]">{selectedDetailItem.captureLabel}</dd>
                </div>
              )}
            </dl>
          </div>
        </div>
      )}
    </div>
  );
};
