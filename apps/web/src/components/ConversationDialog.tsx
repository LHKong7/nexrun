import { useRef, useState, type FormEvent } from 'react';
import type { Conversation } from '@nexrun/protocol';
import { Archive, CircleAlert, Pencil } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { api, RequestError } from '../lib/api';
import { errorKey, type TranslationKey } from '../lib/i18n';

export type ConversationAction = { type: 'rename' | 'archive'; conversation: Conversation; trigger?: HTMLElement };

type Props = {
  action: ConversationAction;
  onDismiss: () => void;
  onSaved: (conversation: Conversation) => void;
  t: (key: TranslationKey) => string;
};

export function ConversationDialog({ action, onDismiss, onSaved, t }: Props) {
  const [title, setTitle] = useState(action.conversation.title);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const archive = action.type === 'archive';
  const finalFocus = () => action.trigger?.isConnected ? action.trigger : document.querySelector<HTMLElement>('[data-new-chat]');

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (busyRef.current || (!archive && !title.trim())) return;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      const updated = await api.updateConversation(action.conversation.id, archive ? { archived: true } : { title: title.trim() });
      onSaved(updated); onDismiss();
    } catch (failure) {
      setError(failure instanceof RequestError ? failure.code : 'REQUEST_FAILED');
      busyRef.current = false; setBusy(false);
    }
  }
  const errorAlert = error && <Alert className="inline-error" variant="destructive"><CircleAlert size={16} /><AlertDescription>{t(errorKey(error))}</AlertDescription></Alert>;

  if (archive) {
    return <AlertDialog open onOpenChange={(open, details) => {
      if (!open) { if (busyRef.current) details.cancel(); else onDismiss(); }
    }}>
      <AlertDialogContent className="conversation-dialog" initialFocus={cancelRef} finalFocus={finalFocus}>
        <AlertDialogHeader>
          <div className="dialog-icon archive-icon"><Archive size={21} /></div>
          <AlertDialogTitle>{t('archiveTitle')}</AlertDialogTitle>
          <AlertDialogDescription>{t('archiveDescription')}</AlertDialogDescription>
        </AlertDialogHeader>
        {errorAlert}
        <AlertDialogFooter className="dialog-actions">
          <AlertDialogCancel ref={cancelRef} disabled={busy}>{t('cancel')}</AlertDialogCancel>
          <AlertDialogAction disabled={busy} onClick={() => void submit()}>{busy && <Spinner aria-label={t('loading')} />}{t(busy ? 'working' : 'archive')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>;
  }

  return <Dialog open disablePointerDismissal={busy} onOpenChange={(open, details) => {
    if (!open) { if (busyRef.current) details.cancel(); else onDismiss(); }
  }}>
    <DialogContent className="conversation-dialog" closeLabel={t('close')} closeButtonProps={{ disabled: busy }} initialFocus={inputRef} finalFocus={finalFocus}>
      <form onSubmit={event => void submit(event)}>
        <DialogHeader>
          <div className="dialog-icon"><Pencil size={21} /></div>
          <DialogTitle>{t('renameTitle')}</DialogTitle>
          <DialogDescription>{t('renameDescription')}</DialogDescription>
        </DialogHeader>
        <div className="dialog-label"><Label htmlFor="conversation-title">{t('titleLabel')}</Label><Input id="conversation-title" ref={inputRef} value={title} onChange={event => setTitle(event.target.value)} maxLength={120} required /></div>
        {errorAlert}
        <DialogFooter className="dialog-actions"><Button type="button" variant="outline" onClick={onDismiss} disabled={busy}>{t('cancel')}</Button><Button type="submit" disabled={busy || !title.trim()}>{busy && <Spinner aria-label={t('loading')} />}{t(busy ? 'working' : 'save')}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
