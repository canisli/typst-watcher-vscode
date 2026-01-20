import * as vscode from 'vscode';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

type Status = 'idle' | 'ok' | 'error' | 'starting';

class WatchItem {
  proc: ChildProcessWithoutNullStreams;
  log: vscode.OutputChannel;
  status: Status = 'starting';
  lastErrorAt: number = 0;
  constructor(proc: ChildProcessWithoutNullStreams, log: vscode.OutputChannel) {
    this.proc = proc; this.log = log;
  }
}

class WatchManager {
  private map = new Map<string, WatchItem>(); // key: file fsPath
  private decoEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChangeFileDecorations = this.decoEmitter.event;
  private statusBarItem: vscode.StatusBarItem;

  constructor(private ctx: vscode.ExtensionContext) {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBarItem.command = 'typst.toggleWatch';
    ctx.subscriptions.push(this.statusBarItem);

    // Update status bar when active editor changes
    vscode.window.onDidChangeActiveTextEditor(this.updateStatusBar.bind(this));
    this.updateStatusBar();
  }

  isWatching(uri: vscode.Uri) {
    return this.map.has(uri.fsPath);
  }

  getStatus(uri: vscode.Uri): Status {
    return this.map.get(uri.fsPath)?.status ?? 'idle';
  }

  async toggle(uri?: vscode.Uri) {
    // If no URI provided, use the active editor
    if (!uri) {
      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor || path.extname(activeEditor.document.fileName) !== '.typ') {
        vscode.window.showWarningMessage('No active Typst file to toggle autocompile.');
        return;
      }
      uri = activeEditor.document.uri;
    }

    if (this.isWatching(uri)) {
      this.stop(uri);
      return;
    }
    await this.start(uri);
  }

  private updateStatusBar() {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor || path.extname(activeEditor.document.fileName) !== '.typ') {
      this.statusBarItem.hide();
      return;
    }

    const uri = activeEditor.document.uri;
    const isWatching = this.isWatching(uri);
    const status = this.getStatus(uri);

    if (isWatching) {
      const statusIcon = status === 'ok' ? '🟢' : status === 'error' ? '🔴' : '🟡';
      this.statusBarItem.text = `${statusIcon} Typst Auto`;
      this.statusBarItem.tooltip = `Typst autocompile is ON. Click to stop. Status: ${status}`;
    } else {
      this.statusBarItem.text = '⚪ Typst Auto';
      this.statusBarItem.tooltip = 'Typst autocompile is OFF. Click to start.';
    }

    this.statusBarItem.show();
  }

  private cfg() {
    const cfg = vscode.workspace.getConfiguration('typstAutowatch');
    return {
      typstPath: cfg.get<string>('typstPath', 'typst'),
      outputDir: cfg.get<string>('outputDir', '^pdfs'),
      extraArgs: cfg.get<string[]>('extraArgs', [])
    };
  }

  private ensureOutputDir(workspaceFolder: vscode.WorkspaceFolder | undefined, outDir: string) {
    if (!workspaceFolder) return;
    const p = path.join(workspaceFolder.uri.fsPath, outDir);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  }

  async start(uri: vscode.Uri) {
    const ws = vscode.workspace.getWorkspaceFolder(uri);
    const { typstPath, outputDir, extraArgs } = this.cfg();
  
    // rootdir is the workspace folder if present, otherwise the file's folder
    const rootdir = ws ? ws.uri.fsPath : path.dirname(uri.fsPath);
  
    // Check if we're in the typst/ folder
    const isTypstFolder = rootdir.includes('/typst/') || rootdir.endsWith('/typst');
  
    let cmd: string;
    let args: string[];
    let cwd: string;
  
    if (isTypstFolder) {
      // Use standard typst watch for typst/ folder
      // Ensure ^pdfs (or whatever you set) exists under root
      const pdfDirAbs = path.join(rootdir, outputDir);
      if (!fs.existsSync(pdfDirAbs)) fs.mkdirSync(pdfDirAbs, { recursive: true });
    
      const name = path.basename(uri.fsPath, '.typ');         // $name
      const fnRel = path.relative(rootdir, uri.fsPath);       // $fn (relative to root)
      const outRel = path.join(outputDir, `${name}.pdf`);     // $rootdir/^pdfs/$name.pdf (relative)
    
      cmd = typstPath;
      args = ['watch', fnRel, outRel, '--root', rootdir, ...extraArgs];
      cwd = rootdir;
    } else {
      // Use custom watch.sh script for other folders
      const filename = path.basename(uri.fsPath);
      cmd = '/Users/canis/dev/01_learning/new notes/watch.sh';
      args = [filename];
      cwd = path.dirname(uri.fsPath);
    }
  
    const log = vscode.window.createOutputChannel(`Typst: ${path.basename(uri.fsPath)}`);
    log.appendLine(`$ ${cmd} ${args.join(' ')}`);
  
    const proc = spawn(cmd, args, { cwd, shell: process.platform === 'win32' });
    const item = new WatchItem(proc, log);
    this.map.set(uri.fsPath, item);
    this.bump(uri);
  
        proc.stdout.on('data', (d: Buffer) => {
      const s = d.toString();
      log.append(s);
      
      // Parse each line to get the latest status
      const lines = s.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        
        // Check for compilation start: "[timestamp] compiling ..."
        if (/\[\d{2}:\d{2}:\d{2}\]\s+compiling\s*\.\.\./i.test(trimmed)) {
          item.status = 'starting';
          this.bump(uri);
          this.updateStatusBar();
          continue;
        }
        
        // Check for successful compilation: "[timestamp] compiled successfully"
        if (/\[\d{2}:\d{2}:\d{2}\]\s+compiled successfully/i.test(trimmed)) {
          item.status = 'ok';
          this.bump(uri);
          this.updateStatusBar();
          continue;
        }
        
        // Check for compilation with warnings: "[timestamp] compiled with warnings"
        if (/\[\d{2}:\d{2}:\d{2}\]\s+compiled with warnings/i.test(trimmed)) {
          // Treat warnings as ok (green dot) - layout warnings are just noise
          item.status = 'ok';
          this.bump(uri);
          this.updateStatusBar();
          continue;
        }
        
        // Check for compilation errors: "[timestamp] compiled with errors"
        if (/\[\d{2}:\d{2}:\d{2}\]\s+compiled with errors/i.test(trimmed)) {
          item.status = 'error';
          item.lastErrorAt = Date.now();
          this.bump(uri);
          this.updateStatusBar();
          continue;
        }
      }
    });

    proc.stderr.on('data', (d: Buffer) => {
      const s = d.toString();
      log.append(s);
      
      // Parse each line to check for status messages (typst outputs to stderr)
      const lines = s.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        
        // Skip layout convergence warnings - don't change status for these
        if (/warning.*layout did not converge/i.test(trimmed)) {
          continue;
        }
        
        // Check for compilation start: "[timestamp] compiling ..."
        if (/\[\d{2}:\d{2}:\d{2}\]\s+compiling\s*\.\.\./i.test(trimmed)) {
          item.status = 'starting';
          this.bump(uri);
          this.updateStatusBar();
          continue;
        }
        
        // Check for successful compilation: "[timestamp] compiled successfully"
        if (/\[\d{2}:\d{2}:\d{2}\]\s+compiled successfully/i.test(trimmed)) {
          item.status = 'ok';
          this.bump(uri);
          this.updateStatusBar();
          continue;
        }
        
        // Check for compilation with warnings: "[timestamp] compiled with warnings"
        if (/\[\d{2}:\d{2}:\d{2}\]\s+compiled with warnings/i.test(trimmed)) {
          // Treat warnings as ok (green dot) - layout warnings are just noise
          item.status = 'ok';
          this.bump(uri);
          this.updateStatusBar();
          continue;
        }
        
        // Check for compilation errors: "[timestamp] compiled with errors"
        if (/\[\d{2}:\d{2}:\d{2}\]\s+compiled with errors/i.test(trimmed)) {
          item.status = 'error';
          item.lastErrorAt = Date.now();
          this.bump(uri);
          this.updateStatusBar();
          continue;
        }
      }
      
      // Only treat actual error messages as errors, ignore warnings (especially layout convergence)
      if (/error:|failed to|panic/i.test(s) && !/warning:|hint:|layout did not converge/i.test(s)) {
        item.status = 'error';
        item.lastErrorAt = Date.now();
        this.bump(uri);
        this.updateStatusBar();
      }
    });
  
    proc.on('exit', (code) => {
      log.appendLine(`\n[watcher exited with code ${code}]`);
      item.status = code === 0 ? 'idle' : 'error';
      this.map.delete(uri.fsPath);
      this.bump(uri);
      this.updateStatusBar();
    });
    
    proc.on('error', (error) => {
      log.appendLine(`\n[Process error: ${error.message}]`);
      item.status = 'error';
      this.bump(uri);
    });
  
    item.status = 'starting';
    this.bump(uri);
    this.updateStatusBar();
    vscode.window.setStatusBarMessage(`Typst watch started: ${path.basename(uri.fsPath)}`, 2000);
  }
  

  stop(uri: vscode.Uri) {
    const it = this.map.get(uri.fsPath);
    if (!it) return;
    try { it.proc.kill(); } catch {}
    it.log.appendLine('\n[watcher stopped]');
    it.log.dispose();
    this.map.delete(uri.fsPath);
    this.bump(uri);
    this.updateStatusBar();
    vscode.window.setStatusBarMessage(`Typst watch stopped: ${path.basename(uri.fsPath)}`, 2000);
  }

  showLog(uri?: vscode.Uri) {
    if (uri && this.map.get(uri.fsPath)) {
      this.map.get(uri.fsPath)!.log.show(true);
      return;
    }
    // If no URI, show a quick pick of all logs
    const items = [...this.map.keys()].map(k => ({ label: path.basename(k), k }));
    if (!items.length) { vscode.window.showInformationMessage('No active Typst watchers.'); return; }
    vscode.window.showQuickPick(items).then(sel => sel && this.map.get(sel.k)!.log.show(true));
  }

  private bump(uri: vscode.Uri) {
    this.decoEmitter.fire(uri);
  }

  disposeAll() {
    for (const [k, it] of this.map.entries()) {
      try { it.proc.kill(); } catch {}
      it.log.dispose();
      this.map.delete(k);
    }
  }
}

class DecorationProvider implements vscode.FileDecorationProvider {
    private wm: WatchManager;
    public readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri>;
  
    constructor(wm: WatchManager) {
      this.wm = wm;
      this.onDidChangeFileDecorations = wm.onDidChangeFileDecorations;
    }
  
    provideFileDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
        if (path.extname(uri.fsPath) !== '.typ') return;
       const st = this.wm.getStatus(uri);
        if (st === 'idle') return;
      
        const badge = st === 'ok' ? '🟢' : st === 'error' ? '🔴' : '🟡';
      
        const dec = new vscode.FileDecoration(badge);
        // No need for color since emojis have inherent colors
        dec.tooltip =
          st === 'ok' ? 'Typst: watching (last build OK)'
          : st === 'error' ? 'Typst: watching (last build failed)'
          : 'Typst: starting…';
        dec.propagate = true;
        return dec;
      }
      
  }
  

export function activate(ctx: vscode.ExtensionContext) {
  const wm = new WatchManager(ctx);
  const dec = new DecorationProvider(wm);
  ctx.subscriptions.push(
    vscode.window.registerFileDecorationProvider(dec),
    vscode.commands.registerCommand('typst.toggleWatch', (uri?: vscode.Uri) => wm.toggle(uri)),
    vscode.commands.registerCommand('typst.showLog', (uri?: vscode.Uri) => wm.showLog(uri)),
    { dispose: () => wm.disposeAll() }
  );
}



export function deactivate() {}