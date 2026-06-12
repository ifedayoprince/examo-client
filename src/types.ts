export type ScanItemType = 'image' | 'boundary';

export interface ScanItem {
  id: string; // unique identifier
  type: ScanItemType;
  fileData?: Blob | null; // Null if type is block/boundary
  fileUrl?: string; // Temporary Object URL for rendering
  subject?: string; // Only if type === 'boundary'
  className?: string; // Only if type === 'boundary'
  orientation?: 'portrait' | 'landscape'; // Default 'portrait'
  timestamp: number; // for chronological sorting
}

export interface ExamGroup {
  id: string; // ID of the boundary or 'active-session'
  isCompleted: boolean;
  subject?: string;
  className?: string;
  pagesCount: number;
  items: ScanItem[]; // Includes the pages and the boundary item (if completed)
  displayIndex: number; // e.g. 1, 2, 3...
}

export interface AppSessionState {
  subjectInput: string;
  classInput: string;
  viewMode: 'capture' | 'completed';
  activeExamIndexToDelete: string | null;
}
