import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { ArrowUp, ChevronDown, Cpu, Gauge, ImagePlus, Info, MoreHorizontal, PanelLeft, Sparkles, Square, X } from 'lucide-react';
import { piClient } from '../client/pi-client.js';
import { useAgentStore, type DisplayMessage } from '../stores/agent.js';
import { useProjectsStore } from '../stores/projects.js';
import { useUiStore } from '../stores/ui.js';
import type { AgentImageContent, AgentState, PromptOptions, ThinkingLevel } from '../../agent/backend.js';
import { Markdown } from './Markdown.js';
import { SoftCells } from './SoftCells.js';
import { ToolCallCard } from './ToolCallCard.js';
import styles from './Chat.module.css';

const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_ATTACHMENTS = 6;
// Same headroom pi's TUI uses before provider limits such as Anthropic's 5 MB inline image cap.
const MAX_IMAGE_BASE64_CHARS = 4.5 * 1024 * 1024;

function imageSrc(image: AgentImageContent): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

function formatBytes(bytes?: number): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTokenCount(count: number): string {
  if (count < 1_000) return String(Math.round(count));
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function formatUsage(state: AgentState): string {
  const parts: string[] = [];
  if (state.tokenUsage.input > 0) parts.push(`↑${formatTokenCount(state.tokenUsage.input)}`);
  if (state.tokenUsage.output > 0) parts.push(`↓${formatTokenCount(state.tokenUsage.output)}`);
  if (state.tokenUsage.cacheRead > 0) parts.push(`R${formatTokenCount(state.tokenUsage.cacheRead)}`);
  if (state.tokenUsage.cacheWrite > 0) parts.push(`W${formatTokenCount(state.tokenUsage.cacheWrite)}`);
  if (state.costUsd > 0 || state.tokenUsage.total > 0) parts.push(`$${state.costUsd.toFixed(3)}`);
  const pct = state.contextPercent == null ? '?' : state.contextPercent.toFixed(1);
  parts.push(`${pct}%/${formatTokenCount(state.tokensMax)}${state.autoCompactionEnabled ? ' (auto)' : ''}`);
  return parts.join(' ');
}

function formatElapsedSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return `${mins}m ${String(secs).padStart(2, '0')}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${String(mins % 60).padStart(2, '0')}m`;
}

function useElapsedTimer(enabled: boolean): number {
  const startedAtRef = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!enabled) {
      startedAtRef.current = null;
      setElapsed(0);
      return undefined;
    }

    startedAtRef.current = Date.now();
    setElapsed(0);
    const id = window.setInterval(() => {
      const startedAt = startedAtRef.current ?? Date.now();
      setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 500);

    return () => window.clearInterval(id);
  }, [enabled]);

  return elapsed;
}

function normalizeImageMimeType(type: string): string {
  const normalized = type.trim().toLowerCase();
  return normalized === 'image/jpg' ? 'image/jpeg' : normalized;
}

function dataUrlToImage(dataUrl: string, name: string, size: number): AgentImageContent {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!match || !match[1] || !match[2]) {
    throw new Error('Could not read image data');
  }
  return {
    type: 'image',
    mimeType: normalizeImageMimeType(match[1]),
    data: match[2],
    name,
    size,
  };
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name || 'image'}`));
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error(`Could not read ${file.name || 'image'}`));
    };
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode image'));
    img.src = dataUrl;
  });
}

function canvasToDataUrl(canvas: HTMLCanvasElement, mimeType: string, quality?: number): string {
  const dataUrl = canvas.toDataURL(mimeType, quality);
  if (!dataUrl || dataUrl === 'data:,') throw new Error('Could not encode resized image');
  return dataUrl;
}

async function shrinkImageDataUrl(dataUrl: string): Promise<string | null> {
  const img = await loadImage(dataUrl);
  const baseScale = Math.min(1, 2000 / img.naturalWidth, 2000 / img.naturalHeight);
  const scales = [baseScale, baseScale * 0.85, baseScale * 0.7, baseScale * 0.55, baseScale * 0.4, baseScale * 0.25];
  const qualities = [0.82, 0.72, 0.62, 0.52, 0.42];
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  for (const scale of scales) {
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.width = width;
    canvas.height = height;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);

    for (const quality of qualities) {
      const candidate = canvasToDataUrl(canvas, 'image/jpeg', quality);
      const image = dataUrlToImage(candidate, 'resized image.jpg', candidate.length);
      if (image.data.length <= MAX_IMAGE_BASE64_CHARS) return candidate;
    }
  }
  return null;
}

async function fileToImageContent(file: File): Promise<AgentImageContent> {
  const mimeType = normalizeImageMimeType(file.type || '');
  if (!SUPPORTED_IMAGE_TYPES.has(mimeType)) {
    throw new Error(`${file.name || 'Attachment'} is not a supported image type`);
  }
  const dataUrl = await readFileAsDataUrl(file);
  let image = dataUrlToImage(dataUrl, file.name || 'pasted image', file.size);
  if (image.data.length <= MAX_IMAGE_BASE64_CHARS) return image;

  const shrunk = await shrinkImageDataUrl(dataUrl);
  if (!shrunk) {
    throw new Error(`${file.name || 'Image'} is too large to attach`);
  }
  image = dataUrlToImage(shrunk, file.name || 'pasted image', file.size);
  if (image.data.length > MAX_IMAGE_BASE64_CHARS) {
    throw new Error(`${file.name || 'Image'} is too large to attach`);
  }
  return image;
}

function ImagePart({ image }: { image: AgentImageContent }) {
  return (
    <figure className={styles.imagePart} title={`${image.name ?? 'image'} ${formatBytes(image.size)}`}>
      <img src={imageSrc(image)} alt={image.name ?? 'Attached image'} />
      <figcaption>{image.name ?? image.mimeType}</figcaption>
    </figure>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.think}>
      <button
        type="button"
        className={styles.thinkHead}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ChevronDown
          size={12}
          className={`${styles.thinkChev} ${open ? styles.thinkChevOpen : ''}`}
        />
        <Sparkles size={12} />
        <span>Thinking</span>
      </button>
      {open && <div className={styles.thinkBody}>{text}</div>}
    </div>
  );
}

function MessageView({
  m,
  isActiveRun,
  onDiscardQueued,
}: {
  m: DisplayMessage;
  isActiveRun: boolean;
  onDiscardQueued: (messageId: string) => void;
}) {
  const runState = useAgentStore((s) => s.runState);
  const isUser = m.role === 'user';
  const isAgent = m.role === 'assistant';
  const queued = isUser ? m.queue : undefined;
  const elapsedLabel = formatElapsedSeconds(useElapsedTimer(isActiveRun));
  const runLabel = runState === 'thinking' ? 'Thinking' : 'Working';
  const queueLabel = queued?.status === 'pending'
    ? 'queueing'
    : queued?.kind === 'followUp'
      ? 'follow-up'
      : 'steer';
  return (
    <div className={`${styles.msg} ${isUser ? styles.user : styles.agent} ${queued ? styles.queuedMsg : ''}`}>
      <div className={styles.avatar}>{isUser ? 'You' : 'π'}</div>
      <div className={styles.body}>
        <div className={styles.meta}>
          <b>{isUser ? 'You' : 'Pi'}</b>
          <span>·</span>
          <span>{m.time}</span>
          {queued && (
            <span
              className={styles.queueChip}
              title={queued.kind === 'followUp' ? 'Follow-up queued' : 'Steering message queued'}
            >
              <span className={styles.queueDot} aria-hidden="true" />
              <span>{queueLabel}</span>
              <button
                type="button"
                onClick={() => onDiscardQueued(m.id)}
                title="Remove queued message from view"
                aria-label="Remove queued message"
              >
                <X size={9} />
              </button>
            </span>
          )}
        </div>
        <div className={styles.parts}>
          {(() => {
            const firstToolIdx = m.parts.findIndex((p) => p.kind === 'tool');
            return m.parts.map((p, i) => {
              const key = `${m.id}:${i}`;
              if (p.kind === 'thinking') {
                return p.text ? <ThinkingBlock key={key} text={p.text} /> : null;
              }
              if (p.kind === 'tool') {
                return (
                  <ToolCallCard key={key} tool={p.tool} defaultOpen={i === firstToolIdx} />
                );
              }
              if (p.kind === 'image') {
                return <ImagePart key={key} image={p.image} />;
              }
              if (!p.text) return null;
              return isAgent ? (
                <Markdown key={key} text={p.text} />
              ) : (
                <div key={key} className={styles.text}>
                  {p.text}
                </div>
              );
            });
          })()}
        </div>
        {isActiveRun && (
          <div className={styles.workEnd} title={`${runLabel} for ${elapsedLabel}`} aria-label={`${runLabel} for ${elapsedLabel}`}>
            <SoftCells cell={0.75} gap={0.65} />
            <span className={styles.workTimer}>{elapsedLabel}</span>
          </div>
        )}
      </div>
    </div>
  );
}

const THINKING: Array<{ level: ThinkingLevel; label: string }> = [
  { level: 'off', label: 'Off' },
  { level: 'minimal', label: 'Minimal' },
  { level: 'low', label: 'Low' },
  { level: 'medium', label: 'Medium' },
  { level: 'high', label: 'High' },
  { level: 'xhigh', label: 'X-High' },
];

function ModelPicker() {
  const models = useAgentStore((s) => s.models);
  const modelId = useAgentStore((s) => s.state.modelId);
  const modelProvider = useAgentStore((s) => s.state.modelProvider);
  const setModel = useAgentStore((s) => s.setModel);
  const [open, setOpen] = useState(false);

  const current = models.find((m) => m.id === modelId && m.provider === modelProvider);
  const label = current?.name ?? modelId ?? '—';

  if (models.length === 0) {
    return (
      <span className={styles.picker} title="Model">
        <Cpu size={12} className={styles.iconMuted} />
        <span className={styles.modelText}>{label}</span>
      </span>
    );
  }

  const grouped = models.reduce<Record<string, typeof models>>((acc, m) => {
    (acc[m.provider] ??= []).push(m);
    return acc;
  }, {});

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button className={styles.pickerBtn} type="button" title="Model">
          <Cpu size={12} className={styles.iconMuted} />
          <span className={styles.modelText}>{label}</span>
          <ChevronDown size={11} className={styles.menuChev} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={styles.menu} side="top" align="start" sideOffset={6}>
          {Object.entries(grouped).map(([provider, list]) => (
            <div key={provider}>
              <div className={styles.menuLabel}>{provider}</div>
              {list.map((m) => {
                const active = m.id === modelId && m.provider === modelProvider;
                return (
                  <button
                    key={`${m.provider}/${m.id}`}
                    type="button"
                    className={`${styles.menuItem} ${active ? styles.menuItemActive : ''}`}
                    onClick={() => {
                      setOpen(false);
                      if (!active) void setModel(m.provider, m.id);
                    }}
                  >
                    <span className={styles.menuItemName}>{m.name}</span>
                    {m.input.includes('image') && <span className={styles.menuTag}>image</span>}
                    {!m.reasoning && <span className={styles.menuTag}>no thinking</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function UsageBadge() {
  const state = useAgentStore((s) => s.state);
  const contextUsed = state.tokensUsed > 0 ? state.tokensUsed : state.tokenUsage.total;
  const rawPercent = state.contextPercent ?? (state.tokensMax > 0 ? (contextUsed / state.tokensMax) * 100 : null);
  const percent = rawPercent == null ? 0 : Math.min(100, Math.max(0, rawPercent));
  const percentLabel = rawPercent == null ? '—' : `${rawPercent < 10 ? rawPercent.toFixed(1) : rawPercent.toFixed(0)}%`;
  const toneClass = percent >= 85 ? styles.usageDanger : percent >= 65 ? styles.usageWarn : '';
  const contextLabel = `${formatTokenCount(contextUsed)} / ${formatTokenCount(state.tokensMax)} (${percentLabel})`;
  const costLabel = `$${state.costUsd.toFixed(3)}`;
  const ringStyle = {
    background: `conic-gradient(var(--usage-tone) ${percent * 3.6}deg, color-mix(in srgb, var(--ink) 8%, transparent) 0deg)`,
  };
  const barStyle = { width: `${percent}%` };

  return (
    <>
      <Popover.Root>
        <Popover.Trigger asChild>
          <button
            type="button"
            className={`${styles.usageMeterBtn} ${toneClass}`}
            title={`Context window ${contextLabel} · ${formatUsage(state)}`}
            aria-label={`Context window ${contextLabel}`}
          >
            <span className={styles.contextDot} style={ringStyle} aria-hidden="true" />
            <span className={styles.contextMeterMini}>
              <span className={styles.contextText}>
                <span>Context</span>
                <b>{percentLabel}</b>
              </span>
              <span className={styles.contextBar} aria-hidden="true">
                <span style={barStyle} />
              </span>
            </span>
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content className={`${styles.menu} ${styles.usageMenu} ${toneClass}`} side="top" align="center" sideOffset={6}>
            <div className={styles.usageMenuHead}>
              <span>Context window</span>
              <strong>{contextLabel}</strong>
            </div>
            <div className={styles.usageBigBar} aria-hidden="true">
              <span style={barStyle} />
            </div>
            <div className={styles.usageStats}>
              <div className={styles.usageStat}>
                <span>Input</span>
                <b>↑ {formatTokenCount(state.tokenUsage.input)}</b>
              </div>
              <div className={styles.usageStat}>
                <span>Output</span>
                <b>↓ {formatTokenCount(state.tokenUsage.output)}</b>
              </div>
              <div className={styles.usageStat}>
                <span>Cache read</span>
                <b>R {formatTokenCount(state.tokenUsage.cacheRead)}</b>
              </div>
              <div className={styles.usageStat}>
                <span>Cache write</span>
                <b>W {formatTokenCount(state.tokenUsage.cacheWrite)}</b>
              </div>
              <div className={styles.usageStat}>
                <span>Cost</span>
                <b>{costLabel}</b>
              </div>
              <div className={styles.usageStat}>
                <span>Total</span>
                <b>{formatTokenCount(state.tokenUsage.total)}</b>
              </div>
            </div>
            {state.autoCompactionEnabled && (
              <div className={styles.usageHint}>
                <span aria-hidden="true" />
                Auto-compaction enabled
              </div>
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <span className={styles.costBadge} title={`Session cost ${costLabel}`} aria-label={`Session cost ${costLabel}`}>
        <span className={styles.costMark} aria-hidden="true">$</span>
        <span>{state.costUsd.toFixed(3)}</span>
      </span>
    </>
  );
}

function ThinkingPicker() {
  const models = useAgentStore((s) => s.models);
  const modelId = useAgentStore((s) => s.state.modelId);
  const modelProvider = useAgentStore((s) => s.state.modelProvider);
  const thinkingLevel = useAgentStore((s) => s.state.thinkingLevel);
  const setThinkingLevel = useAgentStore((s) => s.setThinkingLevel);
  const [open, setOpen] = useState(false);

  const current = models.find((m) => m.id === modelId && m.provider === modelProvider);
  const reasoning = current?.reasoning ?? true;
  const label = THINKING.find((t) => t.level === thinkingLevel)?.label ?? thinkingLevel;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button className={styles.pickerBtn} type="button" title="Thinking effort">
          <Gauge size={12} className={styles.iconMuted} />
          <span className={styles.modelText}>{label}</span>
          <ChevronDown size={11} className={styles.menuChev} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={styles.menu} side="top" align="start" sideOffset={6}>
          <div className={styles.menuLabel}>Thinking effort</div>
          {THINKING.map((t) => {
            const active = t.level === thinkingLevel;
            return (
              <button
                key={t.level}
                type="button"
                className={`${styles.menuItem} ${active ? styles.menuItemActive : ''}`}
                onClick={() => {
                  setOpen(false);
                  if (!active) void setThinkingLevel(t.level);
                }}
              >
                <span className={styles.menuItemName}>{t.label}</span>
              </button>
            );
          })}
          {!reasoning && (
            <div className={styles.menuHint}>This model doesn&apos;t support thinking.</div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Composer() {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<AgentImageContent[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const runState = useAgentStore((s) => s.runState);
  const sendPrompt = useAgentStore((s) => s.sendPrompt);
  const abort = useAgentStore((s) => s.abort);
  const models = useAgentStore((s) => s.models);
  const modelId = useAgentStore((s) => s.state.modelId);
  const modelProvider = useAgentStore((s) => s.state.modelProvider);
  const running = runState !== 'idle';
  const currentModel = models.find((m) => m.id === modelId && m.provider === modelProvider);
  const supportsImages = currentModel ? currentModel.input.includes('image') : true;
  const canSend = (text.trim().length > 0 || attachments.length > 0) && (supportsImages || attachments.length === 0);

  const addFiles = async (filesLike: FileList | File[]) => {
    if (!supportsImages) {
      setAttachmentError('The current model does not advertise image input. Choose a vision model first.');
      return;
    }
    const files = Array.from(filesLike).filter((file) => file.type.startsWith('image/'));
    if (files.length === 0) return;
    if (attachments.length >= MAX_ATTACHMENTS) {
      setAttachmentError(`You can attach up to ${MAX_ATTACHMENTS} images.`);
      return;
    }
    setAttachmentError(null);
    const slots = Math.max(0, MAX_ATTACHMENTS - attachments.length);
    try {
      const next = await Promise.all(files.slice(0, slots).map(fileToImageContent));
      setAttachments((prev) => [...prev, ...next].slice(0, MAX_ATTACHMENTS));
      if (files.length > slots) {
        setAttachmentError(`Attached the first ${slots} images; limit is ${MAX_ATTACHMENTS}.`);
      }
    } catch (err) {
      setAttachmentError(err instanceof Error ? err.message : String(err));
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send(e.altKey ? 'followUp' : undefined);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files).filter((file) => file.type.startsWith('image/'));
    if (files.length === 0) return;
    e.preventDefault();
    void addFiles(files);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    const files = Array.from(e.dataTransfer.files).filter((file) => file.type.startsWith('image/'));
    if (files.length === 0) return;
    e.preventDefault();
    void addFiles(files);
  };

  const send = async (behavior?: PromptOptions['streamingBehavior']) => {
    if (!canSend) return;
    const t = text;
    const imgs = attachments;
    setText('');
    setAttachments([]);
    setAttachmentError(null);
    await sendPrompt(t, imgs, running ? behavior ?? 'steer' : undefined);
  };

  return (
    <div className={styles.composerWrap}>
      <div
        className={styles.composer}
        onDragOver={(e) => {
          if (Array.from(e.dataTransfer.items).some((item) => item.type.startsWith('image/'))) {
            e.preventDefault();
          }
        }}
        onDrop={onDrop}
      >
        {attachments.length > 0 && (
          <div className={styles.attachments}>
            {attachments.map((image, i) => (
              <div key={`${image.name ?? image.mimeType}-${i}`} className={styles.attachmentThumb}>
                <img src={imageSrc(image)} alt={image.name ?? 'Attached image'} />
                <span className={styles.attachmentMeta}>
                  <span>{image.name ?? image.mimeType}</span>
                  <small>{formatBytes(image.size)}</small>
                </span>
                <button
                  type="button"
                  onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                  aria-label="Remove image"
                  title="Remove image"
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          className={styles.textarea}
          value={text}
          placeholder={
            running
              ? 'Steer the agent — Enter sends now, Alt+Enter queues a follow-up'
              : supportsImages
                ? 'Ask Pi to refactor, debug, run, explain… Paste or attach images for vision models.'
                : 'Ask Pi to refactor, debug, run, explain…'
          }
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={2}
          aria-label="Message Pi"
        />
        {attachmentError && <div className={styles.attachmentError}>{attachmentError}</div>}
        <div className={styles.foot}>
          <ModelPicker />
          <ThinkingPicker />
          <UsageBadge />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            className={styles.fileInput}
            onChange={(e) => {
              if (e.currentTarget.files) void addFiles(e.currentTarget.files);
              e.currentTarget.value = '';
            }}
          />
          <button
            type="button"
            className={styles.attachBtn}
            title={supportsImages ? 'Attach images' : 'Current model does not support image input'}
            disabled={!supportsImages || attachments.length >= MAX_ATTACHMENTS}
            onClick={() => fileInputRef.current?.click()}
          >
            <ImagePlus size={12} />
            <span>Image</span>
          </button>
          <span className={styles.spacer} />
          <Popover.Root>
            <Popover.Trigger asChild>
              <button
                type="button"
                className={styles.moreBtn}
                title="Composer shortcuts"
                aria-label="Composer shortcuts"
              >
                <MoreHorizontal size={13} />
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content className={`${styles.menu} ${styles.moreMenu}`} side="top" align="end" sideOffset={6}>
                <div className={styles.menuLabel}>Shortcuts</div>
                <div className={styles.shortcutRow}>
                  <kbd>⏎</kbd>
                  <span>{running ? 'Steer current run' : 'Send message'}</span>
                </div>
                <div className={styles.shortcutRow}>
                  <kbd>⌥⏎</kbd>
                  <span>Queue as follow-up</span>
                </div>
                <div className={styles.shortcutRow}>
                  <kbd>⇧⏎</kbd>
                  <span>Insert newline</span>
                </div>
                <div className={styles.shortcutRow}>
                  <kbd>⌃C</kbd>
                  <span>Stop current run</span>
                </div>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          {running ? (
            <button
              className={`${styles.btn} ${styles.btnSm}`}
              onClick={() => void abort()}
              title="Stop"
            >
              <Square size={11} /> Stop
            </button>
          ) : (
            <button
              className={`${styles.btn} ${styles.primary} ${styles.btnSm}`}
              onClick={() => void send()}
              disabled={!canSend}
              title="Send (Enter)"
            >
              <ArrowUp size={12} /> Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function Chat() {
  const messages = useAgentStore((s) => s.messages);
  const runState = useAgentStore((s) => s.runState);
  const lastError = useAgentStore((s) => s.lastError);
  const clearError = useAgentStore((s) => s.clearError);
  const discardQueuedMessage = useAgentStore((s) => s.discardQueuedMessage);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const projectName = useProjectsStore((s) => s.activeProject()?.name ?? null);
  const projectPath = useProjectsStore((s) => s.activeProject()?.path ?? null);
  const chatTitle = useProjectsStore((s) => s.activeChat()?.title ?? null);
  const [projectIcon, setProjectIcon] = useState<string | null>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const activeAssistantId = runState === 'idle'
    ? null
    : [...messages].reverse().find((m) => m.role === 'assistant')?.id ?? null;

  useEffect(() => {
    if (!projectPath) {
      setProjectIcon(null);
      return;
    }
    let cancelled = false;
    void piClient.projects.icon(projectPath).then((d) => {
      if (!cancelled) setProjectIcon(d);
    });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  // Auto-scroll on new content unless the user has scrolled up.
  useEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 120) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, runState]);

  return (
    <section className={styles.chat}>
      <div className={styles.header}>
        <button
          className={styles.iconBtn}
          title="Toggle sidebar"
          onClick={toggleSidebar}
          aria-label="Toggle sidebar"
        >
          <PanelLeft size={15} />
        </button>
        <div className={styles.projIcon} aria-hidden="true">
          {projectIcon ? (
            <img src={projectIcon} alt="" className={styles.projIconImg} />
          ) : (
            <span>{(projectName ?? '·').charAt(0).toUpperCase()}</span>
          )}
        </div>
        <div className={styles.headerMeta}>
          <span className={styles.title}>{chatTitle ?? projectName ?? 'No chat'}</span>
          <span className={styles.subPath}>{projectPath ?? 'Open a project to start'}</span>
        </div>
      </div>

      <div className={styles.stream} ref={streamRef}>
        <div className={styles.inner}>
          <div className={styles.runStart}>
            <span className={styles.runStartRule} />
            <span className={styles.runStartText}>
              <Info size={11} /> session started · loaded AGENTS.md · interactive mode
            </span>
            <span className={styles.runStartRule} />
          </div>
          {messages.length === 0 && (
            <div className={styles.empty}>
              <h2>Hello — I am Pi.</h2>
              <p>Ask me to refactor, debug, run, or explain code. P1–P3 ships with a mock backend by default; export PI_BACKEND=sdk-local with ANTHROPIC_API_KEY set to drive Claude Sonnet.</p>
            </div>
          )}
          {messages.map((m) => (
            <MessageView
              key={m.id}
              m={m}
              isActiveRun={m.id === activeAssistantId}
              onDiscardQueued={discardQueuedMessage}
            />
          ))}
        </div>
      </div>

      {lastError && (
        <div className={styles.errorBanner} role="alert">
          <span>{lastError}</span>
          <button onClick={clearError} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      <Composer />
    </section>
  );
}
