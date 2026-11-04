import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { AdminAccess, AdminSettings, AdminSettingsUpdate, CredentialCheck } from '@nexrun/protocol';
import { ArrowLeft, Check, CircleAlert, Globe2, KeyRound, LockKeyhole, RefreshCw, Settings2, ShieldCheck, Trash2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { api, RequestError } from '../lib/api';
import { errorKey, type Locale, type TranslationKey } from '../lib/i18n';

type Draft = Pick<AdminSettingsUpdate, 'adapter' | 'provider' | 'model' | 'responseLanguage' | 'keyAction'>;
type Props = { locale: Locale; onLocaleChange: (locale: Locale) => void; onBack: () => void; backLabel: string; onSaved: () => void; t: (key: TranslationKey) => string };
const draftFor = (settings: AdminSettings): Draft => ({ adapter: settings.adapter, provider: settings.provider, model: settings.model, responseLanguage: settings.responseLanguage, keyAction: 'keep' });
const codeOf = (error: unknown) => error instanceof RequestError ? error.code : 'SETTINGS_UNAVAILABLE';

export function AdminSettingsPage({ locale, onLocaleChange, onBack, backLabel, onSaved, t }: Props) {
  const [access, setAccess] = useState<AdminAccess | null>(null);
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [locked, setLocked] = useState(false);
  const [authToken, setAuthToken] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [verification, setVerification] = useState<CredentialCheck | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const alive = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const keyInput = useRef<HTMLInputElement>(null);
  const tokenInput = useRef<HTMLInputElement>(null);
  const removeCancel = useRef<HTMLButtonElement>(null);
  const removeTrigger = useRef<HTMLButtonElement>(null);
  const busy = loading || saving || checking || unlocking;
  const activeRuns = settings?.activeRuns ?? 0;
  const dirty = Boolean(settings && draft && (draft.adapter !== settings.adapter || draft.model !== settings.model || draft.responseLanguage !== settings.responseLanguage || draft.keyAction !== 'keep'));
  const modelAvailable = Boolean(settings && draft && settings.models.some(model => model.id === draft.model));
  const controlsDisabled = busy || activeRuns > 0 || error === 'SETTINGS_BUSY';

  const applySettings = useCallback((value: AdminSettings) => {
    setSettings(value); setDraft(draftFor(value)); setApiKey(''); setVerification(null); setCheckError(null); setConfirmRemove(false);
  }, []);
  const lockSettings = useCallback(() => {
    setAuthToken(''); setTokenDraft(''); setApiKey(''); setSettings(null); setDraft(null); setLocked(true); setError('ADMIN_AUTH_REQUIRED');
  }, []);
  const reportFailure = useCallback((failure: unknown) => {
    if (failure instanceof DOMException && failure.name === 'AbortError') return;
    if (failure instanceof RequestError && failure.status === 401) lockSettings();
    else setError(codeOf(failure));
  }, [lockSettings]);

  useEffect(() => {
    alive.current = true;
    let current = true;
    const request = new AbortController(); controller.current = request;
    void (async () => {
      try {
        const permission = await api.adminAccess(request.signal);
        if (!current) return;
        setAccess(permission);
        const value = await api.adminSettings(undefined, request.signal);
        if (!current) return;
        applySettings(value); setLocked(false); setError(null);
      } catch (failure) { if (current) reportFailure(failure); }
      finally { if (current) setLoading(false); }
    })();
    return () => {
      current = false; alive.current = false; controller.current?.abort();
      if (keyInput.current) keyInput.current.value = '';
      if (tokenInput.current) tokenInput.current.value = '';
    };
  }, [applySettings, reportFailure]);

  async function reload() {
    if (busy) return;
    controller.current?.abort(); const request = new AbortController(); controller.current = request;
    setLoading(true); setError(null); setSaved(false); setApiKey(''); setTokenDraft('');
    try {
      const value = await api.adminSettings(access?.requiresToken ? authToken : undefined, request.signal);
      if (alive.current) { applySettings(value); setLocked(false); }
    } catch (failure) { if (alive.current) reportFailure(failure); }
    finally { if (alive.current) setLoading(false); }
  }
  async function unlock(event: FormEvent) {
    event.preventDefault();
    if (!tokenDraft.trim() || unlocking) return;
    const candidate = tokenDraft.trim();
    const request = new AbortController(); controller.current = request;
    setUnlocking(true); setError(null); setApiKey('');
    try {
      const value = await api.adminSettings(access?.requiresToken ? candidate : undefined, request.signal);
      if (!alive.current) return;
      setAuthToken(access?.requiresToken ? candidate : ''); setTokenDraft(''); applySettings(value); setLocked(false);
    } catch (failure) { if (alive.current) { setAuthToken(''); setTokenDraft(''); setApiKey(''); reportFailure(failure); } }
    finally { if (alive.current) setUnlocking(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!settings || !draft || !dirty || controlsDisabled || !modelAvailable) return;
    const request = new AbortController(); controller.current = request;
    setSaving(true); setError(null); setSaved(false);
    const update: AdminSettingsUpdate = { ...draft, revision: settings.revision, ...(draft.keyAction === 'replace' ? { apiKey } : {}) };
    try {
      const value = await api.updateAdminSettings(update, access?.requiresToken ? authToken : undefined, request.signal);
      if (!alive.current) return;
      applySettings(value); setSaved(true); onSaved(); toast.add({ title: t('adminSaved'), type: 'success' });
    } catch (failure) {
      if (alive.current) {
        reportFailure(failure);
      }
    } finally { if (alive.current) setSaving(false); }
  }
  async function checkCredentials() {
    if (!settings || dirty || !settings.keyConfigured || busy) return;
    const request = new AbortController(); controller.current = request;
    setChecking(true); setCheckError(null); setVerification(null);
    try {
      const result = await api.checkCredentials(settings.revision, access?.requiresToken ? authToken : undefined, request.signal);
      if (alive.current) setVerification(result);
    } catch (failure) {
      if (alive.current && !(failure instanceof DOMException && failure.name === 'AbortError')) {
        if (failure instanceof RequestError && failure.status === 401) lockSettings();
        else setCheckError(codeOf(failure));
      }
    } finally { if (alive.current) setChecking(false); }
  }
  function change(change: Partial<Draft>) { setDraft(previous => previous ? { ...previous, ...change } : previous); setSaved(false); }
  function updateKey(value: string) { setApiKey(value); change({ keyAction: value ? 'replace' : 'keep' }); }
  function reset() { if (settings) { applySettings(settings); setError(null); setSaved(false); } }
  const languageSelect = <Select items={[{ value: 'en', label: t('english') }, { value: 'zh-CN', label: t('chinese') }]} value={locale} onValueChange={value => { if (value === 'en' || value === 'zh-CN') onLocaleChange(value); }}><SelectTrigger className="admin-locale-trigger" aria-label={t('language')}><Globe2 size={15} /><SelectValue /></SelectTrigger><SelectContent className="admin-select-menu" alignItemWithTrigger={false}><SelectItem value="en">{t('english')}</SelectItem><SelectItem value="zh-CN">{t('chinese')}</SelectItem></SelectContent></Select>;
  const sourceLabel: TranslationKey = settings?.keySource === 'stored' ? 'adminKeyStored' : settings?.keySource === 'environment' ? 'adminKeyEnvironment' : 'adminKeyNone';

  return <div className="admin-page">
    <header className="admin-header"><Button variant="ghost" className="admin-back" onClick={onBack}><ArrowLeft size={17} />{backLabel}</Button><div className="admin-mobile-language">{languageSelect}</div></header>
    <ScrollArea className="admin-scroll" viewportProps={{ className: 'admin-scroll-viewport' }}>
      <div className="admin-content">
        <div className="admin-page-heading"><div className="admin-heading-icon"><Settings2 size={24} strokeWidth={1.5} /></div><div><h1>{t('adminTitle')}</h1><p>{t('adminSubtitle')}</p></div></div>
        {loading && !settings && !locked ? <div className="admin-loading" role="status" aria-label={t('adminLoading')}><Skeleton /><Skeleton /><Skeleton /></div> : locked ? <Card className="admin-unlock-card"><CardHeader><div className="admin-card-icon"><LockKeyhole size={23} /></div><CardTitle>{t('adminUnlockTitle')}</CardTitle><CardDescription>{t('adminUnlockDescription')}</CardDescription></CardHeader><CardContent><form onSubmit={event => void unlock(event)}><div className="admin-field"><Label htmlFor="admin-token">{t('adminToken')}</Label><Input id="admin-token" ref={tokenInput} type="password" autoComplete="off" spellCheck={false} autoCapitalize="none" value={tokenDraft} onChange={event => setTokenDraft(event.target.value)} disabled={unlocking} autoFocus /><p>{t('adminTokenHint')}</p></div>{error && <Alert variant="destructive" className="admin-alert"><CircleAlert size={16} /><AlertDescription>{t(errorKey(error))}</AlertDescription></Alert>}<Button className="admin-unlock-button" type="submit" disabled={unlocking || !tokenDraft.trim()}>{unlocking ? <Spinner aria-label={t('loading')} /> : <LockKeyhole size={15} />}{t(unlocking ? 'adminUnlocking' : 'adminUnlock')}</Button></form></CardContent></Card> : !settings || !draft ? <Card className="admin-unavailable"><CardHeader><CardTitle>{t('adminAccessDeniedTitle')}</CardTitle><CardDescription>{t(errorKey(error ?? 'SETTINGS_UNAVAILABLE'))}</CardDescription></CardHeader><CardContent><Button variant="outline" onClick={() => void reload()} disabled={loading}><RefreshCw size={15} />{t('adminReload')}</Button></CardContent></Card> : <>
          <div className="admin-state-row"><span>{t('adminSavedLabel')}<Badge variant="outline">{t('adminRevision').replace('{revision}', String(settings.revision))}</Badge></span><Button variant="ghost" size="sm" onClick={() => void reload()} disabled={busy}><RefreshCw size={14} />{t('adminReload')}</Button></div>
          {activeRuns > 0 && <Alert className="admin-alert admin-busy-alert"><CircleAlert size={16} /><AlertDescription>{t('adminActiveRuns').replace('{count}', String(activeRuns))}</AlertDescription></Alert>}
          {error && <Alert variant="destructive" className="admin-alert"><CircleAlert size={16} /><AlertDescription>{t(error === 'VALIDATION_ERROR' ? 'errorAdminValidation' : errorKey(error))}</AlertDescription>{error === 'SETTINGS_CONFLICT' && <Button variant="outline" size="sm" onClick={() => void reload()} disabled={busy}>{t('adminReload')}</Button>}</Alert>}
          {saved && <Alert className="admin-alert admin-success-alert" role="status"><Check size={16} /><AlertDescription>{t('adminSaved')}</AlertDescription></Alert>}
          <form className="admin-settings-form" onSubmit={event => void save(event)}>
            <Card className="admin-settings-card"><CardHeader><CardTitle>{t('adminRuntimeTitle')}</CardTitle><CardDescription>{t('adminRuntimeDescription')}</CardDescription></CardHeader><CardContent>
              <div className="admin-fields-grid">
                <div className="admin-field"><Label htmlFor="admin-adapter">{t('adminAdapter')}</Label><Select items={[{ value: 'mock', label: t('agentMock') }, { value: 'pi', label: t('agentPi') }]} value={draft.adapter} onValueChange={value => { if (value === 'mock' || value === 'pi') change({ adapter: value }); }} disabled={controlsDisabled}><SelectTrigger id="admin-adapter" aria-label={t('adminAdapter')}><SelectValue /></SelectTrigger><SelectContent className="admin-select-menu" alignItemWithTrigger={false}><SelectItem value="mock">{t('agentMock')}</SelectItem><SelectItem value="pi">{t('agentPi')}</SelectItem></SelectContent></Select></div>
                <div className="admin-field"><Label htmlFor="admin-provider">{t('adminProvider')}</Label><Select items={[{ value: 'openai', label: 'OpenAI' }]} value="openai" disabled><SelectTrigger id="admin-provider" aria-label={t('adminProvider')}><SelectValue /></SelectTrigger><SelectContent className="admin-select-menu" alignItemWithTrigger={false}><SelectItem value="openai">OpenAI</SelectItem></SelectContent></Select></div>
                <div className="admin-field admin-field-wide"><Label htmlFor="admin-model">{t('adminModel')}</Label><Select items={settings.models.map(model => ({ value: model.id, label: model.name }))} value={draft.model} onValueChange={value => { if (typeof value === 'string') change({ model: value }); }} disabled={controlsDisabled}><SelectTrigger id="admin-model" aria-label={t('adminModel')}><SelectValue>{settings.models.find(model => model.id === draft.model)?.name ?? draft.model}</SelectValue></SelectTrigger><SelectContent className="admin-select-menu" alignItemWithTrigger={false}>{settings.models.map(model => <SelectItem value={model.id} key={model.id}>{model.name}</SelectItem>)}</SelectContent></Select><p>{t(modelAvailable ? 'adminModelHint' : 'errorModelUnavailable')}</p></div>
                <div className="admin-field admin-field-wide"><Label htmlFor="admin-response-language">{t('adminResponseLanguage')}</Label><Select items={[{ value: 'auto', label: t('adminLanguageAuto') }, { value: 'en', label: t('english') }, { value: 'zh-CN', label: t('chinese') }]} value={draft.responseLanguage} onValueChange={value => { if (value === 'auto' || value === 'en' || value === 'zh-CN') change({ responseLanguage: value }); }} disabled={controlsDisabled}><SelectTrigger id="admin-response-language" aria-label={t('adminResponseLanguage')}><SelectValue /></SelectTrigger><SelectContent className="admin-select-menu" alignItemWithTrigger={false}><SelectItem value="auto">{t('adminLanguageAuto')}</SelectItem><SelectItem value="en">{t('english')}</SelectItem><SelectItem value="zh-CN">{t('chinese')}</SelectItem></SelectContent></Select><p>{t('adminResponseLanguageHint')}</p></div>
              </div>
              <Alert className="admin-context-notice"><CircleAlert size={16} /><AlertDescription>{t('adminFreshChat')}</AlertDescription></Alert>
            </CardContent></Card>
            <Card className="admin-settings-card"><CardHeader><div className="admin-card-heading"><div><CardTitle>{t('adminCredentialsTitle')}</CardTitle><CardDescription>{t('adminCredentialsDescription')}</CardDescription></div><Badge variant={settings.keyConfigured ? 'secondary' : 'outline'}>{t(settings.keyConfigured ? 'adminKeyConfigured' : 'adminKeyMissing')}</Badge></div></CardHeader><CardContent>
              <div className="admin-key-source"><KeyRound size={15} /><span>{t('adminKeySource')}</span><strong>{t(sourceLabel)}</strong></div>
              <div className="admin-field"><Label htmlFor="admin-api-key">{t('adminNewKey')}</Label><Input id="admin-api-key" ref={keyInput} type="password" autoComplete="new-password" autoCapitalize="none" spellCheck={false} value={apiKey} onChange={event => updateKey(event.target.value)} disabled={controlsDisabled} placeholder={t('adminNewKeyPlaceholder')} maxLength={4096} /><p>{t('adminKeyKeepHint')}</p></div>
              <div className="admin-key-actions"><Button ref={removeTrigger} type="button" variant="outline" size="sm" disabled={controlsDisabled || !settings.keyConfigured || draft.keyAction === 'remove'} onClick={() => setConfirmRemove(true)}><Trash2 size={14} />{t('adminRemoveKey')}</Button><Button type="button" variant="ghost" size="sm" disabled={controlsDisabled || !settings.environmentKeyAvailable || draft.keyAction === 'inherit'} onClick={() => { setApiKey(''); change({ keyAction: 'inherit' }); }}><RefreshCw size={14} />{t('adminUseEnvironment')}</Button></div>
              {!settings.environmentKeyAvailable && <p className="admin-field-note">{t('adminNoEnvironmentKey')}</p>}
              {draft.keyAction !== 'keep' && <Alert className="admin-alert admin-staged-key" role="status"><KeyRound size={15} /><AlertDescription>{t(draft.keyAction === 'remove' ? 'adminRemoveStaged' : draft.keyAction === 'inherit' ? 'adminInheritStaged' : 'adminReplaceStaged')}</AlertDescription><Button type="button" variant="link" size="sm" disabled={controlsDisabled} onClick={() => { setApiKey(''); change({ keyAction: 'keep' }); }}>{t('adminUndoKeyChange')}</Button></Alert>}
            </CardContent></Card>
            <div className="admin-save-bar"><span>{dirty ? <><span className="admin-unsaved-dot" />{t('adminUnsaved')}</> : <><ShieldCheck size={15} />{t('adminSavedLabel')}</>}</span><div><Button type="button" variant="outline" onClick={reset} disabled={!dirty || busy}>{t('adminReset')}</Button><Button type="submit" disabled={!dirty || controlsDisabled || !modelAvailable}>{saving && <Spinner aria-label={t('loading')} />}{t(saving ? 'adminSaving' : 'adminSave')}</Button></div></div>
          </form>
          <Card className="admin-verification-card"><CardHeader><CardTitle>{t('adminVerificationTitle')}</CardTitle><CardDescription>{t('adminVerificationDescription')}</CardDescription></CardHeader><CardContent><div className="admin-check-row"><Button variant="outline" onClick={() => void checkCredentials()} disabled={busy || dirty || !settings.keyConfigured}>{checking ? <Spinner aria-label={t('loading')} /> : <ShieldCheck size={16} />}{t(checking ? 'adminChecking' : 'adminCheck')}</Button><p>{dirty ? t('adminSaveBeforeCheck') : !settings.keyConfigured ? t('adminCheckNoKey') : !verification ? t('adminCheckNotRun') : ''}</p></div>{verification && <Alert className={`admin-alert${verification.ok ? ' admin-success-alert' : ''}`} variant={verification.ok ? 'default' : 'destructive'} role="status">{verification.ok ? <Check size={16} /> : <CircleAlert size={16} />}<AlertDescription><strong>{t(verification.ok ? 'adminCheckSuccess' : errorKey(verification.code))}</strong><span>{t('adminCheckTimestamp').replace('{time}', new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(verification.checkedAt)))}</span></AlertDescription></Alert>}{checkError && <Alert variant="destructive" className="admin-alert"><CircleAlert size={16} /><AlertDescription>{t(errorKey(checkError))}</AlertDescription></Alert>}</CardContent></Card>
        </>}
      </div>
    </ScrollArea>
    <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}><AlertDialogContent className="conversation-dialog" initialFocus={removeCancel} finalFocus={removeTrigger}><AlertDialogHeader><div className="dialog-icon archive-icon"><Trash2 size={21} /></div><AlertDialogTitle>{t('adminRemoveTitle')}</AlertDialogTitle><AlertDialogDescription>{t('adminRemoveDescription')}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel ref={removeCancel}>{t('cancel')}</AlertDialogCancel><AlertDialogAction onClick={() => { setApiKey(''); change({ keyAction: 'remove' }); setConfirmRemove(false); }}>{t('adminConfirmRemove')}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </div>;
}
