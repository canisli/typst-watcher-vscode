"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const node_child_process_1 = require("node:child_process");
const path = __importStar(require("node:path"));
const fs = __importStar(require("node:fs"));
class WatchItem {
    proc;
    log;
    status = 'starting';
    lastErrorAt = 0;
    constructor(proc, log) {
        this.proc = proc;
        this.log = log;
    }
}
class WatchManager {
    ctx;
    map = new Map(); // key: file fsPath
    decoEmitter = new vscode.EventEmitter();
    onDidChangeFileDecorations = this.decoEmitter.event;
    statusBarItem;
    constructor(ctx) {
        this.ctx = ctx;
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBarItem.command = 'typst.toggleWatch';
        ctx.subscriptions.push(this.statusBarItem);
        // Update status bar when active editor changes
        vscode.window.onDidChangeActiveTextEditor(this.updateStatusBar.bind(this));
        this.updateStatusBar();
    }
    isWatching(uri) {
        return this.map.has(uri.fsPath);
    }
    getStatus(uri) {
        return this.map.get(uri.fsPath)?.status ?? 'idle';
    }
    async toggle(uri) {
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
    updateStatusBar() {
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
        }
        else {
            this.statusBarItem.text = '⚪ Typst Auto';
            this.statusBarItem.tooltip = 'Typst autocompile is OFF. Click to start.';
        }
        this.statusBarItem.show();
    }
    cfg() {
        const cfg = vscode.workspace.getConfiguration('typstAutowatch');
        return {
            typstPath: cfg.get('typstPath', 'typst'),
            outputDir: cfg.get('outputDir', '^pdfs'),
            extraArgs: cfg.get('extraArgs', [])
        };
    }
    ensureOutputDir(workspaceFolder, outDir) {
        if (!workspaceFolder)
            return;
        const p = path.join(workspaceFolder.uri.fsPath, outDir);
        if (!fs.existsSync(p))
            fs.mkdirSync(p, { recursive: true });
    }
    async start(uri) {
        const ws = vscode.workspace.getWorkspaceFolder(uri);
        const { typstPath, outputDir, extraArgs } = this.cfg();
        // rootdir is the workspace folder if present, otherwise the file's folder
        const rootdir = ws ? ws.uri.fsPath : path.dirname(uri.fsPath);
        // Check if we're in the typst/ folder
        const isTypstFolder = rootdir.includes('/typst/') || rootdir.endsWith('/typst');
        let cmd;
        let args;
        let cwd;
        if (isTypstFolder) {
            // Use standard typst watch for typst/ folder
            // Ensure ^pdfs (or whatever you set) exists under root
            const pdfDirAbs = path.join(rootdir, outputDir);
            if (!fs.existsSync(pdfDirAbs))
                fs.mkdirSync(pdfDirAbs, { recursive: true });
            const name = path.basename(uri.fsPath, '.typ'); // $name
            const fnRel = path.relative(rootdir, uri.fsPath); // $fn (relative to root)
            const outRel = path.join(outputDir, `${name}.pdf`); // $rootdir/^pdfs/$name.pdf (relative)
            cmd = typstPath;
            args = ['watch', fnRel, outRel, '--root', rootdir, ...extraArgs];
            cwd = rootdir;
        }
        else {
            // Use custom watch.sh script for other folders
            const filename = path.basename(uri.fsPath);
            cmd = '/Users/canis/dev/01_learning/new notes/watch.sh';
            args = [filename];
            cwd = path.dirname(uri.fsPath);
        }
        const log = vscode.window.createOutputChannel(`Typst: ${path.basename(uri.fsPath)}`);
        log.appendLine(`$ ${cmd} ${args.join(' ')}`);
        const proc = (0, node_child_process_1.spawn)(cmd, args, { cwd, shell: process.platform === 'win32' });
        const item = new WatchItem(proc, log);
        this.map.set(uri.fsPath, item);
        this.bump(uri);
        proc.stdout.on('data', (d) => {
            const s = d.toString();
            log.append(s);
            // Parse each line to get the latest status
            const lines = s.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed)
                    continue;
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
        proc.stderr.on('data', (d) => {
            const s = d.toString();
            log.append(s);
            // Parse each line to check for status messages (typst outputs to stderr)
            const lines = s.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed)
                    continue;
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
    stop(uri) {
        const it = this.map.get(uri.fsPath);
        if (!it)
            return;
        try {
            it.proc.kill();
        }
        catch { }
        it.log.appendLine('\n[watcher stopped]');
        it.log.dispose();
        this.map.delete(uri.fsPath);
        this.bump(uri);
        this.updateStatusBar();
        vscode.window.setStatusBarMessage(`Typst watch stopped: ${path.basename(uri.fsPath)}`, 2000);
    }
    showLog(uri) {
        if (uri && this.map.get(uri.fsPath)) {
            this.map.get(uri.fsPath).log.show(true);
            return;
        }
        // If no URI, show a quick pick of all logs
        const items = [...this.map.keys()].map(k => ({ label: path.basename(k), k }));
        if (!items.length) {
            vscode.window.showInformationMessage('No active Typst watchers.');
            return;
        }
        vscode.window.showQuickPick(items).then(sel => sel && this.map.get(sel.k).log.show(true));
    }
    bump(uri) {
        this.decoEmitter.fire(uri);
    }
    disposeAll() {
        for (const [k, it] of this.map.entries()) {
            try {
                it.proc.kill();
            }
            catch { }
            it.log.dispose();
            this.map.delete(k);
        }
    }
}
class DecorationProvider {
    wm;
    onDidChangeFileDecorations;
    constructor(wm) {
        this.wm = wm;
        this.onDidChangeFileDecorations = wm.onDidChangeFileDecorations;
    }
    provideFileDecoration(uri) {
        if (path.extname(uri.fsPath) !== '.typ')
            return;
        const st = this.wm.getStatus(uri);
        if (st === 'idle')
            return;
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
function activate(ctx) {
    const wm = new WatchManager(ctx);
    const dec = new DecorationProvider(wm);
    ctx.subscriptions.push(vscode.window.registerFileDecorationProvider(dec), vscode.commands.registerCommand('typst.toggleWatch', (uri) => wm.toggle(uri)), vscode.commands.registerCommand('typst.showLog', (uri) => wm.showLog(uri)), { dispose: () => wm.disposeAll() });
}
function deactivate() { }
//# sourceMappingURL=extension.js.map