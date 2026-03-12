/**
 * SkyStream Plugin v2 Type Definitions
 */

export interface Manifest {
  id: string;
  name: string;
  version: number;
  author: string;
  description?: string;
  iconUrl?: string;
}

export type Result<T> = 
  | { success: true; data: T }
  | { success: false; errorCode: string; message: string };

export interface MediaItem {
  title: string;
  url: string;
  posterUrl?: string;
  description?: string;
  isFolder: boolean;
}

export interface HomeData {
  [category: string]: MediaItem[];
}

export interface MediaDetails extends MediaItem {
  episodes?: Episode[];
}

export interface Episode {
  name: string;
  season: number;
  episode: number;
  url: string; // JSON string encoded Stream[] or direct URL
  posterUrl?: string;
}

export interface Stream {
  url: string;
  quality: string;
  headers?: Record<string, string>;
  drmKey?: string;
  drmKid?: string;
  licenseUrl?: string;
}

// Global Bridge Environment
declare global {
  /** The pre-injected manifest for the current plugin */
  const manifest: Manifest;

  /** Standard logging polyfill */
  const console: {
    log(...args: any[]): void;
    error(...args: any[]): void;
    warn(...args: any[]): void;
  };

  /** Native Bridge: HTTP GET */
  function http_get(
    url: string,
    headers?: Record<string, string>,
    callback?: (res: HttpResponse) => void
  ): Promise<HttpResponse>;

  /** Native Bridge: HTTP POST */
  function http_post(
    url: string,
    headers?: Record<string, string>,
    body?: string,
    callback?: (res: HttpResponse) => void
  ): Promise<HttpResponse>;

  interface HttpResponse {
    status: number;
    body: string;
    headers: Record<string, string>;
  }

  /* Polyfills */
  function btoa(data: string): string;
  function atob(data: string): string;
}
