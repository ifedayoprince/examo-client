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

export async function generateBatchPDF(
  scanItems: ScanItem[],
  onProgress?: (progress: number) => void
): Promise<{ blob: Blob; filename: string; pageCount: number; sizeBytes: number }> {
  // Create jsPDF instance (A4 size landscape: 297mm x 210mm)
  const pdf = new jsPDF({
    orientation: 'landscape',
    unit: 'mm',
    format: 'a4',
  });

  const pageWidth = 297;
  const pageHeight = 210;
  let isFirstPage = true;
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

    if (!isFirstPage) {
      pdf.addPage();
    } else {
      isFirstPage = false;
    }

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
        const base64Data = await blobToBase64(item.fileData);
        
        // Render image in pure white block, taking maximum printable container bounds
        // Offset padding around edges to match clean scan styles (12mm bounds)
        const margin = 4;
        const imgWidth = pageWidth - (margin * 2);
        const imgHeight = pageHeight - (margin * 2);
        
        pdf.addImage(base64Data, 'PNG', margin, margin, imgWidth, imgHeight, undefined, 'NONE');

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
  if (isFirstPage) {
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
