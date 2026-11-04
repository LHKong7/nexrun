import { Children, isValidElement, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { TranslationKey } from '../lib/i18n';

type Translator = (key: TranslationKey) => string;
type Position = { start: { offset?: number }; end: { offset?: number } };

function sourceCode(source: string, position: Position | undefined, fallback: string) {
  if (position?.start.offset === undefined || position.end.offset === undefined) return fallback;
  const original = source.slice(position.start.offset, position.end.offset);
  if (!/^ {0,3}(?:`{3,}|~{3,})/.test(original)) return fallback;
  const firstNewline = original.indexOf('\n');
  if (firstNewline < 0) return fallback;
  const lastNewline = original.lastIndexOf('\n');
  const closing = original.slice(lastNewline + 1);
  return /^ {0,3}(?:`{3,}|~{3,})\s*$/.test(closing)
    ? original.slice(firstNewline + 1, lastNewline + 1)
    : original.slice(firstNewline + 1);
}

function CodeBlock({ children, raw, t, onCopy }: { children: ReactNode; raw: string; t: Translator; onCopy: (text: string, kind: 'code' | 'message') => Promise<boolean> }) {
  const [copied, setCopied] = useState(false);
  const child = Children.toArray(children).find(isValidElement);
  const className = child?.props && typeof child.props === 'object' && 'className' in child.props ? String(child.props.className ?? '') : '';
  const language = /language-([^\s]+)/.exec(className)?.[1] ?? '';
  return <Card className="code-block">
    <CardHeader className="code-header"><span>{language || 'text'}</span><Button variant="ghost" size="sm" onClick={async () => {
      if (await onCopy(raw, 'code')) { setCopied(true); window.setTimeout(() => setCopied(false), 1800); }
    }} aria-label={t('copyCode')}>{copied ? <Check size={13} /> : <Copy size={13} />}{t(copied ? 'copied' : 'copyCode')}</Button></CardHeader>
    <CardContent className="code-content"><pre>{children}</pre></CardContent>
  </Card>;
}

export function MarkdownMessage({ content, t, onCopy }: { content: string; t: Translator; onCopy: (text: string, kind: 'code' | 'message') => Promise<boolean> }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    pre: ({ children, node }) => {
      const child = Children.toArray(children).find(isValidElement);
      const fallback = child?.props && typeof child.props === 'object' && 'children' in child.props ? String(child.props.children ?? '') : '';
      return <CodeBlock raw={sourceCode(content, node?.position, fallback)} t={t} onCopy={onCopy}>{children}</CodeBlock>;
    },
    a: ({ href, children }) => <a href={href} target={href?.startsWith('http') ? '_blank' : undefined} rel="noreferrer noopener">{children}{href?.startsWith('http') && <ExternalLink size={11} className="inline-link-icon" />}</a>,
    img: ({ src, alt }) => <a href={src} target="_blank" rel="noreferrer noopener">{t('image')}{alt ? `: ${alt}` : ''}</a>,
    table: ({ children }) => <Table>{children}</Table>,
    thead: ({ children }) => <TableHeader>{children}</TableHeader>,
    tbody: ({ children }) => <TableBody>{children}</TableBody>,
    tr: ({ children }) => <TableRow>{children}</TableRow>,
    th: ({ children, style }) => <TableHead style={style}>{children}</TableHead>,
    td: ({ children, style }) => <TableCell style={style}>{children}</TableCell>,
    input: ({ checked }) => <Checkbox checked={Boolean(checked)} disabled aria-label={t(checked ? 'taskComplete' : 'taskIncomplete')} />,
  }}>{content}</ReactMarkdown></div>;
}
