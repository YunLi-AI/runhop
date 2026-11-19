import * as vscode from 'vscode';
import { debugType } from './launch';

interface SelectedVariable {
  sessionId?: string;
  session?: vscode.DebugSession;
  frameId?: number;
  variable?: { name: string; evaluateName?: string };
}

// Runs only on an explicit preview request, in the selected paused frame.
// Keep both the amount of remote work and the returned representation bounded.
const previewCode = [
  'def preview(obj):',
  '    import base64, io, json, reprlib, itertools',
  '    cls = type(obj)',
  '    module = cls.__module__',
  '    if any(c.__module__.startswith("PIL.") for c in cls.__mro__):',
  '        thumb = obj.copy()',
  '        thumb.thumbnail((448, 448))',
  '        data = io.BytesIO()',
  '        thumb.convert("RGB").save(data, format="JPEG", quality=80)',
  '        result = dict(image=base64.b64encode(data.getvalue()).decode("ascii"),',
  '                      summary=f"{obj.width} × {obj.height} · {obj.mode}")',
  '    elif module.startswith("pandas.") and hasattr(obj, "iloc"):',
  '        table = obj.iloc[:20, :12] if obj.ndim == 2 else obj.iloc[:20].to_frame()',
  '        result = dict(summary=str(obj.shape), columns=[reprlib.repr(c) for c in table.columns],',
  '                      rows=[[reprlib.repr(v) for v in row] for row in table.itertuples(index=False, name=None)])',
  '    elif module.startswith("numpy") and cls.__name__ == "ndarray" and obj.ndim in (1, 2):',
  '        table = obj[:20, :12] if obj.ndim == 2 else obj[:20].reshape(-1, 1)',
  '        result = dict(summary=f"{obj.shape} · {obj.dtype}", columns=list(range(table.shape[1])),',
  '                      rows=[[reprlib.repr(v) for v in row] for row in table])',
  '    elif isinstance(obj, dict):',
  '        result = dict(summary=f"{len(obj)} entries", columns=["Key", "Value"],',
  '                      rows=[[reprlib.repr(k), reprlib.repr(v)] for k, v in itertools.islice(obj.items(), 20)])',
  '    elif isinstance(obj, (list, tuple)):',
  '        result = dict(summary=f"{len(obj)} items", columns=["Index", "Value"],',
  '                      rows=[[i, reprlib.repr(v)] for i, v in enumerate(obj[:20])])',
  '    else:',
  '        result = dict(summary=module + "." + cls.__name__, text=reprlib.repr(obj))',
  '    return "RUNHOP:" + base64.b64encode(json.dumps(result, ensure_ascii=True).encode()).decode("ascii")',
].join('\n');

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderPreview(name: string, data: any): string {
  const cell = (value: unknown) => '<td>' + escapeHtml(value) + '</td>';
  let content = '<pre>' + escapeHtml(data.text ?? '') + '</pre>';
  if (typeof data.image === 'string' && /^[A-Za-z0-9+/=]+$/.test(data.image)) {
    content =
      '<img alt="Preview of ' +
      escapeHtml(name) +
      '" src="data:image/jpeg;base64,' +
      data.image +
      '">';
  } else if (Array.isArray(data.columns) && Array.isArray(data.rows)) {
    content =
      '<table><thead><tr>' +
      data.columns.map(v => '<th>' + escapeHtml(v) + '</th>').join('') +
      '</tr></thead><tbody>' +
      data.rows.map(row => '<tr>' + row.map(cell).join('') + '</tr>').join('') +
      '</tbody></table>';
  }
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">' +
    '<style>body{padding:24px;font-family:var(--vscode-font-family);color:var(--vscode-foreground)}' +
    'h1{font-size:1.25rem;margin:0}p{color:var(--vscode-descriptionForeground);margin:6px 0 18px}' +
    'img{display:block;max-width:100%;height:auto;border-radius:4px}table{border-collapse:collapse}' +
    'td,th{padding:7px 12px;text-align:left;border:1px solid var(--vscode-panel-border)}' +
    'th{background:var(--vscode-editorWidget-background)}pre,td{font-family:var(--vscode-editor-font-family)}' +
    'pre{white-space:pre-wrap}</style></head><body><h1>' +
    escapeHtml(name) +
    '</h1><p>' +
    escapeHtml(data.summary || '') +
    '</p>' +
    content +
    '</body></html>'
  );
}

export function registerPreview(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'runhop.preview',
      async ({ sessionId, session: selected, frameId, variable }: SelectedVariable = {}) => {
        const frame = vscode.debug.activeStackItem;
        const native = frame instanceof vscode.DebugStackFrame ? frame : undefined;
        const session = selected ?? native?.session;
        const requestedFrame = frameId ?? native?.frameId;
        if (
          session?.type !== debugType ||
          requestedFrame === undefined ||
          (sessionId && session.id !== sessionId) ||
          !variable?.evaluateName
        ) {
          void vscode.window.showInformationMessage(
            'RunHop: Select a variable in a paused RunHop session.'
          );
          return;
        }
        const name = variable.name;
        const expression =
          '(lambda ns, value: (__import__("builtins").exec(' +
          JSON.stringify(previewCode) +
          ', ns), ns["preview"](value))[1])({}, (' +
          variable.evaluateName +
          '))';
        try {
          const response = await session.customRequest('evaluate', {
            expression,
            frameId: requestedFrame,
            context: 'clipboard',
          });
          const result = /^['"]?RUNHOP:([A-Za-z0-9+/=]{1,600000})['"]?$/.exec(response.result);
          if (!result) {
            throw new Error('The server did not return a readable preview.');
          }
          const data = JSON.parse(Buffer.from(result[1], 'base64').toString('utf8'));
          const panel = vscode.window.createWebviewPanel(
            'runhop.preview',
            'Preview: ' + name,
            vscode.ViewColumn.Beside,
            { enableScripts: false }
          );
          panel.webview.html = renderPreview(name, data);
        } catch (error) {
          void vscode.window.showErrorMessage('RunHop: ' + (error.message || String(error)));
        }
      }
    )
  );
}
