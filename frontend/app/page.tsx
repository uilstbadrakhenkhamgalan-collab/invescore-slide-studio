'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import Image from 'next/image';
import type {
  V2SlidePlan, Step, TokenUsage, BuildProgress,
  ChatMessage, IntakeData, IntakeMode,
  InterpretResponse, HistoryEntry, SlideWarning,
} from '@/lib/types';
import { BACKEND_URL } from '@/lib/constants';

// ── Example prompts ────────────────────────────────────────────────────────────
const EXAMPLES = [
  'Бизнес төлөвлөгөө 2026 — InvesCore Property стратеги, зорилго, төсөв',
  'Q1 2026 Ulaanbaatar office market update — vacancy, rental trends, new supply',
  'Team introduction — InvesCore Property Research department',
  'Investor presentation — Mongolian real estate opportunities',
];

// ── Progress step builder ──────────────────────────────────────────────────────
type StepState = 'done' | 'active' | 'pending';
interface ProgressItem { label: string; state: StepState; }

function buildProgress(step: Step, buildProgress?: BuildProgress | null): ProgressItem[] {
  const buildLabel = buildProgress
    ? `Building slide ${buildProgress.current} of ${buildProgress.total} — ${buildProgress.title}`
    : 'Building slides';

  const items: ProgressItem[] = [
    { label: 'Interpreting request', state: 'pending' },
    { label: 'Planning slides', state: 'pending' },
    { label: buildLabel, state: 'pending' },
    { label: 'Finalizing', state: 'pending' },
  ];
  if (step === 'interpreting') {
    items[0].state = 'active';
  } else if (step === 'plan_ready') {
    items[0].state = 'done'; items[1].state = 'done';
  } else if (step === 'building') {
    items[0].state = 'done'; items[1].state = 'done'; items[2].state = 'active';
  } else if (step === 'done') {
    items.forEach(i => { i.state = 'done'; });
  }
  return items;
}

// ── Component ──────────────────────────────────────────────────────────────────
export default function HomePage() {
  // ── Presentation generation state ──────────────────────────────────────────
  const [apiKey, setApiKey] = useState('');
  const [prompt, setPrompt] = useState('');
  const [step, setStep] = useState<Step>('idle');
  const [plan, setPlan] = useState<V2SlidePlan | null>(null);
  const [buildProg, setBuildProg] = useState<BuildProgress | null>(null);
  const [downloadArtifactId, setDownloadArtifactId] = useState<string | null>(null);
  const [downloadToken, setDownloadToken] = useState('');
  const [downloadFilename, setDownloadFilename] = useState('presentation.pptx');
  const [error, setError] = useState<string | null>(null);
  const [slideWarnings, setSlideWarnings] = useState<SlideWarning[]>([]);
  const [isDownloading, setIsDownloading] = useState(false);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ── Intake / chat state ─────────────────────────────────────────────────────
  const [intakeMode, setIntakeMode] = useState<IntakeMode>('initial');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [intakeData, setIntakeData] = useState<IntakeData | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLInputElement>(null);

  // ── Local history ─────────────────────────────────────────────────────────
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  // ── Abort controllers for in-flight requests ─────────────────────────────
  const generateAbortRef = useRef<AbortController | null>(null);
  const intakeAbortRef = useRef<AbortController | null>(null);

  const hasApiKey = apiKey.trim().length > 10;
  const isWorking = step === 'interpreting' || step === 'building';
  const canGenerateFromTextarea = hasApiKey && prompt.trim().length > 5 && !isWorking;
  const canGenerateFromIntake = hasApiKey && intakeMode === 'complete' && !!intakeData && !isWorking;

  // ── Auto-scroll chat ────────────────────────────────────────────────────────
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, isTyping]);

  // ── Load persisted data on mount ─────────────────────────────────────────
  useEffect(() => {
    try {
      const savedHistory = localStorage.getItem('invescore_history');
      if (savedHistory) setHistory(JSON.parse(savedHistory));
    } catch { /* ignore */ }
    try {
      const pending = localStorage.getItem('invescore_pending_download');
      if (pending) {
        const p = JSON.parse(pending) as { artifactId: string; token: string; filename: string; expiresAt: number };
        if (p.expiresAt && p.expiresAt > Date.now()) {
          setDownloadArtifactId(p.artifactId);
          setDownloadToken(p.token);
          setDownloadFilename(p.filename || 'presentation.pptx');
          setStep('done');
        } else {
          localStorage.removeItem('invescore_pending_download');
        }
      }
    } catch { /* ignore */ }
  }, []);

  // Persist pending downloads as soon as we receive them.
  useEffect(() => {
    if (downloadArtifactId && downloadToken) {
      try {
        localStorage.setItem('invescore_pending_download', JSON.stringify({
          artifactId: downloadArtifactId,
          token: downloadToken,
          filename: downloadFilename,
          expiresAt: Date.now() + 5 * 60 * 60 * 1000,
        }));
      } catch { /* ignore */ }
    }
  }, [downloadArtifactId, downloadToken, downloadFilename]);

  // ── Intake API call ─────────────────────────────────────────────────────────
  const callIntakeAPI = useCallback(async (messages: ChatMessage[]): Promise<string> => {
    const apiMessages = messages.map(({ role, content }) => ({ role, content }));
    intakeAbortRef.current?.abort();
    const controller = new AbortController();
    intakeAbortRef.current = controller;
    const res = await fetch(`${BACKEND_URL}/api/intake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey.trim(), messages: apiMessages }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { detail?: string }).detail || `Intake failed (${res.status})`);
    }
    return ((await res.json()) as { content: string }).content;
  }, [apiKey]);

  const processResponse = useCallback((content: string, prevMessages: ChatMessage[]) => {
    let displayContent = content;
    let completed = false;
    let parsed: IntakeData | null = null;

    if (content.includes('---INTAKE COMPLETE---')) {
      const match = content.match(/---INTAKE COMPLETE---\s*(\{[\s\S]*?\})\s*---END---/);
      if (match) {
        try {
          parsed = JSON.parse(match[1]) as IntakeData;
          completed = true;
          displayContent = content.replace(/---INTAKE COMPLETE---[\s\S]*?---END---/g, '').trim();
          if (!displayContent) {
            displayContent = "I have everything I need. Here's your presentation brief below.";
          }
        } catch {
          /* fall through */
        }
      }
    }

    setChatMessages([...prevMessages, { role: 'assistant', content, displayContent }]);

    if (completed && parsed) {
      setIntakeData(parsed);
      setIntakeMode('complete');
    }
  }, []);

  const startConversation = useCallback(async (initialMsg?: string) => {
    setIntakeData(null);
    setChatMessages([]);
    setChatInput('');
    setIntakeMode('chat');
    setIsTyping(true);

    const isHidden = !initialMsg;
    const firstContent = initialMsg ?? 'START';
    const messages: ChatMessage[] = [{ role: 'user', content: firstContent, hidden: isHidden }];
    setChatMessages(messages);

    try {
      const content = await callIntakeAPI(messages);
      processResponse(content, messages);
    } catch {
      setChatMessages([
        ...messages,
        { role: 'assistant', content: "Sorry, I couldn't connect. Please check your API key and try again." },
      ]);
    } finally {
      setIsTyping(false);
    }
  }, [callIntakeAPI, processResponse]);

  const sendChatMessage = useCallback(async () => {
    const text = chatInput.trim();
    if (!text || isTyping) return;

    setChatInput('');
    const messages: ChatMessage[] = [...chatMessages, { role: 'user', content: text }];
    setChatMessages(messages);
    setIsTyping(true);

    try {
      const content = await callIntakeAPI(messages);
      processResponse(content, messages);
    } catch {
      setChatMessages([
        ...messages,
        { role: 'assistant', content: "Sorry, something went wrong. Please try again." },
      ]);
    } finally {
      setIsTyping(false);
    }
  }, [chatInput, chatMessages, isTyping, callIntakeAPI, processResponse]);

  const handleChatKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  }, [sendChatMessage]);

  const handleStartOver = useCallback(() => {
    setIntakeMode('initial');
    setChatMessages([]);
    setChatInput('');
    setIntakeData(null);
    setIsTyping(false);
  }, []);

  // ── Presentation generation ─────────────────────────────────────────────────
  const doInterpret = useCallback(async (promptOverride?: string): Promise<V2SlidePlan | null> => {
    setStep('interpreting');
    const actualPrompt = promptOverride ?? prompt.trim();
    generateAbortRef.current?.abort();
    const controller = new AbortController();
    generateAbortRef.current = controller;
    const res = await fetch(`${BACKEND_URL}/api/interpret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey.trim(), prompt: actualPrompt }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { detail?: string }).detail || `Interpretation failed (${res.status})`);
    }
    const data = await res.json() as InterpretResponse;
    const newPlan: V2SlidePlan = {
      presentation_title: data.presentation_title,
      sections: data.sections,
    };
    setTokenUsage(data.token_usage);
    setPlan(newPlan);
    return newPlan;
  }, [apiKey, prompt]);

  const doBuildV2 = useCallback(async (slidePlan: V2SlidePlan) => {
    setStep('building');
    setBuildProg(null);
    setSlideWarnings([]);
    setDownloadArtifactId(null);
    setDownloadToken('');
    setDownloadFilename('presentation.pptx');

    generateAbortRef.current?.abort();
    const controller = new AbortController();
    generateAbortRef.current = controller;
    const res = await fetch(`${BACKEND_URL}/api/generate_v2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey.trim(), slide_plan: slidePlan }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { detail?: string }).detail || `Generation failed (${res.status})`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response stream');
    const decoder = new TextDecoder();
    let buffer = '';
    let completed = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop() ?? '';

      for (const chunk of lines) {
        const eventMatch = chunk.match(/^event: (.+)/m);
        const dataMatch  = chunk.match(/^data: (.+)/m);
        const eventType  = eventMatch?.[1]?.trim();
        let data: Record<string, unknown> = {};
        if (dataMatch?.[1]?.trim()) {
          try { data = JSON.parse(dataMatch[1].trim()); } catch { console.warn('[SSE] Failed to parse event data:', dataMatch[1].trim()); }
        }

        if (eventType === 'building_slide') {
          setBuildProg({
            current: data.current as number,
            total:   data.total   as number,
            title:   data.title   as string,
          });
        } else if (eventType === 'slide_error') {
          setSlideWarnings(prev => [
            ...prev,
            {
              slideIndex: typeof data.slide_index === 'number' ? data.slide_index : undefined,
              title: typeof data.title === 'string' ? data.title : undefined,
              error: (data.error as string) || 'Slide rendering failed.',
            },
          ]);
        } else if (eventType === 'done') {
          setDownloadArtifactId(typeof data.artifact_id === 'string' && data.artifact_id ? data.artifact_id : null);
          setDownloadToken((data.download_token as string) || '');
          setDownloadFilename((data.filename as string) || 'presentation.pptx');
          setStep('done');
          setBuildProg(null);
          completed = true;
        } else if (eventType === 'error') {
          throw new Error((data.message as string) || 'Generation failed');
        }
      }
    }

    if (!completed) {
      throw new Error('Generation ended before the presentation was ready.');
    }
  }, [apiKey]);

  const handleDownload = useCallback(async () => {
    if (!downloadArtifactId || !downloadToken || isDownloading) return;

    setIsDownloading(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/download/${encodeURIComponent(downloadArtifactId)}`, {
        headers: { 'X-Download-Token': downloadToken },
      });

      if (!res.ok) {
        let detail = '';
        try {
          const contentType = res.headers.get('content-type') || '';
          if (contentType.includes('application/json')) {
            const body = await res.json() as { detail?: string };
            detail = body.detail || '';
          } else {
            detail = await res.text();
          }
        } catch {
          detail = '';
        }
        throw new Error(detail || `Download failed (${res.status})`);
      }

      const blob = await res.blob();
      const blobUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = downloadFilename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => window.URL.revokeObjectURL(blobUrl), 0);
      try { localStorage.removeItem('invescore_pending_download'); } catch { /* ignore */ }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Download failed');
    } finally {
      setIsDownloading(false);
    }
  }, [downloadArtifactId, downloadFilename, downloadToken, isDownloading]);

  const handleGenerate = useCallback(async (promptOverride?: string) => {
    if (isWorking) return;
    setError(null);
    setPlan(null);
    setBuildProg(null);
    setSlideWarnings([]);
    setDownloadArtifactId(null);
    setDownloadToken('');
    setDownloadFilename('presentation.pptx');
    setIsDownloading(false);
    const brief = promptOverride ?? prompt.trim();
    try {
      const newPlan = await doInterpret(promptOverride);
      if (newPlan) {
        await doBuildV2(newPlan);
        const entry: HistoryEntry = {
          id: Date.now().toString(),
          date: new Date().toISOString(),
          title: newPlan.presentation_title,
          brief,
          intakeData: intakeData ?? undefined,
        };
        setHistory(prev => {
          const next = [entry, ...prev].slice(0, 20);
          try { localStorage.setItem('invescore_history', JSON.stringify(next)); } catch { /* ignore */ }
          return next;
        });
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error');
      setStep('error');
    }
  }, [isWorking, doInterpret, doBuildV2, prompt, intakeData]);

  const handleGenerateFromIntake = useCallback(() => {
    if (!intakeData) return;
    handleGenerate(intakeData.full_brief);
  }, [intakeData, handleGenerate]);

  const handleBuildFromPlan = useCallback(async () => {
    if (!plan) return;
    setError(null);
    setSlideWarnings([]);
    try { await doBuildV2(plan); }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Unknown error'); setStep('error'); }
  }, [plan, doBuildV2]);

  const handleReset = useCallback(() => {
    generateAbortRef.current?.abort();
    intakeAbortRef.current?.abort();
    setStep('idle');
    setPlan(null);
    setError(null);
    setBuildProg(null);
    setSlideWarnings([]);
    setDownloadArtifactId(null);
    setDownloadToken('');
    setDownloadFilename('presentation.pptx');
    setIsDownloading(false);
    try { localStorage.removeItem('invescore_pending_download'); } catch { /* ignore */ }
    handleStartOver();
  }, [handleStartOver]);

  const handleRestoreHistory = useCallback((entry: HistoryEntry) => {
    if (isWorking) return;
    setStep('idle');
    setError(null);
    setPlan(null);
    setBuildProg(null);
    setSlideWarnings([]);
    setDownloadArtifactId(null);
    setDownloadToken('');
    setDownloadFilename('presentation.pptx');
    setIsDownloading(false);
    setIntakeMode('textarea');
    setPrompt(entry.brief);
  }, [isWorking]);

  const handleClearHistory = useCallback(() => {
    setHistory([]);
    try { localStorage.removeItem('invescore_history'); } catch { /* ignore */ }
  }, []);

  const handleExample = useCallback((ex: string) => {
    if (isWorking) return;
    if (intakeMode === 'textarea') {
      setPrompt(ex);
      textareaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      textareaRef.current?.focus();
    } else {
      startConversation(ex);
    }
  }, [isWorking, intakeMode, startConversation]);

  const progressItems = buildProgress(step, buildProg);
  const showProgress = step !== 'idle' && step !== 'error';

  // ═════════════════════════════════════════════════════════════════════════
  // RENDER
  // ═════════════════════════════════════════════════════════════════════════
  return (
    <div className="app-shell">
      <style>{`
        /* ── App shell ── */
        .app-shell {
          display: flex;
          min-height: 100vh;
          background: var(--bg-primary);
          color: var(--text-primary);
          position: relative;
          z-index: 2;
        }

        /* ── Cursor / transitions ── */
        *, *::before, *::after { cursor: default; }
        button, a, [role="button"], input, textarea,
        .example-item, .intake-start-btn, .textarea-link,
        .back-link, .send-btn, .btn-primary, .btn-ghost, .btn-download,
        .history-item, .summary-startover {
          transition: color ${'200ms'} ease, background ${'200ms'} ease,
                      border-color ${'200ms'} ease, box-shadow ${'200ms'} ease,
                      opacity ${'200ms'} ease, padding-left ${'200ms'} ease,
                      transform ${'200ms'} ease;
        }
        button, a, [role="button"], .example-item, .intake-start-btn,
        .textarea-link, .back-link, .send-btn, .btn-primary, .btn-ghost,
        .btn-download, .history-item, .summary-startover { cursor: pointer; }
        input, textarea { cursor: text; }

        /* ── Two-panel layout ── */
        .left-panel {
          width: 40%;
          flex-shrink: 0;
          position: sticky;
          top: 0;
          height: 100vh;
          background: var(--bg-primary);
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          overflow: hidden;
        }
        .right-panel {
          flex: 1;
          background: var(--bg-primary);
          border-left: 1px solid var(--border);
          min-height: 100vh;
          overflow-y: auto;
          scroll-behavior: smooth;
          position: relative;
        }
        .right-panel::before {
          /* Subtle dot grid — barely there */
          content: '';
          position: absolute;
          inset: 0;
          pointer-events: none;
          background-image: radial-gradient(circle, rgba(255,255,255,0.035) 1px, transparent 1px);
          background-size: 24px 24px;
        }
        .right-inner {
          position: relative;
          max-width: 580px;
          padding: 72px 48px 96px;
          margin: 0 auto;
        }

        /* ── Left panel decorations ── */
        .city-bg {
          position: absolute;
          inset: 0;
          background-image: url('/invescore/city-bg.jpg');
          background-size: cover;
          background-position: center;
          animation: ken-burns 20s ease-in-out infinite alternate;
          will-change: transform;
        }
        .city-overlay {
          position: absolute;
          inset: 0;
          background: linear-gradient(160deg,
            rgba(9,9,11,0.85) 0%,
            rgba(9,9,11,0.40) 40%,
            rgba(9,9,11,0.70) 100%);
          pointer-events: none;
        }
        .brand-block {
          position: relative;
          z-index: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          padding: 0 32px;
        }
        .brand-title {
          font-family: var(--font-brand);
          font-weight: 300;
          font-size: 48px;
          letter-spacing: 0.25em;
          color: var(--text-primary);
          text-transform: uppercase;
          margin: 32px 0 0;
          line-height: 1;
          text-align: center;
        }
        .brand-accent {
          width: 48px;
          height: 2px;
          background: var(--accent);
          margin: 22px 0 18px;
          box-shadow: 0 0 20px rgba(200, 16, 46, 0.3);
        }
        .brand-subtitle {
          font-family: var(--font-body);
          font-weight: 400;
          font-size: 14px;
          letter-spacing: 0.04em;
          color: var(--text-secondary);
          margin: 0;
          text-align: center;
        }
        .brand-stats {
          display: flex;
          align-items: center;
          gap: 22px;
          margin-top: 32px;
        }
        .stat {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
          min-width: 64px;
        }
        .stat-value {
          font-family: var(--font-brand);
          font-weight: 600;
          font-size: 20px;
          color: var(--text-primary);
          line-height: 1;
        }
        .stat-label {
          font-family: var(--font-body);
          font-weight: 400;
          font-size: 10px;
          letter-spacing: 0.08em;
          color: var(--text-tertiary);
          text-transform: uppercase;
        }
        .stat-divider {
          width: 1px;
          height: 32px;
          background: var(--border);
        }
        .left-footer {
          position: absolute;
          bottom: 24px;
          left: 0;
          right: 0;
          text-align: center;
          font-family: var(--font-body);
          font-weight: 400;
          font-size: 10px;
          color: var(--text-tertiary);
          z-index: 1;
        }

        /* ── Right panel: pill badge ── */
        .pill-badge {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 6px 14px;
          background: var(--bg-tertiary);
          border: 1px solid var(--border);
          border-radius: 100px;
          font-family: var(--font-body);
          font-weight: 400;
          font-size: 11px;
          color: var(--text-tertiary);
          margin: 0 auto 48px;
        }
        .pill-dot {
          width: 6px;
          height: 6px;
          background: var(--accent);
          border-radius: 100px;
          box-shadow: 0 0 8px rgba(200, 16, 46, 0.4);
        }
        .pill-row {
          display: flex;
          justify-content: center;
        }

        /* ── Labels ── */
        .field-label {
          display: block;
          font-family: var(--font-body);
          font-weight: 500;
          font-size: 10px;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--text-tertiary);
          margin-bottom: 10px;
        }

        /* ── Inputs ── */
        .input-field {
          width: 100%;
          background: var(--bg-secondary);
          border: 1px solid var(--border);
          padding: 16px 20px;
          font-family: var(--font-mono);
          font-size: 13px;
          color: var(--text-secondary);
          display: block;
          box-sizing: border-box;
          transition: border-color ${'200ms'} ease, box-shadow ${'200ms'} ease;
        }
        .input-field::placeholder { color: var(--text-tertiary); }
        .input-field:focus {
          border-color: var(--accent);
          box-shadow: 0 0 0 3px var(--accent-glow);
          outline: none;
        }
        .input-textarea {
          font-family: var(--font-body);
          font-size: 14px;
          color: var(--text-primary);
          line-height: 1.65;
          resize: vertical;
          min-height: 180px;
        }
        .api-key-wrap { position: relative; }
        .api-key-dot {
          position: absolute;
          right: 18px;
          top: 50%;
          transform: translateY(-50%);
          width: 6px;
          height: 6px;
          background: var(--green-ok);
          border-radius: 100px;
          opacity: 0;
          transition: opacity ${'200ms'} ease;
          pointer-events: none;
        }
        .api-key-dot.visible { opacity: 1; }
        .helper {
          margin-top: 10px;
          font-family: var(--font-body);
          font-weight: 400;
          font-size: 11px;
          color: var(--text-tertiary);
        }

        /* ── Chat container ── */
        .chat-container {
          background: var(--bg-secondary);
          border: 1px solid var(--border);
          min-height: 440px;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }

        /* ── Initial state ── */
        .intake-initial {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 24px;
          padding: 80px 32px;
        }
        .intake-tagline {
          font-family: var(--font-brand);
          font-weight: 300;
          font-size: 24px;
          color: var(--text-primary);
          text-align: center;
          margin: 0;
          opacity: 0;
          animation: enter-up 600ms ease 200ms forwards;
        }
        .intake-start-btn {
          background: transparent;
          border: 1px solid var(--text-secondary);
          color: var(--text-primary);
          padding: 14px 56px;
          font-family: var(--font-body);
          font-weight: 500;
          font-size: 11px;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          opacity: 0;
          animation: enter-up 600ms ease 300ms forwards;
        }
        .intake-start-btn:hover:not(:disabled) {
          background: var(--text-primary);
          color: var(--bg-primary);
          border-color: var(--text-primary);
        }
        .intake-start-btn:disabled {
          border-color: var(--bg-tertiary);
          color: var(--text-tertiary);
          cursor: not-allowed;
        }
        .textarea-link {
          background: none;
          border: none;
          color: var(--text-tertiary);
          font-family: var(--font-body);
          font-weight: 400;
          font-size: 12px;
          padding: 0;
          opacity: 0;
          animation: enter-up 600ms ease 400ms forwards;
        }
        .textarea-link:hover { color: var(--text-primary); }

        /* ── Chat messages ── */
        .chat-messages {
          flex: 1;
          overflow-y: auto;
          padding: 28px;
        }
        .msg-agent-wrap { display: flex; justify-content: flex-start; }
        .msg-user-wrap { display: flex; justify-content: flex-end; }
        .msg-agent {
          position: relative;
          max-width: 85%;
          margin-bottom: 24px;
          padding-left: 14px;
          font-family: var(--font-body);
          font-weight: 400;
          font-size: 14px;
          color: var(--text-secondary);
          line-height: 1.65;
          white-space: pre-wrap;
          word-break: break-word;
          animation: fade-in 150ms ease forwards;
        }
        .msg-agent::before {
          content: '';
          position: absolute;
          left: 0;
          top: 9px;
          width: 4px;
          height: 4px;
          background: var(--accent);
          border-radius: 100px;
        }
        .msg-user {
          max-width: 75%;
          margin-bottom: 24px;
          font-family: var(--font-body);
          font-weight: 400;
          font-size: 14px;
          color: var(--text-primary);
          line-height: 1.65;
          text-align: right;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .typing-indicator {
          position: relative;
          padding-left: 14px;
          font-family: var(--font-body);
          font-size: 14px;
          color: var(--text-tertiary);
          margin-bottom: 24px;
          letter-spacing: 0.06em;
        }
        .typing-indicator::before {
          content: '';
          position: absolute;
          left: 0;
          top: 9px;
          width: 4px;
          height: 4px;
          background: var(--accent);
          border-radius: 100px;
        }

        .chat-input-area {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 16px 20px;
          border-top: 1px solid var(--border);
          flex-shrink: 0;
        }
        .chat-input {
          flex: 1;
          background: transparent;
          border: none;
          color: var(--text-primary);
          font-family: var(--font-body);
          font-weight: 400;
          font-size: 14px;
          outline: none;
        }
        .chat-input::placeholder { color: var(--text-tertiary); }
        .chat-input:disabled { opacity: 0.4; }
        .send-btn {
          width: 38px;
          height: 38px;
          flex-shrink: 0;
          background: transparent;
          border: 1px solid var(--border);
          color: var(--text-secondary);
          font-size: 14px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .send-btn:not(:disabled):hover {
          background: var(--accent);
          color: var(--text-primary);
          border-color: var(--accent);
        }
        .send-btn:disabled {
          color: var(--text-tertiary);
          border-color: var(--border);
          cursor: not-allowed;
          opacity: 0.3;
        }

        /* ── Summary card ── */
        .summary-card {
          background: var(--bg-secondary);
          border: 1px solid var(--border);
          padding: 32px;
          animation: fade-in 200ms ease forwards;
        }
        .summary-header {
          font-family: var(--font-body);
          font-weight: 500;
          font-size: 10px;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: var(--accent);
          margin-bottom: 20px;
        }
        .summary-row {
          display: flex;
          gap: 12px;
          padding: 8px 0;
          align-items: baseline;
        }
        .summary-label {
          font-family: var(--font-body);
          font-weight: 500;
          font-size: 11px;
          color: var(--text-tertiary);
          width: 90px;
          flex-shrink: 0;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .summary-value {
          font-family: var(--font-body);
          font-weight: 400;
          font-size: 14px;
          color: var(--text-primary);
          line-height: 1.5;
        }
        .summary-actions {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-top: 28px;
        }
        .summary-startover {
          background: transparent;
          border: none;
          padding: 14px 24px;
          font-family: var(--font-body);
          font-weight: 400;
          font-size: 12px;
          color: var(--text-tertiary);
        }
        .summary-startover:hover { color: var(--text-primary); }
        .summary-startover:disabled { opacity: 0.4; cursor: not-allowed; }

        /* ── Primary CTA ── */
        .btn-primary {
          background: var(--accent);
          border: none;
          padding: 14px 44px;
          font-family: var(--font-body);
          font-weight: 500;
          font-size: 11px;
          letter-spacing: 0.10em;
          text-transform: uppercase;
          color: var(--text-primary);
        }
        .btn-primary:not(:disabled):hover {
          background: var(--accent-hover);
          box-shadow: 0 0 24px var(--accent-glow);
        }
        .btn-primary:disabled {
          background: var(--bg-tertiary);
          color: var(--text-tertiary);
          cursor: not-allowed;
        }
        .btn-primary--full {
          width: 100%;
          padding: 16px 0;
        }

        /* ── Back link ── */
        .back-link {
          background: none;
          border: none;
          color: var(--text-tertiary);
          font-family: var(--font-body);
          font-weight: 400;
          font-size: 12px;
          padding: 0;
          margin-bottom: 12px;
          display: block;
          text-align: left;
        }
        .back-link:hover { color: var(--text-primary); }

        /* ── Example prompts ── */
        .example-item {
          display: block;
          background: none;
          border: none;
          padding: 8px 0;
          text-align: left;
          width: 100%;
          color: var(--text-tertiary);
          font-family: var(--font-body);
          font-weight: 400;
          font-size: 13px;
          line-height: 1.5;
          border-left: 2px solid transparent;
          padding-left: 0;
        }
        .example-item:hover {
          color: var(--text-primary);
          border-left-color: var(--accent);
          padding-left: 16px;
        }

        /* ── History ── */
        .history-item {
          display: flex;
          align-items: baseline;
          gap: 10px;
          padding: 7px 0;
          border-left: 2px solid transparent;
          padding-left: 0;
        }
        .history-item:hover {
          border-left-color: var(--accent);
          padding-left: 14px;
        }
        .history-item:hover .history-title { color: var(--text-primary); }
        .history-title {
          flex: 1;
          font-family: var(--font-body);
          font-weight: 400;
          font-size: 13px;
          color: var(--text-secondary);
          line-height: 1.5;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .history-date {
          font-family: var(--font-body);
          font-weight: 400;
          font-size: 11px;
          color: var(--text-tertiary);
          flex-shrink: 0;
        }
        .history-clear {
          background: none;
          border: none;
          padding: 0;
          font-family: var(--font-body);
          font-weight: 400;
          font-size: 11px;
          color: var(--text-tertiary);
        }
        .history-clear:hover { color: var(--accent); }

        /* ── Error block ── */
        .error-block {
          margin-top: 24px;
          border: 1px solid rgba(200, 16, 46, 0.25);
          padding: 14px 18px;
          font-family: var(--font-body);
          font-size: 13px;
          color: var(--text-primary);
          line-height: 1.6;
          background: rgba(200, 16, 46, 0.05);
        }
        .error-tag {
          color: var(--accent);
          font-weight: 500;
        }

        /* ── Progress ── */
        .progress-section { animation: fade-in 200ms ease forwards; }
        .progress-row {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 12px;
        }
        .progress-dot {
          width: 6px;
          height: 6px;
          border-radius: 100px;
          flex-shrink: 0;
        }
        .progress-dot--done {
          background: var(--green-ok);
        }
        .progress-dot--active {
          background: var(--accent);
          animation: pulse-dot 1.5s ease-in-out infinite;
        }
        .progress-dot--pending {
          background: transparent;
          border: 1px solid var(--text-tertiary);
        }
        .progress-label {
          font-family: var(--font-body);
          font-weight: 400;
          font-size: 13px;
        }
        .progress-label--done    { color: var(--text-primary); }
        .progress-label--active  { color: var(--accent); }
        .progress-label--pending { color: var(--text-tertiary); }

        /* ── Plan preview ── */
        .plan-section { animation: fade-in 200ms ease forwards; }
        .plan-card {
          background: var(--bg-secondary);
          border: 1px solid var(--border);
          padding: 32px;
        }
        .plan-section-name {
          font-family: var(--font-body);
          font-weight: 600;
          font-size: 10px;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--accent);
          margin-bottom: 10px;
        }
        .plan-slide-row {
          display: flex;
          align-items: center;
          gap: 12px;
          padding-left: 16px;
          margin-bottom: 8px;
        }
        .plan-bullet {
          width: 3px;
          height: 3px;
          background: var(--bg-tertiary);
          flex-shrink: 0;
        }
        .plan-bullet--divider { background: var(--accent); }
        .plan-slide-title {
          font-family: var(--font-body);
          font-weight: 400;
          font-size: 13px;
          color: var(--text-secondary);
          line-height: 1.5;
        }
        .plan-slide-title--divider { font-style: italic; color: var(--text-tertiary); }

        /* ── Download section ── */
        .download-section { animation: fade-in 200ms ease forwards; }
        .btn-download {
          width: 100%;
          padding: 18px 0;
          background: transparent;
          border: 1.5px solid var(--text-primary);
          color: var(--text-primary);
          font-family: var(--font-body);
          font-weight: 500;
          font-size: 12px;
          letter-spacing: 0.10em;
          text-transform: uppercase;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
        }
        .btn-download:not(:disabled):hover {
          background: var(--text-primary);
          color: var(--bg-primary);
        }
        .btn-download:disabled { opacity: 0.6; cursor: wait; }

        .warning-block {
          margin-top: 16px;
          border: 1px solid rgba(225, 180, 80, 0.25);
          background: rgba(225, 180, 80, 0.05);
          padding: 16px 18px;
        }
        .warning-header {
          margin: 0 0 10px;
          font-family: var(--font-body);
          font-weight: 600;
          font-size: 11px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: #D4A943;
        }
        .warning-title {
          margin: 0;
          font-family: var(--font-body);
          font-weight: 500;
          font-size: 13px;
          color: var(--text-primary);
        }
        .warning-body {
          margin: 4px 0 0;
          font-family: var(--font-body);
          font-size: 12px;
          line-height: 1.5;
          color: var(--text-secondary);
        }
        .cost-line {
          margin-top: 12px;
          font-family: var(--font-body);
          font-weight: 400;
          font-size: 11px;
          color: var(--text-tertiary);
          text-align: center;
        }

        .btn-ghost {
          background: transparent;
          border: 1px solid var(--border);
          padding: 14px 0;
          font-family: var(--font-body);
          font-weight: 400;
          font-size: 12px;
          letter-spacing: 0.10em;
          text-transform: uppercase;
          color: var(--text-tertiary);
        }
        .btn-ghost:hover {
          color: var(--text-primary);
          border-color: var(--border-hover);
        }
        .btn-ghost--full { width: 100%; }

        /* ── Tablet ── */
        @media (min-width: 1024px) and (max-width: 1440px) {
          .left-panel { width: 35%; }
          .brand-title { font-size: 42px; }
          .right-inner { padding: 56px 40px 80px; }
        }

        /* ── Mobile ── */
        @media (max-width: 1023px) {
          .left-panel {
            width: 100%;
            height: 280px;
            position: relative;
            flex-shrink: 0;
          }
          .right-panel { border-left: none; border-top: 1px solid var(--border); }
          .right-inner { padding: 48px 24px 80px; }
          .brand-title { font-size: 32px; }
          .brand-stats { display: none; }
          .left-footer { display: none; }
          .chat-container { min-height: 360px; }
          .example-item:hover { padding-left: 0; border-left-color: transparent; }
          .field-label { font-size: 9px; }
        }
      `}</style>

      {/* ══════════════════════════════════════════════
          LEFT PANEL — brand wall
          ══════════════════════════════════════════════ */}
      <div className="left-panel">
        <div className="city-bg" />
        <div className="city-overlay" />

        <div className="brand-block">
          <Image
            src="/invescore/logo-new.png"
            alt="InvesCore Property"
            width={160}
            height={64}
            style={{
              objectFit: 'contain',
              maxWidth: 160,
              filter: 'brightness(0) invert(1)',
            }}
            priority
          />
          <h1 className="brand-title">Slide Studio</h1>
          <div className="brand-accent" />
          <p className="brand-subtitle">AI Presentation Generator</p>

          <div className="brand-stats">
            <div className="stat">
              <span className="stat-value">10×</span>
              <span className="stat-label">Faster</span>
            </div>
            <div className="stat-divider" />
            <div className="stat">
              <span className="stat-value">100%</span>
              <span className="stat-label">On-Brand</span>
            </div>
            <div className="stat-divider" />
            <div className="stat">
              <span className="stat-value">AI</span>
              <span className="stat-label">Powered</span>
            </div>
          </div>
        </div>

        <p className="left-footer">© 2026 InvesCore Property</p>
      </div>

      {/* ══════════════════════════════════════════════
          RIGHT PANEL — all interactive content
          ══════════════════════════════════════════════ */}
      <div className="right-panel">
        <div className="right-inner">

          {/* ── Pill badge ── */}
          <div className="pill-row">
            <span className="pill-badge">
              <span className="pill-dot" />
              Powered by Claude AI · Opus 4.6
            </span>
          </div>

          {/* ── API Key ── */}
          <div style={{ marginBottom: 48 }}>
            <label className="field-label">API Key</label>
            <div className="api-key-wrap">
              <input
                type="password"
                className="input-field"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder="sk-ant-..."
                disabled={isWorking}
                autoComplete="off"
                spellCheck={false}
              />
              <span className={`api-key-dot${apiKey.trim().length > 20 ? ' visible' : ''}`} aria-hidden="true" />
            </div>
            <p className="helper">Stored locally. Never leaves your browser.</p>
          </div>

          {/* ── Describe Your Presentation ── */}
          <div style={{ marginBottom: 48 }}>
            <label className="field-label">Describe Your Presentation</label>

            {/* State 1 — Initial */}
            {intakeMode === 'initial' && (
              <div className="chat-container">
                <div className="intake-initial">
                  <p className="intake-tagline">What would you like to create?</p>
                  <button
                    className="intake-start-btn"
                    onClick={() => startConversation()}
                    disabled={!hasApiKey || isWorking}
                    title={!hasApiKey ? 'Enter your API key above to begin' : undefined}
                  >
                    Begin
                  </button>
                  <button
                    className="textarea-link"
                    onClick={() => setIntakeMode('textarea')}
                  >
                    or write a detailed brief
                  </button>
                </div>
              </div>
            )}

            {/* State 2 — Chat active */}
            {intakeMode === 'chat' && (
              <div className="chat-container">
                <div className="chat-messages">
                  {chatMessages.filter(m => !m.hidden).map((msg, i) => (
                    <div key={i} className={msg.role === 'assistant' ? 'msg-agent-wrap' : 'msg-user-wrap'}>
                      <div className={msg.role === 'assistant' ? 'msg-agent' : 'msg-user'}>
                        {msg.displayContent ?? msg.content}
                      </div>
                    </div>
                  ))}
                  {isTyping && (
                    <div className="msg-agent-wrap">
                      <div className="typing-indicator">...</div>
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>
                <div className="chat-input-area">
                  <input
                    ref={chatInputRef}
                    className="chat-input"
                    value={chatInput}
                    onChange={e => setChatInput(e.target.value)}
                    onKeyDown={handleChatKeyDown}
                    placeholder="Type here..."
                    disabled={isTyping || isWorking}
                    autoComplete="off"
                  />
                  <button
                    className="send-btn"
                    onClick={sendChatMessage}
                    disabled={!chatInput.trim() || isTyping || isWorking}
                    aria-label="Send"
                  >
                    ↑
                  </button>
                </div>
              </div>
            )}

            {/* State 3 — Summary card */}
            {intakeMode === 'complete' && intakeData && (
              <div className="summary-card">
                <div className="summary-header">Brief</div>
                {[
                  ['Topic', intakeData.topic],
                  ['Audience', intakeData.audience],
                  ['Language', intakeData.language],
                  ['Slides', intakeData.slide_count],
                  ['Sections', Array.isArray(intakeData.sections)
                    ? intakeData.sections.join(', ')
                    : intakeData.sections],
                  ['Tone', intakeData.tone],
                  ...(intakeData.special_requests
                    ? [['Special', intakeData.special_requests] as [string, string]]
                    : []),
                ].map(([label, value]) => value ? (
                  <div key={label} className="summary-row">
                    <span className="summary-label">{label}</span>
                    <span className="summary-value">{String(value)}</span>
                  </div>
                ) : null)}
                <div className="summary-actions">
                  <button
                    className="btn-primary"
                    onClick={handleGenerateFromIntake}
                    disabled={!canGenerateFromIntake}
                  >
                    {isWorking ? 'Generating...' : 'Generate'}
                  </button>
                  <button
                    className="summary-startover"
                    onClick={handleStartOver}
                    disabled={isWorking}
                  >
                    Start over
                  </button>
                </div>
              </div>
            )}

            {/* State 4 — Textarea */}
            {intakeMode === 'textarea' && (
              <>
                <button className="back-link" onClick={() => setIntakeMode('initial')}>
                  ← Back to guided mode
                </button>
                <textarea
                  ref={textareaRef}
                  className="input-field input-textarea"
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  placeholder="Describe the presentation you need..."
                  disabled={isWorking}
                  rows={5}
                />
              </>
            )}
          </div>

          {/* ── Example prompts ── */}
          <div style={{ marginBottom: 48 }}>
            {EXAMPLES.map((ex, i) => (
              <button
                key={i}
                className="example-item"
                onClick={() => handleExample(ex)}
                disabled={isWorking}
              >
                {ex}
              </button>
            ))}
          </div>

          {/* ── History ── */}
          {history.length > 0 && (
            <div style={{ marginBottom: 48 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <span className="field-label" style={{ margin: 0 }}>Recent</span>
                <button className="history-clear" onClick={handleClearHistory}>Clear</button>
              </div>
              {history.map(entry => (
                <div
                  key={entry.id}
                  className="history-item"
                  onClick={() => handleRestoreHistory(entry)}
                  role="button"
                  tabIndex={0}
                >
                  <span className="history-title">{entry.title}</span>
                  <span className="history-date">
                    {new Date(entry.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* ── Generate button — textarea mode only ── */}
          {intakeMode === 'textarea' && (step === 'idle' || step === 'error') && (
            <>
              <div style={{ borderTop: '1px solid var(--border)', marginBottom: 32 }} />
              <button
                className="btn-primary btn-primary--full"
                onClick={() => handleGenerate()}
                disabled={!canGenerateFromTextarea}
              >
                Generate Presentation
              </button>
            </>
          )}

          {/* ── Error ── */}
          {error && (
            <div className="error-block">
              <span className="error-tag">Error: </span>{error}
            </div>
          )}

          {/* ── Progress ── */}
          {showProgress && (
            <div className="progress-section" style={{ marginTop: 40 }}>
              {progressItems.map((item, i) => (
                <div key={i} className="progress-row">
                  <span className={`progress-dot progress-dot--${item.state}`} />
                  <span className={`progress-label progress-label--${item.state}`}>
                    {item.label}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* ── Slide Plan Preview ── */}
          {(step === 'plan_ready' || step === 'building' || step === 'done') && plan && (
            <div className="plan-section" style={{ marginTop: 40 }}>
              <div className="plan-card">
                {plan.sections.map((section, gi) => (
                  <div key={gi} style={{ marginBottom: gi < plan.sections.length - 1 ? 24 : 0 }}>
                    <div className="plan-section-name">{section.name}</div>
                    {section.slides.map((s, si) => (
                      <div
                        key={si}
                        className="plan-slide-row"
                        style={{ marginBottom: si < section.slides.length - 1 ? 8 : 0 }}
                      >
                        <span className={`plan-bullet${s.slide_type === 'section_divider' ? ' plan-bullet--divider' : ''}`} />
                        <span className={`plan-slide-title${s.slide_type === 'section_divider' ? ' plan-slide-title--divider' : ''}`}>
                          {s.title}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>

              {step === 'plan_ready' && (
                <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
                  <button
                    className="btn-primary"
                    onClick={handleBuildFromPlan}
                    style={{ flex: 1, padding: '16px 0' }}
                  >
                    Build Presentation
                  </button>
                  <button
                    className="btn-ghost"
                    onClick={handleReset}
                    style={{ flex: 1 }}
                  >
                    Regenerate
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── Download ── */}
          {step === 'done' && downloadArtifactId && downloadToken && (
            <div className="download-section" style={{ marginTop: 48 }}>
              <button
                className="btn-download"
                onClick={handleDownload}
                disabled={isDownloading}
              >
                <span aria-hidden="true">↓</span>
                {isDownloading ? 'Preparing Download...' : 'Download .pptx'}
              </button>

              {slideWarnings.length > 0 && (
                <div className="warning-block">
                  <p className="warning-header">
                    {slideWarnings.length} slide{slideWarnings.length === 1 ? '' : 's'} used fallback content
                  </p>
                  <div style={{ display: 'grid', gap: 10 }}>
                    {slideWarnings.map((warning, idx) => (
                      <div key={`${warning.title ?? 'warning'}-${idx}`}>
                        <p className="warning-title">
                          {warning.title || `Content slide ${typeof warning.slideIndex === 'number' ? warning.slideIndex + 1 : idx + 1}`}
                        </p>
                        <p className="warning-body">{warning.error}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {tokenUsage && (
                <p className="cost-line">
                  ~${tokenUsage.estimated_cost_usd.toFixed(4)} · {(tokenUsage.input_tokens + tokenUsage.output_tokens).toLocaleString()} tokens
                </p>
              )}

              <button
                className="btn-ghost btn-ghost--full"
                onClick={handleReset}
                style={{ marginTop: 16 }}
              >
                New Presentation
              </button>
            </div>
          )}

        </div>{/* end right-inner */}
      </div>{/* end right-panel */}
    </div>
  );
}
