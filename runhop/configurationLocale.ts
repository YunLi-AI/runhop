export type ConfigurationLanguageMode = 'auto' | 'zh-CN' | 'en';
export type ConfigurationLocale = Exclude<ConfigurationLanguageMode, 'auto'>;

export function isConfigurationLanguageMode(value: unknown): value is ConfigurationLanguageMode {
  return value === 'auto' || value === 'zh-CN' || value === 'en';
}

export function configurationLocale(
  mode: ConfigurationLanguageMode,
  vscodeLanguage: string
): ConfigurationLocale {
  if (mode !== 'auto') return mode;
  return /^zh(?:[-_]|$)/i.test(vscodeLanguage) ? 'zh-CN' : 'en';
}

const chinese: Record<string, string> = {
  'RunHop Configurations': 'RunHop 配置中心',
  Settings: '设置',
  Appearance: '外观',
  'Interface Language': '界面语言',
  'Changes apply immediately. This preference is saved on this machine for all projects.':
    '切换立即生效。此偏好保存在本机，适用于所有项目。',
  'Follow VS Code': '跟随 VS Code',
  'Could not save the interface language.': '无法保存界面语言。',
  'Workspace Folder': '工作区文件夹',
  'Open JSON': '打开 JSON',
  'Open Configurations': '打开配置中心',
  'Configuration Sections': '配置类别',
  'Configuration Entries': '配置列表',
  'Configuration Details': '配置详情',
  'Resize configuration categories': '调整配置类别宽度',
  'Resize configuration list': '调整配置列表宽度',
  'Run / Debug': '运行 / 调试',
  'SSH Servers': 'SSH 服务器',
  'Remote Interpreters': '远程解释器',
  Synchronization: '同步',
  Configurations: '运行配置',
  'Saved servers': '已保存的服务器',
  'Saved interpreters': '已保存的解释器',
  'Project and targets': '项目与同步目标',
  'Current Python File': '当前 Python 文件',
  'Project defaults': '项目默认设置',
  'SSH server {0}': 'SSH 服务器 {0}',
  'Copy Run Configuration': '复制运行配置',
  'New Run Configuration': '新建运行配置',
  'New SSH Server': '新建 SSH 服务器',
  'New Remote Interpreter': '新建远程解释器',
  'Add…': '添加…',
  'No saved entries.': '暂无已保存的配置。',
  Active: '当前使用',
  Default: '默认',
  'Open runhop.json to fix the problem or reload the editor.':
    '请打开 runhop.json 修正问题，或重新加载配置中心。',
  'Loading project settings…': '正在加载项目配置…',
  'This project has no runhop.json. Apply a configuration before running or debugging.':
    '此项目还没有 runhop.json。请先应用配置，再运行或调试。',
  'Save a RunHop configuration before running or debugging this project.':
    '请先保存此项目的 RunHop 配置，再运行或调试。',
  'Add an SSH server to use remote Python.': '添加 SSH 服务器后即可使用远程 Python。',
  'Add a remote Python interpreter.': '添加远程 Python 解释器。',
  Duplicate: '复制',
  Remove: '移除',
  'Remove configuration?': '移除此配置？',
  'Remove {0} from runhop.json.': '从 runhop.json 中移除「{0}」。',
  Cancel: '取消',
  'Unsaved changes': '有未保存的更改',
  'Keep Editing': '继续编辑',
  'Discard and Continue': '放弃更改并继续',
  'Apply and Continue': '应用并继续',
  'Apply or discard the changes before leaving this entry.': '离开此配置前，请应用或放弃更改。',
  'runhop.json changed while you were editing. Your draft is still open.':
    '编辑期间 runhop.json 已发生更改。当前草稿仍然保留。',
  Reload: '重新加载',
  'Actions for {0}': '「{0}」的操作',
  'Discard Changes': '放弃更改',
  Apply: '应用',
  Save: '保存',
  'Saved to runhop.json.': '已保存到 runhop.json。',
  'Open a Python file to edit its arguments and launch settings.':
    '打开一个 Python 文件即可编辑其参数和启动设置。',
  'Use Current Python File': '使用当前 Python 文件',
  Launch: '启动',
  'Configuration Name': '配置名称',
  Execute: '启动方式',
  Script: '脚本',
  'Python module': 'Python 模块',
  'Module Name': '模块名称',
  'Script Path': '脚本路径',
  'Run On': '运行位置',
  Automatic: '自动',
  'SSH server': 'SSH 服务器',
  'Local Python': '本地 Python',
  'Local Interpreter': '本地解释器',
  'Leave blank to detect your local Python.': '留空以自动检测本地 Python。',
  'Remote Interpreter': '远程解释器',
  'Use project / script default': '使用项目或脚本的默认设置',
  'Run the current Python file from the toolbar': '通过工具栏运行或调试当前 Python 文件',
  'Use this configuration for toolbar Run and Debug': '在工具栏中使用此配置运行和调试',
  Execution: '执行参数',
  'Program Arguments': '脚本参数',
  'Quote arguments that contain spaces.': '请为含空格的参数加上引号。',
  'Working Directory': '工作目录',
  'Local directory mapped to the server for remote runs.':
    '远程运行时，此本地目录会映射到服务器上的对应目录。',
  'Environment Variables': '环境变量',
  'Variable {0} name': '第 {0} 个变量的名称',
  'Variable {0} value': '第 {0} 个变量的值',
  NAME: '名称',
  Value: '值',
  'Saved value': '已保存的值',
  'Add Variable': '添加变量',
  Deployment: '部署',
  'Sync Before Launch': '启动前同步',
  'Use project default': '使用项目默认设置',
  'Changed Files': '仅同步变更',
  'Project Scan': '扫描项目',
  Off: '关闭',
  'Download Results': '下载结果',
  'One remote project-relative file or folder per line.':
    '每行填写一个相对于远程项目根目录的文件或文件夹路径。',
  Debugger: '调试器',
  'Debug only project code': '仅调试项目代码',
  'Stop on entry': '启动后在入口暂停',
  'Local Project Root': '本地项目根目录',
  'Relative to this workspace folder.': '相对于当前工作区文件夹。',
  'Remote Project Root': '远程项目根目录',
  'Absolute or relative to the SSH login directory.': '可填写绝对路径或相对于 SSH 登录目录的路径。',
  Connection: '连接',
  'Server Name': '服务器名称',
  Host: '主机',
  'SSH hostname or OpenSSH alias': 'SSH 主机名或 OpenSSH 别名',
  'Leave Port and Username blank to use the alias settings.':
    '端口和用户名可留空，以使用 SSH 别名中的设置。',
  Port: '端口',
  '22 or OpenSSH default': '22 或 OpenSSH 默认值',
  Username: '用户名',
  'Use OpenSSH setting': '使用 OpenSSH 设置',
  Authentication: '身份验证',
  Method: '验证方式',
  'OpenSSH configuration': 'OpenSSH 配置',
  'Identity file': '密钥文件',
  'SSH agent': 'SSH 代理',
  'Password prompt / saved password': '输入密码或使用已保存的密码',
  'SSH Config File': 'SSH 配置文件',
  'Identity File': '密钥文件',
  'Prompt for an encrypted key passphrase': '提示输入密钥口令',
  'Agent Socket': 'SSH 代理套接字',
  'RunHop uses the VS Code password prompt and SecretStorage.':
    'RunHop 使用 VS Code 的密码输入框和安全存储。',
  'Project Mapping': '项目映射',
  'Default SSH Profile': '默认 SSH 连接配置',
  'Use base server settings': '使用服务器基本设置',
  'Test Connection': '测试连接',
  'Connected to {0}:{1} · {2}': '已连接到 {0}:{1} · {2}',
  'Project root {0}': '项目根目录 {0}',
  'Project root is not accessible yet.': '暂时无法访问项目根目录。',
  'Python Environment': 'Python 环境',
  'Interpreter Name': '解释器名称',
  'SSH Server': 'SSH 服务器',
  'Match project mapping': '按项目映射选择',
  'SSH Profile': 'SSH 连接配置',
  'Use server default': '使用服务器默认设置',
  'Python Executable': 'Python 可执行文件',
  'Verify Interpreter': '验证解释器',
  'Python Version': 'Python 版本',
  Environment: '环境类型',
  Executable: '可执行文件',
  Prefix: '环境目录',
  'Conda Environment': 'Conda 环境',
  'Virtual environment': '虚拟环境',
  'System / standalone': '系统 / 独立安装',
  Activation: '环境激活',
  'Conda Executable': 'Conda 可执行文件',
  'Optional path for Remote Terminal activation.': '可选。远程终端激活环境时使用此路径。',
  'Use as the default remote interpreter': '设为默认远程解释器',
  'Upload Policy': '上传策略',
  'Upload eligible files when saved': '保存时上传符合规则的文件',
  'Changed Files deploys once, then uploads local changes. Project Scan compares files at every launch. Off skips launch sync.':
    '「仅同步变更」首次部署后只上传本地改动。「扫描项目」每次启动时比较文件。「关闭」会跳过启动前同步。',
  'Path Mapping': '路径映射',
  Exclusions: '排除规则',
  'Excluded Paths': '排除的路径',
  'One gitignore-style pattern per line, relative to the local project root.':
    '每行填写一条 gitignore 风格的规则，路径相对于本地项目根目录。',
  'Ignore File': '忽略规则文件',
  'Upload on Save and launch synchronization use this mapping. Review the remote root before the next upload.':
    '保存时上传与启动前同步均使用此映射。下次上传前请确认远程项目根目录。',
  'Testing SSH connection…': '正在测试 SSH 连接…',
  'Checking Python on the server…': '正在检查服务器上的 Python…',
  'Discovered on server': '在服务器上发现',
  'OpenSSH alias': 'OpenSSH 别名',
  'Choose an SSH host': '选择 SSH 主机',
  'Choose a Python executable': '选择 Python 可执行文件',
  'Filter SSH hosts': '筛选 SSH 主机',
  'Filter Python executables': '筛选 Python 可执行文件',
  'Reading OpenSSH aliases…': '正在读取 OpenSSH 别名…',
  'Type to filter the remaining entries.': '输入关键词以筛选其余条目。',
  'No matching entries.': '无匹配条目。',
  'No SSH aliases found. You can enter a host manually.': '未找到 SSH 别名，可以手动输入主机。',
  'Discover Python on the server or enter an executable manually.':
    '可搜索服务器上的 Python，或手动输入可执行文件路径。',
  'Discover on Server…': '在服务器上查找…',
  '{0} (unavailable)': '{0}（不可用）',
  'Browse…': '浏览…',
  'Choose a RunHop project': '选择 RunHop 项目',
  'Open a local project folder first.': '请先打开本地项目文件夹。',
  'RunHop Configurations requires a trusted local workspace.':
    '请在受信任的本地工作区中打开 RunHop 配置中心。',
  'This folder was removed from the workspace. Select another project.':
    '此文件夹已从工作区移除，请选择其他项目。',
  'The project is no longer in this workspace.': '此项目已不在当前工作区中。',
  'The project is no longer selected. Reload the configuration editor.':
    '当前项目已取消选中，请重新加载配置中心。',
  'Choose a path inside this workspace.': '请选择当前工作区内的路径。',
  'runhop.json changed. Reload before applying or testing your draft.':
    'runhop.json 已发生更改。请重新加载后再应用或测试草稿。',
  'Invalid configuration selection.': '所选配置无效。',
  'Invalid configuration fields.': '配置字段无效。',
  'Invalid {0}.': '字段 {0} 无效。',
  'Enter a valid SSH server name.': '请输入有效的 SSH 服务器名称。',
  'Enter a valid run configuration name.': '请输入有效的运行配置名称。',
  'Enter a valid interpreter name.': '请输入有效的解释器名称。',
  'Enter a single path for {0}.': '字段 {0} 只能填写一个路径。',
  'This entry no longer exists.': '此配置已不存在。',
  'Select an SSH server.': '请选择 SSH 服务器。',
  'This SSH server no longer exists.': '此 SSH 服务器已不存在。',
  'Choose an existing file inside the workspace.': '请选择工作区中已存在的文件。',
  'Choose an existing directory inside the workspace.': '请选择工作区中已存在的目录。',
  'Expected a file at {0}.': '路径「{0}」应指向文件。',
  'Expected a directory at {0}.': '路径「{0}」应指向目录。',
  'An entry already uses the name {0}.': '名称「{0}」已被其他配置使用。',
  'An SSH server already uses the name {0}.': '名称「{0}」已被其他 SSH 服务器使用。',
  'Invalid environment variables.': '环境变量无效。',
  'Enter a unique environment variable name.': '请输入有效且不重复的环境变量名称。',
  'The saved environment value is unavailable.': '无法获取已保存的环境变量值。',
  'Choose a valid synchronization mode.': '请选择有效的同步模式。',
  'Enter the remote project root.': '请输入远程项目根目录。',
  'Enter a hostname, IP address or OpenSSH alias.': '请输入主机名、IP 地址或 OpenSSH 别名。',
  'Enter a valid SSH username.': '请输入有效的 SSH 用户名。',
  'Port must be between 1 and 65535.': '端口必须在 1 到 65535 之间。',
  'Choose an SSH authentication method.': '请选择 SSH 身份验证方式。',
  'Choose an SSH identity file.': '请选择 SSH 密钥文件。',
  'Select an existing SSH profile.': '请选择已存在的 SSH 连接配置。',
  'Select an existing SSH server.': '请选择已存在的 SSH 服务器。',
  'Select a run configuration.': '请选择运行配置。',
  'Enter an existing script path or a dotted Python module name.':
    '请输入已存在的脚本路径，或使用点分隔的 Python 模块名。',
  'Choose a run location.': '请选择运行位置。',
  'Select a remote interpreter.': '请选择远程解释器。',
  'The script and working directory must be within the SSH project mapping.':
    '脚本和工作目录必须位于 SSH 项目映射的本地根目录内。',
  'Change the interpreter in {0} before removing it.':
    '移除此解释器前，请先更改「{0}」关联的解释器。',
  'Move or remove the interpreters linked to this SSH server first.':
    '请先更换或移除关联到此 SSH 服务器的解释器。',
  'The remote interpreter check timed out.': '检查远程解释器超时。',
  'The remote command failed.': '远程命令执行失败。',
  'The remote Python returned invalid version information.': '远程 Python 返回的版本信息无效。',
  'The remote Python returned incomplete version information.':
    '远程 Python 返回的版本信息不完整。',
  'The operation failed.': '操作失败。',
};

export function configurationText(
  locale: ConfigurationLocale,
  message: string,
  ...args: (string | number)[]
): string {
  const template =
    locale === 'zh-CN' && Object.hasOwn(chinese, message) ? chinese[message] : message;
  return args.length
    ? template.replace(/\{(\d+)\}/g, (match, index) => String(args[index] ?? match))
    : template;
}

export class ConfigurationInputError extends Error {
  readonly values: (string | number)[];

  constructor(
    readonly template: string,
    ...values: (string | number)[]
  ) {
    super(configurationText('en', template, ...values));
    this.values = values;
  }
}
