import { jsPDF } from 'jspdf';
import { type ScanItem } from './types';

// Converts a Blob to a Base64 string for embedding in PDF
const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      resolve(reader.result as string);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

// Retrieves original image dimensions to preserve aspect ratio
const getImageDimensions = (base64: string): Promise<{ width: number; height: number }> => {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth || img.width, height: img.naturalHeight || img.height });
    };
    img.onerror = () => {
      resolve({ width: 0, height: 0 });
    };
    img.src = base64;
  });
};

export async function generateBatchPDF(
  scanItems: ScanItem[],
  onProgress?: (progress: number) => void
): Promise<{ blob: Blob; filename: string; pageCount: number; sizeBytes: number }> {
  // Detect first orientation to initialize jsPDF correctly
  let firstOrientation: 'portrait' | 'landscape' = 'portrait';
  let firstFormat: [number, number] = [210, 280]; // default to 4:3 portrait

  const firstImageItem = scanItems.find(item => item.type === 'image' && item.fileData);
  if (firstImageItem && firstImageItem.fileData) {
    try {
      const base64 = await blobToBase64(firstImageItem.fileData);
      const { width, height } = await getImageDimensions(base64);
      if (width > height) {
        firstOrientation = 'landscape';
        firstFormat = [280, 210]; // landscape 4:3
      }
    } catch (e) {
      console.error('Failed to read first image dimensions:', e);
    }
  }

  const pdf = new jsPDF({
    orientation: firstOrientation,
    unit: 'mm',
    format: firstFormat,
  });

  let processedItems = 0;
  const totalSteps = scanItems.length;

  const updateProgress = () => {
    processedItems++;
    if (onProgress && totalSteps > 0) {
      onProgress(Math.min(100, Math.round((processedItems / totalSteps) * 100)));
    }
  };

  for (let i = 0; i < scanItems.length; i++) {
    const item = scanItems[i];

    // Determine the page format and orientation for the current page
    let pageOrientation: 'portrait' | 'landscape' = firstOrientation;
    let pageFormat: [number, number] = firstFormat;
    let base64Data = '';
    let imgOrigWidth = 0;
    let imgOrigHeight = 0;

    if (item.type === 'image' && item.fileData) {
      try {
        base64Data = await blobToBase64(item.fileData);
        const dims = await getImageDimensions(base64Data);
        imgOrigWidth = dims.width;
        imgOrigHeight = dims.height;
        if (imgOrigWidth > imgOrigHeight) {
          pageOrientation = 'landscape';
          pageFormat = [280, 210];
        } else {
          pageOrientation = 'portrait';
          pageFormat = [210, 280];
        }
      } catch (err) {
        console.error(err);
      }
    }

    if (i > 0) {
      pdf.addPage(pageFormat, pageOrientation);
    }

    const pageWidth = pageOrientation === 'landscape' ? 280 : 210;
    const pageHeight = pageOrientation === 'landscape' ? 210 : 280;

    if (item.type === 'boundary') {
      // 1. Divider cover - A pure white page with just the Class and Subject elegant, centered, and minimal.
      pdf.setFillColor(255, 255, 255);
      pdf.rect(0, 0, pageWidth, pageHeight, 'F');

      // Centered elegance
      pdf.setTextColor(17, 24, 39); // Deep dark gray/black
      
      // Draw a subtle minimal horizontal rule or frame on the divider page
      pdf.setDrawColor(229, 231, 235); // Light slate line
      pdf.setLineWidth(0.5);
      pdf.line(40, pageHeight / 2 - 25, pageWidth - 40, pageHeight / 2 - 25);
      pdf.line(40, pageHeight / 2 + 25, pageWidth - 40, pageHeight / 2 + 25);

      // Subject (Enormous, centered, modern bold)
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(28);
      const subjectText = (item.subject || 'UNTITLED EXAM').toUpperCase();
      pdf.text(subjectText, pageWidth / 2, pageHeight / 2 - 5, { align: 'center' });

      // Class (Centered, medium elegance)
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(16);
      pdf.setTextColor(107, 114, 128); // Slate gray
      const classText = `Class Section: ${item.className || 'General'}`;
      pdf.text(classText, pageWidth / 2, pageHeight / 2 + 10, { align: 'center' });

      // Clean footer citation
      pdf.setFont('courier', 'normal');
      pdf.setFontSize(8);
      pdf.setTextColor(156, 163, 175);
      pdf.text(`EXAMO CLIENT DIVIDER • TIMESTAMP REFERENCE: ${new Date(item.timestamp).toLocaleString()}`, pageWidth / 2, pageHeight - 20, { align: 'center' });

      updateProgress();
    } else {
      // 2. Scan Image Page - Pure clean representation with no heavy brutalist black margins
      if (!item.fileData) {
        // Fallback for null scans
        pdf.setFillColor(249, 250, 251);
        pdf.rect(0, 0, pageWidth, pageHeight, 'F');
        pdf.setTextColor(156, 163, 175);
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(12);
        pdf.text('[Empty Scan Page]', pageWidth / 2, pageHeight / 2, { align: 'center' });
        updateProgress();
        continue;
      }

      try {
        // Render image in pure white block, taking maximum printable container bounds
        // Offset padding around edges to match clean scan styles (12mm bounds)
        const margin = 4;
        const maxImgWidth = pageWidth - (margin * 2);
        const maxImgHeight = pageHeight - (margin * 2);

        let printWidth = maxImgWidth;
        let printHeight = maxImgHeight;
        
        if (imgOrigWidth > 0 && imgOrigHeight > 0) {
          const pageRatio = maxImgWidth / maxImgHeight;
          const imgRatio = imgOrigWidth / imgOrigHeight;
          
          if (imgRatio > pageRatio) {
            // Image is wider than the printable area's aspect ratio
            printWidth = maxImgWidth;
            printHeight = maxImgWidth / imgRatio;
          } else {
            // Image is taller than the printable area's aspect ratio
            printHeight = maxImgHeight;
            printWidth = maxImgHeight * imgRatio;
          }
        }

        // Center the image within the margins
        const xOffset = margin + (maxImgWidth - printWidth) / 2;
        const yOffset = margin + (maxImgHeight - printHeight) / 2;
        
        pdf.addImage(base64Data, 'PNG', xOffset, yOffset, printWidth, printHeight, undefined, 'NONE');

      } catch (err) {
        console.error('Failed to embed scan image in PDF:', err);
        pdf.setFillColor(254, 242, 242);
        pdf.rect(10, 10, pageWidth - 20, pageHeight - 20, 'F');
        pdf.setDrawColor(239, 68, 68);
        pdf.setLineWidth(0.5);
        pdf.rect(10, 10, pageWidth - 20, pageHeight - 20, 'S');
        
        pdf.setTextColor(220, 38, 38);
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(12);
        pdf.text('PAGE EMBED ERROR', pageWidth / 2, pageHeight / 2 - 5, { align: 'center' });
        pdf.setFont('courier', 'normal');
        pdf.setFontSize(8);
        pdf.text(`ID: ${item.id}`, pageWidth / 2, pageHeight / 2 + 5, { align: 'center' });
      }

      updateProgress();
    }
  }

  // If empty
  if (scanItems.length === 0) {
    const pageWidth = firstFormat[0];
    const pageHeight = firstFormat[1];
    pdf.setFillColor(255, 255, 255);
    pdf.rect(0, 0, pageWidth, pageHeight, 'F');
    pdf.setTextColor(100, 116, 139);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(12);
    pdf.text('No capture pages or boundaries were detected for compilation.', pageWidth / 2, pageHeight / 2, { align: 'center' });
  }

  const outputBlob = pdf.output('blob');
  const sizeBytes = outputBlob.size;
  const pageCount = pdf.getNumberOfPages();
  
  const randomId = Math.floor(100 + Math.random() * 900);
  const filename = `examo_batch_${randomId}.pdf`;

  return {
    blob: outputBlob,
    filename,
    pageCount,
    sizeBytes,
  };
}
