import './workbench.css';

const tools = [
  [
    ['restart', 'Restart', 'M3 6a5 5 0 1 1 0 4M3 2v4h4'],
    ['stop', 'Stop', 'M3 3h10v10H3z'],
    ['continue', 'Continue', 'M4 2l10 6-10 6z'],
    ['pause', 'Pause', 'M5 3v10m6-10v10'],
  ],
  [
    [
      'showExecutionPoint',
      'Show Execution Point',
      'M8 2v3m0 6v3M2 8h3m6 0h3m-2 0a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    ],
    ['next', 'Step Over', 'M2 8a6 6 0 0 1 12 0m-3-1 3 2 1-3M6 12h4'],
    ['stepIn', 'Step Into', 'M8 2v9M4 7l4 4 4-4M5 14h6'],
    ['stepOut', 'Step Out', 'M8 14V5M4 9l4-4 4 4M5 2h6'],
  ],
  [
    [
      'viewBreakpoints',
      'View Breakpoints',
      'M12 6a4.5 4.5 0 1 1-9 0 4.5 4.5 0 1 1 9 0m.5.5A4.5 4.5 0 0 1 8.5 15',
    ],
    ['muteBreakpoints', 'Mute Breakpoints', 'M13 8A5 5 0 1 1 3 8a5 5 0 1 1 10 0M2 14 14 2'],
  ],
  [['more', 'More Actions', 'M8 3h.01M8 8h.01M8 13h.01']],
];
const shortcuts = { continue: 'F9', next: 'F8', stepIn: 'F7', stepOut: 'Shift+F8' };
const appleKeyboard = navigator.platform.startsWith('Mac');
shortcuts.stop = appleKeyboard ? 'Cmd+F2' : 'Ctrl+F2';
shortcuts.viewBreakpoints = appleKeyboard ? 'Cmd+Shift+F8' : 'Ctrl+Shift+F8';

const $ = id => document.getElementById(id);
const make = (tag, text, cls) => {
  const el = document.createElement(tag);
  if (text !== undefined) {
    el.textContent = text;
  }
  if (cls) {
    el.className = cls;
  }
  return el;
};

function toolbarTooltip() {
  const popup = make('div', undefined, 'debug-tooltip');
  popup.id = 'debug-toolbar-tooltip';
  popup.setAttribute('role', 'tooltip');
  popup.hidden = true;
  document.body.append(popup);
  let anchor;

  function hide() {
    anchor?.firstElementChild.removeAttribute('aria-describedby');
    anchor = undefined;
    popup.hidden = true;
  }

  function refresh() {
    if (!anchor) return;
    if (!anchor.getClientRects().length) {
      hide();
      return;
    }
    if (popup.textContent !== anchor.dataset.tooltip) {
      popup.textContent = anchor.dataset.tooltip;
    }
    const rect = anchor.getBoundingClientRect();
    const gap = 6;
    const { width, height } = popup.getBoundingClientRect();
    const left = Math.min(rect.left, window.innerWidth - width - gap);
    const top =
      rect.bottom + gap + height <= window.innerHeight
        ? rect.bottom + gap
        : rect.top - gap - height;
    popup.style.left = Math.max(gap, left) + 'px';
    popup.style.top = Math.max(0, top) + 'px';
  }

  function wrap(button, label) {
    const target = make('span', undefined, 'debug-tip-anchor');
    target.dataset.tooltip = label;
    button.replaceWith(target);
    target.append(button);
    function show() {
      hide();
      anchor = target;
      popup.hidden = false;
      button.setAttribute('aria-describedby', popup.id);
      refresh();
    }
    function leave() {
      if (anchor === target) hide();
    }
    target.addEventListener('pointerenter', event => {
      if (event.pointerType !== 'touch') show();
    });
    target.addEventListener('pointerleave', leave);
    target.addEventListener('pointerdown', leave);
    button.addEventListener('focus', () => {
      if (button.matches(':focus-visible')) show();
    });
    button.addEventListener('blur', leave);
    return target;
  }

  window.addEventListener('resize', refresh);
  window.addEventListener('blur', hide);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') hide();
  });
  return { wrap, refresh };
}

export function mountWorkbench(vscode, outputVisibility, executionCommand) {
  const debuggerView = $('debugger');
  const drawer = $('debug-drawer');
  const controls = $('execution-controls');
  controls.innerHTML = `
    <div class="debug-toolbar">
      <div id="debug-tools" role="toolbar" aria-label="RunHop session controls"></div>
      <button id="debug-breakpoint-summary" class="debug-secondary" type="button" hidden></button>
      <span id="debug-phase" role="status"></span>
      <span id="debug-reason"></span>
    </div>
    <div id="debug-more-menu" aria-label="More Actions" hidden></div>
  `;
  debuggerView.innerHTML = `
    <div id="debug-error" role="alert" hidden></div>
    <div id="debug-inspect">
      <section class="debug-pane" aria-label="Threads and frames">
        <h3>Threads &amp; Frames</h3>
        <div id="debug-threads" class="debug-tree"></div>
      </section>
      <div id="debug-divider" class="debug-divider" role="separator" aria-orientation="vertical" aria-label="Resize threads and variables" tabindex="0"></div>
      <section class="debug-pane" aria-label="Variables and watches">
        <nav class="debug-tabs" aria-label="Inspect">
          <button data-inspect="variables" type="button">Variables</button>
          <button data-inspect="watches" type="button">Watches</button>
        </nav>
        <div id="debug-variables" class="debug-tree"></div>
      </section>
    </div>
    <div id="debug-height" class="debug-divider" role="separator" aria-orientation="horizontal" aria-label="Resize debugger and output" tabindex="0"></div>
  `;
  drawer.innerHTML = `
    <nav class="debug-tabs" aria-label="Debug output">
      <button data-output="console" type="button">Debug Console</button>
      <button data-output="output" type="button">Program Output</button>
      <span class="debug-spacer"></span>
      <button id="debug-copy" type="button">Copy Output</button>
      <button id="debug-clear" type="button">Clear</button>
    </nav>
    <div id="debug-console" hidden>
      <div id="debug-console-history" role="log" aria-label="Console results" tabindex="0"></div>
      <form id="debug-console-form">
        <textarea id="debug-console-input" aria-label="Python expression" rows="1" placeholder="Evaluate in the selected paused frame"></textarea>
        <button id="debug-eval" type="submit">Evaluate</button>
      </form>
    </div>
  `;

  let state;
  let debugState;
  let menuKey;
  let execution;
  let inspect = 'variables';
  let selectedOutput = 'output';
  let historyPosition;
  const saved = vscode.getState() || {};
  const input = $('debug-console-input');
  const history = $('debug-console-history');
  const dispatch = (action, fields = {}) => {
    if (state) {
      vscode.postMessage({ type: 'debugger', intent: { session: state.id, action, ...fields } });
    }
  };

  const button = (text, action, fields = {}, cls = '') => {
    const el = make('button', text, cls);
    el.type = 'button';
    el.addEventListener('click', () => dispatch(action, fields));
    return el;
  };

  const more = $('debug-more-menu');
  const toolbar = new Map();
  const tooltip = toolbarTooltip();
  const quickTooltip = tooltip.wrap($('debug-breakpoint-summary'), '');
  const hint = (action, label) =>
    shortcuts[action] ? label + ' (' + shortcuts[action] + ')' : label;
  for (const group of tools) {
    const groupEl = make('div', undefined, 'debug-tool-group');
    for (const [action, label, outline] of group) {
      const el = make('button', '', 'debug-icon');
      el.type = 'button';
      el.dataset.action = action;
      el.setAttribute('aria-label', label);
      el.addEventListener('click', () => useTool(action));
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 16 16');
      const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      shape.setAttribute('d', outline);
      shape.setAttribute('fill', ['continue', 'stop'].includes(action) ? 'currentColor' : 'none');
      shape.setAttribute('stroke', 'currentColor');
      shape.setAttribute('stroke-width', '1.4');
      shape.setAttribute('stroke-linejoin', 'round');
      shape.setAttribute('stroke-linecap', 'round');
      svg.append(shape);
      el.append(svg);
      groupEl.append(tooltip.wrap(el, hint(action, label)));
      toolbar.set(action, el);
    }
    $('debug-tools').append(groupEl);
  }
  toolbar.get('more').setAttribute('aria-expanded', 'false');
  toolbar.get('more').setAttribute('aria-controls', 'debug-more-menu');

  function menu(open) {
    more.hidden = !open;
    if (open) {
      menuKey = undefined;
      renderMenu();
    }
    toolbar.get('more').setAttribute('aria-expanded', String(open));
    if (open) more.querySelector('button:enabled')?.focus();
  }

  function useTool(action) {
    if (action === 'restart' || action === 'stop') {
      executionCommand(
        action === 'restart' ? 'rerunSession' : 'stopSession',
        execution?.id,
        execution?.executionId
      );
    } else if (action === 'viewBreakpoints') {
      vscode.postMessage({ type: 'breakpoints', action: 'open' });
    } else if (action === 'more') {
      menu(more.hidden);
    } else {
      dispatch(action);
    }
  }

  function moreButton(label, action, disabled = false) {
    const el = make('button', label);
    el.type = 'button';
    el.disabled = disabled;
    el.addEventListener('click', () => {
      menu(false);
      action();
    });
    return el;
  }

  function renderToolbar() {
    const debugging = Boolean(execution?.debug);
    controls.hidden = !execution?.executable;
    $('debug-phase').textContent = execution?.status ?? '';
    $('debug-phase').dataset.phase = state?.phase ?? '';
    $('debug-reason').textContent = execution?.activity || state?.reason || '';
    $('debug-reason').title = execution?.activity || execution?.detail || state?.reason || '';
    toolbar.get('restart').setAttribute('aria-label', debugging ? 'Restart' : 'Rerun');
    toolbar.get('restart').parentElement.dataset.tooltip = debugging ? 'Restart' : 'Rerun';
    toolbar.get('restart').disabled = !execution?.canRerun;
    toolbar.get('stop').parentElement.dataset.tooltip = debugging ? hint('stop', 'Stop') : 'Stop';
    toolbar.get('stop').disabled = !execution?.canStop;
    const blocked =
      !state || state.busy || state.ended || ['Starting', 'Stopping'].includes(state.phase);
    for (const action of [
      'continue',
      'pause',
      'showExecutionPoint',
      'next',
      'stepIn',
      'stepOut',
      'viewBreakpoints',
      'muteBreakpoints',
    ]) {
      toolbar.get(action).hidden = !debugging;
    }
    for (const action of ['continue', 'next', 'stepIn', 'stepOut']) {
      toolbar.get(action).disabled = blocked || !state?.canStep;
    }
    toolbar.get('pause').disabled = blocked || state?.phase !== 'Running';
    toolbar.get('showExecutionPoint').disabled = blocked || !state?.canShowPoint;
    $('debug-breakpoint-summary').hidden = !debugging;
    const mute = toolbar.get('muteBreakpoints');
    mute.disabled = blocked || !state?.canMute || state?.mutePending;
    mute.parentElement.dataset.tooltip = state?.muted
      ? 'Unmute Breakpoints for this session'
      : 'Mute Breakpoints for this session';
    mute.setAttribute('aria-pressed', String(Boolean(state?.muted)));
    mute.setAttribute('aria-label', state?.muted ? 'Unmute Breakpoints' : 'Mute Breakpoints');
    toolbar.get('more').hidden = !execution?.canEdit && !debugging;
    if (!more.hidden) renderMenu();
    tooltip.refresh();
  }

  function renderMenu() {
    const key = JSON.stringify([
      execution?.id,
      execution?.canEdit,
      state?.id,
      state?.canSmartStep,
      state?.busy,
      input.disabled,
    ]);
    if (menuKey === key) return;
    menuKey = key;
    const actions = [];
    if (state) {
      actions.push(
        moreButton(
          'Evaluate Expression',
          () => {
            selectedOutput = 'console';
            renderOutput();
            input.focus();
          },
          input.disabled
        )
      );
      if (state.canSmartStep) {
        actions.push(moreButton('Smart Step Into', () => dispatch('smartStepInto'), state.busy));
      }
      actions.push(
        moreButton('Reset Panel Layout', () => {
          resetWidth();
          resetHeight();
        })
      );
    }
    if (execution?.canEdit) {
      actions.push(
        moreButton('Modify Run Configuration', () =>
          executionCommand('editConfiguration', execution.id)
        )
      );
    }
    more.replaceChildren(...actions);
  }

  document.addEventListener('pointerdown', event => {
    if (
      !more.hidden &&
      !more.contains(event.target) &&
      !toolbar.get('more').contains(event.target)
    ) {
      menu(false);
    }
  });
  controls.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !more.hidden) {
      menu(false);
      toolbar.get('more').focus();
    }
  });

  function line(text, cls = '') {
    return make('div', text, ('debug-line ' + cls).trim());
  }

  function renderThreads() {
    const root = $('debug-threads');
    const scroll = root.scrollTop;
    const rows = [];
    for (const thread of state.threads) {
      const row = button(
        (thread.open ? '▾ ' : '▸ ') + thread.name,
        'thread',
        { thread: thread.id },
        'debug-row thread'
      );
      row.setAttribute('aria-expanded', Boolean(thread.open));
      row.disabled = !thread.paused;
      row.title = thread.paused ? thread.name : 'Running thread';
      rows.push(row);
      if (!thread.open) {
        continue;
      }
      for (const frame of thread.frames || []) {
        const frameRow = button(
          '',
          'frame',
          { thread: thread.id, frame: frame.id },
          'debug-row frame'
        );
        frameRow.setAttribute('aria-label', 'Select frame ' + frame.name + ' ' + frame.location);
        frameRow.setAttribute(
          'aria-current',
          frame.id === state.frame && thread.id === state.thread
        );
        frameRow.append(make('span', frame.name), make('span', frame.location, 'muted'));
        rows.push(frameRow);
      }
      if (thread.error) {
        rows.push(line(thread.error, 'error indent'));
      } else if (!thread.frames) {
        rows.push(line('Loading frames…', 'muted indent'));
      } else if (thread.frames.length < Math.min(thread.total ?? 0, 200)) {
        rows.push(
          button('Load more frames', 'framesMore', { thread: thread.id }, 'debug-row frame muted')
        );
      }
    }
    root.replaceChildren(
      ...(rows.length ? rows : [line('Threads appear when the program pauses.', 'muted')])
    );
    root.scrollTop = scroll;
  }

  function variablesRows(nodes, rows, depth = 0) {
    for (const node of nodes) {
      const wrapper = make('div', undefined, 'debug-variable');
      wrapper.style.setProperty('--depth', String(Math.min(depth, 14)));
      const row = node.variablesReference
        ? button('', 'variable', { node: node.id }, 'debug-row variable')
        : make('div', undefined, 'debug-row variable');
      if (node.variablesReference) {
        row.setAttribute('aria-expanded', Boolean(node.open));
        row.setAttribute('aria-label', (node.open ? 'Collapse ' : 'Expand ') + node.name);
      }
      row.title = [node.name, node.type, node.metadata, node.value].filter(Boolean).join(' · ');
      row.append(
        make('span', node.variablesReference ? (node.open ? '▾' : '▸') : ''),
        make('span', node.name, 'variable-name'),
        make('span', node.type || '', 'variable-type muted'),
        make('span', node.metadata || node.value || '', 'variable-value')
      );
      wrapper.append(row);
      if (state.preview && node.evaluateName && !node.scope) {
        const preview = button('Preview', 'preview', { node: node.id }, 'debug-secondary preview');
        preview.title = 'Preview this variable in a separate editor';
        wrapper.append(preview);
      }
      rows.push(wrapper);
      if (node.open) {
        variablesRows(node.children || [], rows, depth + 1);
        if (node.more) {
          rows.push(
            button(
              'Load more variables',
              'variablesMore',
              { node: node.id },
              'debug-row frame muted'
            )
          );
        }
        if (node.loading || node.error || node.limited) {
          rows.push(
            line(
              node.error || (node.loading ? 'Loading…' : 'Showing a limited set of children.'),
              node.error ? 'error indent' : 'muted indent'
            )
          );
        }
      }
    }
  }

  function renderInspector() {
    const root = $('debug-variables');
    const scroll = root.scrollTop;
    const rows = [];
    if (inspect === 'variables') {
      variablesRows(state.variables, rows);
      if (!rows.length) {
        rows.push(
          line(
            state.scopesLoading
              ? 'Loading scopes…'
              : state.frame !== undefined
                ? 'The adapter did not report any scopes for this frame.'
                : 'Select a paused frame to inspect variables.',
            'muted'
          )
        );
      }
    } else if (inspect === 'watches') {
      rows.push(button('Add Watch', 'addWatch', {}, 'debug-secondary'));
      for (const watch of state.watches) {
        const row = make('div', undefined, 'debug-list-item');
        row.append(
          make('code', watch.expression),
          make('span', watch.value ?? (watch.auto ? 'On pause' : 'Manual evaluation'), 'muted')
        );
        const evaluate = button('Evaluate', 'evaluateWatch', { id: watch.id }, 'debug-secondary');
        evaluate.disabled = state.frame === undefined;
        row.append(
          evaluate,
          button('Edit', 'editWatch', { id: watch.id }, 'debug-secondary'),
          button('Remove', 'removeWatch', { id: watch.id }, 'debug-secondary')
        );
        rows.push(row);
      }
    }
    root.replaceChildren(...rows);
    root.scrollTop = scroll;
  }

  function renderOutput() {
    const activeOutput = state ? selectedOutput : 'output';
    const consoleSelected = activeOutput === 'console';
    drawer.hidden = !execution?.executable;
    drawer.querySelector('[data-output="console"]').hidden = !state;
    $('debug-copy').textContent = consoleSelected ? 'Copy Results' : 'Copy Output';
    $('debug-console').hidden = !consoleSelected;
    drawer.classList.toggle('console-selected', consoleSelected);
    outputVisibility(!state || !consoleSelected);
    for (const el of drawer.querySelectorAll('[data-output]')) {
      el.setAttribute('aria-pressed', String(el.dataset.output === activeOutput));
    }
    if (state && consoleSelected) {
      history.replaceChildren(
        ...state.console.map(entry =>
          make('pre', (entry.kind === 'input' ? '>>> ' : '') + entry.text, entry.kind)
        )
      );
      history.scrollTop = history.scrollHeight;
    }
  }

  for (const el of debuggerView.querySelectorAll('[data-inspect]')) {
    el.addEventListener('click', () => {
      inspect = el.dataset.inspect;
      updateInspector();
    });
  }
  function updateInspector() {
    for (const el of debuggerView.querySelectorAll('[data-inspect]')) {
      el.setAttribute('aria-pressed', String(el.dataset.inspect === inspect));
    }
    renderInspector();
  }
  for (const el of drawer.querySelectorAll('[data-output]')) {
    el.addEventListener('click', () => {
      selectedOutput = el.dataset.output;
      renderOutput();
      if (selectedOutput === 'console' && !input.disabled) {
        input.focus();
      }
    });
  }
  $('debug-copy').addEventListener('click', () => {
    if (state) dispatch(selectedOutput === 'console' ? 'copyConsole' : 'copyOutput');
    else executionCommand('copyRunOutput', execution?.id);
  });
  $('debug-clear').addEventListener('click', () => {
    if (state) dispatch(selectedOutput === 'console' ? 'clearConsole' : 'clearOutput');
    else executionCommand('clearRunOutput', execution?.id);
  });
  $('debug-console-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!input.disabled && input.value.trim()) {
      dispatch('evaluate', { input: input.value });
      input.value = '';
      historyPosition = undefined;
    }
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      $('debug-console-form').requestSubmit();
    } else if (
      (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
      !input.value.includes('\n') &&
      state?.history.length
    ) {
      event.preventDefault();
      const amount = event.key === 'ArrowUp' ? -1 : 1;
      historyPosition = Math.min(
        state.history.length,
        Math.max(0, (historyPosition ?? state.history.length) + amount)
      );
      input.value = state.history[historyPosition] ?? '';
    }
  });

  function separator(id, parent, property, key, min, max, fallback, horizontal) {
    const divider = $(id);
    let size = saved[key] ?? fallback;
    const apply = value => {
      size = Math.min(max, Math.max(min, value));
      (horizontal ? debuggerView : document.body).style.setProperty(
        property,
        horizontal ? size + '%' : String(size)
      );
      saved[key] = size;
      vscode.setState(saved);
      divider.setAttribute('aria-valuenow', String(size));
    };
    apply(size);
    divider.addEventListener('pointerdown', event => divider.setPointerCapture(event.pointerId));
    divider.addEventListener('pointermove', event => {
      if (!divider.hasPointerCapture(event.pointerId)) {
        return;
      }
      const rect = parent.getBoundingClientRect();
      const inspectorTop = debuggerView.getBoundingClientRect().top;
      apply(
        Math.round(
          (horizontal
            ? (event.clientX - rect.left) / rect.width
            : (event.clientY - inspectorTop) / Math.max(1, rect.bottom - inspectorTop)) * 100
        )
      );
    });
    divider.addEventListener('keydown', event => {
      const keys = horizontal ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
      if (keys.includes(event.key)) {
        event.preventDefault();
        apply(size + (event.key === keys[0] ? -3 : 3));
      }
    });
    return () => apply(fallback);
  }
  const resetWidth = separator(
    'debug-divider',
    $('debug-inspect'),
    '--debug-left',
    'split',
    22,
    75,
    39,
    true
  );
  const resetHeight = separator(
    'debug-height',
    document.body,
    '--debug-top',
    'height',
    36,
    78,
    59,
    false
  );

  function updateState() {
    const next = execution?.debug === debugState?.id ? debugState : undefined;
    if (state?.id !== next?.id) {
      historyPosition = undefined;
      input.value = '';
      if (!more.hidden) menu(false);
    }
    state = next;
    debuggerView.hidden = !state;
    if (state) {
      const issue = $('debug-error');
      issue.hidden = !state.error;
      issue.textContent = state.error || '';
      input.disabled = state.frame === undefined;
      $('debug-eval').disabled = input.disabled;
      renderThreads();
      updateInspector();
    }
    renderToolbar();
    renderOutput();
  }

  function updateDebugger(next) {
    debugState = next;
    updateState();
  }

  function updateExecution(next) {
    if (execution?.id !== next?.id && !more.hidden) menu(false);
    execution = next;
    updateState();
  }

  $('debug-breakpoint-summary').addEventListener('click', () => {
    vscode.postMessage({ type: 'breakpoints', action: 'quick' });
  });

  function updateBreakpoints(summary) {
    const quick = $('debug-breakpoint-summary');
    quick.textContent = 'Breakpoints ' + summary.total;
    quickTooltip.dataset.tooltip =
      summary.enabled +
      ' enabled / ' +
      summary.total +
      ' total' +
      (summary.muted ? ' · muted in this session' : '') +
      ' · Quick Breakpoints';
    quick.setAttribute('aria-label', 'Quick Breakpoints, ' + summary.total + ' total');
    tooltip.refresh();
  }
  updateBreakpoints({ total: 0, enabled: 0, muted: false });

  return { updateDebugger, updateExecution, updateBreakpoints };
}
