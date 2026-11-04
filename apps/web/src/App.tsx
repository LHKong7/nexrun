import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { ChatEvent, Conversation, Message, Run, RuntimeConfig } from '@nexrun/protocol';
import { ArrowDown, ArrowLeft, ArrowUp, Archive, Check, ChevronDown, ChevronRight, CircleAlert, Copy, Globe2, Lightbulb, LoaderCircle, MessageSquare, Pencil, PenLine, Plus, RefreshCw, Sparkles, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { MarkdownMessage } from './components/MarkdownMessage';
import { api, RequestError } from './lib/api';
import { errorKey, translate, type Locale, type TranslationKey } from './lib/i18n';

type Connection = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'resyncing';
type PendingSend = { content: string; key: string; state: 'sending' | 'uncertain' };
type DialogAction = { type: 'rename' | 'archive'; conversation: Conversation };
const activeStatuses = new Set(['queued', 'running', 'cancelling']);
const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const isActive = (run: Run | null | undefined) => Boolean(run && activeStatuses.has(run.status));
const readPath = () => /^\/chat\/([^/]+)\/?$/.exec(window.location.pathname)?.[1] ?? null;
const draftKey = (id: string) => `nexrun:draft:${id}`;
function readDraft(id: string) { try { return sessionStorage.getItem(draftKey(id)) ?? ''; } catch { return ''; } }
function storeDraft(id: string, value: string) { try { if (value) sessionStorage.setItem(draftKey(id), value); else sessionStorage.removeItem(draftKey(id)); } catch { /* Drafts can remain in memory when browser storage is unavailable. */ } }
function initialLocale(): Locale { try { return localStorage.getItem('nexrun:locale') === 'zh-CN' ? 'zh-CN' : 'en'; } catch { return 'en'; } }
function mergeMessages(current: Message[], incoming: Message[], protectNewer = false) {
  const messages = new Map(current.map(message => [message.id, message]));
  for (const message of incoming) {
    const previous = messages.get(message.id);
    if (previous && terminalStatuses.has(previous.status) && !terminalStatuses.has(message.status)) continue;
    if (previous && protectNewer && previous.content.length > message.content.length) continue;
    messages.set(message.id, message);
  }
  return [...messages.values()].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}
function mergeRun(previous: Run | null, incoming: Run): Run {
  if (previous && previous.id !== incoming.id && previous.createdAt > incoming.createdAt) return previous;
  if (previous?.id === incoming.id) {
    if (terminalStatuses.has(previous.status) && !terminalStatuses.has(incoming.status)) return previous;
    if (previous.status === 'cancelling' && (incoming.status === 'queued' || incoming.status === 'running')) return previous;
  }
  return incoming;
}
function failureCode(error: unknown) { return error instanceof RequestError ? error.code : 'REQUEST_FAILED'; }

function BrandMark({ small = false }: { small?: boolean }) {
  return <span className={`brand-mark${small ? ' brand-mark-small' : ''}`} aria-hidden="true"><span /><span /><span /></span>;
}

function ConversationDialog({ action, onDismiss, onSaved, t }: { action: DialogAction; onDismiss: () => void; onSaved: (conversation: Conversation) => void; t: (key: TranslationKey) => string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(action.conversation.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  const archive = action.type === 'archive';
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || (!archive && !title.trim())) return;
    setBusy(true); setError(null);
    try {
      const updated = await api.updateConversation(action.conversation.id, archive ? { archived: true } : { title: title.trim() });
      onSaved(updated); onDismiss();
    } catch (failure) { setError(failureCode(failure)); setBusy(false); }
  }
  return <dialog ref={ref} className="conversation-dialog" onCancel={onDismiss} onClick={event => { if (event.target === ref.current && !busy) onDismiss(); }} aria-labelledby="dialog-title" aria-describedby="dialog-description">
    <form onSubmit={submit}>
      <Button className="dialog-close" type="button" size="icon" variant="ghost" onClick={onDismiss} aria-label={t('close')}><X size={18} /></Button>
      <div className={`dialog-icon${archive ? ' archive-icon' : ''}`}>{archive ? <Archive size={21} /> : <Pencil size={21} />}</div>
      <h2 id="dialog-title">{t(archive ? 'archiveTitle' : 'renameTitle')}</h2>
      <p id="dialog-description">{t(archive ? 'archiveDescription' : 'renameDescription')}</p>
      {!archive && <label className="dialog-label">{t('titleLabel')}<Input autoFocus value={title} onChange={event => setTitle(event.target.value)} maxLength={120} required /></label>}
      {error && <div className="inline-error" role="alert"><CircleAlert size={16} />{t(errorKey(error))}</div>}
      <div className="dialog-actions"><Button type="button" variant="outline" onClick={onDismiss} disabled={busy}>{t('cancel')}</Button><Button type="submit" disabled={busy || (!archive && !title.trim())}>{busy && <LoaderCircle size={15} className="spin" />}{t(busy ? 'working' : archive ? 'archive' : 'save')}</Button></div>
    </form>
  </dialog>;
}

export default function App() {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const t = useCallback((key: TranslationKey) => translate(locale, key), [locale]);
  const [selectedId, setSelectedId] = useState<string | null>(readPath);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [nextListCursor, setNextListCursor] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [moreListLoading, setMoreListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [creating, setCreating] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [before, setBefore] = useState<number | null>(null);
  const [olderLoading, setOlderLoading] = useState(false);
  const [connection, setConnection] = useState<Connection>('idle');
  const [networkOnline, setNetworkOnline] = useState(() => navigator.onLine);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [draft, setDraft] = useState('');
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [pendingSends, setPendingSends] = useState<Record<string, PendingSend>>({});
  const pendingSendsRef = useRef(pendingSends);
  pendingSendsRef.current = pendingSends;
  const [conversationErrors, setConversationErrors] = useState<Record<string, string | undefined>>({});
  const [cancelPending, setCancelPending] = useState(false);
  const [dialog, setDialog] = useState<DialogAction | null>(null);
  const [toast, setToast] = useState<TranslationKey | null>(null);
  const [hasNewOutput, setHasNewOutput] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const nearBottomRef = useRef(true);
  const historyLoadRef = useRef<{ height: number; top: number } | null>(null);
  const composingRef = useRef(false);
  const currentConversation = conversations.find(conversation => conversation.id === selectedId);
  const active = isActive(run);
  const currentPending = selectedId ? pendingSends[selectedId] : undefined;
  const currentError = selectedId ? conversationErrors[selectedId] : undefined;
  const agentName = t(config?.adapter === 'pi' ? 'agentPi' : config?.adapter === 'mock' ? 'agentMock' : 'agent');

  useEffect(() => {
    document.documentElement.lang = locale;
    try { localStorage.setItem('nexrun:locale', locale); } catch { /* Locale still applies for this session. */ }
  }, [locale]);
  useEffect(() => { const handler = () => setSelectedId(readPath()); window.addEventListener('popstate', handler); return () => window.removeEventListener('popstate', handler); }, []);
  useEffect(() => {
    const offline = () => setNetworkOnline(false);
    const online = () => setNetworkOnline(true);
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    return () => { window.removeEventListener('offline', offline); window.removeEventListener('online', online); };
  }, []);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(null), 2600); return () => window.clearTimeout(timer); }, [toast]);
  const navigate = useCallback((id: string | null) => {
    const path = id ? `/chat/${encodeURIComponent(id)}` : '/';
    if (window.location.pathname !== path) window.history.pushState({}, '', path);
    setSelectedId(id);
  }, []);
  const refreshList = useCallback(async () => {
    try {
      const page = await api.conversations();
      setConversations(previous => {
        const firstIds = new Set(page.conversations.map(conversation => conversation.id));
        const older = previous.filter(conversation => !firstIds.has(conversation.id) && !conversation.archivedAt && (page.conversations.length > 0 ? conversation.updatedAt < page.conversations[page.conversations.length - 1]!.updatedAt : false));
        return [...page.conversations, ...older];
      });
      setNextListCursor(page.nextCursor); setListError(null);
      void api.config().then(setConfig).catch(() => { /* Configuration is retried with the next list refresh. */ });
    } catch (error) { setListError(failureCode(error)); }
    finally { setListLoading(false); }
  }, []);
  useEffect(() => {
    void refreshList();
    const controller = new AbortController();
    void api.config(controller.signal).then(setConfig).catch(() => { /* The list exposes service connectivity errors. */ });
    return () => controller.abort();
  }, [refreshList]);
  useEffect(() => {
    const refreshOnFocus = () => { void refreshList(); };
    window.addEventListener('focus', refreshOnFocus);
    return () => window.removeEventListener('focus', refreshOnFocus);
  }, [refreshList]);
  const hasActiveConversations = conversations.some(conversation => isActive(conversation.activeRun));
  useEffect(() => {
    if (!hasActiveConversations) return;
    const timer = window.setInterval(() => void refreshList(), 5000);
    return () => window.clearInterval(timer);
  }, [hasActiveConversations, refreshList]);

  useLayoutEffect(() => {
    setDraft(selectedId ? readDraft(selectedId) : '');
    setMessages([]); setRun(null); setSnapshotError(null); setBefore(null); setHasNewOutput(false); setCancelPending(false);
    setSnapshotLoading(Boolean(selectedId));
    nearBottomRef.current = true; historyLoadRef.current = null;
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) { setConnection('idle'); setSnapshotLoading(false); return; }
    if (!networkOnline) {
      setConnection('disconnected'); setSnapshotLoading(false); setSnapshotError('NETWORK_ERROR');
      return;
    }
    let alive = true;
    let source: EventSource | null = null;
    let timer: number | undefined;
    let controller: AbortController | null = null;
    let sequence = 0;
    let bootVersion = 0;
    setSnapshotLoading(true); setConnection('connecting');
    const updateRun = (incoming: Run) => {
      setRun(previous => mergeRun(previous, incoming));
      setConversations(previous => previous.map(conversation => conversation.id === selectedId ? { ...conversation, activeRun: isActive(incoming) ? incoming : null } : conversation));
      if (terminalStatuses.has(incoming.status)) {
        setCancelPending(false); void refreshList();
        if (incoming.errorCode) setConversationErrors(previous => ({ ...previous, [selectedId]: incoming.errorCode ?? undefined }));
      }
    };
    const receive = (event: MessageEvent<string>) => {
      if (!alive) return;
      let value: ChatEvent;
      try { value = JSON.parse(event.data) as ChatEvent; } catch { return; }
      if (value.conversationId !== selectedId || !Number.isSafeInteger(value.sequence) || value.sequence <= sequence) return;
      sequence = value.sequence;
      const incoming = [value.payload.userMessage, value.payload.assistantMessage, value.payload.message].filter((message): message is Message => Boolean(message));
      if (incoming.length) setMessages(previous => mergeMessages(previous, incoming, value.type === 'message.accepted'));
      if (value.payload.run) updateRun(value.payload.run);
    };
    const connect = () => {
      source?.close();
      source = new EventSource(`/api/conversations/${encodeURIComponent(selectedId)}/events?after=${sequence}`);
      source.onopen = () => { if (alive) { setConnection('connected'); if (timer) window.clearTimeout(timer); } };
      source.onmessage = receive;
      source.addEventListener('resync_required', () => { if (!alive) return; source?.close(); setConnection('resyncing'); void boot(true); });
      source.onerror = () => {
        if (!alive) return;
        setConnection('reconnecting');
        if (timer) window.clearTimeout(timer);
        timer = window.setTimeout(() => { source?.close(); void boot(true); }, 1800);
      };
    };
    const boot = async (resync = false) => {
      const version = ++bootVersion;
      controller?.abort(); controller = new AbortController();
      try {
        const snapshot = await api.snapshot(selectedId, undefined, controller.signal);
        if (!alive || version !== bootVersion) return;
        sequence = snapshot.cursor;
        setMessages(previous => resync ? mergeMessages(previous, snapshot.messages) : snapshot.messages);
        setRun(snapshot.activeRun); setBefore(snapshot.nextCursor); setSnapshotError(null); setSnapshotLoading(false);
        connect();
      } catch (error) {
        if (!alive || (error instanceof DOMException && error.name === 'AbortError')) return;
        setSnapshotLoading(false); setSnapshotError(failureCode(error)); setConnection('disconnected');
        if (failureCode(error) === 'NETWORK_ERROR') timer = window.setTimeout(() => void boot(true), 4000);
      }
    };
    void boot();
    return () => { alive = false; source?.close(); controller?.abort(); if (timer) window.clearTimeout(timer); };
  }, [selectedId, refreshVersion, refreshList, networkOnline]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (historyLoadRef.current) {
      const previous = historyLoadRef.current;
      element.scrollTop = previous.top + element.scrollHeight - previous.height;
      historyLoadRef.current = null;
      return;
    }
    if (nearBottomRef.current) { element.scrollTop = element.scrollHeight; setHasNewOutput(false); }
    else if (messages.length) setHasNewOutput(true);
  }, [messages]);
  useEffect(() => {
    if (!snapshotLoading && selectedId && !snapshotError && window.matchMedia('(min-width: 768px)').matches) composerRef.current?.focus();
  }, [selectedId, snapshotLoading, snapshotError]);
  useEffect(() => {
    if (run && terminalStatuses.has(run.status)) setAnnouncement(t(run.status === 'completed' ? 'completedAnnouncement' : run.status === 'failed' ? 'failedMessage' : run.status === 'interrupted' ? 'interruptedMessage' : 'cancelledMessage'));
    else if (run) setAnnouncement(t(run.status === 'cancelling' ? 'cancelling' : run.status === 'queued' ? 'queued' : 'generating'));
  }, [run?.status, run?.id, t]);
  useLayoutEffect(() => {
    const element = composerRef.current;
    if (element) { element.style.height = 'auto'; element.style.height = `${Math.min(element.scrollHeight, 190)}px`; }
  }, [draft]);

  async function createChat(initialDraft = '') {
    if (creating) return;
    setCreating(true); setListError(null);
    try {
      const conversation = await api.createConversation();
      setConversations(previous => [conversation, ...previous.filter(item => item.id !== conversation.id)]);
      if (initialDraft) storeDraft(conversation.id, initialDraft);
      navigate(conversation.id);
    } catch (error) { setListError(failureCode(error)); }
    finally { setCreating(false); }
  }
  async function loadMoreChats() {
    if (!nextListCursor || moreListLoading) return;
    setMoreListLoading(true);
    try {
      const page = await api.conversations(nextListCursor);
      setConversations(previous => [...previous, ...page.conversations.filter(conversation => !previous.some(item => item.id === conversation.id))]);
      setNextListCursor(page.nextCursor);
    } catch (error) { setListError(failureCode(error)); }
    finally { setMoreListLoading(false); }
  }
  async function loadEarlier() {
    if (!selectedId || before === null || olderLoading) return;
    const id = selectedId; setOlderLoading(true);
    try {
      const snapshot = await api.snapshot(id, before);
      if (selectedRef.current !== id) return;
      const element = scrollRef.current;
      if (element) historyLoadRef.current = { height: element.scrollHeight, top: element.scrollTop };
      setMessages(previous => mergeMessages(snapshot.messages, previous)); setBefore(snapshot.nextCursor);
    } catch (error) { if (selectedRef.current === id) setConversationErrors(previous => ({ ...previous, [id]: failureCode(error) })); }
    finally { setOlderLoading(false); }
  }
  async function sendMessage(retry?: PendingSend) {
    if (!selectedId || !networkOnline || snapshotLoading || pendingSendsRef.current[selectedId]?.state === 'sending') return;
    const id = selectedId;
    const content = retry?.content ?? draft;
    if (!content.trim() || (!retry && (active || currentPending))) return;
    const pending: PendingSend = { content, key: retry?.key ?? crypto.randomUUID(), state: 'sending' };
    setPendingSends(previous => ({ ...previous, [id]: pending }));
    setConversationErrors(previous => ({ ...previous, [id]: undefined }));
    nearBottomRef.current = true;
    try {
      const accepted = await api.send(id, pending.content, pending.key);
      if (selectedRef.current === id) {
        setMessages(previous => mergeMessages(previous, [accepted.userMessage, accepted.assistantMessage], true));
        setRun(previous => mergeRun(previous, accepted.run));
        if (draftRef.current === content) setDraft('');
      }
      if (readDraft(id) === content) storeDraft(id, '');
      setPendingSends(previous => { const updated = { ...previous }; delete updated[id]; return updated; });
      void refreshList();
    } catch (error) {
      const code = failureCode(error);
      if (code === 'NETWORK_ERROR' || (error instanceof RequestError && error.status >= 500 && ['INTERNAL_ERROR', 'REQUEST_FAILED'].includes(code))) setPendingSends(previous => ({ ...previous, [id]: { ...pending, state: 'uncertain' } }));
      else {
        setPendingSends(previous => { const updated = { ...previous }; delete updated[id]; return updated; });
        setConversationErrors(previous => ({ ...previous, [id]: code }));
        if (code === 'CONVERSATION_BUSY' && selectedRef.current === id) setRefreshVersion(previous => previous + 1);
      }
    }
  }
  async function cancelRun() {
    if (!run || run.conversationId !== selectedId || !active || cancelPending || run.status === 'cancelling') return;
    const id = selectedId; setCancelPending(true);
    try { const updated = await api.cancel(run.id); if (selectedRef.current === id) setRun(previous => mergeRun(previous, updated)); }
    catch (error) { if (id && selectedRef.current === id) setConversationErrors(previous => ({ ...previous, [id]: failureCode(error) })); }
    finally { if (selectedRef.current === id) setCancelPending(false); }
  }
  function updateDraft(value: string) { setDraft(value); if (selectedId) storeDraft(selectedId, value); }
  function handleComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composingRef.current && event.keyCode !== 229) { event.preventDefault(); void sendMessage(); }
  }
  async function copy(text: string, kind: 'code' | 'message') {
    try { await navigator.clipboard.writeText(text); setToast(kind === 'code' ? 'copiedCode' : 'copiedMessage'); return true; }
    catch { setToast('copyFailed'); return false; }
  }
  function scrollToBottom() { const element = scrollRef.current; if (element) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' }); nearBottomRef.current = true; setHasNewOutput(false); }
  const suggestions = [
    { icon: Lightbulb, title: 'suggestionThink', description: 'suggestionThinkDetail', prompt: 'suggestionThinkPrompt' },
    { icon: Sparkles, title: 'suggestionExplain', description: 'suggestionExplainDetail', prompt: 'suggestionExplainPrompt' },
    { icon: PenLine, title: 'suggestionWrite', description: 'suggestionWriteDetail', prompt: 'suggestionWritePrompt' },
  ] as const;
  const suggestionCards = <div className="suggestion-grid">{suggestions.map(suggestion => <button type="button" className="suggestion-card" key={suggestion.title} disabled={creating} onClick={() => selectedId ? (updateDraft(t(suggestion.prompt)), composerRef.current?.focus()) : void createChat(t(suggestion.prompt))}><suggestion.icon size={19} strokeWidth={1.6} /><span>{t(suggestion.title)}</span><p>{t(suggestion.description)}</p><ChevronRight className="suggestion-arrow" size={16} /></button>)}</div>;

  return <div className={`app-shell${selectedId ? ' detail-open' : ''}`}>
    <a className="skip-link" href="#conversation-main">{t('skipToChat')}</a>
    <aside className="sidebar" aria-label={t('sidebarLabel')}>
      <a href="/" className="brand" onClick={event => { event.preventDefault(); navigate(null); }}><BrandMark /><span>NexRun<span className="brand-subtitle">{t('workspace')}</span></span></a>
      <Button className="new-chat-button" onClick={() => void createChat()} disabled={creating}>{creating ? <LoaderCircle className="spin" size={17} /> : <Plus size={18} />}<span>{t('newChat')}</span><span className="new-chat-corner"><PenLine size={15} /></span></Button>
      <div className="sidebar-section-heading"><span>{t('yourChats')}</span><span>{conversations.length || '—'}</span></div>
      <nav className="conversation-list" aria-label={t('sidebarLabel')}>
        {listLoading ? <div className="list-skeleton" role="status" aria-label={t('loadingChats')}>{[1, 2, 3].map(value => <div key={value}><span /><span /></div>)}</div> : conversations.length === 0 && !listError ? <div className="sidebar-empty"><MessageSquare size={23} strokeWidth={1.4} /><strong>{t('noChats')}</strong><p>{t('noChatsHint')}</p></div> : conversations.map(conversation => <div className={`conversation-row${conversation.id === selectedId ? ' selected' : ''}`} key={conversation.id}>
          <a href={`/chat/${encodeURIComponent(conversation.id)}`} className="conversation-link" aria-current={conversation.id === selectedId ? 'page' : undefined} onClick={event => { if (event.ctrlKey || event.metaKey || event.shiftKey) return; event.preventDefault(); navigate(conversation.id); }}>
            <MessageSquare size={16} className="conversation-icon" strokeWidth={1.7} /><span className="conversation-text"><span className="conversation-title">{conversation.title || t('untitled')}</span><span className="conversation-preview">{conversation.preview || t('newConversation')}</span></span>{isActive(conversation.activeRun) && <span className="activity-dot" aria-label={t('generating')} />}
          </a>
          <div className="conversation-actions"><Button size="icon" variant="ghost" aria-label={`${t('rename')}: ${conversation.title}`} title={t('rename')} onClick={() => setDialog({ type: 'rename', conversation })}><Pencil size={13} /></Button><Button size="icon" variant="ghost" aria-label={`${t('archive')}: ${conversation.title}`} title={isActive(conversation.activeRun) ? t('archiveBusy') : t('archive')} disabled={isActive(conversation.activeRun)} onClick={() => setDialog({ type: 'archive', conversation })}><Archive size={13} /></Button></div>
        </div>)}
        {nextListCursor && <button className="more-chats" type="button" onClick={() => void loadMoreChats()} disabled={moreListLoading}>{moreListLoading ? <LoaderCircle className="spin" size={14} /> : <ChevronDown size={14} />}{t('loadMoreChats')}</button>}
      </nav>
      {listError && <div className="sidebar-error" role="alert"><CircleAlert size={15} /><span>{t(errorKey(listError))}</span><button onClick={() => void refreshList()} aria-label={t('retry')}><RefreshCw size={14} /></button></div>}
      <div className="sidebar-footer"><div className="workspace-label"><span className="workspace-avatar">N</span><span><strong>{t('privatePreview')}</strong><span><i />{t(config?.adapter === 'pi' ? 'agentPi' : config?.adapter === 'mock' ? 'mockMode' : 'connecting')}</span></span></div><label className="language-picker"><Globe2 size={15} /><span className="sr-only">{t('language')}</span><select aria-label={t('language')} value={locale} onChange={event => setLocale(event.target.value as Locale)}><option value="en">English</option><option value="zh-CN">简体中文</option></select><ChevronDown size={13} /></label></div>
    </aside>

    <main className="chat-main" id="conversation-main" tabIndex={-1}>
      <header className="chat-header"><div className="chat-heading"><Button className="mobile-back" variant="ghost" size="icon" onClick={() => navigate(null)} aria-label={t('home')}><ArrowLeft size={19} /></Button><div className="header-icon"><MessageSquare size={18} strokeWidth={1.6} /></div><div><h1>{selectedId ? currentConversation?.title || t('conversation') : t('newConversation')}</h1><p>{t('directChat')}<span>·</span>{t('textOnly')}</p></div></div><div className="header-status"><span className="agent-pill"><span className="agent-pill-icon">π</span>{agentName}</span>{selectedId && <span className={`connection-pill ${connection}`} role="status"><i />{t(connection === 'idle' ? 'connecting' : connection)}</span>}</div></header>

      {!selectedId ? <div className="home-screen"><div className="welcome-content"><div className="welcome-eyebrow"><span />NEXRUN<span /></div><div className="welcome-symbol"><BrandMark /></div><h2>{t('hello')}</h2><p className="welcome-description">{t('welcomeHint')}</p><Button className="welcome-start" onClick={() => void createChat()} disabled={creating}>{creating ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />}{t('startChat')}<ArrowUp className="diagonal-arrow" size={17} /></Button>{suggestionCards}<div className="welcome-footnote"><span className="tiny-status-dot" />{config?.adapter === 'mock' ? t('mockDescription') : config?.adapter === 'pi' ? t('piDescription') : t('loading')}</div></div><div className="home-bottom-note">{t('autoSaved')}</div></div> : <>
        <div className="timeline" ref={scrollRef} role="region" aria-label={t('timelineLabel')} onScroll={event => { const element = event.currentTarget; nearBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; if (nearBottomRef.current) setHasNewOutput(false); }}>
          <div className="timeline-inner">
            {snapshotLoading ? <div className="message-skeleton" role="status" aria-label={t('loadingMessages')}><div /><div /><div /><span /><div /><div /></div> : snapshotError && messages.length === 0 ? <div className="chat-load-error" role="alert"><CircleAlert size={30} strokeWidth={1.4} /><p>{t(errorKey(snapshotError))}</p><Button variant="outline" onClick={() => setRefreshVersion(value => value + 1)}><RefreshCw size={15} />{t('retry')}</Button></div> : messages.length === 0 ? <div className="empty-chat"><div className="empty-chat-icon"><Sparkles size={27} strokeWidth={1.3} /></div><h2>{t('freshTitle')}</h2><p>{t('freshHint')}</p>{suggestionCards}</div> : <>
              {before !== null && <div className="earlier-messages"><Button size="sm" variant="ghost" onClick={() => void loadEarlier()} disabled={olderLoading}>{olderLoading ? <LoaderCircle size={14} className="spin" /> : <ArrowUp size={14} />}{t(olderLoading ? 'loading' : 'loadEarlier')}</Button></div>}
              <div className="timeline-date"><span />{new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(messages[0]!.createdAt))}<span /></div>
              {messages.map(message => <article key={message.id} className={`message message-${message.role}`} data-message-id={message.id}>
                {message.role === 'assistant' && <div className="message-attribution"><span className="assistant-avatar">π</span><span>{agentName}</span>{message.status === 'streaming' || message.status === 'pending' ? <span className="message-generating"><i />{t(message.status === 'pending' ? 'queued' : 'generating')}</span> : <span className="message-time">{new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(message.createdAt))}</span>}</div>}
                <div className="message-body">{message.content ? message.role === 'user' ? <p className="user-content">{message.content}</p> : <MarkdownMessage content={message.content} t={t} onCopy={copy} /> : message.status === 'pending' || message.status === 'streaming' ? <div className="typing-indicator" role="status" aria-label={t('emptyResponse')}><span /><span /><span /></div> : <p className="empty-response">{t('noResponse')}</p>}</div>
                {message.role === 'assistant' && ['failed', 'cancelled', 'interrupted'].includes(message.status) && <div className={`message-outcome ${message.status}`}><span className="outcome-tag">{message.status === 'cancelled' ? <Square size={10} /> : <CircleAlert size={12} />}{t(message.status === 'failed' ? 'failed' : message.status === 'interrupted' ? 'interrupted' : 'cancelled')}</span><span>{t(message.status === 'failed' ? 'failedMessage' : message.status === 'interrupted' ? 'interruptedMessage' : 'cancelledMessage')}</span></div>}
                {message.content && <div className="message-toolbar"><Button variant="ghost" size="icon" title={t('copyMessage')} aria-label={t('copyMessage')} onClick={() => void copy(message.content, 'message')}><Copy size={14} /></Button>{message.role === 'user' && <span>{t('you')}</span>}</div>}
              </article>)}
            </>}
          </div>
        </div>
        {hasNewOutput && <Button className="new-output" size="sm" variant="outline" onClick={scrollToBottom}><ArrowDown size={14} />{t('newOutput')}</Button>}
        <div className="composer-region"><div className="composer-inner">
          {(!config?.configured && config?.adapter === 'pi') && <div className="config-notice" role="alert"><CircleAlert size={16} /><span>{t('errorNotConfigured')}</span></div>}
          {connection !== 'connected' && connection !== 'connecting' && <div className="connection-notice" role="status"><RefreshCw size={14} className={connection === 'disconnected' ? '' : 'spin'} /><span>{t('connectionHint')}</span><button type="button" onClick={() => setRefreshVersion(value => value + 1)}>{t('reconnect')}</button></div>}
          {currentError && <div className="composer-error" role="alert"><CircleAlert size={16} /><span>{t(errorKey(currentError))}</span><button aria-label={t('dismiss')} onClick={() => setConversationErrors(previous => ({ ...previous, [selectedId]: undefined }))}><X size={14} /></button></div>}
          {currentPending?.state === 'uncertain' && <div className="composer-error" role="alert"><CircleAlert size={16} /><span>{t('retrySendHint')}</span><button type="button" disabled={!networkOnline} onClick={() => void sendMessage(currentPending)}>{t('retrySend')}</button></div>}
          <form className={`composer${active ? ' composer-active' : ''}`} onSubmit={event => { event.preventDefault(); void sendMessage(); }}>
            <Textarea ref={composerRef} aria-label={t('compose')} placeholder={t(config?.adapter === 'pi' && !config.configured ? 'composeUnavailable' : 'composePlaceholder')} value={draft} rows={2} maxLength={16000} onChange={event => updateDraft(event.target.value)} onKeyDown={handleComposerKey} onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }} disabled={snapshotLoading || Boolean(snapshotError && messages.length === 0) || currentPending?.state === 'sending' || (config?.adapter === 'pi' && !config.configured)} />
            <div className="composer-bottom"><span className="composer-agent"><span>π</span>{agentName}{active && <span className="composer-run-status"><i />{t(run?.status === 'cancelling' || cancelPending ? 'cancelling' : run?.status === 'queued' ? 'queued' : 'generating')}</span>}{currentPending?.state === 'sending' && <span className="composer-run-status"><LoaderCircle size={12} className="spin" />{t('sending')}</span>}</span>{active ? <Button type="button" className="stop-button" size="sm" variant="outline" onClick={() => void cancelRun()} disabled={cancelPending || run?.status === 'cancelling'} aria-label={t('stop')}>{cancelPending || run?.status === 'cancelling' ? <LoaderCircle size={13} className="spin" /> : <Square size={12} fill="currentColor" />}{t(cancelPending || run?.status === 'cancelling' ? 'stopping' : 'stop')}</Button> : <Button type="submit" className="send-button" size="icon" aria-label={t('send')} disabled={!networkOnline || !draft.trim() || Boolean(currentPending) || snapshotLoading || Boolean(snapshotError && messages.length === 0) || (config?.adapter === 'pi' && !config.configured)}>{currentPending?.state === 'sending' ? <LoaderCircle className="spin" size={18} /> : <ArrowUp size={19} />}</Button>}</div>
          </form>
          <div className="composer-hint"><span>{t('autoSaved')}</span><span><kbd>↵</kbd> {t('enterToSend')}<span className="hint-divider">·</span>{t('shiftEnter')}</span></div>
        </div></div>
      </>}
    </main>
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>
    {dialog && <ConversationDialog key={`${dialog.type}:${dialog.conversation.id}`} action={dialog} t={t} onDismiss={() => setDialog(null)} onSaved={conversation => { if (conversation.archivedAt) { setConversations(previous => previous.filter(item => item.id !== conversation.id)); if (selectedId === conversation.id) navigate(null); } else setConversations(previous => previous.map(item => item.id === conversation.id ? conversation : item)); }} />}
    {toast && <div className="toast" role="status"><Check size={16} /><span>{t(toast)}</span><button onClick={() => setToast(null)} aria-label={t('dismiss')}><X size={14} /></button></div>}
  </div>;
}
