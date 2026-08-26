import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  AppWindow,
  ArrowRight,
  Check,
  ChevronRight,
  Clock3,
  Copy,
  ExternalLink,
  FileImage,
  FolderOpen,
  Globe2,
  HardDrive,
  History as HistoryIcon,
  Home,
  Info,
  Keyboard,
  LoaderCircle,
  Monitor,
  MoreHorizontal,
  Pin,
  RefreshCw,
  Rows3,
  Save,
  ScanLine,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
  Timer,
  Trash2,
  X
} from 'lucide-react'
import type {
  AppSettings,
  CaptureAsset,
  CaptureMode,
  DesktopSourcePreview,
  HistoryItem,
  PermissionState,
  ShortcutAction,
  ShortcutDefinition
} from '../../../shared/types'
import Editor from './Editor'

type Page = 'home' | 'history' | 'settings' | 'about'
type ToastTone = 'info' | 'success' | 'error'

interface ToastState {
  message: string
  tone: ToastTone
}

const shortcutLabels: Record<ShortcutAction, string> = {
  captureRegion: '区域截图',
  captureWindow: '窗口截图',
  captureFullscreen: '全屏截图',
  captureScroll: '长截图',
  captureDelay: '延时截图',
  repeatLastRegion: '重复上一区域',
  openHistory: '打开历史',
  openDashboard: '打开工作台',
  stopScrollCapture: '停止长截图'
}

const navItems: Array<{ id: Page; label: string; icon: typeof Home }> = [
  { id: 'home', label: '截图工作台', icon: Home },
  { id: 'history', label: '最近记录', icon: HistoryIcon },
  { id: 'settings', label: '偏好设置', icon: SettingsIcon },
  { id: 'about', label: '关于 Brclio', icon: Info }
]

const pageMeta: Record<Page, { eyebrow: string; title: string; description: string }> = {
  home: { eyebrow: 'CAPTURE DESK', title: '截图工作台', description: '选一种方式，马上开始。' },
  history: { eyebrow: 'LOCAL ARCHIVE', title: '最近记录', description: '仅保存在这台设备上的截图。' },
  settings: { eyebrow: 'PREFERENCES', title: '偏好设置', description: '保存、快捷键与长截图都在这里。' },
  about: { eyebrow: 'ABOUT', title: '关于 Brclio Shot', description: '为 macOS 与 Windows 打造的本地截图工具。' }
}

const captureCards: Array<{
  mode: CaptureMode
  title: string
  description: string
  shortcut: string
  accent: 'blue' | 'yellow' | 'red'
  icon: typeof ScanLine
}> = [
  { mode: 'region', title: '区域截图', description: '冻结画面后精确框选，支持像素级微调。', shortcut: '1', accent: 'blue', icon: ScanLine },
  { mode: 'window', title: '窗口截图', description: '先预览窗口，再捕获当前应用画面。', shortcut: '2', accent: 'yellow', icon: AppWindow },
  { mode: 'fullscreen', title: '全屏截图', description: '捕获当前显示器的完整画面。', shortcut: '3', accent: 'red', icon: Monitor },
  { mode: 'scroll', title: '长截图', description: '边滚动边拼接，可随时完成或取消。', shortcut: '4', accent: 'blue', icon: Rows3 },
  { mode: 'delay', title: '延时截图', description: '预留 3、5 或 10 秒准备界面状态。', shortcut: '5', accent: 'yellow', icon: Timer },
  { mode: 'webpage', title: '网页整页', description: '输入网址，捕获完整网页而不只是一屏。', shortcut: '6', accent: 'red', icon: Globe2 }
]

const actionCopy: Record<string, string> = {
  editor: '进入编辑器',
  clipboard: '复制到剪贴板',
  save: '直接保存'
}

function formatDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

function formatAccelerator(value: string, platform: string): string {
  if (platform !== 'darwin') return value.replaceAll('+', ' + ')
  return value
    .replace(/CommandOrControl|Command|Cmd/gi, '⌘')
    .replace(/Control|Ctrl/gi, '⌃')
    .replace(/Option|Alt/gi, '⌥')
    .replace(/Shift/gi, '⇧')
    .replaceAll('+', '')
}

function captureLabel(mode: CaptureMode): string {
  return captureCards.find((card) => card.mode === mode)?.title ?? mode
}

function Toggle({
  checked,
  onChange,
  label,
  description
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  description?: string
}): React.JSX.Element {
  return (
    <label className="toggle-row">
      <span><strong>{label}</strong>{description && <small>{description}</small>}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <i aria-hidden="true"><span /></i>
    </label>
  )
}

function EmptyState({ icon: Icon, title, copy }: { icon: typeof HistoryIcon; title: string; copy: string }): React.JSX.Element {
  return (
    <div className="empty-state">
      <span><Icon size={25} /></span>
      <strong>{title}</strong>
      <p>{copy}</p>
    </div>
  )
}

function SourcePicker({
  sources,
  loading,
  onRefresh,
  onSelect,
  onClose
}: {
  sources: DesktopSourcePreview[]
  loading: boolean
  onRefresh: () => void
  onSelect: (source: DesktopSourcePreview) => void
  onClose: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const filtered = sources.filter((source) => source.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="source-dialog" role="dialog" aria-modal="true" aria-labelledby="source-title">
        <header className="dialog-header">
          <div><span className="eyebrow">WINDOW SOURCE</span><h2 id="source-title">选择要截取的窗口</h2></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭窗口选择"><X size={19} /></button>
        </header>
        <div className="source-tools">
          <label className="search-field"><Search size={16} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索窗口名称" /></label>
          <button type="button" className="quiet-button" onClick={onRefresh} disabled={loading}><RefreshCw size={15} className={loading ? 'is-spinning' : ''} /> 刷新</button>
        </div>
        <div className="source-grid">
          {loading && sources.length === 0 ? (
            <div className="source-loading"><LoaderCircle size={22} className="is-spinning" /> 正在读取窗口…</div>
          ) : filtered.length === 0 ? (
            <EmptyState icon={AppWindow} title="没有找到窗口" copy="请打开目标应用后刷新。Brclio Shot 自身不会出现在列表里。" />
          ) : filtered.map((source) => (
            <button type="button" className="source-card" key={source.id} onClick={() => onSelect(source)}>
              <span className="source-preview"><img src={source.thumbnailDataUrl} alt="" /></span>
              <span className="source-name">
                {source.appIconDataUrl && <img src={source.appIconDataUrl} alt="" />}
                <strong>{source.name}</strong>
                <small>{source.width} × {source.height}</small>
              </span>
            </button>
          ))}
        </div>
        <footer className="dialog-footer"><ShieldCheck size={15} /> 列表与预览仅在本机读取，不会上传。</footer>
      </section>
    </div>
  )
}

function DelayDialog({ onSelect, onClose }: { onSelect: (seconds: number) => void; onClose: () => void }): React.JSX.Element {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="small-dialog" role="dialog" aria-modal="true" aria-labelledby="delay-title">
        <header className="dialog-header"><div><span className="eyebrow">TIMER</span><h2 id="delay-title">延时多久？</h2></div><button className="icon-button" type="button" onClick={onClose}><X size={19} /></button></header>
        <div className="delay-options">
          {[3, 5, 10].map((seconds) => <button type="button" key={seconds} onClick={() => onSelect(seconds)}><strong>{seconds}</strong><span>秒</span></button>)}
        </div>
        <p className="dialog-note">倒计时结束后会自动进入区域选择。</p>
      </section>
    </div>
  )
}

function WebpageDialog({ onSubmit, onClose }: { onSubmit: (url: string) => void; onClose: () => void }): React.JSX.Element {
  const [url, setUrl] = useState('https://')
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="small-dialog" role="dialog" aria-modal="true" aria-labelledby="webpage-title" onSubmit={(event) => { event.preventDefault(); onSubmit(url) }}>
        <header className="dialog-header"><div><span className="eyebrow">FULL PAGE</span><h2 id="webpage-title">网页整页截图</h2></div><button className="icon-button" type="button" onClick={onClose}><X size={19} /></button></header>
        <label className="form-field"><span>网页地址</span><input autoFocus value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com" inputMode="url" /></label>
        <p className="dialog-note">动态内容、登录页面与受保护视频可能无法完整捕获。</p>
        <div className="dialog-actions"><button type="button" className="quiet-button" onClick={onClose}>取消</button><button type="submit" className="primary-button"><Globe2 size={16} /> 开始捕获</button></div>
      </form>
    </div>
  )
}

function HomePage({
  settings,
  permission,
  history,
  busyMode,
  onCapture,
  onOpenHistory,
  onOpenHistoryItem,
  onRequestPermission
}: {
  settings: AppSettings | null
  permission: PermissionState | null
  history: HistoryItem[]
  busyMode: CaptureMode | null
  onCapture: (mode: CaptureMode) => void
  onOpenHistory: () => void
  onOpenHistoryItem: (item: HistoryItem) => void
  onRequestPermission: () => void
}): React.JSX.Element {
  const permissionOkay = !permission || permission.screen === 'granted' || permission.screen === 'not-needed'
  return (
    <div className="page-stack home-page">
      {!permissionOkay && (
        <section className="permission-banner">
          <span className="permission-icon"><AlertCircle size={20} /></span>
          <div><strong>需要屏幕录制权限</strong><p>macOS 需要授权后才能读取屏幕画面；设置只会在你点击时打开。</p></div>
          <button type="button" className="primary-button" onClick={onRequestPermission}>检查并授权</button>
        </section>
      )}

      <section className="capture-launcher" aria-labelledby="capture-title">
        <div className="section-heading">
          <div><span className="eyebrow">QUICK CAPTURE</span><h2 id="capture-title">你想截取什么？</h2></div>
          <span className="default-action"><Sparkles size={14} /> 完成后：{settings ? actionCopy[settings.afterCapture] : '载入中'}</span>
        </div>
        <div className="capture-grid">
          {captureCards.map((card, index) => {
            const Icon = card.icon
            const isBusy = busyMode === card.mode
            return (
              <button
                type="button"
                className={`capture-card accent-${card.accent}`}
                key={card.mode}
                onClick={() => onCapture(card.mode)}
                disabled={busyMode !== null}
                style={{ '--capture-index': index } as React.CSSProperties}
              >
                <span className="capture-icon">{isBusy ? <LoaderCircle size={23} className="is-spinning" /> : <Icon size={23} />}</span>
                <span className="capture-copy"><strong>{card.title}</strong><small>{card.description}</small></span>
                <kbd>{card.shortcut}</kbd>
                <ChevronRight size={17} className="capture-arrow" />
              </button>
            )
          })}
        </div>
      </section>

      <div className="home-lower-grid">
        <section className="recent-panel">
          <div className="section-heading compact"><div><span className="eyebrow">RECENT</span><h2>最近截图</h2></div><button type="button" className="text-button" onClick={onOpenHistory}>查看全部 <ArrowRight size={14} /></button></div>
          {history.length === 0 ? (
            <EmptyState icon={HistoryIcon} title="第一张截图会出现在这里" copy="截图记录默认只保留在本地，你也可以在设置中关闭历史。" />
          ) : (
            <div className="recent-strip">
              {history.slice(0, 4).map((item) => (
                <button type="button" className="recent-item" key={item.id} onClick={() => onOpenHistoryItem(item)}>
                  <img src={item.thumbnailDataUrl} alt={`${captureLabel(item.mode)}缩略图`} />
                  <span><strong>{captureLabel(item.mode)}</strong><small>{formatDate(item.createdAt)} · {item.width}×{item.height}</small></span>
                </button>
              ))}
            </div>
          )}
        </section>

        <aside className="privacy-panel">
          <div className="privacy-seal"><ShieldCheck size={27} /><span>LOCAL<br />FIRST</span></div>
          <div><span className="eyebrow">PRIVACY STATUS</span><h2>截图内容不会离开设备</h2><p>核心截图、编辑与历史记录全部在本地完成。Brclio Shot 不读取截图内容做分析。</p></div>
          <div className="privacy-facts"><span><Check size={14} /> 无云端上传</span><span><Check size={14} /> 本地历史可关闭</span><span><Check size={14} /> 权限按需请求</span></div>
        </aside>
      </div>
    </div>
  )
}

function HistoryPage({
  history,
  loading,
  onRefresh,
  onOpen,
  onDelete,
  onClear,
  onReveal
}: {
  history: HistoryItem[]
  loading: boolean
  onRefresh: () => void
  onOpen: (item: HistoryItem) => void
  onDelete: (item: HistoryItem) => void
  onClear: () => void
  onReveal: (path: string) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const filtered = history.filter((item) => `${captureLabel(item.mode)} ${item.sourceName ?? ''} ${item.createdAt}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))

  return (
    <div className="page-stack">
      <section className="history-toolbar">
        <label className="search-field"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索类型、来源或日期" /></label>
        <button type="button" className="quiet-button" onClick={onRefresh} disabled={loading}><RefreshCw size={15} className={loading ? 'is-spinning' : ''} /> 刷新</button>
        <button type="button" className="danger-button" onClick={onClear} disabled={history.length === 0}><Trash2 size={15} /> 清空记录</button>
      </section>
      {filtered.length === 0 ? (
        <EmptyState icon={HistoryIcon} title={query ? '没有匹配的截图' : '还没有截图记录'} copy={query ? '换个关键词试试。' : '从截图工作台完成一张截图后，记录会显示在这里。'} />
      ) : (
        <section className="history-grid">
          {filtered.map((item) => (
            <article className="history-card" key={item.id}>
              <button type="button" className="history-preview" onClick={() => onOpen(item)} aria-label={`编辑 ${captureLabel(item.mode)}`}>
                <img src={item.thumbnailDataUrl} alt="" />
                <span className="history-size">{item.width} × {item.height}</span>
              </button>
              <div className="history-meta">
                <div><strong>{item.sourceName || captureLabel(item.mode)}</strong><span>{formatDate(item.createdAt)} · {captureLabel(item.mode)}</span></div>
                <div className="history-actions">
                  {item.filePath && <button type="button" onClick={() => onReveal(item.filePath!)} aria-label="在文件夹中显示"><FolderOpen size={15} /></button>}
                  <button type="button" onClick={() => onDelete(item)} aria-label="删除记录"><Trash2 size={15} /></button>
                  <button type="button" onClick={() => onOpen(item)} aria-label="打开编辑器"><ExternalLink size={15} /></button>
                </div>
              </div>
            </article>
          ))}
        </section>
      )}
    </div>
  )
}

function SettingsPage({
  settings,
  shortcuts,
  onChooseDirectory,
  onSave
}: {
  settings: AppSettings | null
  shortcuts: ShortcutDefinition[]
  onChooseDirectory: () => Promise<string | null>
  onSave: (settings: AppSettings) => Promise<void>
}): React.JSX.Element {
  const [draft, setDraft] = useState<AppSettings | null>(settings)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    setDraft(settings)
    setDirty(false)
  }, [settings])

  const patch = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void => {
    setDraft((current) => current ? { ...current, [key]: value } : current)
    setDirty(true)
  }
  const shortcutPatch = (action: ShortcutAction, value: string): void => {
    if (!draft) return
    patch('shortcuts', { ...draft.shortcuts, [action]: value })
  }

  if (!draft) return <div className="settings-loading"><LoaderCircle size={20} className="is-spinning" /> 正在读取偏好设置…</div>

  const chooseDirectory = async (): Promise<void> => {
    const path = await onChooseDirectory()
    if (path) patch('saveDirectory', path)
  }
  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await onSave(draft)
      setDirty(false)
    } finally {
      setSaving(false)
    }
  }

  const shortcutState = new Map(shortcuts.map((item) => [item.action, item]))

  return (
    <div className="settings-layout">
      <div className="settings-column">
        <section className="settings-section">
          <header><span className="settings-icon blue"><FolderOpen size={18} /></span><div><h2>保存与文件</h2><p>决定截图放在哪里，以及文件如何命名。</p></div></header>
          <div className="settings-body">
            <label className="form-field full"><span>默认保存路径</span><div className="path-field"><input readOnly value={draft.saveDirectory} /><button type="button" className="quiet-button" onClick={chooseDirectory}>选择…</button></div></label>
            <div className="form-grid two">
              <label className="form-field"><span>图片格式</span><select value={draft.imageFormat} onChange={(event) => patch('imageFormat', event.target.value as AppSettings['imageFormat'])}><option value="png">PNG · 无损</option><option value="jpeg">JPEG · 更小</option><option value="webp">WebP · 高压缩</option></select></label>
              <label className="form-field"><span>完成后默认动作</span><select value={draft.afterCapture} onChange={(event) => patch('afterCapture', event.target.value as AppSettings['afterCapture'])}><option value="editor">进入编辑器</option><option value="clipboard">复制到剪贴板</option><option value="save">直接保存</option></select></label>
            </div>
            {draft.imageFormat === 'jpeg' && <label className="range-field"><span><strong>JPEG 质量</strong><small>{draft.jpegQuality}%</small></span><input type="range" min="40" max="100" value={draft.jpegQuality} onChange={(event) => patch('jpegQuality', Number(event.target.value))} /></label>}
            <label className="form-field full"><span>文件名模板</span><input value={draft.fileNameTemplate} onChange={(event) => patch('fileNameTemplate', event.target.value)} /><small>可用：{'{date} {time} {mode} {timestamp}'}</small></label>
            <Toggle label="保存后同时复制" description="方便直接粘贴到聊天或文档。" checked={draft.copyAfterSave} onChange={(value) => patch('copyAfterSave', value)} />
          </div>
        </section>

        <section className="settings-section">
          <header><span className="settings-icon yellow"><Rows3 size={18} /></span><div><h2>长截图</h2><p>控制抓帧节奏、长度与重叠判断。</p></div></header>
          <div className="settings-body">
            <label className="range-field"><span><strong>采集间隔</strong><small>{draft.scrollIntervalMs} ms</small></span><input type="range" min="250" max="1800" step="50" value={draft.scrollIntervalMs} onChange={(event) => patch('scrollIntervalMs', Number(event.target.value))} /></label>
            <label className="range-field"><span><strong>最大帧数</strong><small>{draft.scrollMaxFrames} 帧</small></span><input type="range" min="10" max="160" step="5" value={draft.scrollMaxFrames} onChange={(event) => patch('scrollMaxFrames', Number(event.target.value))} /></label>
            <label className="range-field"><span><strong>重叠匹配阈值</strong><small>{Math.round(draft.scrollOverlapThreshold * 100)}%</small></span><input type="range" min="50" max="99" value={draft.scrollOverlapThreshold * 100} onChange={(event) => patch('scrollOverlapThreshold', Number(event.target.value) / 100)} /></label>
            <div className="setting-callout"><AlertCircle size={16} /><p>达到安全上限时会保留已采集内容，并让你保存当前结果，不会丢图。</p></div>
          </div>
        </section>

        <section className="settings-section">
          <header><span className="settings-icon red"><HardDrive size={18} /></span><div><h2>应用与隐私</h2><p>后台行为、通知和本地记录。</p></div></header>
          <div className="settings-body toggles">
            <Toggle label="开机时启动" checked={draft.launchAtLogin} onChange={(value) => patch('launchAtLogin', value)} />
            <Toggle label="关闭窗口后留在托盘" checked={draft.keepInTray} onChange={(value) => patch('keepInTray', value)} />
            <Toggle label="显示完成通知" checked={draft.showNotifications} onChange={(value) => patch('showNotifications', value)} />
            <label className="form-field"><span>最多保留历史</span><select value={draft.historyLimit} onChange={(event) => patch('historyLimit', Number(event.target.value))}><option value="0">不保存历史</option><option value="20">20 条</option><option value="50">50 条</option><option value="100">100 条</option><option value="250">250 条</option></select></label>
          </div>
        </section>
      </div>

      <div className="settings-column">
        <section className="settings-section shortcut-section">
          <header><span className="settings-icon blue"><Keyboard size={18} /></span><div><h2>全局快捷键</h2><p>在其他应用中也能直接开始截图。</p></div></header>
          <div className="shortcut-list">
            {(Object.keys(draft.shortcuts) as ShortcutAction[]).map((action) => {
              const status = shortcutState.get(action)
              return (
                <label className="shortcut-row" key={action}>
                  <span><strong>{shortcutLabels[action]}</strong><small className={status?.registered === false ? 'shortcut-error' : ''}>{status?.registered === false ? status.error || '快捷键冲突' : '已启用'}</small></span>
                  <input value={draft.shortcuts[action]} onChange={(event) => shortcutPatch(action, event.target.value)} aria-label={`${shortcutLabels[action]}快捷键`} />
                  <i className={status?.registered === false ? 'error' : 'okay'}>{status?.registered === false ? <AlertCircle size={14} /> : <Check size={14} />}</i>
                </label>
              )
            })}
          </div>
          <div className="shortcut-hint"><Keyboard size={15} /><p>若组合键已被系统或其他应用占用，会在此明确标出；菜单入口仍然可用。</p></div>
        </section>
      </div>

      <div className="settings-savebar">
        <span>{dirty ? '有尚未保存的更改' : '偏好设置已是最新'}</span>
        <button type="button" className="primary-button" onClick={save} disabled={!dirty || saving}>{saving ? <LoaderCircle size={16} className="is-spinning" /> : <Save size={16} />} {saving ? '保存中' : '保存设置'}</button>
      </div>
    </div>
  )
}

function AboutPage({ platform }: { platform: string }): React.JSX.Element {
  return (
    <div className="about-layout">
      <section className="about-hero">
        <div className="about-brand-mark"><span className="brand-crop top" /><span className="brand-crop right" /><span className="brand-crop bottom" /><span className="brand-crop left" /><i /></div>
        <div><span className="eyebrow">BRCLIO UTILITY 01</span><h2>让截图回到<br /><em>快、准、安静。</em></h2><p>Brclio Shot 是一款键盘优先、本地优先的桌面截图工具。区域、窗口、全屏、长截图与完整标注都在一个清晰的工作台里。</p></div>
      </section>
      <section className="about-facts">
        <div className="about-fact"><span>01</span><strong>本地优先</strong><p>截图与历史默认不上传，不用云端账号也能完整使用。</p></div>
        <div className="about-fact"><span>02</span><strong>双平台</strong><p>为 macOS 与 Windows 的键盘习惯和系统权限分别适配。</p></div>
        <div className="about-fact"><span>03</span><strong>功能完整</strong><p>从捕获、长图拼接到标注、复制、保存和置顶贴图。</p></div>
      </section>
      <section className="about-footer-card">
        <div><span className="version-badge">v0.1.0 · {platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : platform}</span><h3>Brclio Shot</h3><p>Designed and built by Brclio</p></div>
        <div className="about-copyright"><strong>© 2026 Brclio</strong><span>All rights reserved.</span></div>
      </section>
    </div>
  )
}

function Toast({ toast, onClose }: { toast: ToastState; onClose: () => void }): React.JSX.Element {
  return (
    <div className={`toast toast-${toast.tone}`} role="status">
      {toast.tone === 'success' ? <Check size={17} /> : toast.tone === 'error' ? <AlertCircle size={17} /> : <Info size={17} />}
      <span>{toast.message}</span>
      <button type="button" onClick={onClose} aria-label="关闭提示"><X size={15} /></button>
    </div>
  )
}

export default function Workspace(): React.JSX.Element {
  const [page, setPage] = useState<Page>('home')
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [permission, setPermission] = useState<PermissionState | null>(null)
  const [shortcuts, setShortcuts] = useState<ShortcutDefinition[]>([])
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [historyLoading, setHistoryLoading] = useState(true)
  const [busyMode, setBusyMode] = useState<CaptureMode | null>(null)
  const [editorAsset, setEditorAsset] = useState<CaptureAsset | null>(null)
  const [sourceDialog, setSourceDialog] = useState(false)
  const [sources, setSources] = useState<DesktopSourcePreview[]>([])
  const [sourcesLoading, setSourcesLoading] = useState(false)
  const [delayDialog, setDelayDialog] = useState(false)
  const [webpageDialog, setWebpageDialog] = useState(false)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [toast, setToast] = useState<ToastState | null>(null)
  const toastTimer = useRef<number | null>(null)
  const api = window.brclioShot

  const notify = useCallback((message: string, tone: ToastTone = 'info'): void => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    setToast({ message, tone })
    toastTimer.current = window.setTimeout(() => setToast(null), 4200)
  }, [])

  const refreshHistory = useCallback(async (): Promise<void> => {
    setHistoryLoading(true)
    try {
      setHistory(await api.getHistory())
    } catch (error) {
      notify(error instanceof Error ? error.message : '无法读取截图历史', 'error')
    } finally {
      setHistoryLoading(false)
    }
  }, [api, notify])

  useEffect(() => {
    void Promise.all([
      api.getSettings().then(setSettings).catch((error) => notify(error instanceof Error ? error.message : '无法读取设置', 'error')),
      api.getPermissionState().then(setPermission).catch(() => undefined),
      refreshHistory()
    ])
    const offCapture = api.onCaptureResult((asset) => {
      setEditorAsset(asset)
      setBusyMode(null)
      void refreshHistory()
    })
    const offSettings = api.onSettingsChanged(setSettings)
    const offShortcuts = api.onShortcutStatus(setShortcuts)
    const offNavigate = api.onNavigate((section) => {
      setEditorAsset(null)
      setPage(section === 'capture' ? 'home' : section)
    })
    const offCountdown = api.onCaptureCountdown((seconds) => setCountdown(seconds > 0 ? seconds : null))
    return () => {
      offCapture()
      offSettings()
      offShortcuts()
      offNavigate()
      offCountdown()
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
    }
  }, [api, notify, refreshHistory])

  const capture = useCallback(async (mode: CaptureMode, extra: { sourceId?: string; delaySeconds?: number; url?: string } = {}): Promise<void> => {
    setBusyMode(mode)
    try {
      if (mode === 'scroll') {
        await api.startScrollCapture()
        notify('长截图已开始，请在目标窗口中向下滚动。')
        return
      }
      const asset = await api.capture({ mode, ...extra })
      if (asset) {
        setEditorAsset(asset)
        void refreshHistory()
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : `${captureLabel(mode)}失败`, 'error')
    } finally {
      setBusyMode(null)
    }
  }, [api, notify, refreshHistory])

  const loadSources = useCallback(async (): Promise<void> => {
    setSourcesLoading(true)
    try {
      setSources(await api.listDesktopSources('window'))
    } catch (error) {
      notify(error instanceof Error ? error.message : '无法读取窗口列表', 'error')
    } finally {
      setSourcesLoading(false)
    }
  }, [api, notify])

  const beginCapture = useCallback((mode: CaptureMode): void => {
    if (mode === 'window') {
      setSourceDialog(true)
      void loadSources()
    } else if (mode === 'delay') setDelayDialog(true)
    else if (mode === 'webpage') setWebpageDialog(true)
    else void capture(mode)
  }, [capture, loadSources])

  useEffect(() => {
    const keyDown = (event: KeyboardEvent): void => {
      if (editorAsset) return
      if (event.key === 'Escape' && (sourceDialog || delayDialog || webpageDialog)) {
        event.preventDefault()
        setSourceDialog(false)
        setDelayDialog(false)
        setWebpageDialog(false)
        return
      }
      if (isEditableElement(event.target)) return
      const command = event.metaKey || event.ctrlKey
      if (command && event.key === ',') {
        event.preventDefault()
        setPage('settings')
        return
      }
      if (command && ['1', '2', '3', '4'].includes(event.key)) {
        event.preventDefault()
        setPage(navItems[Number(event.key) - 1].id)
        return
      }
      if (command || event.altKey) return
      const index = Number(event.key) - 1
      if (index >= 0 && index < captureCards.length && page === 'home') {
        event.preventDefault()
        beginCapture(captureCards[index].mode)
      }
    }
    window.addEventListener('keydown', keyDown)
    return () => window.removeEventListener('keydown', keyDown)
  }, [beginCapture, delayDialog, editorAsset, page, sourceDialog, webpageDialog])

  const openHistoryItem = useCallback(async (item: HistoryItem): Promise<void> => {
    try {
      const asset = await api.openHistoryItem(item.id)
      if (asset) setEditorAsset(asset)
    } catch (error) {
      notify(error instanceof Error ? error.message : '无法打开截图', 'error')
    }
  }, [api, notify])

  const deleteHistory = async (item: HistoryItem): Promise<void> => {
    await api.deleteHistoryItem(item.id)
    setHistory((current) => current.filter((candidate) => candidate.id !== item.id))
    notify('已从本地历史中移除。', 'success')
  }
  const clearHistory = async (): Promise<void> => {
    if (!window.confirm('清空全部本地截图记录？已保存到文件夹中的图片不会被删除。')) return
    await api.clearHistory()
    setHistory([])
    notify('本地截图历史已清空。', 'success')
  }
  const requestPermission = async (): Promise<void> => {
    try {
      setPermission(await api.requestScreenPermission())
    } catch (error) {
      notify(error instanceof Error ? error.message : '无法打开屏幕录制设置', 'error')
    }
  }

  if (editorAsset) return <Editor asset={editorAsset} onClose={() => { setEditorAsset(null); void refreshHistory() }} />

  const meta = pageMeta[page]
  const platform = api.platform
  const regionShortcut = settings?.shortcuts.captureRegion

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="brand-lockup" aria-label="Brclio Shot">
          <span className="brand-symbol"><i /><b /></span>
          <span><strong>Brclio</strong><small>SHOT</small></span>
        </div>
        <nav className="side-nav" aria-label="主导航">
          <span className="nav-label">WORKSPACE</span>
          {navItems.map((item) => {
            const Icon = item.icon
            return <button type="button" key={item.id} className={page === item.id ? 'active' : ''} onClick={() => setPage(item.id)}><Icon size={18} /><span>{item.label}</span>{page === item.id && <i />}</button>
          })}
        </nav>
        <div className="sidebar-quick">
          <span className="quick-icon"><ScanLine size={18} /></span>
          <div><strong>随时开始区域截图</strong><span>{regionShortcut ? formatAccelerator(regionShortcut, platform) : '读取快捷键…'}</span></div>
        </div>
        <div className="sidebar-footer"><span className="status-dot" /> 本地服务就绪 <small>v0.1.0</small></div>
      </aside>

      <header className="app-topbar">
        <div className="topbar-title"><span>{meta.eyebrow}</span><h1>{meta.title}</h1><p>{meta.description}</p></div>
        <div className="topbar-actions">
          <button type="button" className="command-button" onClick={() => setPage('settings')}><Keyboard size={15} /><span>快捷键</span><kbd>{platform === 'darwin' ? '⌘ ,' : 'Ctrl ,'}</kbd></button>
          <button type="button" className="primary-button compact" onClick={() => beginCapture('region')} disabled={busyMode !== null}><ScanLine size={16} /> 新建截图</button>
        </div>
      </header>

      <main className="app-main">
        {page === 'home' && <HomePage settings={settings} permission={permission} history={history} busyMode={busyMode} onCapture={beginCapture} onOpenHistory={() => setPage('history')} onOpenHistoryItem={(item) => void openHistoryItem(item)} onRequestPermission={() => void requestPermission()} />}
        {page === 'history' && <HistoryPage history={history} loading={historyLoading} onRefresh={() => void refreshHistory()} onOpen={(item) => void openHistoryItem(item)} onDelete={(item) => void deleteHistory(item)} onClear={() => void clearHistory()} onReveal={(path) => void api.revealFile(path)} />}
        {page === 'settings' && <SettingsPage settings={settings} shortcuts={shortcuts} onChooseDirectory={() => api.chooseSaveDirectory()} onSave={async (next) => { const saved = await api.updateSettings(next); setSettings(saved); notify('偏好设置已保存。', 'success') }} />}
        {page === 'about' && <AboutPage platform={platform} />}
      </main>

      {sourceDialog && <SourcePicker sources={sources} loading={sourcesLoading} onRefresh={() => void loadSources()} onClose={() => setSourceDialog(false)} onSelect={(source) => { setSourceDialog(false); void capture('window', { sourceId: source.id }) }} />}
      {delayDialog && <DelayDialog onClose={() => setDelayDialog(false)} onSelect={(seconds) => { setDelayDialog(false); void capture('delay', { delaySeconds: seconds }) }} />}
      {webpageDialog && <WebpageDialog onClose={() => setWebpageDialog(false)} onSubmit={(url) => { setWebpageDialog(false); void capture('webpage', { url }) }} />}
      {countdown !== null && (
        <div className="capture-countdown" role="status" aria-live="assertive">
          <span className="eyebrow">GET READY</span>
          <strong>{countdown}</strong>
          <p>保持目标画面，倒计时结束后开始截图</p>
        </div>
      )}
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}
    </div>
  )
}

function isEditableElement(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)
}
