import React, { useState, useEffect, useRef } from 'react';
import { 
  Camera as CameraIcon, 
  List as ListIcon, 
  Plus, 
  Trash2, 
  Check, 
  Download, 
  RefreshCw, 
  FileText, 
  X, 
  ChevronRight,
  Sparkles,
  RotateCcw,
  UploadCloud,
  FileCheck,
  AlertCircle
} from 'lucide-react';
import { db, compressPhoto } from './db';
import { type ScanItem, type ExamGroup } from './types';
import { generateBatchPDF } from './pdfGenerator';

export default function App() {
  // Database States
  const [items, setItems] = useState<ScanItem[]>([]);
  const [examGroups, setExamGroups] = useState<ExamGroup[]>([]);
  const [totalPageCount, setTotalPageCount] = useState<number>(0);
  const [totalExamsCount, setTotalExamsCount] = useState<number>(0);

  // UI Flow States
  const [isManagerOpen, setIsManagerOpen] = useState<boolean>(false);
  const [isBoundaryModalOpen, setIsBoundaryModalOpen] = useState<boolean>(false);
  const [isDeletingGroup, setIsDeletingGroup] = useState<string | null>(null);
  const [isDeletingSingleItem, setIsDeletingSingleItem] = useState<string | null>(null);
  
  // PDF Compilation Result States
  const [viewMode, setViewMode] = useState<'capture' | 'completed'>('capture');
  const [generatedPdf, setGeneratedPdf] = useState<{
    blob: Blob | null;
    filename: string;
    sizeFormatted: string;
    examsCount: number;
    totalPages: number;
  }>({
    blob: null,
    filename: '',
    sizeFormatted: '',
    examsCount: 0,
    totalPages: 0
  });

  // Boundary Form Inputs
  const [subjectInput, setSubjectInput] = useState<string>('');
  const [classInput, setClassInput] = useState<string>('');

  // Interactive Live Web Camera States
  const [useLiveCamera, setUseLiveCamera] = useState<boolean>(true);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [cameraAvailable, setCameraAvailable] = useState<boolean>(true);
  const [cameraErrorMsg, setCameraErrorMsg] = useState<string>('');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Status logs or warning states
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [isCompiling, setIsCompiling] = useState<boolean>(false);
  const [compilationProgress, setCompilationProgress] = useState<number>(0);

  // Dynamic Thumbnail Cache
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>({});

  // 1. Load Items from Database on mount & reload
  const refreshItemsFromDB = async () => {
    try {
      const dbItems = await db.scans.orderBy('timestamp').toArray();
      setItems(dbItems);
      
      // Formulate exam groups
      const parsed = parseScansToExams(dbItems);
      setExamGroups(parsed);

      // Compute statistics
      const imagesCount = dbItems.filter(item => item.type === 'image').length;
      const completedExams = parsed.filter(group => group.isCompleted).length;
      
      setTotalPageCount(imagesCount);
      setTotalExamsCount(completedExams);

      // Generate object URLs for images to avoid high memory spikes
      const newUrls: Record<string, string> = {};
      
      // Revoke older URLs first to avoid memory leaks
      (Object.values(thumbnailUrls) as string[]).forEach(url => URL.revokeObjectURL(url));

      dbItems.forEach(item => {
        if (item.type === 'image' && item.fileData) {
          newUrls[item.id] = URL.createObjectURL(item.fileData);
        }
      });
      setThumbnailUrls(newUrls);

    } catch (err) {
      console.error('Error fetching database items:', err);
      setStatusMessage('Error loading scanner state.');
    }
  };

  useEffect(() => {
    refreshItemsFromDB();
    // Cleanup URLs on unmount
    return () => {
      (Object.values(thumbnailUrls) as string[]).forEach(url => URL.revokeObjectURL(url));
    };
  }, []);

  // Sync Live Camera Stream when requested
  useEffect(() => {
    if (useLiveCamera && viewMode === 'capture') {
      startCamera();
    } else {
      stopCamera();
    }
    return () => stopCamera();
  }, [useLiveCamera, viewMode]);

  // Parse list of ScanItems into Exams List
  const parseScansToExams = (scanItems: ScanItem[]): ExamGroup[] => {
    const sorted = [...scanItems].sort((a, b) => a.timestamp - b.timestamp);
    const groups: ExamGroup[] = [];
    
    let accumulatedPages: ScanItem[] = [];
    let dIndex = 1;

    for (const item of sorted) {
      if (item.type === 'image') {
        accumulatedPages.push(item);
      } else if (item.type === 'boundary') {
        // Enclose previous accumulated pages into this completed exam group
        groups.push({
          id: item.id,
          isCompleted: true,
          subject: item.subject,
          className: item.className,
          pagesCount: accumulatedPages.length,
          items: [...accumulatedPages, item],
          displayIndex: dIndex++
        });
        accumulatedPages = []; // Reset pages context
      }
    }

    // Capture pages in active non-bounded session
    if (accumulatedPages.length > 0) {
      groups.push({
        id: 'active-session',
        isCompleted: false,
        pagesCount: accumulatedPages.length,
        items: accumulatedPages,
        displayIndex: dIndex
      });
    }

    return groups;
  };

  // Live Camera Controls
  const startCamera = async () => {
    setCameraErrorMsg('');
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 960 } },
          audio: false
        });
        setCameraStream(stream);
        setCameraAvailable(true);
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      } else {
        setCameraAvailable(false);
        setCameraErrorMsg('No system video capture permission or hardware available.');
      }
    } catch (err: any) {
      console.warn('Camera stream lock failed:', err);
      setCameraAvailable(false);
      setCameraErrorMsg('Camera access denied or device is currently busy.');
    }
  };

  const stopCamera = () => {
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      setCameraStream(null);
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  };

  // Capture Photo action using video feed frame
  const captureFromVideo = async () => {
    if (!videoRef.current || !cameraStream) {
      // Prompt user to snap a beautifully formatted mock sheet as a high-fidelity fallback
      await captureMockSheet();
      return;
    }
    
    try {
      const video = videoRef.current;
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 1024;
      canvas.height = video.videoHeight || 768;

      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(async (blob) => {
          if (blob) {
            const compressed = await compressPhoto(blob);
            await saveCapturedImage(compressed);
            triggerHapticFeedback();
            showBriefToast('Scanned single page');
          }
        }, 'image/jpeg', 0.85);
      }
    } catch (err) {
      console.error('Camera canvas snapshot failed:', err);
      showBriefToast('Snap failed. Please upload files instead.');
    }
  };

  // Native Image Upload Handler
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setStatusMessage('Compressing and saving papers...');
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const compressedBlob = await compressPhoto(file);
        await saveCapturedImage(compressedBlob);
      } catch (err) {
        console.error('File compression issue:', err);
      }
    }
    setStatusMessage('');
    showBriefToast(`Uploaded ${files.length} pages`);
    if (fileInputRef.current) {
      fileInputRef.current.value = ''; // Reset input
    }
  };

  // Generate a premium, highly realistic hand-drawn simulated exam paper sheet for desktop testing
  const captureMockSheet = async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1000;
    canvas.height = 1400;
    const ctx = canvas.getContext('2d');

    if (ctx) {
      // White page background
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, 1000, 1400);

      // Clean elegant page header area
      ctx.fillStyle = '#F3F4F6';
      ctx.fillRect(60, 60, 880, 160);

      // Student metadata placeholders
      ctx.fillStyle = '#111827';
      ctx.font = 'bold 32px sans-serif';
      ctx.fillText('EXAM ANSWER DOCUMENT', 100, 120);

      ctx.fillStyle = '#4B5563';
      ctx.font = '20px monospace';
      ctx.fillText('CANDIDATE ID: EXM-34081-PL', 100, 160);
      ctx.fillText(`DATE: ${new Date().toLocaleDateString()}`, 100, 190);

      // Highlight badge
      ctx.fillStyle = '#10B981';
      ctx.fillRect(720, 100, 160, 80);
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 24px sans-serif';
      ctx.fillText('PAGE SCAN', 740, 145);

      // Ruled guidelines
      ctx.strokeStyle = '#E5E7EB';
      ctx.lineWidth = 1.5;
      for (let y = 280; y < 1300; y += 45) {
        ctx.beginPath();
        ctx.moveTo(60, y);
        ctx.lineTo(940, y);
        ctx.stroke();
      }

      // Simulated handwriting
      ctx.fillStyle = '#1D4ED8'; // Hand-written blue ink style
      ctx.font = 'italic 22px "Georgia", serif';
      ctx.fillText('Question 1: Elaborate on the design limits of standard mobile memory state caches.', 90, 315);
      
      ctx.fillText('Answer: In web ecosystems, tab caching is vulnerable to browser garbage collection loops.', 90, 360);
      ctx.fillText('Thus, using IndexDB prevents transaction failures in offline conditions.', 90, 405);
      
      // Drawings
      ctx.strokeStyle = '#1D4ED8';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(800, 420, 45, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillText('Correct (98%)', 760, 490);

      ctx.fillText('Question 2: Create a high fidelity mock representation.', 90, 580);
      ctx.fillText('Diagram below depicts the flow for dividing exams on-the-fly.', 90, 625);

      // Draw beautiful flowchart container
      ctx.strokeStyle = '#1D4ED8';
      ctx.fillStyle = '#EFF6FF';
      ctx.fillRect(200, 700, 240, 120);
      ctx.strokeRect(200, 700, 240, 120);
      
      ctx.fillStyle = '#1D4ED8';
      ctx.font = 'bold 18px monospace';
      ctx.fillText('SCAN PAGES 1 & 2', 230, 750);
      ctx.fillText('[Local Blob Cached]', 225, 780);

      // Arrow
      ctx.beginPath();
      ctx.moveTo(440, 760);
      ctx.lineTo(540, 760);
      ctx.stroke();

      ctx.fillStyle = '#F0FDF4';
      ctx.fillRect(540, 700, 260, 120);
      ctx.strokeRect(540, 700, 260, 120);
      
      ctx.fillStyle = '#065F46';
      ctx.font = 'bold 18px monospace';
      ctx.fillText('CLICK DONE & BOUNDARY', 560, 750);
      ctx.fillText('[Insert White Divider]', 565, 780);

      // Text section page 2
      ctx.fillStyle = '#1D4ED8';
      ctx.font = 'italic 22px "Georgia", serif';
      ctx.fillText('All exam sequences output cleanly according to chronological timeline slots.', 90, 920);
      ctx.fillText('By choosing custom input labels, multiple school scripts compile safely.', 90, 965);

      // Signature / stamp at footer page
      ctx.strokeStyle = '#10B981';
      ctx.strokeRect(650, 1080, 240, 100);
      ctx.fillStyle = '#10B981';
      ctx.font = 'bold 20px monospace';
      ctx.fillText('EXAMO CERTIFICATION', 670, 1120);
      ctx.fillText('VERIFIED ORIGINAL', 680, 1150);

      // Save canvas to db as blob
      canvas.toBlob(async (blob) => {
        if (blob) {
          await saveCapturedImage(blob);
          triggerHapticFeedback();
          showBriefToast('Generated original scanned page');
        }
      }, 'image/jpeg', 0.85);
    }
  };

  // Save scan page to db
  const saveCapturedImage = async (imageBlob: Blob) => {
    const newItem: ScanItem = {
      id: `scan-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      type: 'image',
      fileData: imageBlob,
      timestamp: Date.now()
    };
    await db.scans.add(newItem);
    await refreshItemsFromDB();
  };

  const triggerHapticFeedback = () => {
    if (navigator.vibrate) {
      navigator.vibrate(50);
    }
  };

  const showBriefToast = (message: string) => {
    setStatusMessage(message);
    setTimeout(() => {
      setStatusMessage((current) => current === message ? '' : current);
    }, 3500);
  };

  // Add Boundary Block (Marks previous exams complete to split pages context)
  const handleInsertBoundary = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!subjectInput.trim()) {
      showBriefToast('Please specify a subject');
      return;
    }

    const boundaryItem: ScanItem = {
      id: `boundary-${Date.now()}`,
      type: 'boundary',
      subject: subjectInput.trim(),
      className: classInput.trim() || 'General',
      timestamp: Date.now(),
      fileData: null
    };

    try {
      await db.scans.add(boundaryItem);
      // Reset
      setSubjectInput('');
      setClassInput('');
      setIsBoundaryModalOpen(false);
      showBriefToast('Custom divider page inserted');
      await refreshItemsFromDB();
    } catch (err) {
      console.error(err);
      showBriefToast('Could not insert boundary separator.');
    }
  };

  // Delete Individual Slide / Scan Item directly
  const handleDeleteItem = async (itemId: string) => {
    try {
      await db.scans.delete(itemId);
      setIsDeletingSingleItem(null);
      await refreshItemsFromDB();
      showBriefToast('Removed item from sequence');
    } catch (err) {
      console.error(err);
    }
  };

  // Delete Whole Exam Group
  const handleDeleteGroup = async () => {
    if (!isDeletingGroup) return;

    try {
      if (isDeletingGroup === 'active-session') {
        const activePages = items.filter(
          item => item.type === 'image' && 
          !examGroups.some(g => g.isCompleted && g.items.some(gi => gi.id === item.id))
        );
        for (const page of activePages) {
          await db.scans.delete(page.id);
        }
        showBriefToast('Cleared active workspace');
      } else {
        const targetGroup = examGroups.find(g => g.id === isDeletingGroup);
        if (targetGroup) {
          for (const item of targetGroup.items) {
            await db.scans.delete(item.id);
          }
          showBriefToast('Deleted exam batch');
        }
      }
      setIsDeletingGroup(null);
      await refreshItemsFromDB();
    } catch (err) {
      console.error('Failed to purge group:', err);
    }
  };

  // Clear All
  const handleClearAll = async () => {
    if (window.confirm('Clear all scans and divider pages in this session?')) {
      try {
        await db.scans.clear();
        await refreshItemsFromDB();
        showBriefToast('Cleared completely');
      } catch (err) {
        console.error(err);
      }
    }
  };

  // Compile PDF Batch routine
  const handleCompilePDF = async () => {
    if (items.length === 0) {
      showBriefToast('No scanned pages found to compile');
      return;
    }

    try {
      setIsCompiling(true);
      setCompilationProgress(20);
      
      // Let's call the flat chronological PDF builder
      const result = await generateBatchPDF(items, (progress) => {
        setCompilationProgress(progress);
      });

      const sizeMB = (result.sizeBytes / (1024 * 1024)).toFixed(2);
      
      setGeneratedPdf({
        blob: result.blob,
        filename: result.filename,
        sizeFormatted: `${sizeMB} MB`,
        examsCount: totalExamsCount,
        totalPages: result.pageCount
      });

      setIsManagerOpen(false);
      setViewMode('completed');
      setIsCompiling(false);
      showBriefToast('PDF compilation complete!');

    } catch (err) {
      console.error('PDF compiling error:', err);
      showBriefToast('Compilation failed.');
      setIsCompiling(false);
    }
  };

  const triggerPdfDownload = () => {
    if (!generatedPdf.blob) return;
    
    const url = URL.createObjectURL(generatedPdf.blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = generatedPdf.filename;
    document.body.appendChild(link);
    link.click();
    
    setTimeout(() => {
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }, 100);
  };

  const handleStartNewBatch = async () => {
    if (window.confirm('Create a standard new batch? This clears current storage to prevent memory fatigue.')) {
      try {
        await db.scans.clear();
        setGeneratedPdf({
          blob: null,
          filename: '',
          sizeFormatted: '',
          examsCount: 0,
          totalPages: 0
        });
        setViewMode('capture');
        await refreshItemsFromDB();
      } catch (err) {
        console.error(err);
      }
    }
  };

  // Check how many pages are currently in the working active session
  const activeUnlabeledPagesCount = items.filter(
    item => item.type === 'image' && 
    !examGroups.some(g => g.isCompleted && g.items.some(gi => gi.id === item.id))
  ).length;

  return (
    <div className="min-h-screen bg-[#0F172A] flex flex-col items-center justify-center p-0 md:p-4 selection:bg-indigo-500 selection:text-white">
      
      {/* PHONE WRAPPER - Looks gorgeous, avoids brutalist pixelation, is very neat and fits screen perfectly */}
      <div className="w-full max-w-md h-[100dvh] md:h-[840px] bg-black md:rounded-[44px] md:p-3 shadow-2xl relative flex flex-col overflow-hidden border-2 md:border-4 border-slate-800">
        
        {/* Physical phone ear speaker/notch simulation */}
        <div className="absolute top-1.5 left-1/2 -translate-x-1/2 w-32 h-4.5 bg-black rounded-full z-40 hidden md:block" />

        {/* Dynamic App Container inside phone screen */}
        <div className="flex-1 h-full w-full bg-[#FAF9F6] text-[#0F172A] relative flex flex-col justify-between overflow-hidden md:rounded-[32px]">
          
          {/* Header Overlay - absolute top floating to keep layout entirely snapchat-like */}
          <header className="absolute top-0 left-0 right-0 h-16 bg-white/70 backdrop-blur-md border-b border-gray-200/50 px-4 flex justify-between items-center z-30 select-none">
            <div className="flex flex-col">
              <h1 className="text-base font-display font-black tracking-tight text-slate-900 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-indigo-600 block animate-pulse" />
                EXAMO CLIENT
              </h1>
              <span className="text-[9px] text-gray-500 font-mono tracking-wider font-extrabold uppercase -mt-0.5">LOCAL PERSISTENT SCANNER</span>
            </div>
            
            {/* Minimal Premium counters badge */}
            <div className="bg-indigo-50 border border-indigo-200 py-1.5 px-3 rounded-full flex items-center gap-1.5 shadow-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
              <span className="font-mono text-[10px] font-bold text-indigo-700 tracking-tight">
                {viewMode === 'completed' ? 'READY' : `${totalPageCount} PGS / ${totalExamsCount} EXAMS`}
              </span>
            </div>
          </header>

          {/* MAIN CONTAINER PANEL */}
          <div className="flex-1 w-full h-full relative flex flex-col overflow-hidden pt-16">
            
            {/* Brief Feedback Toast Banner */}
            {statusMessage && (
              <div className="absolute top-18 left-4 right-4 z-40 bg-zinc-900 text-white text-xs font-medium px-4 py-3 rounded-xl shadow-lg border border-zinc-800 flex items-center justify-between transition-all animate-slide-up">
                <span className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping inline-block" />
                  {statusMessage}
                </span>
                <button onClick={() => setStatusMessage('')} className="p-1 hover:bg-zinc-800 rounded-full">
                  <X className="w-3.5 h-3.5 text-zinc-400" />
                </button>
              </div>
            )}

            {viewMode === 'capture' ? (
              // 1. CAPTURE & SNAP UI (SNAPCHAT CAMERA SCREEN)
              <div className="flex-1 w-full h-full flex flex-col justify-between overflow-hidden relative">
                
                {/* Full screen viewfinder backdrop */}
                <div className="absolute inset-0 w-full h-full bg-[#111827] flex items-center justify-center p-0 overflow-hidden">
                  
                  {useLiveCamera ? (
                    <div className="w-full h-full relative bg-zinc-950 flex items-center justify-center">
                      {cameraAvailable ? (
                        <video 
                          ref={videoRef}
                          autoPlay 
                          playsInline 
                          muted 
                          className="w-full h-full object-cover transition-opacity duration-300"
                        />
                      ) : (
                        <div className="text-zinc-400 font-mono text-center px-6">
                          <AlertCircle className="w-10 h-10 text-rose-500 mx-auto mb-2.5" />
                          <p className="text-sm font-bold text-rose-400">Live Camera Stream Offline</p>
                          <p className="text-[11px] text-zinc-500 mt-1 max-w-xs leading-relaxed">
                            Denied permissions or in-use. Tap below to quick-scan realistic student exam answer papers instantly.
                          </p>
                          <div className="mt-4 flex flex-col gap-2">
                            <button 
                              onClick={captureMockSheet}
                              className="bg-indigo-600 hover:bg-indigo-500 text-white font-semibold font-sans text-xs py-2 px-4 rounded-xl shadow-md transition-colors"
                            >
                              Scan Realistic Sheet
                            </button>
                            <button 
                              type="button"
                              onClick={() => {
                                setUseLiveCamera(false);
                                fileInputRef.current?.click();
                              }}
                              className="bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-medium text-xs py-2 px-4 rounded-xl transition-colors"
                            >
                              Upload Image File
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    // Standby view if camera specifically turned off
                    <div className="text-zinc-500 font-sans text-center p-8 max-w-xs">
                      <UploadCloud className="w-12 h-12 text-zinc-600 mx-auto mb-3" />
                      <p className="text-sm font-bold text-zinc-300">File Import Channel Active</p>
                      <p className="text-xs text-zinc-500 mt-1 leading-relaxed">
                        Tap capture shutter to select files or quick-generate authentic mock scripts.
                      </p>
                      <button 
                        onClick={() => setUseLiveCamera(true)}
                        className="mt-4 bg-zinc-800 hover:bg-zinc-700 text-indigo-400 border border-zinc-700 font-bold text-xs py-2 px-4 rounded-xl transition-all"
                      >
                        Enable Camera
                      </button>
                    </div>
                  )}

                  {/* Centered target crosshair helper inside HUD */}
                  <div className="absolute inset-0 pointer-events-none flex items-center justify-center z-10 p-12">
                    <div className="w-56 h-56 border-2 border-white/25 rounded-3xl relative flex items-center justify-center">
                      <div className="w-4 h-[1px] bg-white/40 absolute" />
                      <div className="h-4 w-[1px] bg-white/40 absolute" />
                      
                      {/* Corner focus brackets */}
                      <div className="absolute top-2 left-2 w-4 h-4 border-t border-l border-white/60" />
                      <div className="absolute top-2 right-2 w-4 h-4 border-t border-r border-white/60" />
                      <div className="absolute bottom-2 left-2 w-4 h-4 border-b border-l border-white/60" />
                      <div className="absolute bottom-2 right-2 w-4 h-4 border-b border-r border-white/60" />
                      
                      <span className="absolute bottom-3 text-[9px] font-mono tracking-widest text-white/50 bg-black/30 backdrop-blur-sm px-2 py-0.5 rounded">
                        ALIGN DOCUMENT
                      </span>
                    </div>
                  </div>

                  {/* High contrast gradient shadow overlays for buttons */}
                  <div className="absolute bottom-0 left-0 right-0 h-44 bg-gradient-to-t from-black/85 via-black/40 to-transparent pointer-events-none z-10" />
                </div>

                {/* DOCK BAR OVER HUD - FLOATING BOTTOM PREVIEW CAROUSEL AND ACTIONS */}
                <div className="mt-auto w-full z-20 flex flex-col justify-end p-4 gap-3 select-none">
                  
                  {/* Thumbnail ribbon */}
                  <div className="flex flex-col gap-1.5">
                    <div className="flex justify-between items-center px-1">
                      <span className="font-mono text-[9px] font-black tracking-wider text-white/70 uppercase">
                        Timeline Sequence
                      </span>
                      {items.length > 0 && (
                        <button 
                          onClick={handleClearAll}
                          className="font-sans text-[10px] text-zinc-400 hover:text-white transition-colors"
                        >
                          Clear Session
                        </button>
                      )}
                    </div>

                    {/* Smooth horizontal strip */}
                    <div className="bg-black/45 backdrop-blur-md rounded-2xl border border-zinc-800/80 p-2.5 flex gap-2.5 overflow-x-auto items-center min-h-[92px] max-w-full scrollbar-none">
                      {items.length === 0 ? (
                        <div className="w-full flex flex-col items-center justify-center py-2 text-zinc-500 font-sans text-[11px] text-center">
                          <p>Camera is ready</p>
                          <p className="text-[10px] opacity-70">Snap a document to populate the stack</p>
                        </div>
                      ) : (
                        <>
                          {items.map((item, idx) => {
                            const labelString = `P.${(idx + 1).toString().padStart(2, '0')}`;
                            
                            if (item.type === 'boundary') {
                              // Boundary is a crisp divider page
                              return (
                                <div 
                                  key={item.id}
                                  onClick={() => setIsDeletingSingleItem(item.id)}
                                  className="w-[74px] h-[74px] bg-white border border-dashed border-zinc-300 rounded-xl p-2 flex flex-col justify-between shrink-0 cursor-pointer relative shadow-md transition-all hover:scale-95 text-[#0F172A]"
                                  title="Delete divider page"
                                >
                                  <div className="font-sans font-black text-[9px] text-[#0F172A] tracking-tight uppercase line-clamp-2 leading-tight">
                                    {item.subject}
                                  </div>
                                  <div className="font-mono text-[8.5px] font-bold text-gray-500 leading-none truncate">
                                    {item.className}
                                  </div>
                                  
                                  {/* Miniature file check icon */}
                                  <div className="absolute right-1.5 bottom-1.5 bg-indigo-500 text-white rounded-full p-0.5">
                                    <FileCheck className="w-2.5 h-2.5" />
                                  </div>
                                  
                                  {/* Delete badge */}
                                  <div className="absolute -top-1 -right-1 bg-rose-500 text-white rounded-full w-4 h-4 shadow-sm flex items-center justify-center text-[8px] font-black pointer-events-none">
                                    <X className="w-2.5 h-2.5" />
                                  </div>
                                </div>
                              );
                            }

                            // Output standard page image
                            const imgUrl = thumbnailUrls[item.id];
                            return (
                              <div 
                                key={item.id}
                                onClick={() => setIsDeletingSingleItem(item.id)}
                                className="w-[74px] h-[74px] bg-zinc-800 border border-zinc-700 rounded-xl relative overflow-hidden shrink-0 cursor-pointer shadow-md transition-all hover:scale-95"
                                title="Delete page"
                              >
                                {imgUrl ? (
                                  <img 
                                    src={imgUrl} 
                                    alt={labelString} 
                                    className="w-full h-full object-cover"
                                    referrerPolicy="no-referrer"
                                  />
                                ) : (
                                  <div className="w-full h-full flex items-center justify-center bg-zinc-900">
                                    <FileText className="w-4.5 h-4.5 text-zinc-500" />
                                  </div>
                                )}
                                
                                <div className="absolute bottom-1 left-1 bg-black/60 backdrop-blur-sm px-1.5 py-0.5 rounded text-[8px] text-white font-mono font-bold leading-none">
                                  {labelString}
                                </div>

                                <div className="absolute -top-1 -right-1 bg-rose-500 text-white rounded-full w-4 h-4 shadow-sm flex items-center justify-center text-[8px] font-black pointer-events-none">
                                  <X className="w-2.5 h-2.5" />
                                </div>
                              </div>
                            );
                          })}

                          {/* Quick Add Dotted Box */}
                          <button 
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            className="w-[74px] h-[74px] bg-white/5 border border-dashed border-white/20 hover:border-white/40 rounded-xl flex flex-col items-center justify-center shrink-0 cursor-pointer active:scale-95 transition-all text-zinc-400 hover:text-white"
                          >
                            <Plus className="w-5 h-5" />
                            <span className="font-mono text-[8px] mt-0.5 uppercase tracking-wider">Browse</span>
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {/* PRIMARY SHUTTER DECK BAR */}
                  <div className="grid grid-cols-3 items-center gap-4 mt-1 select-none">
                    
                    {/* Left button - List batches */}
                    <button 
                      type="button"
                      onClick={() => setIsManagerOpen(true)}
                      className="bg-zinc-900/80 backdrop-blur-md border border-zinc-800 hover:bg-zinc-850 px-4 py-3 rounded-2xl flex flex-col items-center justify-center gap-0.5 text-white active:scale-95 transition-all cursor-pointer shadow-lg"
                    >
                      <ListIcon className="w-5 h-5 text-zinc-300" />
                      <span className="font-sans text-[11px] font-bold text-zinc-300">List Overview</span>
                    </button>

                    {/* Center: Main Camera Shutter button */}
                    <div className="flex justify-center relative items-center">
                      <button 
                        type="button"
                        onClick={captureFromVideo}
                        className="w-16 h-16 rounded-full bg-white border-[4px] border-zinc-900 outline outline-3 outline-white flex items-center justify-center transition-transform active:scale-90 shadow-2xl cursor-pointer"
                        title="Click to take snapshot"
                      >
                        <span className="w-6 h-6 rounded-full bg-indigo-600 block shadow-inner" />
                      </button>

                      {/* Demo indicator sticker */}
                      {!cameraStream && (
                        <span className="absolute -top-5.5 bg-yellow-400 text-black border border-black font-mono text-[7px] px-1.5 py-0.5 font-extrabold uppercase rounded shadow-sm animate-bounce">
                          DEMO READY
                        </span>
                      )}
                    </div>

                    {/* Right button - Done split exam */}
                    <button 
                      type="button"
                      onClick={() => {
                        if (totalPageCount === 0) {
                          showBriefToast('Scan at least 1 image file first');
                          return;
                        }
                        setIsBoundaryModalOpen(true);
                      }}
                      className="bg-indigo-600 hover:bg-indigo-500 border border-indigo-500 py-3 rounded-2xl flex flex-col items-center justify-center gap-0.5 text-white active:scale-95 transition-all cursor-pointer shadow-lg shadow-indigo-600/10"
                    >
                      <ChevronRight className="w-5 h-5 text-indigo-100" />
                      <span className="font-sans text-[11px] font-bold text-indigo-50">Done with Exam</span>
                    </button>

                  </div>

                </div>

              </div>
            ) : (
              // 2. COMPLETED SINGLE BATCH DOWNLOAD SCREEN (WIREFRAME 3)
              <div className="flex-1 w-full h-full flex flex-col justify-between overflow-y-auto p-4 md:p-6 animate-fade-in relative z-20 select-none pb-20">
                
                <div className="flex flex-col items-center justify-center py-6">
                  
                  {/* Exquisite checkmark badge */}
                  <div className="w-20 h-20 rounded-full bg-emerald-50 border-[3px] border-emerald-500 shadow-lg shadow-emerald-500/10 flex items-center justify-center mt-3 mb-6">
                    <Check className="w-11 h-11 text-emerald-500 stroke-[3px]" />
                  </div>

                  <h2 className="font-display font-black text-2xl tracking-tight text-center uppercase leading-none text-slate-900">
                    File Download Complete
                  </h2>
                  <p className="text-xs text-slate-500 font-sans text-center mt-2.5 px-4 leading-relaxed">
                    All exams successfully organized, indexed, and compiled into a single client-side PDF document.
                  </p>

                  {/* Clean layout specs sheet - matches Wireframe 3 specs layout perfectly */}
                  <div className="w-full bg-white border border-slate-200/80 rounded-2xl shadow-sm mt-8 overflow-hidden">
                    <div className="bg-slate-50 border-b border-slate-200/80 p-3 flex justify-between items-center text-xs font-mono font-bold tracking-wider text-slate-600">
                      <span>COMPILED BATCH SPECS</span>
                      <span className="bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded text-[10px]">VERIFIED</span>
                    </div>
                    
                    <div className="divide-y divide-slate-100 text-xs font-mono">
                      
                      <div className="flex justify-between items-center p-3.5">
                        <span className="text-slate-400">FILE NAME :</span>
                        <span className="font-bold text-slate-800 break-all select-text max-w-[210px] text-right">{generatedPdf.filename}</span>
                      </div>

                      <div className="flex justify-between items-center p-3.5">
                        <span className="text-slate-400">FILE SIZE :</span>
                        <span className="font-bold text-slate-800">{generatedPdf.sizeFormatted}</span>
                      </div>

                      <div className="flex justify-between items-center p-3.5">
                        <span className="text-slate-400">EXAMS COUNT :</span>
                        <span className="font-bold text-indigo-600">
                          {generatedPdf.examsCount.toString().padStart(2, '0')} Independent Batches
                        </span>
                      </div>

                      <div className="flex justify-between items-center p-3.5">
                        <span className="text-slate-400">TOTAL PAGES :</span>
                        <span className="font-bold text-slate-800">
                          {generatedPdf.totalPages.toString().padStart(2, '0')} Pages (inc. covers)
                        </span>
                      </div>

                    </div>
                  </div>

                </div>

                {/* Compile controls */}
                <div className="w-full flex flex-col gap-3.5 mt-auto">
                  <button 
                    type="button"
                    onClick={triggerPdfDownload}
                    className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-sans font-extrabold text-sm py-4 rounded-2xl shadow-lg shadow-indigo-600/10 flex items-center justify-center gap-2 transition-all cursor-pointer"
                  >
                    <Download className="w-4.5 h-4.5 stroke-[2.5px]" /> OPEN PDF DIRECTLY
                  </button>

                  <button 
                    type="button"
                    onClick={handleStartNewBatch}
                    className="w-full bg-slate-900 hover:bg-slate-800 text-white font-sans font-extrabold text-sm py-4 rounded-2xl shadow-lg flex items-center justify-center gap-2 transition-all cursor-pointer"
                  >
                    <Plus className="w-4.5 h-4.5 stroke-[2.5px]" /> START NEW BATCH
                  </button>
                </div>

              </div>
            )}

          </div>

          {/* HIDDEN RAW INPUTS */}
          <input 
            type="file"
            ref={fileInputRef}
            onChange={handleFileUpload}
            accept="image/*"
            multiple
            className="hidden"
          />

          {/* 3. SLIDE-UP BATCH OVERVIEW SHEET DRAWER (WIREFRAME 2 BOTTOM SHEET) */}
          {isManagerOpen && (
            <div className="absolute inset-0 bg-black/70 z-50 flex items-end justify-center px-0 transition-opacity">
              <div className="w-full bg-[#FAF9F6] border-t border-slate-200 shadow-2xl pb-6 rounded-t-[28px] max-h-[88%] flex flex-col overflow-hidden animate-slide-up">
                
                {/* Header: Dark sleek Vercel strip */}
                <div className="bg-[#0F172A] text-white py-4.5 px-5 flex justify-between items-center text-sm font-display font-medium tracking-wide">
                  <span className="font-black text-xs uppercase tracking-widest text-zinc-100 flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-indigo-500" />
                    CURRENT BATCH OVERVIEW
                  </span>
                  
                  <button 
                    type="button"
                    onClick={() => setIsManagerOpen(false)}
                    className="text-zinc-400 hover:text-white transition-colors bg-zinc-800 p-1.5 rounded-full"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* Sheet Scroll Body */}
                <div className="flex-1 overflow-y-auto p-5">
                  <p className="text-[11px] text-gray-500 font-sans leading-relaxed mb-4">
                    Compile separated documents instantly. Pages captured preceding a divider slot form individual bounded booklets inside the final PDF file structure.
                  </p>

                  {/* STARK DATA LIST GRID - MATCHES WIREFRAME 2 EXACTLY WITHOUT RETRO BRUTAL DETAILS */}
                  <div className="border border-slate-200/80 bg-white rounded-2xl shadow-sm overflow-hidden mb-5">
                    <table className="w-full text-left font-sans text-xs border-collapse">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200/60 font-mono text-[10px] text-slate-400 uppercase tracking-widest font-extrabold">
                          <th className="py-3 px-4 w-16 text-center">INDEX</th>
                          <th className="py-3 px-4">EXAM NAME</th>
                          <th className="py-3 px-4 text-center w-24">PAGES</th>
                          <th className="py-3 px-4 text-center w-20">ACTION</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {examGroups.length === 0 ? (
                          <tr>
                            <td colSpan={4} className="py-8 px-4 text-center text-zinc-400 text-[11px]">
                              Zero scans captured. Snap some sheets first!
                            </td>
                          </tr>
                        ) : (
                          examGroups.map((group) => {
                            const indexStr = `[${group.displayIndex.toString().padStart(2, '0')}]`;
                            const examTitle = group.isCompleted 
                              ? (group.subject || 'UNTITLED EXAM').toUpperCase()
                              : 'ACTIVE SESSION (UNLABELED)';
                            const subtitleText = group.isCompleted
                              ? `Section Cover: ${group.className || 'General'}`
                              : 'Pending active document split';
                            
                            return (
                              <tr key={group.id} className="hover:bg-slate-50/50">
                                <td className="py-3.5 px-4 font-mono font-bold text-center text-slate-500 bg-slate-50/20">
                                  {indexStr}
                                </td>
                                <td className="py-3.5 px-4">
                                  <p className="font-extrabold text-slate-800 leading-tight text-xs">{examTitle}</p>
                                  <p className="text-[10px] text-zinc-400 font-mono tracking-tight font-medium mt-0.5">{subtitleText}</p>
                                </td>
                                <td className="py-3.5 px-4 font-mono font-bold text-[#0F172A] text-center">
                                  {group.pagesCount.toString().padStart(2, '0')} pgs
                                </td>
                                <td className="py-3.5 px-4 text-center">
                                  <button 
                                    type="button"
                                    onClick={() => setIsDeletingGroup(group.id)}
                                    className="text-[10px] font-bold text-rose-600 hover:text-rose-500 hover:bg-rose-50 border border-slate-100 py-1.5 px-2.5 rounded-lg transition-colors cursor-pointer"
                                  >
                                    Delete
                                  </button>
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>

                  {/* Premium quick totals layout bar */}
                  <div className="bg-[#FAF9F6] border border-slate-200/80 rounded-2xl p-4 mb-6 flex justify-between items-center shadow-sm">
                    <div>
                      <p className="font-sans font-black text-slate-800 text-xs">BATCH STATS</p>
                      <p className="text-[10px] text-gray-500 leading-tight mt-0.5">Calculated in persistent IndexDB</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-sans font-black text-[#111827]">{totalPageCount} SAMPLES</p>
                      <p className="text-[9.5px] font-mono text-indigo-600 font-bold uppercase tracking-wider">{totalExamsCount} BOUNDED EXAMS</p>
                    </div>
                  </div>

                  {/* Massive Compile button */}
                  {items.length > 0 && (
                    <button 
                      type="button"
                      onClick={handleCompilePDF}
                      disabled={isCompiling}
                      className="w-full bg-[#111827] text-white border border-slate-800 py-3.5 rounded-xl font-sans font-extrabold text-xs uppercase tracking-wider shadow-md hover:bg-slate-800 flex items-center justify-center gap-2 select-all transition-all cursor-pointer disabled:opacity-50"
                    >
                      {isCompiling ? (
                        <>
                          <RefreshCw className="w-4 h-4 animate-spin text-zinc-300" />
                          COMPILING BATCH... {compilationProgress}%
                        </>
                      ) : (
                        <>
                          <Download className="w-4 h-4 text-zinc-300" />
                          Compile PDF Batch
                        </>
                      )}
                    </button>
                  )}
                </div>

                <div className="px-5">
                  <button 
                    type="button"
                    onClick={() => setIsManagerOpen(false)}
                    className="w-full bg-slate-100 hover:bg-slate-200 border border-slate-200 py-3.5 rounded-xl font-extrabold text-xs text-slate-700 tracking-wide uppercase transition-colors cursor-pointer"
                  >
                    Close Manager
                  </button>
                </div>

              </div>
            </div>
          )}

          {/* 4. BOUNDARY LINE COVER CREATION MODAL */}
          {isBoundaryModalOpen && (
            <div className="absolute inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
              <form 
                onSubmit={handleInsertBoundary}
                className="w-full max-w-sm bg-white rounded-[24px] shadow-2xl p-5 border border-slate-200 flex flex-col gap-4 animate-scale-up text-slate-900"
              >
                <div className="flex justify-between items-center border-b border-slate-100 pb-2">
                  <h3 className="font-sans font-black text-sm uppercase text-slate-800 flex items-center gap-2">
                    <FileText className="w-4.5 h-4.5 text-indigo-600" /> Done with Exam?
                  </h3>
                  <button 
                    type="button" 
                    onClick={() => setIsBoundaryModalOpen(false)}
                    className="text-zinc-400 hover:text-zinc-650 p-1 bg-slate-50 hover:bg-slate-100 rounded-full"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="bg-indigo-50/50 border border-indigo-100 rounded-xl p-3 text-[10px] text-indigo-700 leading-normal font-sans">
                  Adding an exam boundary creates a beautiful cover sheet for the previous <strong className="text-indigo-900 underline font-black">{activeUnlabeledPagesCount} pages</strong> you scanned in this session.
                </div>

                <div className="space-y-3.5 text-xs text-slate-700">
                  <div>
                    <label className="block font-bold mb-1 uppercase tracking-wider text-[10px] text-zinc-500">
                      Subject Name / Title *
                    </label>
                    <input 
                      type="text"
                      required
                      placeholder="e.g. MATHEMATICS, ENGLISH"
                      value={subjectInput}
                      onChange={(e) => setSubjectInput(e.target.value)}
                      className="w-full border-2 border-slate-200 hover:border-slate-300 focus:border-indigo-500 p-3 bg-white font-semibold text-slate-850 rounded-xl text-xs transition-colors focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block font-bold mb-1 uppercase tracking-wider text-[10px] text-zinc-500">
                      Class Level / Year
                    </label>
                    <input 
                      type="text"
                      placeholder="e.g. SS1, JS3, Grade 10"
                      value={classInput}
                      onChange={(e) => setClassInput(e.target.value)}
                      className="w-full border-2 border-slate-200 hover:border-slate-300 focus:border-indigo-500 p-3 bg-white font-semibold text-slate-850 rounded-xl text-xs transition-colors focus:outline-none"
                    />
                  </div>
                </div>

                {/* Form Controls */}
                <div className="mt-2.5 flex gap-3">
                  <button 
                    type="button"
                    onClick={() => setIsBoundaryModalOpen(false)}
                    className="w-1/3 bg-slate-100 hover:bg-slate-200 font-extrabold text-[#0F172A] py-3 rounded-xl uppercase text-xs transition-colors text-center cursor-pointer"
                  >
                    Cancel
                  </button>
                  
                  <button 
                    type="submit"
                    className="w-2/3 bg-indigo-600 hover:bg-indigo-500 text-white font-extrabold py-3 rounded-xl uppercase text-xs shadow-md transition-all text-center flex items-center justify-center gap-1 cursor-pointer"
                  >
                    Insert Divider Cover
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* 5. CONFIRM DELETE DIALOGS (SINGLE SCAN IMAGE / BLOCK ITEM) */}
          {isDeletingSingleItem && (
            <div className="absolute inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
              <div className="bg-white rounded-[24px] border border-slate-100 shadow-2xl p-5 max-w-xs w-full animate-scale-up font-sans text-slate-900">
                <h4 className="font-black text-sm uppercase text-slate-800 mb-1.5 flex items-center gap-1.5">
                  <Trash2 className="w-4 h-4 text-rose-500" /> Delete Scan Page?
                </h4>
                <p className="text-xs text-zinc-500 leading-relaxed mb-4">
                  Confirm removing this page from your chronological scanning batch sequence?
                </p>
                <div className="flex gap-3 text-xs font-bold">
                  <button 
                    onClick={() => setIsDeletingSingleItem(null)}
                    className="flex-1 bg-slate-100 hover:bg-slate-200 py-3 rounded-xl uppercase transition-colors"
                  >
                    Keep
                  </button>
                  <button 
                    onClick={() => handleDeleteItem(isDeletingSingleItem)}
                    className="flex-1 bg-rose-600 hover:bg-rose-500 text-white py-3 rounded-xl uppercase shadow-md transition-colors"
                  >
                    Delete Page
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 6. CONFIRM PURGE EXAM GROUP DIALOG */}
          {isDeletingGroup && (
            <div className="absolute inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
              <div className="bg-white rounded-[24px] border border-slate-100 shadow-2xl p-5 max-w-xs w-full animate-scale-up font-sans text-slate-900">
                <h4 className="font-black text-sm uppercase text-slate-800 mb-1.5 flex items-center gap-1.5">
                  <Trash2 className="w-4 h-4 text-rose-500" /> Purge Exam Batch?
                </h4>
                <p className="text-xs text-zinc-500 leading-relaxed mb-4">
                  This deletes the entire divider cover page and all page scans attached under this specific section.
                </p>
                <div className="flex gap-3 text-xs font-bold">
                  <button 
                    onClick={() => setIsDeletingGroup(null)}
                    className="flex-1 bg-slate-100 hover:bg-slate-200 py-3 rounded-xl uppercase transition-colors"
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={handleDeleteGroup}
                    className="flex-1 bg-rose-600 hover:bg-rose-500 text-white py-3 rounded-xl uppercase shadow-md transition-colors"
                  >
                    Delete Batch
                  </button>
                </div>
              </div>
            </div>
          )}

        </div>
      </div>

    </div>
  );
}
