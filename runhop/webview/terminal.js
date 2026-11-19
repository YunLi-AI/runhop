import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './terminal.css';
import { mountWorkbench } from './workbench';

const vscode = acquireVsCodeApi();
const container = document.getElementById('terminal');
const empty = document.getElementById('empty');
const sessionBar = document.getElementById('execution-bar');
const tabs = document.getElementById('execution-tabs');
const fit = new FitAddon();
let active;
let terminal;
let outputAllowed = true;
let sessionKey;

function command(type, id, executionId) {
  vscode.postMessage({ type, id, executionId });
}

document.getElementById('execution-new').addEventListener('click', () => command('newSession'));

tabs.addEventListener('keydown', event => {
  const items = [...tabs.querySelectorAll('[role="tab"]')];
  const index = items.indexOf(event.target);
  if (index < 0) return;
  const target = {
    ArrowRight: (index + 1) % items.length,
    ArrowLeft: (index + items.length - 1) % items.length,
    Home: 0,
    End: items.length - 1,
  }[event.key];
  if (target !== undefined) {
    event.preventDefault();
    items[target].focus();
    items[target].click();
  }
});

function renderSessions(sessions, current) {
  const key = JSON.stringify([sessions, current?.id]);
  if (key === sessionKey) return;
  sessionKey = key;
  const focused = tabs.contains(document.activeElement)
    ? document.activeElement.dataset.id
    : undefined;
  const scroll = tabs.scrollLeft;
  tabs.replaceChildren(
    ...sessions.map(session => {
      const item = document.createElement('div');
      item.className = 'execution-tab';
      const selected = session.id === current?.id;
      item.dataset.selected = selected;
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', selected);
      tab.tabIndex = selected ? 0 : -1;
      tab.dataset.id = session.id;
      tab.dataset.phase = session.phase;
      tab.title = session.detail ? session.name + ' · ' + session.detail : session.name;
      const name = document.createElement('span');
      name.className = 'execution-name';
      name.textContent = session.name;
      const status = document.createElement('span');
      status.className = 'execution-phase';
      status.textContent = ' · ' + session.status;
      tab.append(name, status);
      tab.addEventListener('click', () => command('selectSession', session.id));
      item.append(tab);
      if (session.canClose) {
        const close = document.createElement('button');
        close.type = 'button';
        close.textContent = '×';
        close.className = 'execution-tab-close';
        const label =
          session.name.startsWith('Run · ') || session.name.startsWith('Debug · ')
            ? 'Close finished session'
            : 'Close terminal session';
        close.title = label;
        close.setAttribute('aria-label', label + ' · ' + session.name);
        close.dataset.id = session.id + '-close';
        close.addEventListener('click', () =>
          command('closeSession', session.id, session.executionId)
        );
        item.append(close);
      }
      return item;
    })
  );
  tabs.scrollLeft = scroll;
  if (focused) {
    [...tabs.querySelectorAll('button')].find(item => item.dataset.id === focused)?.focus();
  }
  tabs
    .querySelector('[aria-selected="true"]')
    ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

for (const button of empty.querySelectorAll('button[data-action]')) {
  button.addEventListener('click', () =>
    vscode.postMessage({ type: 'start', action: button.dataset.action })
  );
}

function themeColor(token, fallback) {
  return (
    getComputedStyle(document.body)
      .getPropertyValue('--vscode-' + token)
      .trim() || fallback
  );
}

function theme() {
  return {
    background: themeColor('terminal-background', themeColor('panel-background', '#1e1e1e')),
    foreground: themeColor('terminal-foreground', themeColor('foreground', '#ddd')),
    cursor: themeColor('terminalCursor-foreground', themeColor('foreground', '#ddd')),
    selectionBackground: themeColor('terminal-selectionBackground', '#406690'),
  };
}

function resize() {
  if (!terminal || container.hidden || container.clientHeight < 16 || container.clientWidth < 25) {
    return;
  }
  fit.fit();
  if (active?.writable) {
    vscode.postMessage({ type: 'resize', id: active.id, cols: terminal.cols, rows: terminal.rows });
  }
}

function ensureTerminal() {
  if (!terminal) {
    terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      disableStdin: true,
      scrollback: 3000,
      fontFamily: themeColor('editor-font-family', 'monospace'),
      fontSize: Number.parseFloat(themeColor('editor-font-size', '13')) || 13,
      theme: theme(),
      linkHandler: { activate() {}, allowNonHttpProtocols: false },
    });
    terminal.loadAddon(fit);
    terminal.open(container);
    terminal.onData(data => {
      if (active?.writable) {
        vscode.postMessage({ type: 'input', id: active.id, data });
      }
    });
    new ResizeObserver(resize).observe(container);
    new MutationObserver(() => {
      terminal.options.theme = theme();
    }).observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
  }
}

const workbench = mountWorkbench(
  vscode,
  allowed => {
    outputAllowed = allowed;
    container.hidden = !active || !allowed;
    if (allowed) {
      resize();
    }
  },
  command
);

window.addEventListener('message', ({ data: message }) => {
  if (message.type === 'breakpointSummary') {
    workbench.updateBreakpoints(message.summary);
    return;
  }
  if (message.type === 'sessions') {
    const current = message.active;
    sessionBar.hidden = !current;
    renderSessions(message.sessions, current);
    workbench.updateExecution(current);
    return;
  }
  if (message.type === 'debugger') {
    workbench.updateDebugger(message.state);
    return;
  }
  if (
    message.type === 'data' &&
    active?.id === message.id &&
    active.executionId === message.executionId
  ) {
    terminal.write(message.data);
    return;
  }
  if (message.type !== 'state') {
    return;
  }
  active = message.active;
  empty.hidden = Boolean(active);
  container.hidden = !active || !outputAllowed;
  if (!active) {
    return;
  }
  ensureTerminal();
  terminal.options.disableStdin = !active.writable;
  resize();
  if (typeof active.history === 'string') {
    terminal.write('\x1bc' + active.history);
  }
  if (message.focus && active.writable) {
    terminal.focus();
  }
});
vscode.postMessage({ type: 'ready' });
