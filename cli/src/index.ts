#!/usr/bin/env node
import { Command } from 'commander';
import * as path from 'path';
import * as vm from 'vm';
import * as crypto from 'crypto';
import fs from 'fs-extra';
import { z } from 'zod';
import archiver from 'archiver';
import axios from 'axios';
import AdmZip from 'adm-zip';
import { JSDOM } from 'jsdom';
import { spawn } from 'child_process';

const program = new Command();

program
  .name('skystream')
  .description('SkyStream Plugin Development Kit CLI (Sky Gen 2)')
  .version('1.5.7');

// Schemas
const pluginSchema = z.object({
  packageName: z.string().min(5).regex(/^[a-z0-9._-]+$/),
  name: z.string().min(1),
  version: z.number().int().positive(),
  description: z.string().min(1),
  baseUrl: z.string().url(),
  authors: z.array(z.string()).min(1),
  languages: z.array(z.string()).min(1),
  categories: z.array(z.string()).min(1),
});

const repoSchema = z.object({
  name: z.string().min(1),
  packageName: z.string().min(3).regex(/^[a-z0-9._-]+$/),
  description: z.string().min(1),
  manifestVersion: z.number().int().positive(),
  pluginLists: z.array(z.string().url()),
});

const REQUIRED_FUNCTIONS = ['getHome', 'search', 'load', 'loadStreams'] as const;
const CLI_TEST_NAMESPACE = '__skystream_cli_test__';
const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";
const DEBUG_HTTP = process.env.SKYSTREAM_CLI_DEBUG_HTTP === '1';
const PYTHON_CFFI_BRIDGE = `
import json, sys, time
from curl_cffi import requests

def is_cf(status, body):
    text = (body or "").lower()
    return status in (403, 503) and (
        "just a moment" in text or
        "cf-ray" in text or
        "cf_chl" in text or
        "challenge-platform" in text or
        "attention required" in text
    )

def main():
    payload = json.loads(sys.stdin.read() or "{}")
    method = str(payload.get("method", "GET")).upper()
    url = str(payload.get("url", ""))
    headers = payload.get("headers") or {}
    body = payload.get("body", None)
    timeout = int(payload.get("timeout", 30))
    attempts = int(payload.get("attempts", 4))

    ses = requests.Session()
    last = None
    for i in range(max(1, attempts)):
        kwargs = {
            "method": method,
            "url": url,
            "headers": headers,
            "timeout": timeout,
            "allow_redirects": True,
            "impersonate": "chrome124",
        }
        if method != "GET" and body is not None:
            kwargs["data"] = body

        resp = ses.request(**kwargs)
        current = {
            "status": int(resp.status_code),
            "statusCode": int(resp.status_code),
            "body": resp.text or "",
            "headers": dict(resp.headers or {}),
            "finalUrl": str(resp.url or url),
        }
        last = current
        if not is_cf(current["status"], current["body"]):
            break
        if i < attempts - 1:
            time.sleep(0.8 + (0.4 * i))

    sys.stdout.write(json.dumps(last or {
        "status": 0,
        "statusCode": 0,
        "body": "",
        "headers": {},
        "finalUrl": url,
    }))

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        sys.stdout.write(json.dumps({
            "status": 0,
            "statusCode": 0,
            "body": "",
            "headers": {},
            "finalUrl": "",
            "error": str(e),
        }))
`;

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateMultimediaItemShape(value: unknown, label: string): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) {
    errors.push(`${label}: must be an object`);
    return errors;
  }
  if (!hasText(value.title)) errors.push(`${label}.title: required string`);
  if (!hasText(value.url)) errors.push(`${label}.url: required string`);
  if (!hasText(value.posterUrl)) errors.push(`${label}.posterUrl: required string`);
  return errors;
}

function validateStreamShape(value: unknown, label: string): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) {
    errors.push(`${label}: must be an object`);
    return errors;
  }
  if (!hasText(value.url)) errors.push(`${label}.url: required string`);
  return errors;
}

function validateFunctionResult(fnName: string, response: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(response)) return ['response must be an object'];
  if (typeof response.success !== 'boolean') {
    errors.push('response.success must be boolean');
    return errors;
  }
  if (response.success === false) return errors;

  const data = response.data;
  if (fnName === 'getHome') {
    if (!isRecord(data)) {
      errors.push('getHome.data must be an object: { "Category": MultimediaItem[] }');
      return errors;
    }
    for (const [category, items] of Object.entries(data)) {
      if (!Array.isArray(items)) {
        errors.push(`getHome.data.${category}: must be an array`);
        continue;
      }
      items.forEach((item, idx) => {
        errors.push(...validateMultimediaItemShape(item, `getHome.data.${category}[${idx}]`));
      });
    }
    return errors;
  }

  if (fnName === 'search') {
    if (!Array.isArray(data)) {
      errors.push('search.data must be an array of MultimediaItem');
      return errors;
    }
    data.forEach((item, idx) => {
      errors.push(...validateMultimediaItemShape(item, `search.data[${idx}]`));
    });
    return errors;
  }

  if (fnName === 'load') {
    if (!isRecord(data)) {
      errors.push('load.data must be a MultimediaItem object');
      return errors;
    }
    if (!hasText(data.url)) errors.push('load.data.url: required string');
    return errors;
  }

  if (fnName === 'loadStreams') {
    if (!Array.isArray(data)) {
      errors.push('loadStreams.data must be an array of StreamResult');
      return errors;
    }
    data.forEach((item, idx) => {
      errors.push(...validateStreamShape(item, `loadStreams.data[${idx}]`));
    });
    return errors;
  }

  return errors;
}

function wrapPluginForAppParity(
  script: string,
  manifest: Record<string, any>,
  packageName: string,
  namespace: string = CLI_TEST_NAMESPACE,
): string {
  const manifestJson = JSON.stringify(manifest || {});
  return `
  (function() {
    const manifest = ${manifestJson};
    const getPreference = (key) => {
      return sendMessage('get_preference', JSON.stringify({ packageName: ${JSON.stringify(packageName)}, key: key }));
    };
    const setPreference = (key, value) => {
      return sendMessage('set_preference', JSON.stringify({ packageName: ${JSON.stringify(packageName)}, key: key, value: value }));
    };
    const registerSettings = (schema) => {
      return sendMessage('register_settings', JSON.stringify({ packageName: ${JSON.stringify(packageName)}, schema: schema }));
    };
    globalThis.getPreference = getPreference;
    globalThis.setPreference = setPreference;
    globalThis.registerSettings = registerSettings;

    var exports = (function() {
      ${script}
      return {
        getHome: (typeof getHome !== 'undefined') ? getHome : (typeof globalThis.getHome !== 'undefined' ? globalThis.getHome : undefined),
        search: (typeof search !== 'undefined') ? search : (typeof globalThis.search !== 'undefined' ? globalThis.search : undefined),
        load: (typeof load !== 'undefined') ? load : (typeof globalThis.load !== 'undefined' ? globalThis.load : undefined),
        loadStreams: (typeof loadStreams !== 'undefined') ? loadStreams : (typeof globalThis.loadStreams !== 'undefined' ? globalThis.loadStreams : undefined),
      };
    })();

    globalThis[${JSON.stringify(namespace)}] = exports;
    if (globalThis.getHome) delete globalThis.getHome;
    if (globalThis.search) delete globalThis.search;
    if (globalThis.load) delete globalThis.load;
    if (globalThis.loadStreams) delete globalThis.loadStreams;
  })();
  `;
}

function detectExports(jsContent: string, manifest: Record<string, any> = {}, packageName = 'cli.validate'): { missing: string[]; runtimeError?: string } {
  const sandbox: any = Object.create(null);
  sandbox.globalThis = sandbox;
  sandbox.console = console;
  sandbox.sendMessage = () => null;
  const vmContext = vm.createContext(sandbox);
  try {
    const wrapped = wrapPluginForAppParity(jsContent, manifest, packageName);
    vm.runInContext(wrapped, vmContext, { timeout: 5000, breakOnSigint: true });
  } catch (e: any) {
    return { missing: [...REQUIRED_FUNCTIONS], runtimeError: e?.message || String(e) };
  }
  const exportsObj = (vmContext as any).globalThis[CLI_TEST_NAMESPACE] || {};
  const missing = REQUIRED_FUNCTIONS.filter((fn) => typeof exportsObj[fn] !== 'function');
  return { missing };
}

function isCloudflareChallenge(status: number, body: string): boolean {
  const text = String(body || '').toLowerCase();
  return (status === 403 || status === 503) && (
    text.includes('just a moment') ||
    text.includes('cf-ray') ||
    text.includes('cf_chl') ||
    text.includes('challenge-platform') ||
    text.includes('attention required')
  );
}

async function requestWithCurlCffi(
  method: 'GET' | 'POST',
  url: string,
  headers: Record<string, any>,
  body: any,
): Promise<any | null> {
  return await new Promise((resolve) => {
    const child = spawn('python', ['-c', PYTHON_CFFI_BRIDGE], { stdio: ['pipe', 'pipe', 'pipe'] });
    const payload = JSON.stringify({
      method,
      url,
      headers,
      body: body ?? null,
      timeout: 30,
      attempts: 4,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      if (DEBUG_HTTP) console.log(`[CLI HTTP] cffi spawn error: ${err?.message || err}`);
      resolve(null);
    });
    child.on('close', () => {
      if (stderr.trim() && DEBUG_HTTP) console.log(`[CLI HTTP] cffi stderr: ${stderr.trim()}`);
      if (!stdout.trim()) return resolve(null);
      try {
        const parsed = JSON.parse(stdout);
        if (parsed && typeof parsed === 'object') return resolve(parsed);
      } catch (_) {}
      resolve(null);
    });

    child.stdin.write(payload);
    child.stdin.end();
  });
}

function sanitizeHeadersForCffi(headers: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  const blockedPrefixes = ['sec-ch-', 'sec-fetch-'];
  const allowedKeys = new Set([
    'user-agent',
    'accept',
    'accept-language',
    'referer',
    'origin',
    'cookie',
    'content-type',
    'authorization',
  ]);

  for (const [k, v] of Object.entries(headers || {})) {
    const key = k.toLowerCase();
    if (blockedPrefixes.some((p) => key.startsWith(p))) continue;
    if (!allowedKeys.has(key) && key.startsWith('x-')) continue;
    if (v === undefined || v === null || String(v).trim() === '') continue;
    out[k] = v;
  }
  if (!Object.keys(out).some((k) => k.toLowerCase() === 'user-agent')) {
    out['User-Agent'] = DEFAULT_UA;
  }
  return out;
}

async function requestWithParityHttp(
  method: 'GET' | 'POST',
  url: string,
  headersInput: any,
  bodyInput: any,
  cb?: (res: any) => void,
): Promise<any> {
  let headers = headersInput;
  let body = bodyInput;

  if (isRecord(headersInput) && (headersInput.headers || headersInput.body)) {
    headers = headersInput.headers;
    if ((body === undefined || body === null || body === '') && headersInput.body !== undefined) {
      body = headersInput.body;
    }
  }

  const finalHeaders: Record<string, any> = { ...(headers || {}) };
  if (!Object.keys(finalHeaders).some((k) => k.toLowerCase() === 'user-agent')) {
    finalHeaders['User-Agent'] = DEFAULT_UA;
  }

  try {
    const res = await axios.request({
      method,
      url,
      headers: finalHeaders,
      data: body,
      validateStatus: () => true,
      maxRedirects: 8,
    });

    const response = {
      status: res.status,
      statusCode: res.status,
      body: typeof res.data === 'string' ? res.data : JSON.stringify(res.data),
      headers: res.headers || {},
      finalUrl: (res.request as any)?.res?.responseUrl || res.config?.url || url,
    };

    if (isCloudflareChallenge(response.status, response.body)) {
      if (DEBUG_HTTP) console.log(`[CLI HTTP] CF detected for ${url}, attempting cffi fallback`);
      const cfHeaders = sanitizeHeadersForCffi(finalHeaders);
      const cfRes = await requestWithCurlCffi(method, url, cfHeaders, body);
      if (cfRes && Number(cfRes.status || 0) > 0) {
        if (DEBUG_HTTP) console.log(`[CLI HTTP] cffi status=${cfRes.status || cfRes.statusCode || 0} finalUrl=${cfRes.finalUrl || url}`);
        const out = {
          status: Number(cfRes.status || cfRes.statusCode || 0),
          statusCode: Number(cfRes.statusCode || cfRes.status || 0),
          body: String(cfRes.body || ''),
          headers: cfRes.headers || {},
          finalUrl: String(cfRes.finalUrl || url),
        };
        if (cb) cb(out);
        return out;
      }
      if (DEBUG_HTTP && cfRes) console.log(`[CLI HTTP] cffi returned non-success status=${cfRes.status || cfRes.statusCode || 0} error=${cfRes.error || ''}`);
      if (DEBUG_HTTP && !cfRes) console.log('[CLI HTTP] cffi returned null');
    }

    if (cb) cb(response);
    return response;
  } catch (e: any) {
    const out = {
      status: e.response?.status || 500,
      statusCode: e.response?.status || 500,
      body: typeof e.response?.data === 'string' ? e.response.data : JSON.stringify(e.response?.data || e.message),
      headers: e.response?.headers || {},
      finalUrl: e.response?.config?.url || url,
    };
    if (cb) cb(out);
    return out;
  }
}

const JS_TEMPLATE = `(function() {
    /**
     * @typedef {Object} Response
     * @property {boolean} success
     * @property {any} [data]
     * @property {string} [errorCode]
     * @property {string} [message]
     */

    /**
     * @type {import('@skystream/sdk').Manifest}
     */
    // var manifest is injected at runtime

    // 1. (Optional) Register your plugin settings
    //     registerSettings([
    //         { id: "quality", name: "Default Quality", type: "select", options: ["1080p", "720p"], default: "1080p" },
    //         { id: "prefer_dub", name: "Prefer Dubbed", type: "toggle", default: false }
    //     ]);

    /**
     * Loads the home screen categories.
     * @param {(res: Response) => void} cb 
     */
    async function getHome(cb) {
        // Example: Using solveCaptcha if needed (await solveCaptcha(siteKey, url))
        try {
            // Dashboard Layout:
            // - "Trending" is a reserved category promoted to the Hero Carousel.
            // - Other categories appear as horizontal thumbnail rows.
            // - If "Trending" is missing, the first category is used for the carousel.
            cb({ 
                success: true, 
                data: { 
                    "Trending": [
                        new MultimediaItem({ 
                            title: "Example Movie (Carousel)", 
                            url: \`\${manifest.baseUrl}/movie\`, 
                            posterUrl: \`https://placehold.co/400x600.png?text=Trending+Movie\`, 
                            type: "movie", // Valid types: movie, series, anime, livestream, other
                            bannerUrl: \`https://placehold.co/1280x720.png?text=Trending+Banner\`, // (optional)
                            description: "Plot summary here...", // (optional)
                            headers: { "Referer": \`\${manifest.baseUrl}\` } // (optional)
                        })
                    ],
                    "Latest Series": [
                        new MultimediaItem({ 
                            title: "Example Series (Thumb)", 
                            url: \`\${manifest.baseUrl}/series\`, 
                            posterUrl: \`https://placehold.co/400x600.png?text=Series+Poster\`, 
                            type: "series",
                            description: "This category appears as a thumbnail row."
                        })
                    ]
                } 
            });
        } catch (e) {
            cb({ success: false, errorCode: "PARSE_ERROR", message: e.stack });
        }
    }

    /**
     * Searches for media items.
     * @param {string} query
     * @param {(res: Response) => void} cb 
     */
    async function search(query, cb) {
        try {
            // Standard: Return a List of items
            // Samples show both a movie and a series
            cb({ 
                success: true, 
                data: [
                        new MultimediaItem({ 
                            title: "Example Movie (Search Result)", 
                            url: \`\${manifest.baseUrl}/movie\`, 
                            posterUrl: \`https://placehold.co/400x600.png?text=Search+Movie\`, 
                            type: "movie", 
                            bannerUrl: \`https://placehold.co/1280x720.png?text=Search+Banner\`,
                            description: "Plot summary here...", 
                            headers: { "Referer": \`\${manifest.baseUrl}\` } 
                        }),
                        new MultimediaItem({ 
                            title: "Example Series (Search Result)", 
                            url: \`\${manifest.baseUrl}/series\`, 
                            posterUrl: \`https://placehold.co/400x600.png?text=Search+Series\`, 
                            type: "series", 
                            description: "A series found in search.", 
                            headers: { "Referer": \`\${manifest.baseUrl}\` } 
                        })
                ] 
            });
        } catch (e) {
            cb({ success: false, errorCode: "SEARCH_ERROR", message: e.stack });
        }
    }

    /**
     * Loads details for a specific media item.
     * @param {string} url
     * @param {(res: Response) => void} cb 
     */
    async function load(url, cb) {
        try {
            // Standard: Return a single item with full metadata
            // Sample shows a series with episodes
            cb({ 
                success: true, 
                data: new MultimediaItem({
                    title: "Example Series Full Details",
                    url: url,
                    posterUrl: \`https://placehold.co/400x600.png?text=Series+Details\`,
                    type: "series", 
                    bannerUrl: \`https://placehold.co/1280x720.png?text=Series+Banner\`,
                    description: "This is a detailed description of the media.", 
                    year: 2024,
                    score: 8.5,
                    duration: 120, // (optional, in minutes)
                    status: "ongoing", // ongoing, completed, upcoming
                    contentRating: "PG-13",
                    logoUrl: \`https://placehold.co/200x100.png?text=Logo\`,
                    isAdult: false,
                    tags: ["Action", "Adventure"],
                    cast: [
                        new Actor({ name: "John Doe", role: "Protagonist", image: "https://placehold.co/200x300.png" })
                    ],
                    trailers: [
                        new Trailer({ name: "Official Trailer", url: "https://www.youtube.com/watch?v=..." })
                    ],
                    nextAiring: new NextAiring({ episode: 5, season: 1, airDate: "2024-04-01" }),
                    recommendations: [
                        new MultimediaItem({ title: "Similar Show", url: \`\${manifest.baseUrl}/similar\`, posterUrl: "https://placehold.co/400x600", type: "series" })
                    ],
                    playbackPolicy: "none", // 'none' | 'VPN Recommended' | 'torrent' | 'externalPlayerOnly' | 'internalPlayerOnly'
                    syncData: { "my_service_id": "12345" }, // Optional: external metadata sync
                    streams: [
                        // Optional: "Instant Load" - bypass loadStreams by providing links here
                        new StreamResult({ url: "https://example.com/movie.mp4", source: "Instant High" })
                    ],
                    headers: { "Referer": \`\${manifest.baseUrl}\` }, 
                    episodes: [
                        new Episode({ 
                            name: "Episode 1", 
                            url: \`\${manifest.baseUrl}/watch/1\`, 
                            season: 1, 
                            episode: 1, 
                            description: "Episode summary...", 
                            posterUrl: \`https://placehold.co/400x600.png?text=Episode+Poster\`,
                            headers: { "Referer": \`\${manifest.baseUrl}\` },
                            dubStatus: "sub",
                            streams: [] // Optional: "Instant Load" for episodes
                        }),
                        new Episode({ 
                            name: "Episode 2", 
                            url: \`\${manifest.baseUrl}/watch/2\`, 
                            season: 1, 
                            episode: 2, 
                            description: "Next episode summary...", 
                            posterUrl: \`https://placehold.co/400x600.png?text=Episode+Poster\`,
                            headers: { "Referer": \`\${manifest.baseUrl}\` },
                            dubStatus: "sub"
                        })
                    ]
                })
            });
        } catch (e) {
            cb({ success: false, errorCode: "LOAD_ERROR", message: e.stack });
        }
    }

    /**
     * Resolves streams for a specific media item or episode.
     * @param {string} url
     * @param {(res: Response) => void} cb 
     */
    async function loadStreams(url, cb) {
        try {
            // Standard: Return a List of stream objects
            cb({ 
                success: true, 
                data: [
                    new StreamResult({ 
                        url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8", 
                        source: "Direct Quality", 
                        headers: { "Referer": \`\${manifest.baseUrl}\` }
                    })
                ] 
            });
        } catch (e) {
            cb({ success: false, errorCode: "STREAM_ERROR", message: String(e) });
        }
    }

    // Export to global scope for namespaced IIFE capture
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
`;

const README_TEMPLATE = (name: string, slug: string) => `# 🌌 ${name}
${name} is an extension repo for [SkyStream](https://github.com/akashdh11/skystream). Follow the guide below to get started and set up your providers.

## 🚀 Getting Started

### 1. Installation
To install SkyStream on your device, follow these steps:

*   **Download:** Navigate to the [SkyStream releases page](https://github.com/akashdh11/skystream/releases/) and download the latest release for your platform.
*   **Install:** Open the downloaded file and follow your system's installation prompts.
*   **Launch:** Once installed, open the **SkyStream** app.

---

## 🛠 Setting Up Extensions
SkyStream uses a repository system to fetch plugins. Follow these steps to activate the app's content:

1.  Open the app and navigate to **Settings**.
2.  Select the **Manage Extensions** menu.
3.  Click on the **Add Repository** button.
4.  Enter the following Repository URL:
    > **Repository URL:** \`https://raw.githubusercontent.com/USER_NAME/REPO_NAME/main/repo.json\`
5.  Tap **Add**.
6.  Wait for the list to populate, then **download** the desired plugins.

---

## 📺 Using the App
After you have installed your plugins, you need to toggle the providers to see content on your dashboard:

1.  Return to the **Home Screen**.
2.  Change **Provider** (bottom right floating action button).
3.  Switch to your newly installed providers to begin browsing.
`;

const GITHUB_ACTION_TEMPLATE = `name: Build and Deploy Repository

on:
  push:
    branches: [ main ]
    paths-ignore:
      - 'dist/**'
      - 'README.md'

permissions:
  contents: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Deploy Repository
        run: |
          npm install -g skystream-cli
          skystream deploy -u https://raw.githubusercontent.com/\${{ github.repository }}/main

      - name: Commit and Push changes
        run: |
          git config --global user.name "github-actions[bot]"
          git config --global user.email "github-actions[bot]@users.noreply.github.com"
          git add .
          git commit -m "chore: automated deploy [skip ci]" || echo "No changes to commit"
          git push
`;

async function updatePluginsJson(rootDir: string) {
  // Logic removed: deploy command now handles dynamic generation in dist/
}

program.command('init')
  .description('Initialize a Sky Gen 2 Repository project')
  .argument('<project-name>', 'Display name of the project')
  .requiredOption('-p, --package-name <id>', 'Unique Repository ID (e.g. dev.akash.stars)')
  .requiredOption('-n, --plugin-name <name>', 'First plugin name (e.g. "AYNA 2")')
  .option('-d, --description <desc>', 'Repository description', 'SkyStream plugins repository')
  .option('-a, --author <author>', 'Author name', 'Developer')
  .action(async (projectName, options) => {
    const rootDir = path.resolve(projectName.toLowerCase().replace(/\s+/g, '-'));
    if (await fs.pathExists(rootDir)) {
      console.error(`Error: Directory ${rootDir} already exists`);
      process.exit(1);
    }

    await fs.ensureDir(rootDir);
    console.log(`Initializing Repository: ${projectName} (${options.packageName})`);

    const projectSlug = projectName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

    const repo = {
      name: projectName,
      packageName: options.packageName,
      description: options.description,
      manifestVersion: 1,
      pluginLists: [
          `https://raw.githubusercontent.com/USER_NAME/REPO_NAME/main/dist/plugins.json`
      ]
    };
    await fs.writeJson(path.join(rootDir, 'repo.json'), repo, { spaces: 2 });
    await fs.writeFile(path.join(rootDir, 'README.md'), README_TEMPLATE(projectName, projectSlug));

    // GitHub Action
    const githubWorkflowsDir = path.join(rootDir, '.github', 'workflows');
    await fs.ensureDir(githubWorkflowsDir);
    await fs.writeFile(path.join(githubWorkflowsDir, 'build.yml'), GITHUB_ACTION_TEMPLATE);

    // First Plugin
    const pluginName = options.pluginName;
    const packageName = options.packageName;
    const pluginSlug = pluginName.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
    const pluginDir = path.join(rootDir, pluginSlug);
    await fs.ensureDir(pluginDir);

    const pluginManifest = {
      packageName: `${packageName}.${pluginSlug}`,
      name: pluginName,
      version: 1,
      baseUrl: "https://example.com",
      description: `${pluginName} plugin (Sky Gen 2)`,
      authors: [options.author],
      languages: ["en"],
      categories: ["Others"]
    };

    await fs.writeJson(path.join(pluginDir, 'plugin.json'), pluginManifest, { spaces: 2 });
    await fs.writeFile(path.join(pluginDir, 'plugin.js'), JS_TEMPLATE);

    console.log('\nSky Gen 2 Repository successfully initialized!');
    console.log(`Project Directory: ${rootDir}`);
    console.log(`First Plugin Package Name: ${pluginManifest.packageName}`);
  });

program.command('add')
  .description('Add a new Sky Gen 2 plugin to the repository')
  .argument('<plugin-name>', 'Name of the plugin (e.g. "Yflix")')
  .option('-d, --description <desc>', 'Plugin description')
  .option('-a, --author <author>', 'Author name')
  .action(async (pluginName, options) => {
    const rootDir = process.cwd();
    const repoPath = path.join(rootDir, 'repo.json');

    if (!await fs.pathExists(repoPath)) {
      console.error('Error: Not in a SkyStream repository (repo.json missing)');
      process.exit(1);
    }

    const repo = await fs.readJson(repoPath);
    const pluginSlug = pluginName.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
    const pluginDir = path.join(rootDir, pluginSlug);

    if (await fs.pathExists(pluginDir)) {
      console.error(`Error: Plugin ${pluginName} already exists at ${pluginSlug}`);
      process.exit(1);
    }

    // Guess package-name from repo id
    const packageName = repo.packageName;

    const pluginManifest = {
      packageName: `${packageName}.${pluginSlug}`,
      name: pluginName,
      version: 1,
      baseUrl: "https://example.com",
      description: options.description || `${pluginName} plugin for ${repo.name}`,
      authors: [options.author || repo.author || "Developer"],
      languages: ["en"],
      categories: ["Others"]
    };

    await fs.ensureDir(pluginDir);
    await fs.writeJson(path.join(pluginDir, 'plugin.json'), pluginManifest, { spaces: 2 });
    await fs.writeFile(path.join(pluginDir, 'plugin.js'), JS_TEMPLATE);

    console.log(`✓ Added Plugin: ${pluginName} (Package: ${pluginManifest.packageName})`);
  });

program.command('validate')
  .description('Validate all plugins in the repo')
  .action(async () => {
    const rootDir = process.cwd();
    const items = await fs.readdir(rootDir);
    let count = 0;
    for (const item of items) {
        const itemPath = path.join(rootDir, item);
        const manifestPath = path.join(itemPath, 'plugin.json');
        if (await fs.pathExists(manifestPath) && (await fs.stat(itemPath)).isDirectory()) {
            try {
                const manifest = await fs.readJson(manifestPath);
                pluginSchema.parse(manifest);
                console.log(`✓ ${manifest.packageName}: Manifest OK`);
                const js = await fs.readFile(path.join(itemPath, 'plugin.js'), 'utf8');
                const exportCheck = detectExports(js, manifest, manifest.packageName || item);
                if (exportCheck.runtimeError) {
                  console.warn(`! ${manifest.packageName}: Runtime parse issue (${exportCheck.runtimeError})`);
                }
                if (exportCheck.missing.length === 0) {
                    console.log(`✓ ${manifest.packageName}: Logic exports OK`);
                } else {
                    console.warn(`! ${manifest.packageName}: Missing exports -> ${exportCheck.missing.join(', ')}`);
                }
                count++;
            } catch (e: any) {
                console.error(`\u2717 ${item} invalid: ${e.message}`);
                if (e instanceof z.ZodError) {
                    console.error(JSON.stringify(e.format(), null, 2));
                }
            }
        }
    }
    console.log(`\nValidation complete. Validated ${count} plugins.`);
  });

program.command('test')
  .description('Test a specific plugin')
  .option('-p, --path <path>', 'Path to plugin folder', '.')
  .option('-r, --repo', 'Treat --path as repository root and run all plugin folders')
  .option('--plugin <name>', 'In --repo mode, only run a specific plugin folder/packageName')
  .option('-f, --function <function>', 'Function to test', 'getHome')
  .option('-q, --query <query>', 'Query for function', '')
  .action(async (options) => {
    const functionName = String(options.function || 'getHome');
    if (!REQUIRED_FUNCTIONS.includes(functionName as any)) {
      console.error(`Error: Unsupported function "${functionName}". Use one of: ${REQUIRED_FUNCTIONS.join(', ')}`);
      process.exit(1);
    }

    const pluginDirs: string[] = [];
    const targetPath = path.resolve(options.path);
    if (options.repo) {
      const items = await fs.readdir(targetPath);
      for (const item of items) {
        const itemPath = path.join(targetPath, item);
        if (!(await fs.stat(itemPath)).isDirectory()) continue;
        const manifestPath = path.join(itemPath, 'plugin.json');
        const jsPath = path.join(itemPath, 'plugin.js');
        if (await fs.pathExists(manifestPath) && await fs.pathExists(jsPath)) {
          pluginDirs.push(itemPath);
        }
      }
    } else {
      pluginDirs.push(targetPath);
    }

    if (pluginDirs.length === 0) {
      console.error(`Error: No plugin folders found in ${targetPath}`);
      process.exit(1);
    }

    let failures = 0;

    for (const pluginDir of pluginDirs) {
      const manifestPath = path.join(pluginDir, 'plugin.json');
      const jsPath = path.join(pluginDir, 'plugin.js');

      if (!await fs.pathExists(manifestPath) || !await fs.pathExists(jsPath)) {
        if (!options.repo) {
          console.error(`Error: plugin.json/plugin.js not found at ${pluginDir}`);
          console.log('Hint: Run this command from your plugin directory or specify --path');
          process.exit(1);
        }
        continue;
      }

      const manifest = await fs.readJson(manifestPath);
      const pluginName = manifest.packageName || path.basename(pluginDir);
      if (options.repo && options.plugin) {
        if (options.plugin !== path.basename(pluginDir) && options.plugin !== pluginName) {
          continue;
        }
      }
      const jsContent = await fs.readFile(jsPath, 'utf8');

      console.log(`\n--- Testing ${pluginName} -> ${functionName} ---`);
      const preferences: Record<string, any> = {};
      const context: any = {
        manifest,
        console: { 
          log: (...args: any[]) => console.log('  [JS]:', ...args), 
          error: (...args: any[]) => console.error('  [JS ERR]:', ...args) 
        },
        http_get: async (url: string, headers_or_options: any, cb: any) => {
          return requestWithParityHttp('GET', url, headers_or_options, null, cb);
        },
        http_post: async (url: string, headers: any, body: any, cb: any) => {
          return requestWithParityHttp('POST', url, headers, body, cb);
        },
        registerSettings: (schema: any) => {
          console.log('  [Mock SDK]: Plugin registered settings:', JSON.stringify(schema, null, 2));
        },
        getPreference: (key: string) => {
            return preferences[key] || null;
        },
        setPreference: (key: string, value: any) => {
            preferences[key] = value;
            return true;
        },
        solveCaptcha: async (siteKey: string, url: string) => {
          console.log('  [Mock SDK]: solveCaptcha requested for ' + url + ' with key ' + siteKey);
          return "mock_captcha_token";
        },
        btoa: (s: string) => Buffer.from(s).toString('base64'),
        atob: (s: string) => Buffer.from(s, 'base64').toString('utf8'),
        sendMessage: (id: string, arg: string) => {
          if (id === 'get_preference') {
              const { packageName: pName, key } = JSON.parse(arg);
              const scopedKey = pName ? `${pName}:${key}` : key;
              if (Object.prototype.hasOwnProperty.call(preferences, scopedKey)) return preferences[scopedKey];
              return preferences[key] || null;
          }
          if (id === 'set_preference') {
              const { packageName: pName, key, value } = JSON.parse(arg);
              const scopedKey = pName ? `${pName}:${key}` : key;
              preferences[scopedKey] = value;
              preferences[key] = value;
              return true;
          }
          if (id === 'register_settings') {
            const { packageName: pName, schema } = JSON.parse(arg);
            console.log('  [Mock SDK]: Plugin registered settings for ' + (pName || pluginName) + ':', JSON.stringify(schema, null, 2));
            return true;
          }
          if (id === 'crypto_decrypt_aes') {
            const { data, key, iv } = JSON.parse(arg);
            try {
              const decodeBuffer = (s: string) => {
                return s.length % 4 === 0 && /^[A-Za-z0-9+/=]+$/.test(s) ? Buffer.from(s, 'base64') : Buffer.from(s, 'utf8');
              };

              const k = decodeBuffer(key);
              const ivBuf = Buffer.alloc(16, 0);
              decodeBuffer(iv).copy(ivBuf);
              
              let algo = 'aes-256-cbc';
              let finalKey = Buffer.alloc(32, 0);
              if (k.length <= 16) {
                  algo = 'aes-128-cbc';
                  finalKey = Buffer.alloc(16, 0);
              } else if (k.length <= 24) {
                  algo = 'aes-192-cbc';
                  finalKey = Buffer.alloc(24, 0);
              }
              k.copy(finalKey);

              const decipher = crypto.createDecipheriv(algo, finalKey, ivBuf);
              let decrypted = decipher.update(data, 'base64', 'utf8');
              decrypted += decipher.final('utf8');
              return decrypted;
            } catch (e: any) {
              console.error('  [Mock ERR]: AES Decryption failed:', e.message);
              return data;
            }
          }
          return '';
        },
        crypto: {
          decryptAES: async (data: string, key: string, iv: string) => {
            return context.sendMessage('crypto_decrypt_aes', JSON.stringify({ data, key, iv }));
          }
        },
        globalThis: {} as any,
      };
      context.globalThis = context;

      const entityDefs = `
      class Actor {
        constructor(params) {
          Object.assign(this, params);
        }
      }

      class Trailer {
        constructor(params) {
          Object.assign(this, params);
        }
      }

      class NextAiring {
        constructor(params) {
          Object.assign(this, params);
        }
      }

      class MultimediaItem {
        constructor(params) {
          Object.assign(this, {
            type: 'movie',
            status: 'ongoing',
            playbackPolicy: 'none',
            isAdult: false,
            streams: [],
            syncData: {},
            ...params
          });
        }
      }

      class Episode {
        constructor(params) {
          Object.assign(this, {
            season: 0,
            episode: 0,
            dubStatus: 'none',
            playbackPolicy: 'none',
            streams: [],
            ...params
          });
        }
      }

      class StreamResult {
        constructor({ url, source, headers, subtitles, drmKid, drmKey, licenseUrl }) {
          this.url = url;
          this.source = source || 'Auto';
          this.headers = headers;
          this.subtitles = subtitles;
          this.drmKid = drmKid;
          this.drmKey = drmKey;
          this.licenseUrl = licenseUrl;
        }
      }

      // Sync CLI with App's Async JSDOM behavior
      globalThis.JSDOM = class JSDOM {
        constructor(html) {
          this._initPromise = (async () => {
             const dom = new __NodeJSDOM__(html);
             this.window = { document: dom.window.document };
             return this;
          })();
        }
        async waitForInit() {
          return await this._initPromise;
        }
      };

      globalThis.parseHtml = async function(html) {
          const dom = new JSDOM(html);
          await dom.waitForInit();
          return dom.window.document;
      };

      globalThis.CloudStream = {
         getLanguage: function() { return "en"; },
         getRegion: function() { return "US"; }
      };

      globalThis.crypto = {
        md5: function(s) { return __crypto__.createHash('md5').update(s).digest('hex'); },
        b64encode: function(s) { return Buffer.from(s).toString('base64'); },
        b64decode: function(s) { return Buffer.from(s, 'base64').toString('utf8'); }
      };

      globalThis.clearInterval = clearInterval;
    `;

      const sandbox = Object.create(null);
      Object.assign(sandbox, context);
    
      // Ensure Node globals are present
      sandbox.atob = (str: string) => Buffer.from(str, 'base64').toString('binary');
      sandbox.btoa = (str: string) => Buffer.from(str, 'binary').toString('base64');
      sandbox.URL = URL;
      sandbox.console = {
        log: (...args: any[]) => console.log('[JS LOG]', ...args),
        error: (...args: any[]) => console.error('[JS ERROR]', ...args),
        warn: (...args: any[]) => console.warn('[JS WARN]', ...args),
      };
      sandbox.axios = axios;
      sandbox.Buffer = Buffer;
      sandbox.setTimeout = setTimeout;
      sandbox.clearTimeout = clearTimeout;
      sandbox.setInterval = setInterval;
      sandbox.clearInterval = clearInterval;
      sandbox.__NodeJSDOM__ = JSDOM;
      sandbox.__crypto__ = crypto;
      sandbox.URL = URL;
      sandbox.globalThis = sandbox;
    
      // Inject the classes from entityDefs into the sandbox
      const vmContext = vm.createContext(sandbox);
      vm.runInContext(entityDefs, vmContext);

      const combinedScript = `
        try {
          ${wrapPluginForAppParity(jsContent, manifest, pluginName)}
        } catch (e) {
          console.error("Critical Runtime Error: " + e.stack);
        }
      `;

      try {
        vm.runInContext(combinedScript, vmContext, { timeout: 5000, breakOnSigint: true });
      } catch (e: any) {
        console.error("VM Execution Error: " + e.message);
      }

      const scopedExports = (vmContext as any).globalThis[CLI_TEST_NAMESPACE] || {};
      const fn = scopedExports[functionName] || (vmContext as any).globalThis[functionName];
      if (typeof fn !== 'function') {
        console.error(`Error: exported function "${functionName}" not found`);
        failures++;
        continue;
      }

      let callbackResult: any = undefined;
      const callback = (res: any) => {
        callbackResult = res;
        console.log('\n--- Result ---');
        if (res && res.success === false) {
          console.log('\x1b[31mStatus: FAILED\x1b[0m');
          console.log('\x1b[31mError Code: ' + (res.errorCode || 'UNKNOWN') + '\x1b[0m');
          if (res.message) console.log('\x1b[31mMessage: ' + res.message + '\x1b[0m');
        } else {
          console.log('\x1b[32mStatus: SUCCESS\x1b[0m');
        }
        const contractErrors = validateFunctionResult(functionName, res);
        if (contractErrors.length > 0) {
          console.log('\x1b[33mContract Warnings:\x1b[0m');
          for (const err of contractErrors) {
            console.log(`  - ${err}`);
          }
        } else {
          console.log('\x1b[32mContract: OK\x1b[0m');
        }
        console.log(JSON.stringify(res, null, 2));
      };

      try {
          if (functionName === 'getHome') await fn(callback);
          else if (functionName === 'search') await fn(options.query, callback);
          else if (!options.query || options.query.trim() === "") {
              console.warn('\x1b[33mWarning: Function \'' + functionName + '\' usually requires a query/URL (-q), but none was provided.\x1b[0m');
              await fn(options.query, callback);
          } else {
              await fn(options.query, callback);
          }
      } catch (e: any) {
          console.error('\n\x1b[31m--- CRITICAL ERROR DURING EXECUTION ---\x1b[0m');
          console.error('\x1b[31m' + (e.stack || e.message) + '\x1b[0m\n');
          failures++;
          continue;
      }

      if (callbackResult === undefined) {
        console.warn('\x1b[33mWarning: callback was never called by plugin.\x1b[0m');
        failures++;
      }
    }

    if (options.repo) {
      console.log(`\nRepo test finished. Failures: ${failures}`);
    }
    if (failures > 0) process.exit(2);
  });

program.command('deploy')
  .description('Deploy all plugins and repository index')
  .requiredOption('-u, --url <url>', 'Base hosting URL for .sky files')
  .action(async (options) => {
    const rootDir = process.cwd();
    const repoPath = path.join(rootDir, 'repo.json');
    if (!await fs.pathExists(repoPath)) { process.exit(1); }

    const distDir = path.join(rootDir, 'dist');
    await fs.ensureDir(distDir);

    const repo = await fs.readJson(repoPath);
    const items = await fs.readdir(rootDir);
    const catalog = [];

    // Standardize URL: Append /dist automatically
    const baseRaw = options.url.endsWith('/') ? options.url.slice(0, -1) : options.url;
    const distUrl = baseRaw + "/dist";

    for (const item of items) {
        const itemPath = path.join(rootDir, item);
        const mPath = path.join(itemPath, 'plugin.json');
        if (await fs.pathExists(mPath) && (await fs.stat(itemPath)).isDirectory()) {
            const manifest = await fs.readJson(mPath);
            const packageName = manifest.packageName || manifest.id || item;
            const bundleName = packageName + ".sky";
            const outPath = path.join(distDir, bundleName);
            
            const arch = archiver('zip', { zlib: { level: 9 } });
            arch.pipe(fs.createWriteStream(outPath));
            arch.file(mPath, { name: 'plugin.json' });
            arch.file(path.join(itemPath, 'plugin.js'), { name: 'plugin.js' });
            await arch.finalize();

            catalog.push({ ...manifest, url: distUrl + "/" + bundleName });
            console.log("✓ Bundled " + manifest.packageName);
        }
    }

    const finalRepo = {
        ...repo,
        pluginLists: [ distUrl + "/plugins.json" ]
    };

    await fs.writeJson(repoPath, finalRepo, { spaces: 2 });
    await fs.writeJson(path.join(distDir, 'plugins.json'), catalog, { spaces: 2 });
    
    // Update README.md with the live URL
    const readmePath = path.join(rootDir, 'README.md');
    if (await fs.pathExists(readmePath)) {
        let readme = await fs.readFile(readmePath, 'utf8');
        const placeholder = 'https://raw.githubusercontent.com/USER_NAME/REPO_NAME/main/repo.json';
        const liveUrl = baseRaw + "/repo.json";
        if (readme.includes(placeholder)) {
            readme = readme.replace(placeholder, liveUrl);
            await fs.writeFile(readmePath, readme);
            console.log("✓ Updated README.md with live URL");
        }
    }

    console.log("\nDeployment Complete. Assets generated in dist/");
    console.log("\nYour Repo Link for the app:");
    console.log("> " + baseRaw + "/repo.json");
  });

program.parse();
