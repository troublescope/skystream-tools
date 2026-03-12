import axios from 'axios';
import { JSDOM } from 'jsdom';
import * as fs from 'fs-extra';
import * as path from 'path';

export interface RuntimeOptions {
  manifest: any;
  pluginPath: string;
}

export class SkyStreamRuntime {
  private context: any;

  constructor(private options: RuntimeOptions) {
    this.context = this.createMockContext();
  }

  private createMockContext() {
    return {
      manifest: this.options.manifest,
      console: {
        log: (...args: any[]) => console.log('[Plugin Log]:', ...args),
        error: (...args: any[]) => console.error('[Plugin Error]:', ...args),
        warn: (...args: any[]) => console.warn('[Plugin Warn]:', ...args),
      },
      http_get: async (url: string, headers: any, cb: any) => {
        try {
          const res = await axios.get(url, { headers });
          const result = { status: res.status, body: res.data, headers: res.headers };
          if (cb) cb(result);
          return result;
        } catch (e: any) {
             const result = { status: e.response?.status || 500, body: e.message, headers: {} };
             if (cb) cb(result);
             return result;
        }
      },
      http_post: async (url: string, headers: any, body: any, cb: any) => {
        try {
          const res = await axios.post(url, body, { headers });
          const result = { status: res.status, body: res.data, headers: res.headers };
          if (cb) cb(result);
          return result;
        } catch (e: any) {
            const result = { status: e.response?.status || 500, body: e.message, headers: {} };
            if (cb) cb(result);
            return result;
        }
      },
      btoa: (s: string) => Buffer.from(s).toString('base64'),
      atob: (s: string) => Buffer.from(s, 'base64').toString('utf8'),
      globalThis: {} as any,
    };
  }

  async run() {
    const jsContent = await fs.readFile(this.options.pluginPath, 'utf8');
    
    // Simple execution in Node vm-like style but using a Function constructor for mock injection
    const runtimeFunc = new Function('manifest', 'console', 'http_get', 'http_post', 'btoa', 'atob', 'globalThis', jsContent);
    
    runtimeFunc(
      this.context.manifest,
      this.context.console,
      this.context.http_get,
      this.context.http_post,
      this.context.btoa,
      this.context.atob,
      this.context.globalThis
    );

    return this.context.globalThis;
  }
}
