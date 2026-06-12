import Dexie, { type Table } from 'dexie';
import { type ScanItem } from './types';

export class ExamoClientDatabase extends Dexie {
  scans!: Table<ScanItem, string>;

  constructor() {
    super('ExamoClientDB');
    this.version(1).stores({
      scans: 'id, type, timestamp'
    });
  }
}

export const db = new ExamoClientDatabase();

// Utility helper to compress captured images
// Re-scales high-res mobile photos to prevent bloating client-side storage while preserving perfect readability
export async function compressPhoto(fileOrBlob: Blob, maxWidth = 1200, quality = 0.75): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;

        // Maintain scale
        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }

        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(fileOrBlob); // fallback
          return;
        }

        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => {
            if (blob) {
              resolve(blob);
            } else {
              resolve(fileOrBlob); // fallback
            }
          },
          'image/jpeg',
          quality
        );
      };
      img.onerror = () => resolve(fileOrBlob); // fallback
      img.src = event.target?.result as string;
    };
    reader.onerror = () => resolve(fileOrBlob); // fallback
    reader.readAsDataURL(fileOrBlob);
  });
}
