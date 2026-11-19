import './breakpoints.css';

const vscode = acquireVsCodeApi();
const root = document.getElementById('breakpoint-manager');
root.innerHTML = `
  <header class="bp-toolbar">
    <h1>Breakpoints</h1>
    <button type="button" data-action="add" title="Add breakpoint at editor cursor (Alt+Insert)" aria-label="Add at Cursor">+</button>
    <button type="button" data-action="addFunction" title="Add a function breakpoint" aria-label="Add Function Breakpoint" hidden>ƒ+</button>
    <button type="button" data-action="remove" title="Remove selected breakpoint (Delete)" aria-label="Remove Breakpoint">−</button>
    <span class="bp-session"></span>
  </header>
  <div class="bp-layout">
    <nav class="bp-navigation" aria-label="Breakpoint list">
      <input type="search" aria-label="Filter breakpoints" placeholder="Filter…">
      <div class="bp-list" tabindex="-1"></div>
    </nav>
    <section class="bp-detail" aria-label="Breakpoint properties">
      <header class="bp-location">
        <h2></h2>
        <button type="button" data-action="source">Go to Source</button>
      </header>
      <p class="bp-status"></p>
      <p class="bp-warning" hidden></p>
      <form class="bp-form" hidden>
        <label class="bp-check"><input name="enabled" type="checkbox"> Enabled</label>
        <label>Condition <input name="condition" type="text" maxlength="6000" placeholder="Python expression, e.g. epoch &gt; 5"></label>
        <label>Hit Condition <input name="hitCondition" type="text" maxlength="6000" placeholder="e.g. 5 or &gt;= 5"></label>
        <label>On Hit
          <select name="mode">
            <option value="pause">Pause</option>
            <option value="log">Log and continue</option>
          </select>
        </label>
        <label class="bp-log" hidden>Log Message <input name="logMessage" type="text" maxlength="6000" placeholder="Use {expression} to include a value"></label>
        <div class="bp-actions">
          <button type="submit">Apply</button>
          <button type="reset">Reset</button>
        </div>
      </form>
      <button type="button" data-action="exceptions" hidden>Configure workspace filters in VS Code</button>
    </section>
  </div>
  <footer class="bp-footer">
    <span class="bp-notice" role="status" aria-live="polite"></span>
    <button type="button" data-action="undo" hidden>Undo Delete</button>
    <button type="button" data-action="close" title="Close (Esc)">Close</button>
  </footer>
  <div class="bp-menu" role="menu" aria-label="Breakpoint actions" hidden></div>
`;

const find = selector => root.querySelector(selector);
const list = find('.bp-list');
const filter = find('input[type="search"]');
const form = find('.bp-form');
const fields = form.elements;
const title = find('h2');
const status = find('.bp-status');
const warning = find('.bp-warning');
const notice = find('.bp-notice');
const source = find('[data-action="source"]');
const remove = find('[data-action="remove"]');
const exceptions = find('[data-action="exceptions"]');
const apply = form.querySelector('[type="submit"]');
const reset = form.querySelector('[type="reset"]');
const menu = find('.bp-menu');
const drafts = new Map();
const collapsed = new Set();
let selected;
let snapshot;
let previousSelection;
let menuAnchor;

const send = (action, id, input) =>
  vscode.postMessage({ action, id, input, sessionId: snapshot?.sessionId });
const row = () => snapshot?.rows.find(point => point.key === selected);
const properties = bp => ({
  enabled: bp.enabled,
  condition: bp.condition,
  hitCondition: bp.hitCondition,
  logMessage: bp.logMessage,
  mode: bp.logMessage ? 'log' : 'pause',
});
const read = () => ({
  enabled: fields.enabled.checked,
  condition: fields.condition.value,
  hitCondition: fields.hitCondition.value,
  logMessage: fields.logMessage.value,
  mode: fields.mode.value,
});
const submitted = values => ({
  ...values,
  condition: values.condition.trim(),
  hitCondition: values.hitCondition.trim(),
  logMessage: values.mode === 'log' ? values.logMessage : '',
});
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fileLabel = point => (point.kind === 'line' ? point.file + ':' + point.line : point.file);

function pointStatus(point) {
  if (!point.enabled) return 'Disabled';
  if (!point.supported) return 'Unsupported by this adapter';
  if (snapshot.muted) return 'Muted in this session';
  if (point.verified === true) return 'Verified';
  if (point.verified === false) return 'Unverified';
  return snapshot.session ? 'Pending verification' : 'Enabled';
}

function setDetail() {
  const point = row();
  const exception = snapshot.exceptions.find(item => 'exception:' + item.filter === selected);
  const showingExceptions = selected === 'exceptions' || Boolean(exception);
  form.hidden = !point;
  source.hidden = point?.kind !== 'line';
  remove.disabled = !point;
  exceptions.hidden = !showingExceptions;
  warning.hidden = true;
  if (point) {
    title.textContent = fileLabel(point);
    status.textContent = [
      point.enabled && point.verified !== undefined && !snapshot.muted
        ? 'Enabled · ' + pointStatus(point)
        : pointStatus(point),
      point.directory,
      point.resolvedLine && point.resolvedLine !== point.line
        ? 'Adapter line ' + point.resolvedLine
        : '',
      point.message,
    ]
      .filter(Boolean)
      .join(' · ');
    const draft = drafts.get(point.key);
    const values = draft?.value ?? properties(point);
    fields.enabled.checked = values.enabled;
    for (const key of ['condition', 'hitCondition', 'mode', 'logMessage']) {
      if (fields[key].value !== values[key]) fields[key].value = values[key];
    }
    fields.condition.disabled = snapshot.condition === false && !values.condition;
    fields.hitCondition.disabled = snapshot.hitCondition === false && !values.hitCondition;
    fields.mode.options[1].disabled = snapshot.logMessage === false && values.mode !== 'log';
    fields.logMessage.disabled = snapshot.logMessage === false;
    warning.hidden = !draft || draft.id === point.id;
    warning.textContent =
      'This breakpoint changed in VS Code. Reset to load its current properties.';
    syncForm();
  } else if (showingExceptions) {
    title.textContent = exception?.label ?? 'Python Exception Breakpoints';
    status.textContent = [
      exception?.description,
      exception?.enabled === undefined
        ? ''
        : exception.enabled
          ? snapshot.muted
            ? 'Muted in this session'
            : 'Enabled'
          : 'Disabled',
      snapshot.session
        ? snapshot.exceptionOverride
          ? 'Temporary session settings. A change in VS Code restores the workspace filters.'
          : 'Checkboxes apply to the selected RunHop session. VS Code stores workspace filters.'
        : 'The Python adapter reports available filters when a debug session starts.',
    ]
      .filter(Boolean)
      .join(' · ');
  } else {
    title.textContent = 'Breakpoint Properties';
    status.textContent = snapshot.rows.length
      ? 'Select a breakpoint to edit its properties.'
      : 'Add a breakpoint at the editor cursor or click the editor gutter.';
  }
}

function syncForm() {
  const point = row();
  if (!point) return;
  const values = read();
  form.querySelector('.bp-log').hidden = values.mode !== 'log';
  const draft = drafts.get(point.key);
  apply.disabled =
    equal(values, properties(point)) ||
    Boolean(draft && draft.id !== point.id) ||
    (values.mode === 'log' && !values.logMessage.trim());
  reset.disabled = equal(values, properties(point)) && (!draft || draft.id === point.id);
}

function select(key) {
  selected = key;
  for (const button of list.querySelectorAll('button[data-key]')) {
    if (button.dataset.key === selected) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  }
  setDetail();
}

function entry(key, text) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.key = key;
  button.textContent = text;
  if (key === selected) button.setAttribute('aria-current', 'true');
  button.addEventListener('click', () => select(key));
  return button;
}

function group(key, text, hint) {
  const element = document.createElement('details');
  element.open = !collapsed.has(key) || Boolean(filter.value);
  const label = document.createElement('summary');
  label.textContent = text;
  label.title = hint ? text + ' · ' + hint : text;
  if (hint) {
    const description = document.createElement('span');
    description.textContent = hint;
    label.append(description);
  }
  element.append(label);
  element.addEventListener('toggle', () => {
    if (!filter.value && element.isConnected) {
      if (element.open) collapsed.delete(key);
      else collapsed.add(key);
    }
  });
  return element;
}

function checkbox(key, label, enabled, disabled, action) {
  const element = document.createElement('input');
  element.type = 'checkbox';
  element.dataset.key = key;
  element.checked = enabled;
  element.disabled = disabled;
  element.setAttribute('aria-label', label);
  element.addEventListener('change', () => {
    element.checked = enabled;
    action();
  });
  return element;
}

function pointRow(point) {
  const item = document.createElement('div');
  item.className = 'bp-row';
  const label = fileLabel(point);
  const check = checkbox('toggle:' + point.key, 'Enable ' + label, point.enabled, false, () =>
    send('toggle', point.id)
  );
  const button = entry(point.key, '');
  const state = pointStatus(point);
  const mark = document.createElement('span');
  mark.className = 'bp-marker';
  mark.dataset.kind = point.logMessage ? 'log' : point.kind;
  mark.dataset.state =
    !point.enabled || snapshot.muted
      ? 'inactive'
      : point.verified === false
        ? 'unverified'
        : point.verified === true
          ? 'verified'
          : 'active';
  mark.setAttribute('aria-hidden', 'true');
  const name = document.createElement('span');
  name.className = 'bp-point-name';
  name.textContent = label;
  button.append(mark, name);
  if (point.kind === 'line') {
    name.classList.add('bp-full-name');
    const line = document.createElement('span');
    line.className = 'bp-compact-name';
    line.textContent = 'Line ' + point.line;
    button.append(line);
  }
  const details = [point.logMessage ? 'Logpoint' : point.condition ? 'Conditional' : '', state];
  button.setAttribute('aria-label', [label, ...details].filter(Boolean).join(' · '));
  for (const detail of details) {
    if (detail) {
      const badge = document.createElement('span');
      badge.className = 'bp-label';
      badge.textContent = detail;
      button.append(badge);
    }
  }
  button.title = [label, state, point.message].filter(Boolean).join(' · ');
  if (point.kind === 'line') button.addEventListener('dblclick', () => send('source', point.id));
  item.addEventListener('contextmenu', event => {
    event.preventDefault();
    openMenu(point, button, event.clientX, event.clientY);
  });
  item.append(check, button);
  return item;
}

function renderList() {
  const focused = list.contains(document.activeElement) && document.activeElement.dataset.key;
  const scroll = list.scrollTop;
  const query = filter.value.trim().toLowerCase();
  const matches = (...values) =>
    !query || values.some(value => String(value).toLowerCase().includes(query));
  const line = group('lines', 'Python Line Breakpoints');
  const functions = group('functions', 'Function Breakpoints');
  const exceptionGroup = group('exceptions', 'Python Exception Breakpoints');
  const files = new Map();
  for (const point of snapshot.rows) {
    if (
      !matches(
        fileLabel(point),
        point.directory,
        point.condition,
        point.hitCondition,
        point.logMessage
      )
    ) {
      continue;
    }
    if (point.kind === 'function') {
      functions.append(pointRow(point));
    } else {
      let file = files.get(point.group);
      if (!file) {
        file = group(
          point.group,
          point.file,
          [point.workspace, point.directory].filter(Boolean).join(' · ')
        );
        files.set(point.group, file);
        line.append(file);
      }
      file.append(pointRow(point));
    }
  }
  list.replaceChildren(line);
  if (functions.children.length > 1 || snapshot.functions) list.append(functions);
  const exceptionSettings = entry('exceptions', 'Exception Settings');
  exceptionGroup.append(exceptionSettings);
  for (const exception of snapshot.exceptions) {
    if (!matches(exception.label, exception.description ?? '')) continue;
    const item = document.createElement('div');
    item.className = 'bp-row';
    const key = 'exception:' + exception.filter;
    const check = checkbox(
      'toggle:' + key,
      'Enable ' + exception.label,
      exception.enabled === true,
      !snapshot.canSetException || exception.enabled === undefined,
      () => send('exception', exception.filter, !exception.enabled)
    );
    check.title = check.disabled
      ? 'Use the workspace filters in VS Code, or select a live unmuted RunHop session.'
      : 'Change only the selected RunHop session';
    if (exception.enabled === undefined) check.indeterminate = true;
    item.append(check, entry(key, exception.label));
    exceptionGroup.append(item);
  }
  list.append(exceptionGroup);
  list.scrollTop = scroll;
  if (focused) {
    [...list.querySelectorAll('[data-key]')]
      .find(el => el.dataset.key === focused)
      ?.focus({ preventScroll: true });
  }
}

function closeMenu(restore = false) {
  menu.hidden = true;
  if (restore) menuAnchor?.focus();
  menuAnchor = undefined;
}

function openMenu(point, anchor, x, y) {
  select(point.key);
  menuAnchor = anchor;
  const actions = [
    ...(point.kind === 'line' ? [['Go to Source', 'source']] : []),
    [point.enabled ? 'Disable' : 'Enable', 'toggle'],
    ['Remove', 'remove'],
  ];
  menu.replaceChildren(
    ...actions.map(([label, action]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.textContent = label;
      button.addEventListener('click', () => {
        closeMenu(true);
        send(action, point.id);
      });
      return button;
    })
  );
  menu.hidden = false;
  menu.style.left = Math.max(0, Math.min(x, innerWidth - menu.offsetWidth)) + 'px';
  menu.style.top = Math.max(0, Math.min(y, innerHeight - menu.offsetHeight)) + 'px';
  menu.querySelector('button').focus();
}

filter.addEventListener('input', renderList);
form.addEventListener('input', () => {
  const point = row();
  if (!point) return;
  const draft = drafts.get(point.key);
  drafts.set(point.key, { id: draft?.id ?? point.id, value: read() });
  syncForm();
});
form.addEventListener('reset', event => {
  event.preventDefault();
  if (selected) drafts.delete(selected);
  setDetail();
});
form.addEventListener('submit', event => {
  event.preventDefault();
  const point = row();
  if (point && !apply.disabled) send('apply', point.id, submitted(read()));
});

root.addEventListener('click', event => {
  if (!menu.contains(event.target) && !menu.hidden) closeMenu();
  const action = event.target.closest('button[data-action]')?.dataset.action;
  if (action === 'addFunction') send('add', undefined, 'function');
  else if (action) send(action, row()?.id);
});
root.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.preventDefault();
    if (!menu.hidden) closeMenu(true);
    else send('close');
  } else if (event.key === 'Delete' && list.contains(event.target) && row()) {
    event.preventDefault();
    send('remove', row().id);
  } else if (event.key === 'Insert' && event.altKey && snapshot?.canAddLine) {
    event.preventDefault();
    send('add');
  } else if (event.key === 'F4' && row()?.kind === 'line') {
    event.preventDefault();
    send('source', row().id);
  } else if (
    (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) &&
    list.contains(event.target) &&
    row()
  ) {
    event.preventDefault();
    const rect = event.target.getBoundingClientRect();
    openMenu(row(), event.target, rect.left, rect.bottom);
  } else if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
    const parent = !menu.hidden ? menu : list;
    const targets = [
      ...parent.querySelectorAll(parent === menu ? 'button' : 'button[data-key]'),
    ].filter(button => button.getClientRects().length);
    const current = targets.indexOf(document.activeElement);
    if (current >= 0) {
      event.preventDefault();
      const next =
        targets[(current + (event.key === 'ArrowDown' ? 1 : targets.length - 1)) % targets.length];
      next.focus();
      if (parent === list) select(next.dataset.key);
    }
  }
});

window.addEventListener('message', ({ data }) => {
  if (data.type !== 'state') return;
  const previous = row();
  snapshot = data.state;
  closeMenu();
  for (const [key, draft] of drafts) {
    const current = snapshot.rows.find(point => point.id === draft.id);
    const replacement = snapshot.rows.find(point => point.key === key);
    if (current && current.key !== key) {
      drafts.delete(key);
      drafts.set(current.key, draft);
    } else if (
      !current &&
      (!replacement || equal(submitted(draft.value), properties(replacement)))
    ) {
      drafts.delete(key);
    }
  }
  if (previous && !row()) {
    selected = snapshot.rows.find(point => point.id === previous.id)?.key ?? selected;
  }
  if (snapshot.selected && snapshot.selectionRevision !== previousSelection) {
    selected = snapshot.selected;
  } else if (
    selected !== 'exceptions' &&
    !row() &&
    !snapshot.exceptions.some(item => 'exception:' + item.filter === selected)
  ) {
    selected = snapshot.rows[0]?.key;
  }
  const first = previousSelection === undefined;
  previousSelection = snapshot.selectionRevision;
  find('.bp-session').textContent = snapshot.session
    ? snapshot.session + (snapshot.muted ? ' · Muted' : '')
    : 'Workspace breakpoints';
  find('[data-action="add"]').disabled = !snapshot.canAddLine;
  find('[data-action="addFunction"]').hidden = !snapshot.functions;
  notice.textContent = snapshot.notice?.text ?? '';
  find('[data-action="undo"]').hidden = !snapshot.canUndo;
  notice.classList.toggle('bp-error', Boolean(snapshot.notice?.error));
  renderList();
  setDetail();
  if (first) filter.focus();
});
send('ready');
