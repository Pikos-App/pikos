import { writable } from "svelte/store";

export interface Page {
  id: string;
  title: string;
  path: string;
  isCompleted: boolean;
  scheduledAt: string | null;
  content?: string;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
  is_directory: boolean;
  is_markdown: boolean;
}

export interface FileInfo {
  name: string;
  path: string;
  is_directory: boolean;
  is_markdown: boolean;
}

export interface Folder {
  id: string;
  name: string;
  path: string;
  color?: string;
  parentId?: string | null;
}

// Main stores
export const pages = writable<Page[]>([]);
export const selectedPage = writable<Page | null>(null);
export const selectedFolder = writable<Folder | null>(null);
