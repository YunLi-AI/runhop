import {
  configurationColumnMaximum,
  configurationColumns,
  fitConfigurationColumnWidths,
  readConfigurationColumnWidths,
} from '../configurationLayout';
import { configurationText } from '../configurationLocale';
import './configurations.css';

const vscode = acquireVsCodeApi();
const root = document.getElementById('configurations');
let columnWidths = readConfigurationColumnWidths({
  categories: Number(root.dataset.categoriesWidth),
  entries: Number(root.dataset.entriesWidth),
});
let savedColumnWidths = columnWidths;
let languageMode = root.dataset.languageMode;
let locale = document.documentElement.lang;
let languagePending = false;
let languageError;
const t = (message, ...args) => configurationText(locale, message, ...args);
const labels = {
  run: 'Run / Debug',
  servers: 'SSH Servers',
  interpreters: 'Remote Interpreters',
  sync: 'Synchronization',
};
const entryTitles = {
  run: 'Configurations',
  servers: 'Saved servers',
  interpreters: 'Saved interpreters',
  sync: 'Project and targets',
};
const modes = [
  ['incremental', 'Changed Files'],
  ['full', 'Project Scan'],
  ['off', 'Off'],
];
let snapshot;
let newerSnapshot;
let section = 'run';
let settingsOpen = false;
let draft;
let dirty = false;
let conflict = false;
let busy = false;
let notice = '';
let noticeZh;
let failed = false;
let afterApply;
let queuedNavigation;
let probe;
const verifiedInterpreters = new Map();
const discoveredInterpreters = new Map();
let openPicker;
let aliasRequest = 0;
let focusField;

function node(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}

function button(text, action, className, disabled = false) {
  const item = node('button', text, className);
  item.type = 'button';
  item.disabled = disabled;
  item.addEventListener('click', action);
  return item;
}

function send(type, data = {}) {
  vscode.postMessage({
    type,
    folder: snapshot?.folder,
    revision: snapshot?.revision,
    section,
    key: draft?.key,
    ...data,
  });
}

function setNotice(text = '', error = false, chinese) {
  notice = text;
  noticeZh = chinese;
  failed = error;
  updateEditorFeedback();
}

function switchTo(callback) {
  if (busy) return;
  if (!dirty) {
    callback();
    return;
  }
  queuedNavigation = callback;
  document.getElementById('unsaved-dialog')?.showModal();
}

function dialog() {
  const modal = node('dialog', undefined, 'unsaved-dialog');
  modal.id = 'unsaved-dialog';
  modal.setAttribute('aria-labelledby', 'unsaved-title');
  const title = node('h2', t('Unsaved changes'));
  title.id = 'unsaved-title';
  const actions = node('div', undefined, 'dialog-actions');
  const continueEditing = () => {
    queuedNavigation = undefined;
    modal.close();
  };
  modal.addEventListener('cancel', () => {
    queuedNavigation = undefined;
  });
  actions.append(
    button(t('Keep Editing'), continueEditing),
    button(t('Discard and Continue'), () => {
      const next = queuedNavigation;
      continueEditing();
      discard(false);
      next?.();
    }),
    button(
      t('Apply and Continue'),
      () => {
        const next = queuedNavigation;
        continueEditing();
        apply(next);
      },
      'primary',
      conflict
    )
  );
  modal.append(
    title,
    node('p', t('Apply or discard the changes before leaving this entry.')),
    actions
  );
  return modal;
}

function savedRows(which = section) {
  return snapshot?.entries?.[which] ?? [];
}

function entryLabel(entry) {
  if (['file', 'current', 'project', 'new'].includes(entry.key)) return t(entry.label);
  if (entry.key.startsWith('server:') && !entry.values.name && !entry.values.host) {
    return t('SSH server {0}', Number(entry.key.slice(7)) + 1);
  }
  return entry.label;
}

function copy(values) {
  return structuredClone(values);
}

function interpreterProbeKey() {
  return JSON.stringify([
    snapshot?.folder,
    snapshot?.revision,
    value('target'),
    value('profile'),
    value('path'),
  ]);
}

function selectRow(key) {
  const row = savedRows().find(item => item.key === key) ?? savedRows()[0];
  draft = row && { key: row.key, label: row.label, values: copy(row.values) };
  dirty = false;
  conflict = false;
  notice = '';
  noticeZh = undefined;
  failed = false;
  probe = section === 'interpreters' ? verifiedInterpreters.get(interpreterProbeKey()) : undefined;
  render();
}

function newDraft(from) {
  const defaults = {
    run: {
      name: '',
      kind: 'script',
      program: snapshot?.script ?? '',
      args: '',
      env: [],
      justMyCode: true,
      active: false,
    },
    servers: { name: '', auth: 'sshConfig', context: '.', remotePath: '.' },
    interpreters: { name: '', path: '', default: savedRows().length === 0 },
  };
  const original = from ?? draft;
  const values = from
    ? { ...copy(from.values), name: uniqueCopyName(from.values.name), active: false }
    : defaults[section];
  if (!values) return;
  draft = {
    key: 'new',
    label: from
      ? 'Copy Run Configuration'
      : {
          run: 'New Run Configuration',
          servers: 'New SSH Server',
          interpreters: 'New Remote Interpreter',
        }[section],
    values,
    copyFrom: from ? original.key.slice(4) : undefined,
  };
  dirty = true;
  conflict = false;
  notice = '';
  noticeZh = undefined;
  failed = false;
  probe = undefined;
  focusField = 'name';
  render();
}

function uniqueCopyName(name) {
  const used = new Set(savedRows().map(row => row.label));
  let label = name + ' Copy';
  for (let number = 2; used.has(label); number++) label = name + ' Copy ' + number;
  return label;
}

function choose(which, key, field, create = false) {
  section = which;
  focusField = field;
  if (create) {
    newDraft();
  } else {
    selectRow(
      key ?? (section === 'run' ? savedRows().find(row => row.values.active)?.key : undefined)
    );
  }
}

function value(name) {
  return draft?.values[name];
}

function change(name, value, renderAgain = false) {
  draft.values[name] = value;
  const baseline = savedRows().find(row => row.key === draft.key);
  dirty = !baseline || JSON.stringify(baseline.values) !== JSON.stringify(draft.values);
  if (
    [
      'path',
      'host',
      'port',
      'username',
      'target',
      'profile',
      'auth',
      'privateKeyPath',
      'agent',
      'sshConfigPath',
    ].includes(name)
  ) {
    probe = undefined;
  }
  setNotice();
  if (renderAgain) {
    focusField = name;
    render();
  }
}

function discard(reload = true) {
  if (!snapshot?.entries) return;
  if (newerSnapshot) {
    snapshot = newerSnapshot;
    newerSnapshot = undefined;
  } else if (conflict && reload) {
    const key = draft?.key;
    dirty = false;
    conflict = false;
    send('reload', { focus: { section, key } });
    return;
  }
  selectRow(draft?.key);
}

function setBusy() {
  busy = true;
  render();
}

function apply(next, remove = false) {
  if (!draft || busy || conflict) return;
  afterApply = next;
  setNotice();
  setBusy();
  send('apply', { fields: draft.values, copyFrom: draft.copyFrom, remove });
}

function localizedOptions(options) {
  return options.map(([key, label]) => [key, t(label)]);
}

function formGroup(form, title) {
  const group = node('section', undefined, 'form-group');
  group.append(node('h3', t(title)));
  form.append(group);
  return group;
}

function discoveryKey() {
  return JSON.stringify([
    snapshot.folder,
    snapshot.revision,
    value('target'),
    value('profile'),
    value('condaExecutable'),
  ]);
}

function executableChoices() {
  const target = value('target') ?? '';
  const index = savedRows('servers').findIndex(item => item.values.name === target && target);
  const defaultProfile = snapshot.profiles[index]?.defaultProfile ?? '';
  const profile = value('profile') || defaultProfile;
  const choices = new Map();
  for (const row of savedRows('interpreters')) {
    const { path, target: savedTarget, profile: savedProfile } = row.values;
    if (path && savedTarget === target && (savedProfile || defaultProfile) === profile) {
      choices.set(path, row.label);
    }
  }
  for (const path of discoveredInterpreters.get(discoveryKey()) ?? []) {
    if (!choices.has(path)) choices.set(path, t('Discovered on server'));
  }
  return choices;
}

function hostChoices(aliases = []) {
  const choices = new Map(aliases.map(host => [host, t('OpenSSH alias')]));
  const names = new Set(aliases.map(host => host.toLowerCase()));
  for (const row of savedRows('servers')) {
    const host = row.values.host;
    if (host && !names.has(host.toLowerCase())) {
      names.add(host.toLowerCase());
      choices.set(host, row.label);
    }
  }
  return choices;
}

function addFieldPicker(group, input, name) {
  const isHost = name === 'host';
  const label = t(isHost ? 'Choose an SSH host' : 'Choose a Python executable');
  const menu = node('div', undefined, 'field-picker-menu');
  menu.id = input.id + '-choices';
  menu.hidden = true;
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', label);
  const search = node('input', undefined, 'field-picker-search');
  search.placeholder = t(isHost ? 'Filter SSH hosts' : 'Filter Python executables');
  search.setAttribute('aria-label', search.placeholder);
  search.spellcheck = false;
  const items = node('div', undefined, 'field-picker-items');
  const info = node('small', undefined, 'hint');
  const trigger = button('▾', toggle, 'field-picker-trigger', busy);
  trigger.id = 'choose-' + name;
  trigger.setAttribute('aria-label', label);
  trigger.title = label;
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', menu.id);

  let aliases;
  let loadError;
  let request;

  function refresh() {
    const options = isHost ? hostChoices(aliases) : executableChoices();
    const filter = search.value.trim().toLowerCase();
    const matches = [...options].filter(
      ([entry, detail]) =>
        entry.toLowerCase().includes(filter) || detail.toLowerCase().includes(filter)
    );
    const shown = matches.slice(0, 80).map(([entry, detail]) => {
      const option = button(
        entry,
        () => {
          close();
          change(name, entry, true);
        },
        'field-picker-option'
      );
      option.title = entry;
      if (entry === value(name)) option.setAttribute('aria-current', 'true');
      if (entry !== detail) option.append(node('small', detail));
      return option;
    });
    items.replaceChildren(...shown);
    info.textContent = t(
      loadError ||
        (isHost && aliases === undefined
          ? 'Reading OpenSSH aliases…'
          : matches.length > shown.length
            ? 'Type to filter the remaining entries.'
            : !matches.length
              ? filter
                ? 'No matching entries.'
                : isHost
                  ? 'No SSH aliases found. You can enter a host manually.'
                  : 'Discover Python on the server or enter an executable manually.'
              : '')
    );
    info.hidden = !info.textContent;
  }

  function close(returnFocus = false) {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (openPicker?.group === group) openPicker = undefined;
    if (returnFocus) trigger.focus();
  }

  function toggle() {
    if (!menu.hidden) {
      close(true);
      return;
    }
    openPicker?.close();
    search.value = '';
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    if (isHost) {
      aliases = undefined;
      loadError = undefined;
      request = ++aliasRequest;
      send('sshAliases', { request, configPath: value('sshConfigPath') ?? '' });
    }
    openPicker = {
      group,
      request,
      close,
      receive(message) {
        aliases = message.aliases ?? [];
        loadError = (locale === 'zh-CN' && message.errorZh) || message.error;
        refresh();
      },
    };
    refresh();
    search.focus();
  }

  search.addEventListener('input', refresh);
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'Enter' && event.target === search) {
      event.preventDefault();
      items.querySelector('button')?.click();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const options = [...items.querySelectorAll('button')];
      if (!options.length) return;
      event.preventDefault();
      const index = options.indexOf(document.activeElement);
      const next =
        event.key === 'ArrowDown'
          ? (index + 1) % options.length
          : index <= 0
            ? options.length - 1
            : index - 1;
      options[next].focus();
    }
  });
  menu.append(search, items, info);
  if (!isHost) {
    menu.append(
      button(
        t('Discover on Server…'),
        () => runProbe('discoverPython'),
        'picker-discover',
        busy || conflict
      )
    );
  }
  group.classList.add('field-picker');
  group.append(trigger, menu);
}

function row(form, name, label, kind = 'input', options = {}) {
  const container = node('div', undefined, 'field');
  const id = 'field-' + name;
  const caption = node('label', t(label));
  caption.htmlFor = id;
  const content = node('div', undefined, 'field-content');
  const input = node(kind === 'select' ? 'select' : kind === 'textarea' ? 'textarea' : 'input');
  input.id = id;
  input.disabled = busy || options.disabled === true;
  if (kind === 'select') {
    const items = [...options.options];
    const current = value(name) ?? items[0]?.[0];
    if (current && !items.some(([key]) => key === current)) {
      items.push([current, t('{0} (unavailable)', current)]);
    }
    for (const [key, text] of items) {
      const option = node('option', text);
      option.value = key;
      input.append(option);
    }
    input.value = current ?? '';
    input.addEventListener('change', () => change(name, input.value, options.rerender));
  } else if (kind === 'checkbox') {
    input.type = 'checkbox';
    input.checked = value(name) === true;
    input.addEventListener('change', () => change(name, input.checked, options.rerender));
  } else {
    if (kind === 'textarea') {
      input.rows = options.rows ?? 3;
      input.spellcheck = false;
    }
    input.value = value(name) ?? '';
    if (options.placeholder) input.placeholder = t(options.placeholder);
    if (options.readOnly) input.readOnly = true;
    input.addEventListener('input', () => change(name, input.value));
  }
  const group = node('div', undefined, 'input-group');
  group.append(input);
  if (options.picker) addFieldPicker(group, input, name);
  if (options.browse) {
    group.append(
      button(
        t('Browse…'),
        () => {
          setBusy();
          send('browse', { field: name });
        },
        undefined,
        busy
      )
    );
  }
  content.append(group);
  if (options.hint) {
    const hint = node('small', t(options.hint), 'hint');
    hint.id = id + '-hint';
    input.setAttribute('aria-describedby', hint.id);
    content.append(hint);
  }
  container.append(caption, content);
  form.append(container);
  return input;
}

function check(form, name, caption) {
  const item = node('label', undefined, 'check');
  const input = node('input');
  input.type = 'checkbox';
  input.id = 'field-' + name;
  input.checked = value(name) === true;
  input.disabled = busy;
  input.addEventListener('change', () => change(name, input.checked));
  item.append(input, document.createTextNode(t(caption)));
  form.append(item);
}

function environment(form) {
  const group = formGroup(form, 'Environment Variables');
  const values = value('env') ?? [];
  const grid = node('div', undefined, 'environment');
  values.forEach((entry, index) => {
    const name = node('input');
    name.setAttribute('aria-label', t('Variable {0} name', index + 1));
    name.placeholder = t('NAME');
    name.value = entry.name;
    name.disabled = busy;
    name.addEventListener('input', () => {
      entry.name = name.value;
      change('env', values);
    });
    const input = node('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', t('Variable {0} value', index + 1));
    input.value = entry.value ?? '';
    input.placeholder = t(entry.original === undefined ? 'Value' : 'Saved value');
    input.disabled = busy;
    input.addEventListener('input', () => {
      entry.value = input.value;
      change('env', values);
    });
    const remove = button(
      t('Remove'),
      () => {
        values.splice(index, 1);
        change('env', values, true);
      },
      undefined,
      busy
    );
    grid.append(name, input, remove);
  });
  if (values.length) group.append(grid);
  group.append(
    button(
      t('Add Variable'),
      () => {
        change('env', [...values, { name: '' }], true);
        const inputs = document.querySelectorAll(
          '.environment input[type=text], .environment input:not([type])'
        );
        inputs[inputs.length - 1]?.focus();
      },
      undefined,
      busy
    )
  );
}

function runEditor(form) {
  if (draft.key === 'current') {
    form.append(node('p', t('Open a Python file to edit its arguments and launch settings.')));
    form.append(
      button(t('Use Current Python File'), () => apply(), 'primary', busy || value('active'))
    );
    return;
  }
  const current = draft.key === 'file';
  const launch = formGroup(form, 'Launch');
  if (!current) {
    row(launch, 'name', 'Configuration Name');
    row(launch, 'kind', 'Execute', 'select', {
      options: localizedOptions([
        ['script', 'Script'],
        ['module', 'Python module'],
      ]),
      rerender: true,
    });
    if (value('kind') === 'module') {
      row(launch, 'module', 'Module Name', 'input', { placeholder: 'package.module' });
    } else {
      row(launch, 'program', 'Script Path', 'input', {
        browse: true,
        placeholder: 'scripts/train.py',
      });
    }
  }
  row(launch, 'runOn', 'Run On', 'select', {
    options: localizedOptions([
      ['', 'Automatic'],
      ['remote', 'SSH server'],
      ['local', 'Local Python'],
    ]),
    rerender: true,
  });
  const remote = value('runOn') !== 'local';
  if (remote) {
    const interpreters = savedRows('interpreters').map(item => [item.label, item.label]);
    row(launch, 'interpreter', 'Remote Interpreter', 'select', {
      options: [['', t('Use project / script default')], ...interpreters],
    });
  }
  if (value('runOn') !== 'remote') {
    row(launch, 'localPython', 'Local Interpreter', 'input', {
      browse: true,
      placeholder: 'python3',
      hint: 'Leave blank to detect your local Python.',
    });
  }
  check(
    launch,
    'active',
    current
      ? 'Run the current Python file from the toolbar'
      : 'Use this configuration for toolbar Run and Debug'
  );

  const execution = formGroup(form, 'Execution');
  row(execution, 'args', 'Program Arguments', 'textarea', {
    rows: 2,
    placeholder: '--config "path with spaces.yaml"',
    hint: 'Quote arguments that contain spaces.',
  });
  row(execution, 'cwd', 'Working Directory', 'input', {
    browse: true,
    hint: 'Local directory mapped to the server for remote runs.',
  });
  environment(form);

  if (remote) {
    const deployment = formGroup(form, 'Deployment');
    row(deployment, 'syncMode', 'Sync Before Launch', 'select', {
      options: [['', t('Use project default')], ...localizedOptions(modes)],
    });
    row(deployment, 'download', 'Download Results', 'textarea', {
      rows: 2,
      hint: 'One remote project-relative file or folder per line.',
    });
  }

  const debugging = formGroup(form, 'Debugger');
  check(debugging, 'justMyCode', 'Debug only project code');
  check(debugging, 'stopOnEntry', 'Stop on entry');
}

function mapping(form) {
  row(form, 'context', 'Local Project Root', 'input', {
    browse: true,
    placeholder: '.',
    hint: 'Relative to this workspace folder.',
  });
  row(form, 'remotePath', 'Remote Project Root', 'input', {
    placeholder: '/home/user/project',
    hint: 'Absolute or relative to the SSH login directory.',
  });
}

function sshEditor(form) {
  const connection = formGroup(form, 'Connection');
  row(connection, 'name', 'Server Name');
  row(connection, 'host', 'Host', 'input', {
    placeholder: 'SSH hostname or OpenSSH alias',
    picker: true,
    hint: 'Leave Port and Username blank to use the alias settings.',
  });
  row(connection, 'port', 'Port', 'input', { placeholder: '22 or OpenSSH default' }).inputMode =
    'numeric';
  row(connection, 'username', 'Username', 'input', { placeholder: 'Use OpenSSH setting' });
  const auth = formGroup(form, 'Authentication');
  row(auth, 'auth', 'Method', 'select', {
    options: localizedOptions([
      ['sshConfig', 'OpenSSH configuration'],
      ['key', 'Identity file'],
      ['agent', 'SSH agent'],
      ['password', 'Password prompt / saved password'],
    ]),
    rerender: true,
  });
  row(auth, 'sshConfigPath', 'SSH Config File', 'input', {
    browse: true,
    placeholder: '~/.ssh/config',
  });
  if (value('auth') === 'key') {
    row(auth, 'privateKeyPath', 'Identity File', 'input', { browse: true });
    check(auth, 'encryptedKey', 'Prompt for an encrypted key passphrase');
  }
  if (value('auth') === 'agent') {
    row(auth, 'agent', 'Agent Socket', 'input', { placeholder: '$SSH_AUTH_SOCK' });
  }
  if (value('auth') === 'password') {
    auth.append(node('p', t('RunHop uses the VS Code password prompt and SecretStorage.'), 'hint'));
  }
  const project = formGroup(form, 'Project Mapping');
  mapping(project);
  const profile = snapshot.profiles[Number(draft.key.split(':')[1])];
  if (profile?.names.length) {
    row(project, 'defaultProfile', 'Default SSH Profile', 'select', {
      options: [['', t('Use base server settings')], ...profile.names.map(name => [name, name])],
    });
  }
  project.append(
    button(t('Test Connection'), () => runProbe('testSsh'), undefined, busy || conflict)
  );
  if (probe?.kind === 'ssh') {
    project.append(
      node(
        'p',
        t(
          'Connected to {0}:{1} · {2}',
          probe.host,
          probe.port,
          probe.root ? t('Project root {0}', probe.root) : t('Project root is not accessible yet.')
        ),
        'probe'
      )
    );
  }
}

function pythonEditor(form) {
  const executable = formGroup(form, 'Python Environment');
  row(executable, 'name', 'Interpreter Name');
  const servers = savedRows('servers').flatMap(item =>
    item.values.name ? [[item.values.name, item.label]] : []
  );
  row(executable, 'target', 'SSH Server', 'select', {
    options: [['', t('Match project mapping')], ...servers],
    rerender: true,
  });
  const index = savedRows('servers').findIndex(item => item.values.name === value('target'));
  const profiles = snapshot.profiles[index]?.names ?? [];
  if (profiles.length || value('profile')) {
    row(executable, 'profile', 'SSH Profile', 'select', {
      options: [['', t('Use server default')], ...profiles.map(name => [name, name])],
      rerender: true,
    });
  }
  row(executable, 'path', 'Python Executable', 'input', {
    placeholder: '/opt/conda/envs/train/bin/python',
    picker: true,
  });
  executable.append(
    button(t('Verify Interpreter'), () => runProbe('testPython'), undefined, busy || conflict)
  );
  if (probe?.kind === 'python' && probe.info) {
    const info = node('dl', undefined, 'python-info');
    for (const [label, text] of [
      ['Python Version', probe.info.version],
      ['Environment', t(probe.info.kind)],
      ['Executable', probe.info.executable],
      ['Prefix', probe.info.prefix],
      ['Conda Environment', probe.info.condaName],
    ]) {
      if (text) info.append(node('dt', t(label)), node('dd', text));
    }
    executable.append(info);
  }
  const activation = formGroup(form, 'Activation');
  row(activation, 'condaExecutable', 'Conda Executable', 'input', {
    hint: 'Optional path for Remote Terminal activation.',
  });
  check(activation, 'default', 'Use as the default remote interpreter');
}

function syncEditor(form) {
  if (draft.key === 'project') {
    const policy = formGroup(form, 'Upload Policy');
    row(policy, 'syncMode', 'Sync Before Launch', 'select', { options: localizedOptions(modes) });
    check(policy, 'uploadOnSave', 'Automatically upload eligible local file changes');
    policy.append(
      node(
        'p',
        t(
          'Changed Files deploys once, then uploads local changes. Project Scan compares files at every launch. Off skips launch sync.'
        ),
        'hint'
      )
    );
    return;
  }
  mapping(formGroup(form, 'Path Mapping'));
  const exclusions = formGroup(form, 'Exclusions');
  row(exclusions, 'ignore', 'Excluded Paths', 'textarea', {
    rows: 5,
    hint: 'One gitignore-style pattern per line, relative to the local project root.',
    placeholder: '/datasets/\n*.safetensors',
  });
  row(exclusions, 'ignoreFile', 'Ignore File', 'input', { browse: true });
  exclusions.append(
    node(
      'p',
      t(
        'Automatic uploads and launch synchronization use this mapping. Review the remote root before the next upload.'
      ),
      'hint'
    )
  );
}

function runProbe(type) {
  setNotice(type === 'testSsh' ? 'Testing SSH connection…' : 'Checking Python on the server…');
  probe = undefined;
  setBusy();
  send(type, { fields: draft.values });
}

function requestDelete() {
  const modal = document.getElementById('delete-dialog');
  modal?.showModal();
}

function deleteDialog() {
  const modal = node('dialog', undefined, 'unsaved-dialog');
  modal.id = 'delete-dialog';
  modal.setAttribute('aria-labelledby', 'delete-title');
  const title = node('h2', t('Remove configuration?'));
  title.id = 'delete-title';
  const actions = node('div', undefined, 'dialog-actions');
  actions.append(
    button(t('Cancel'), () => modal.close()),
    button(
      t('Remove'),
      () => {
        modal.close();
        apply(undefined, true);
      },
      'primary'
    )
  );
  modal.append(title, node('p', t('Remove {0} from runhop.json.', entryLabel(draft))), actions);
  return modal;
}

function languageSelector() {
  const select = node('select', undefined, 'language');
  select.id = 'configuration-language';
  select.setAttribute('aria-describedby', 'configuration-language-hint');
  select.disabled = languagePending;
  for (const [mode, label] of [
    ['auto', t('Follow VS Code')],
    ['zh-CN', '简体中文'],
    ['en', 'English'],
  ]) {
    const option = node('option', label);
    option.value = mode;
    option.lang = mode === 'auto' ? locale : mode;
    select.append(option);
  }
  select.value = languageMode;
  select.addEventListener('change', () => {
    languagePending = true;
    select.disabled = true;
    send('setLanguage', { mode: select.value });
  });
  return select;
}

function settingsEditor() {
  const editor = node('section', undefined, 'editor');
  editor.setAttribute('aria-labelledby', 'runhop-settings-title');
  const heading = node('div', undefined, 'editor-heading');
  const title = node('h2', t('Appearance'));
  title.id = 'runhop-settings-title';
  title.tabIndex = -1;
  heading.append(title);
  const content = node('div', undefined, 'settings-content');
  const field = node('div', undefined, 'field');
  const label = node('label', t('Interface Language'));
  label.htmlFor = 'configuration-language';
  const controls = node('div', undefined, 'field-content');
  const hint = node(
    'small',
    t('Changes apply immediately. This preference is saved on this machine for all projects.'),
    'hint'
  );
  hint.id = 'configuration-language-hint';
  controls.append(languageSelector(), hint);
  if (languageError) {
    const alert = node('small', t(languageError), 'status error');
    alert.setAttribute('role', 'alert');
    controls.append(alert);
  }
  field.append(label, controls);
  content.append(field);
  editor.append(heading, content);
  return editor;
}

function updateColumnWidths(layout = root.querySelector('.layout')) {
  if (!layout) return;
  const widths = fitConfigurationColumnWidths(columnWidths, layout.clientWidth);
  for (const column of Object.keys(configurationColumns)) {
    layout.style.setProperty('--' + column + '-width', widths[column] + 'px');
    const divider = layout.querySelector('#resize-' + column);
    divider.setAttribute('aria-valuenow', String(widths[column]));
    divider.setAttribute(
      'aria-valuemax',
      String(configurationColumnMaximum(column, widths, layout.clientWidth))
    );
  }
}

function saveColumnWidths() {
  if (columnWidths === savedColumnWidths) return;
  savedColumnWidths = columnWidths;
  send('resizeColumns', { widths: columnWidths });
}

function columnDivider(layout, column, label) {
  const divider = node('div', undefined, 'column-divider');
  divider.id = 'resize-' + column;
  divider.tabIndex = 0;
  divider.title = t(label);
  divider.setAttribute('role', 'separator');
  divider.setAttribute('aria-orientation', 'vertical');
  divider.setAttribute('aria-label', divider.title);
  divider.setAttribute('aria-controls', 'configuration-' + column);
  divider.setAttribute('aria-valuemin', String(configurationColumns[column].min));

  let drag;
  const visibleWidths = () => fitConfigurationColumnWidths(columnWidths, layout.clientWidth);
  function resize(value) {
    const widths = visibleWidths();
    const min = configurationColumns[column].min;
    const max = configurationColumnMaximum(column, widths, layout.clientWidth);
    const next = Math.min(max, Math.max(min, Math.round(value)));
    if (next === widths[column]) return;
    columnWidths = { ...widths, [column]: next };
    updateColumnWidths(layout);
  }

  divider.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    divider.focus({ preventScroll: true });
    divider.setPointerCapture(event.pointerId);
    drag = { x: event.clientX, width: visibleWidths()[column] };
    divider.classList.add('dragging');
  });
  divider.addEventListener('pointermove', event => {
    if (drag && divider.hasPointerCapture(event.pointerId)) {
      resize(drag.width + event.clientX - drag.x);
    }
  });
  divider.addEventListener('lostpointercapture', () => {
    drag = undefined;
    divider.classList.remove('dragging');
    saveColumnWidths();
  });
  divider.addEventListener('keydown', event => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const width = visibleWidths()[column];
    const { min, max } = configurationColumns[column];
    const values = { ArrowLeft: width - 12, ArrowRight: width + 12, Home: min, End: max };
    resize(values[event.key]);
    saveColumnWidths();
  });
  return divider;
}

function mountColumns(sidebar, list, editor, scrollPositions) {
  const layout = node('div', undefined, 'layout');
  sidebar.id = 'configuration-categories';
  list.id = 'configuration-entries';
  const navigation = sidebar.querySelector('.sections');
  const scope = settingsOpen ? ['settings'] : [snapshot?.folder, section];
  navigation.dataset.scrollKey = 'categories';
  list.dataset.scrollKey = JSON.stringify(['entries', ...scope]);
  editor.dataset.scrollKey = JSON.stringify([
    'editor',
    ...scope,
    settingsOpen ? undefined : draft?.key,
    !settingsOpen && draft?.key === 'file' ? snapshot?.script : undefined,
  ]);
  layout.append(
    sidebar,
    columnDivider(layout, 'categories', 'Resize configuration categories'),
    list,
    columnDivider(layout, 'entries', 'Resize configuration list'),
    editor
  );
  root.append(layout, dialog());
  updateColumnWidths(layout);
  updateEditorFeedback();
  for (const region of [navigation, list, editor]) {
    region.scrollTop = scrollPositions.get(region.dataset.scrollKey) ?? 0;
  }
}

function render() {
  saveColumnWidths();
  const scrollPositions = new Map(
    [...root.querySelectorAll('[data-scroll-key]')].map(region => [
      region.dataset.scrollKey,
      region.scrollTop,
    ])
  );
  openPicker?.close();
  root.replaceChildren();
  const header = node('header', undefined, 'top');
  header.append(node('h1', t('RunHop Configurations')));
  if (!settingsOpen && snapshot?.folders?.length) {
    const projectPicker = node('span', undefined, 'project-picker');
    const folderIcon = node('span', undefined, 'project-icon');
    folderIcon.setAttribute('aria-hidden', 'true');
    const projects = node('select', undefined, 'projects');
    projects.setAttribute('aria-label', t('Workspace Folder'));
    projects.disabled = busy;
    for (const item of snapshot.folders) {
      const option = node('option', item.name);
      option.value = item.id;
      option.title = item.path;
      if (item.id === snapshot.folder) projects.title = item.path;
      projects.append(option);
    }
    projects.value = snapshot.folder;
    projects.addEventListener('change', () => {
      const folder = projects.value;
      projects.value = snapshot.folder;
      switchTo(() => send('navigate', { folder, focus: { section } }));
    });
    projectPicker.append(folderIcon, projects);
    header.append(projectPicker);
    header.append(button(t('Open JSON'), () => send('openJson'), undefined, busy));
  }
  root.append(header);
  const sidebar = node('div', undefined, 'sidebar');
  const navigation = node('nav', undefined, 'sections');
  navigation.setAttribute('aria-label', t('Configuration Sections'));
  for (const [key, label] of Object.entries(labels)) {
    const item = button(
      t(label),
      () => {
        if (settingsOpen && section === key) {
          settingsOpen = false;
          render();
          return;
        }
        switchTo(() => {
          settingsOpen = false;
          choose(key);
        });
      },
      'nav-item',
      busy || !snapshot?.entries
    );
    if (!settingsOpen && key === section) item.setAttribute('aria-current', 'page');
    navigation.append(item);
  }
  const preferences = node('div', undefined, 'settings-navigation');
  const settings = button(
    t('Settings'),
    () => {
      if (settingsOpen) return;
      settingsOpen = true;
      render();
      document.getElementById('runhop-settings-title')?.focus();
    },
    'nav-item',
    busy
  );
  if (settingsOpen) settings.setAttribute('aria-current', 'page');
  preferences.append(settings);
  sidebar.append(navigation, preferences);
  const list = node('aside', undefined, 'entries');
  list.setAttribute('aria-label', t('Configuration Entries'));
  if (settingsOpen) {
    const appearance = node('span', t('Appearance'), 'entry-item');
    appearance.setAttribute('aria-current', 'page');
    list.append(appearance);
    mountColumns(sidebar, list, settingsEditor(), scrollPositions);
    return;
  }

  const listHead = node('div', undefined, 'entries-heading');
  listHead.append(node('h2', t(entryTitles[section])));
  if (section !== 'sync' && snapshot?.entries) {
    listHead.append(button(t('Add…'), () => switchTo(() => newDraft()), undefined, busy));
  }
  list.append(listHead);
  const entries = savedRows();
  if (!entries.length) list.append(node('p', t('No saved entries.'), 'hint'));
  const listEntries = draft?.key === 'new' ? [...entries, draft] : entries;
  for (const entry of listEntries) {
    const item = button(undefined, () => switchTo(() => selectRow(entry.key)), 'entry-item', busy);
    const summary = node('span', undefined, 'entry-summary');
    summary.append(node('span', entryLabel(entry), 'entry-name'));
    if (entry.values.active === true || entry.values.default === true) {
      summary.append(node('small', t(entry.values.active ? 'Active' : 'Default'), 'entry-status'));
    }
    item.append(summary);
    if (entry.detail) {
      const detail = node('small', entry.detail, 'entry-detail');
      detail.title = entry.detail;
      item.append(detail);
    }
    if (entry.key === draft?.key) item.setAttribute('aria-current', 'true');
    list.append(item);
  }
  const editor = node('section', undefined, 'editor');
  editor.setAttribute('aria-label', t('Configuration Details'));
  const feedback = node('div', undefined, 'editor-feedback');
  if (snapshot?.missing) {
    editor.append(
      node(
        'p',
        t('This project has no runhop.json. Apply a configuration before running or debugging.'),
        'hint source-hint'
      )
    );
  }
  if (!snapshot?.entries) {
    editor.append(
      node(
        'p',
        t(
          failed
            ? 'Open runhop.json to fix the problem or reload the editor.'
            : 'Loading project settings…'
        ),
        'hint'
      )
    );
  } else if (!draft) {
    editor.append(
      node(
        'p',
        t(
          section === 'servers'
            ? 'Add an SSH server to use remote Python.'
            : 'Add a remote Python interpreter.'
        ),
        'hint'
      )
    );
  } else {
    const heading = node('div', undefined, 'editor-heading');
    const title = node('div', undefined, 'editor-title');
    title.append(node('h2', entryLabel(draft)));
    if (draft.key === 'file' && snapshot.script) {
      title.append(node('p', snapshot.script, 'hint'));
    }
    heading.append(title);
    const tools = node('div', undefined, 'entry-tools');
    const existing = draft.key !== 'new' && !['file', 'current', 'project'].includes(draft.key);
    if (section === 'run' && existing) {
      tools.append(
        button(
          t('Duplicate'),
          () => {
            const from = copy(draft);
            switchTo(() => newDraft(from));
          },
          undefined,
          busy
        )
      );
    }
    if (section !== 'sync' && existing) {
      tools.append(button(t('Remove'), requestDelete, undefined, busy || conflict));
    }
    if (tools.childElementCount) heading.append(tools);
    editor.append(heading);
    const form = node('form');
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (dirty) apply();
    });
    ({ run: runEditor, servers: sshEditor, interpreters: pythonEditor, sync: syncEditor })[section](
      form
    );
    form.append(feedback);
    editor.append(form);
    if (section !== 'sync' && existing) editor.append(deleteDialog());
  }
  if (!feedback.parentElement) editor.append(feedback);
  mountColumns(sidebar, list, editor, scrollPositions);
  if (focusField) {
    document.getElementById('field-' + focusField)?.focus();
    focusField = undefined;
  }
}

function updateEditorFeedback() {
  const feedback = root.querySelector('.editor-feedback');
  if (!feedback) return;
  const status = node(
    'div',
    t(
      conflict
        ? 'runhop.json changed while you were editing. Your draft is still open.'
        : (locale === 'zh-CN' && noticeZh) || notice || (dirty ? 'Unsaved changes' : '')
    ),
    'status'
  );
  status.setAttribute('role', 'status');
  if (failed || conflict) status.classList.add('error');
  const actions = node('div', undefined, 'editor-actions');
  if (conflict || (failed && !draft)) {
    actions.append(
      button(
        t('Reload'),
        () => switchTo(() => send('reload', { focus: { section, key: draft?.key } })),
        undefined,
        busy
      )
    );
  }
  if (draft && draft.key !== 'current') {
    actions.setAttribute('role', 'group');
    actions.setAttribute('aria-label', t('Actions for {0}', entryLabel(draft)));
    actions.append(
      button(t('Discard Changes'), () => discard(), undefined, busy || !dirty),
      button(t('Apply'), () => apply(), undefined, busy || !dirty || conflict),
      button(
        t('Save'),
        () => {
          if (dirty) apply(() => send('close'));
          else send('close');
        },
        'primary',
        busy || conflict
      )
    );
  }
  feedback.replaceChildren();
  if (status.textContent) feedback.append(status);
  if (actions.childElementCount) feedback.append(actions);
}

window.addEventListener('message', ({ data: message }) => {
  if (message.type === 'language') {
    const openDialog = root.querySelector('dialog[open]')?.id;
    const restoreFocus =
      document.activeElement === document.body ||
      document.activeElement?.id === 'configuration-language';
    languagePending = false;
    languageError = message.error;
    languageMode = message.mode;
    locale = message.locale;
    document.documentElement.lang = locale;
    render();
    if (openDialog) document.getElementById(openDialog)?.showModal();
    else if (restoreFocus) document.getElementById('configuration-language')?.focus();
  } else if (message.type === 'snapshot') {
    if (!message.force && dirty) {
      const changed = snapshot?.revision !== message.revision;
      if (changed || conflict) {
        newerSnapshot = changed ? message : undefined;
        conflict = changed;
        setNotice();
        const dialogApply = document.querySelector('#unsaved-dialog .primary');
        if (dialogApply) dialogApply.disabled = conflict;
      }
      return;
    }
    if (
      !message.force &&
      snapshot?.folder === message.folder &&
      snapshot?.revision === message.revision
    ) {
      if (JSON.stringify(snapshot.folders) !== JSON.stringify(message.folders)) {
        snapshot = message;
        render();
      }
      return;
    }
    const currentKey = snapshot?.folder === message.folder ? draft?.key : undefined;
    snapshot = message;
    newerSnapshot = undefined;
    busy = false;
    const focus = message.focus;
    choose(focus?.section ?? section, focus ? focus.key : currentKey, focus?.field, focus?.create);
    if (message.applied) {
      setNotice('Saved to runhop.json.');
      const next = afterApply;
      afterApply = undefined;
      next?.();
    }
  } else if (message.type === 'navigate') {
    switchTo(() => {
      settingsOpen = false;
      send('navigate', { folder: message.folder, script: message.script, focus: message.focus });
    });
  } else if (message.type === 'error') {
    afterApply = undefined;
    busy = false;
    if (message.source) {
      newerSnapshot = undefined;
      if (snapshot?.folder === message.folder && dirty) {
        snapshot = { ...snapshot, folders: message.folders };
        conflict = true;
      } else {
        snapshot = { folder: message.folder, folders: message.folders };
        draft = undefined;
        dirty = false;
        conflict = false;
      }
    }
    setNotice(message.error, true, message.errorZh);
    render();
  } else if (message.type === 'browse') {
    if (draft) change(message.field, message.value, true);
  } else if (message.type === 'sshAliases') {
    if (openPicker?.request === message.request) openPicker.receive(message);
  } else if (message.type === 'probe') {
    if (message.kind === 'discover') {
      discoveredInterpreters.set(discoveryKey(), message.candidates);
      busy = false;
      setNotice();
      render();
      document.getElementById('choose-path')?.click();
      return;
    }
    if (message.kind === 'python') verifiedInterpreters.set(interpreterProbeKey(), message);
    probe = message;
    setNotice();
    render();
  } else if (message.type === 'done') {
    if (busy) {
      busy = false;
      render();
    }
  }
});

function dismissPicker(event) {
  if (openPicker && !openPicker.group.contains(event.target)) openPicker.close();
}

window.addEventListener('pointerdown', dismissPicker);
window.addEventListener('focusin', dismissPicker);

window.addEventListener('keydown', event => {
  if (
    !settingsOpen &&
    (event.metaKey || event.ctrlKey) &&
    event.key.toLowerCase() === 's' &&
    dirty &&
    !busy
  ) {
    event.preventDefault();
    apply();
  }
});

new ResizeObserver(() => updateColumnWidths()).observe(root);
render();
send('ready');
