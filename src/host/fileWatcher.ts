import * as vscode from 'vscode';

export interface FileWatcherDeps {
  /** Filesystem root to watch. Defaults to all workspace folders. */
  root?: vscode.Uri;
  /** Workspace-relative path → triggered when an HTML file changes on disk. */
  onHtmlChange: (uri: vscode.Uri) => void;
  /** Workspace-relative path → triggered when a CSS/JS asset changes on disk. */
  onAssetChange: (uri: vscode.Uri) => void;
  /** Debounce window in milliseconds. */
  debounceMs: number;
}

export class FileWatcher implements vscode.Disposable {
  private readonly htmlWatcher: vscode.FileSystemWatcher;
  private readonly assetWatcher: vscode.FileSystemWatcher;
  private readonly disposables: vscode.Disposable[] = [];
  private htmlTimer: ReturnType<typeof setTimeout> | null = null;
  private assetTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pendingHtml = new Map<string, vscode.Uri>();
  private readonly pendingAsset = new Map<string, vscode.Uri>();
  private deps: FileWatcherDeps;

  constructor(deps: FileWatcherDeps) {
    this.deps = deps;
    this.htmlWatcher = vscode.workspace.createFileSystemWatcher(
      watchPattern(deps.root, '**/*.{html,htm}'),
    );
    this.assetWatcher = vscode.workspace.createFileSystemWatcher(
      watchPattern(deps.root, '**/*.{css,js,mjs,jsx,ts,tsx,svg,png,jpg,jpeg,gif,webp,woff,woff2,ttf,otf}'),
    );
    const onHtml = (uri: vscode.Uri): void => this.queueHtml(uri);
    const onAsset = (uri: vscode.Uri): void => this.queueAsset(uri);
    this.disposables.push(
      this.htmlWatcher,
      this.htmlWatcher.onDidChange(onHtml),
      this.htmlWatcher.onDidCreate(onHtml),
      this.htmlWatcher.onDidDelete(onHtml),
      this.assetWatcher,
      this.assetWatcher.onDidChange(onAsset),
      this.assetWatcher.onDidCreate(onAsset),
      this.assetWatcher.onDidDelete(onAsset),
    );
  }

  /** Update debounce window without recreating the watcher. */
  setDebounce(ms: number): void {
    this.deps = { ...this.deps, debounceMs: ms };
  }

  private queueHtml(uri: vscode.Uri): void {
    this.pendingHtml.set(uri.toString(), uri);
    if (this.htmlTimer) clearTimeout(this.htmlTimer);
    this.htmlTimer = setTimeout(() => this.flushHtml(), this.deps.debounceMs);
  }

  private queueAsset(uri: vscode.Uri): void {
    this.pendingAsset.set(uri.toString(), uri);
    if (this.assetTimer) clearTimeout(this.assetTimer);
    this.assetTimer = setTimeout(() => this.flushAsset(), this.deps.debounceMs);
  }

  private flushHtml(): void {
    this.htmlTimer = null;
    const uris = Array.from(this.pendingHtml.values());
    this.pendingHtml.clear();
    for (const uri of uris) {
      try {
        this.deps.onHtmlChange(uri);
      } catch {
        // swallow; one bad handler must not stop others
      }
    }
  }

  private flushAsset(): void {
    this.assetTimer = null;
    const uris = Array.from(this.pendingAsset.values());
    this.pendingAsset.clear();
    for (const uri of uris) {
      try {
        this.deps.onAssetChange(uri);
      } catch {
        // swallow
      }
    }
  }

  dispose(): void {
    if (this.htmlTimer) clearTimeout(this.htmlTimer);
    if (this.assetTimer) clearTimeout(this.assetTimer);
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}

function watchPattern(root: vscode.Uri | undefined, pattern: string): vscode.GlobPattern {
  return root ? new vscode.RelativePattern(root, pattern) : pattern;
}
