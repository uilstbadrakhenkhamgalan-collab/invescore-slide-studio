'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import Image from 'next/image';
import type {
  V2SlidePlan, Step, TokenUsage, BuildProgress,
  ChatMessage, IntakeData, IntakeMode,
  InterpretResponse,
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
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [downloadFilename, setDownloadFilename] = useState('presentation.pptx');
  const [error, setError] = useState<string | null>(null);
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

  const hasApiKey = apiKey.trim().length > 10;
  const isWorking = step === 'interpreting' || step === 'building';
  const canGenerateFromTextarea = hasApiKey && prompt.trim().length > 5 && !isWorking;
  const canGenerateFromIntake = hasApiKey && intakeMode === 'complete' && !!intakeData && !isWorking;

  // ── Auto-scroll chat ────────────────────────────────────────────────────────
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, isTyping]);

  // ── Intake API call ─────────────────────────────────────────────────────────
  const callIntakeAPI = useCallback(async (messages: ChatMessage[]): Promise<string> => {
    const apiMessages = messages.map(({ role, content }) => ({ role, content }));
    const res = await fetch(`${BACKEND_URL}/api/intake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey.trim(), messages: apiMessages }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { detail?: string }).detail || `Intake failed (${res.status})`);
    }
    return ((await res.json()) as { content: string }).content;
  }, [apiKey]);

  // ── Process intake response — detect completion signal ──────────────────────
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
          // JSON parse failed — treat as normal message
        }
      }
    }

    setChatMessages([...prevMessages, { role: 'assistant', content, displayContent }]);

    if (completed && parsed) {
      setIntakeData(parsed);
      setIntakeMode('complete');
    }
  }, []);

  // ── Start conversation ──────────────────────────────────────────────────────
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

  // ── Send chat message ───────────────────────────────────────────────────────
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

  // ── Reset intake ────────────────────────────────────────────────────────────
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
    const res = await fetch(`${BACKEND_URL}/api/interpret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey.trim(), prompt: actualPrompt }),
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

    const res = await fetch(`${BACKEND_URL}/api/generate_v2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey.trim(), slide_plan: slidePlan }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { detail?: string }).detail || `Generation failed (${res.status})`);
    }

    // Parse SSE stream
    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response stream');
    const decoder = new TextDecoder();
    let buffer = '';

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
          try { data = JSON.parse(dataMatch[1].trim()); } catch { /* ignore */ }
        }

        if (eventType === 'building_slide') {
          setBuildProg({
            current: data.current as number,
            total:   data.total   as number,
            title:   data.title   as string,
          });
        } else if (eventType === 'done') {
          const filename = data.filename as string;
          setDownloadFilename(filename);
          setDownloadUrl(`${BACKEND_URL}/api/download/${encodeURIComponent(filename)}`);
          setStep('done');
          setBuildProg(null);
        } else if (eventType === 'error') {
          throw new Error((data.message as string) || 'Generation failed');
        }
      }
    }
  }, [apiKey]);

  const handleGenerate = useCallback(async (promptOverride?: string) => {
    if (isWorking) return;
    setError(null); setDownloadUrl(null); setPlan(null); setBuildProg(null);
    try {
      const newPlan = await doInterpret(promptOverride);
      if (newPlan) await doBuildV2(newPlan);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error');
      setStep('error');
    }
  }, [isWorking, doInterpret, doBuildV2]);

  const handleGenerateFromIntake = useCallback(() => {
    if (!intakeData) return;
    handleGenerate(intakeData.full_brief);
  }, [intakeData, handleGenerate]);

  const handleBuildFromPlan = useCallback(async () => {
    if (!plan) return;
    setError(null);
    try { await doBuildV2(plan); }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Unknown error'); setStep('error'); }
  }, [plan, doBuildV2]);

  const handleReset = useCallback(() => {
    setStep('idle'); setPlan(null); setDownloadUrl(null); setError(null); setBuildProg(null);
    handleStartOver();
  }, [handleStartOver]);

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

  return (
    <div style={{
      background: '#FAFAFA',
      minHeight: '100vh',
      fontFamily: "'Montserrat', sans-serif",
      padding: '60px 24px 0',
    }}>
      <style>{`
        /* Input focus */
        .input-field:focus {
          border-color: #1A1A1A !important;
          box-shadow: none !important;
          outline: none;
        }
        /* Buttons */
        .btn-primary { transition: background 200ms ease; }
        .btn-primary:not(:disabled):hover { background: #B00D27 !important; }
        .btn-ghost { transition: color 150ms ease; }
        .btn-ghost:hover { color: #1A1A1A !important; }
        .btn-download { transition: background 200ms ease, color 200ms ease; }
        .btn-download:hover { background: #1A1A1A !important; color: #FFFFFF !important; }
        /* Example prompts */
        .example-item { transition: color 150ms ease; }
        .example-item:hover { color: #1A1A1A !important; }
        /* Fade-in */
        @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
        .progress-section { animation: fade-in 200ms ease forwards; }
        .plan-section { animation: fade-in 200ms ease forwards; }
        .download-section { animation: fade-in 200ms ease forwards; }
        /* Chat container */
        .chat-container {
          background: #FFFFFF;
          border: 1px solid #EBEBEB;
          max-height: 480px;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .chat-messages {
          flex: 1;
          overflow-y: auto;
          padding: 28px 24px 16px;
          scrollbar-width: thin;
          scrollbar-color: #E0E0E0 transparent;
        }
        .chat-messages::-webkit-scrollbar { width: 3px; }
        .chat-messages::-webkit-scrollbar-track { background: transparent; }
        .chat-messages::-webkit-scrollbar-thumb { background: #E0E0E0; }
        .msg-agent-wrap { display: flex; justify-content: flex-start; }
        .msg-user-wrap { display: flex; justify-content: flex-end; }
        .msg-agent {
          max-width: 80%;
          margin-bottom: 20px;
          font-size: 14px;
          font-weight: 400;
          color: #1A1A1A;
          line-height: 1.7;
          white-space: pre-wrap;
          word-break: break-word;
          animation: fade-in 150ms ease forwards;
        }
        .msg-user {
          max-width: 70%;
          margin-bottom: 20px;
          font-size: 14px;
          font-weight: 400;
          color: #8C8C8C;
          line-height: 1.7;
          text-align: right;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .typing-indicator {
          font-size: 14px;
          color: #B5B5B5;
          margin-bottom: 20px;
          letter-spacing: 0.06em;
        }
        .chat-input-area {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 16px;
          border-top: 1px solid #EBEBEB;
          flex-shrink: 0;
        }
        .chat-input {
          flex: 1;
          background: transparent;
          border: none;
          color: #1A1A1A;
          font-family: 'Montserrat', sans-serif;
          font-size: 14px;
          font-weight: 400;
          outline: none;
        }
        .chat-input::placeholder { color: #CCCCCC; }
        .chat-input:disabled { opacity: 0.4; }
        .send-btn {
          width: 36px;
          height: 36px;
          flex-shrink: 0;
          background: transparent;
          border: 1px solid #E0E0E0;
          color: #1A1A1A;
          cursor: pointer;
          font-size: 14px;
          transition: background 150ms ease, color 150ms ease, border-color 150ms ease;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .send-btn:not(:disabled):hover {
          background: #1A1A1A;
          color: #FFFFFF;
          border-color: #1A1A1A;
        }
        .send-btn:disabled { color: #CCCCCC; border-color: #EBEBEB; cursor: not-allowed; }
        /* Intake initial */
        .intake-initial {
          background: #FFFFFF;
          border: 1px solid #EBEBEB;
          min-height: 360px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 24px;
        }
        .intake-start-btn {
          border: 1px solid #1A1A1A;
          color: #1A1A1A;
          background: transparent;
          padding: 12px 48px;
          font-family: 'Montserrat', sans-serif;
          font-size: 11px;
          font-weight: 500;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          cursor: pointer;
          transition: background 200ms ease, color 200ms ease;
        }
        .intake-start-btn:hover:not(:disabled) { background: #1A1A1A; color: #FFFFFF; }
        .intake-start-btn:disabled {
          border-color: #CCCCCC;
          color: #CCCCCC;
          cursor: not-allowed;
        }
        .textarea-link {
          background: none;
          border: none;
          color: #B5B5B5;
          font-family: 'Montserrat', sans-serif;
          font-size: 12px;
          font-weight: 400;
          cursor: pointer;
          padding: 0;
          transition: color 150ms ease;
        }
        .textarea-link:hover { color: #1A1A1A; }
        .back-link {
          background: none;
          border: none;
          color: #B5B5B5;
          font-family: 'Montserrat', sans-serif;
          font-size: 12px;
          font-weight: 400;
          cursor: pointer;
          padding: 0;
          margin-bottom: 10px;
          display: block;
          text-align: left;
          transition: color 150ms ease;
        }
        .back-link:hover { color: #1A1A1A; }
        /* Summary card */
        .summary-card {
          background: #FFFFFF;
          border: 1px solid #EBEBEB;
          padding: 28px;
          animation: fade-in 200ms ease forwards;
        }
        .summary-header {
          font-size: 10px;
          font-weight: 500;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: #B5B5B5;
          margin-bottom: 20px;
        }
        .summary-row {
          display: flex;
          gap: 12px;
          padding: 8px 0;
          align-items: baseline;
        }
        .summary-label {
          font-size: 12px;
          font-weight: 500;
          color: #B5B5B5;
          width: 100px;
          flex-shrink: 0;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .summary-value {
          font-size: 14px;
          font-weight: 400;
          color: #1A1A1A;
          line-height: 1.5;
        }
        .summary-actions {
          display: flex;
          align-items: center;
          margin-top: 24px;
        }
        /* Mobile */
        @media (max-width: 768px) {
          .page-card {
            margin: 0 !important;
            padding: 48px 28px !important;
            box-shadow: none !important;
            min-height: 100vh;
          }
          .logo-img { max-width: 120px !important; }
          .page-title { font-size: 28px !important; }
          .chat-container { min-height: 320px !important; max-height: 420px !important; }
        }
      `}</style>

      {/* ── Content card ── */}
      <div
        className="page-card"
        style={{
          maxWidth: 560,
          margin: '0 auto',
          background: '#FFFFFF',
          padding: '72px 56px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
        }}
      >

        {/* ── Logo ── */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 40 }}>
          <Image
            src="/invescore/logo-new.png"
            alt="InvesCore Property"
            width={160}
            height={64}
            className="logo-img"
            style={{ objectFit: 'contain', maxWidth: 160, filter: 'brightness(0)' }}
            priority
          />
        </div>

        {/* ── Title ── */}
        <h1
          className="page-title"
          style={{
            textAlign: 'center',
            fontSize: 36,
            fontWeight: 300,
            letterSpacing: '0.20em',
            color: '#1A1A1A',
            textTransform: 'uppercase',
            lineHeight: 1,
          }}
        >
          Slide Studio
        </h1>

        {/* ── Red accent line ── */}
        <div style={{ display: 'flex', justifyContent: 'center', margin: '12px 0' }}>
          <div style={{ width: 40, height: 1.5, background: '#C8102E' }} />
        </div>

        {/* ── Subtitle ── */}
        <p style={{
          textAlign: 'center',
          fontSize: 12,
          fontWeight: 400,
          letterSpacing: '0.06em',
          color: '#B5B5B5',
          marginBottom: 56,
        }}>
          Presentation Generator
        </p>

        {/* ── API Key ── */}
        <div style={{ marginBottom: 48 }}>
          <label style={{
            display: 'block',
            fontSize: 10,
            fontWeight: 500,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: '#B5B5B5',
            marginBottom: 10,
          }}>
            API Key
          </label>
          <input
            type="password"
            className="input-field"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder="sk-ant-..."
            disabled={isWorking}
            autoComplete="off"
            spellCheck={false}
            style={{
              width: '100%',
              background: '#FFFFFF',
              border: '1px solid #E0E0E0',
              borderRadius: 0,
              padding: '14px 18px',
              fontFamily: "'SF Mono', 'JetBrains Mono', monospace",
              fontSize: 13,
              color: '#1A1A1A',
              display: 'block',
              boxSizing: 'border-box',
            }}
          />
          <p style={{
            marginTop: 8,
            fontSize: 11,
            fontWeight: 400,
            color: '#B5B5B5',
          }}>
            Stored locally. Never sent to our servers.
          </p>
        </div>

        {/* ── Describe Your Presentation ── */}
        <div style={{ marginBottom: 24 }}>
          <label style={{
            display: 'block',
            fontSize: 10,
            fontWeight: 500,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: '#B5B5B5',
            marginBottom: 10,
          }}>
            Describe Your Presentation
          </label>

          {/* ── State 1: Initial ── */}
          {intakeMode === 'initial' && (
            <div className="intake-initial">
              <p style={{
                fontSize: 20,
                fontWeight: 300,
                color: '#1A1A1A',
                textAlign: 'center',
                margin: 0,
              }}>
                What would you like to create?
              </p>
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
          )}

          {/* ── State 2: Chat active ── */}
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

          {/* ── State 3: Intake complete — summary card ── */}
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
                  style={{
                    padding: '14px 40px',
                    background: canGenerateFromIntake ? '#C8102E' : '#EBEBEB',
                    border: 'none',
                    borderRadius: 0,
                    fontSize: 12,
                    fontWeight: 500,
                    letterSpacing: '0.10em',
                    textTransform: 'uppercase',
                    color: canGenerateFromIntake ? '#FFFFFF' : '#B5B5B5',
                    cursor: canGenerateFromIntake ? 'pointer' : 'not-allowed',
                    fontFamily: "'Montserrat', sans-serif",
                  }}
                >
                  {isWorking ? 'Generating...' : 'Generate'}
                </button>
                <button
                  onClick={handleStartOver}
                  disabled={isWorking}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    padding: '14px 24px',
                    fontSize: 12,
                    fontWeight: 400,
                    color: '#B5B5B5',
                    cursor: isWorking ? 'not-allowed' : 'pointer',
                    fontFamily: "'Montserrat', sans-serif",
                    transition: 'color 150ms ease',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.color = '#1A1A1A')}
                  onMouseLeave={e => (e.currentTarget.style.color = '#B5B5B5')}
                >
                  Start over
                </button>
              </div>
            </div>
          )}

          {/* ── State 4: Textarea (power user mode) ── */}
          {intakeMode === 'textarea' && (
            <>
              <button className="back-link" onClick={() => setIntakeMode('initial')}>
                Back to guided mode
              </button>
              <textarea
                ref={textareaRef}
                className="input-field"
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                placeholder="Describe the presentation you need..."
                disabled={isWorking}
                rows={5}
                style={{
                  width: '100%',
                  minHeight: 160,
                  background: '#FFFFFF',
                  border: '1px solid #E0E0E0',
                  borderRadius: 0,
                  padding: '14px 18px',
                  fontFamily: "'Montserrat', sans-serif",
                  fontSize: 14,
                  color: '#1A1A1A',
                  lineHeight: 1.7,
                  resize: 'vertical',
                  display: 'block',
                  boxSizing: 'border-box',
                }}
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
              style={{
                display: 'block',
                background: 'none',
                border: 'none',
                cursor: isWorking ? 'default' : 'pointer',
                padding: '6px 0',
                textAlign: 'left',
                width: '100%',
                color: '#B5B5B5',
                fontSize: 13,
                fontWeight: 400,
                lineHeight: 1.5,
                fontFamily: "'Montserrat', sans-serif",
              }}
            >
              {ex}
            </button>
          ))}
        </div>

        {/* ── Generate button — textarea mode only ── */}
        {intakeMode === 'textarea' && (step === 'idle' || step === 'error') && (
          <>
            <div style={{ borderTop: '1px solid #EBEBEB', marginBottom: 40 }} />
            <button
              className="btn-primary"
              onClick={() => handleGenerate()}
              disabled={!canGenerateFromTextarea}
              style={{
                width: '100%',
                padding: '16px 0',
                background: canGenerateFromTextarea ? '#C8102E' : '#EBEBEB',
                border: 'none',
                borderRadius: 0,
                fontSize: 12,
                fontWeight: 500,
                letterSpacing: '0.10em',
                textTransform: 'uppercase',
                color: canGenerateFromTextarea ? '#FFFFFF' : '#B5B5B5',
                cursor: canGenerateFromTextarea ? 'pointer' : 'not-allowed',
                fontFamily: "'Montserrat', sans-serif",
              }}
            >
              Generate Presentation
            </button>
          </>
        )}

        {/* ── Error ── */}
        {error && (
          <div style={{
            marginTop: 24,
            border: '1px solid rgba(200,16,46,0.2)',
            padding: '14px 18px',
            fontSize: 13,
            color: '#1A1A1A',
            lineHeight: 1.6,
            background: 'rgba(200,16,46,0.03)',
          }}>
            <span style={{ color: '#C8102E', fontWeight: 500 }}>Error: </span>{error}
          </div>
        )}

        {/* ── Progress ── */}
        {showProgress && (
          <div className="progress-section" style={{ marginTop: 40 }}>
            {progressItems.map((item, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  marginBottom: i < progressItems.length - 1 ? 10 : 0,
                }}
              >
                <span style={{
                  fontSize: 12,
                  width: 16,
                  flexShrink: 0,
                  color: item.state === 'done' ? '#1A1A1A' : item.state === 'active' ? '#C8102E' : '#CCCCCC',
                  display: 'inline-block',
                }}>
                  {item.state === 'done' ? '✓' : item.state === 'active' ? '·' : '○'}
                </span>
                <span style={{
                  fontSize: 13,
                  fontWeight: 400,
                  color: item.state === 'done' ? '#1A1A1A' : item.state === 'active' ? '#C8102E' : '#CCCCCC',
                }}>
                  {item.label}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* ── Slide Plan Preview ── */}
        {(step === 'plan_ready' || step === 'building' || step === 'done') && plan && (
          <div className="plan-section" style={{ marginTop: 40 }}>
            <div style={{
              background: '#FFFFFF',
              border: '1px solid #EBEBEB',
              padding: 32,
            }}>
              {plan.sections.map((section, gi) => (
                <div key={gi} style={{ marginBottom: gi < plan.sections.length - 1 ? 24 : 0 }}>
                  <div style={{
                    fontSize: 10,
                    fontWeight: 500,
                    letterSpacing: '0.12em',
                    textTransform: 'uppercase',
                    color: '#C8102E',
                    marginBottom: 10,
                  }}>
                    {section.name}
                  </div>
                  {section.slides.map((s, si) => (
                    <div
                      key={si}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        paddingLeft: 16,
                        marginBottom: si < section.slides.length - 1 ? 8 : 0,
                      }}
                    >
                      <span style={{
                        width: 3,
                        height: 3,
                        background: s.slide_type === 'section_divider' ? '#C8102E' : '#CCCCCC',
                        flexShrink: 0,
                        display: 'inline-block',
                      }} />
                      <span style={{
                        fontSize: 13,
                        fontWeight: 400,
                        color: s.slide_type === 'section_divider' ? '#8C8C8C' : '#8C8C8C',
                        lineHeight: 1.5,
                        fontStyle: s.slide_type === 'section_divider' ? 'italic' : 'normal',
                      }}>
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
                  style={{
                    flex: 1,
                    padding: '16px 0',
                    background: '#C8102E',
                    border: 'none',
                    borderRadius: 0,
                    fontSize: 12,
                    fontWeight: 500,
                    letterSpacing: '0.10em',
                    textTransform: 'uppercase',
                    color: '#FFFFFF',
                    cursor: 'pointer',
                    fontFamily: "'Montserrat', sans-serif",
                  }}
                >
                  Build Presentation
                </button>
                <button
                  className="btn-ghost"
                  onClick={handleReset}
                  style={{
                    flex: 1,
                    padding: '16px 0',
                    background: 'transparent',
                    border: '1px solid #EBEBEB',
                    borderRadius: 0,
                    fontSize: 12,
                    fontWeight: 400,
                    letterSpacing: '0.10em',
                    textTransform: 'uppercase',
                    color: '#B5B5B5',
                    cursor: 'pointer',
                    fontFamily: "'Montserrat', sans-serif",
                  }}
                >
                  Regenerate
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── Download ── */}
        {step === 'done' && downloadUrl && (
          <div className="download-section" style={{ marginTop: 48 }}>
            <a href={downloadUrl} download={downloadFilename} target="_blank" rel="noreferrer" style={{ textDecoration: 'none', display: 'block' }}>
              <button
                className="btn-download"
                style={{
                  width: '100%',
                  padding: '16px 0',
                  background: '#FFFFFF',
                  border: '1.5px solid #1A1A1A',
                  borderRadius: 0,
                  fontSize: 12,
                  fontWeight: 500,
                  letterSpacing: '0.10em',
                  textTransform: 'uppercase',
                  color: '#1A1A1A',
                  cursor: 'pointer',
                  fontFamily: "'Montserrat', sans-serif",
                }}
              >
                Download
              </button>
            </a>
            {tokenUsage && (
              <p style={{
                marginTop: 10,
                fontSize: 11,
                fontWeight: 400,
                color: '#B5B5B5',
                textAlign: 'center',
              }}>
                ~${tokenUsage.estimated_cost_usd.toFixed(4)} &nbsp;·&nbsp; {(tokenUsage.input_tokens + tokenUsage.output_tokens).toLocaleString()} tokens
              </p>
            )}
            <button
              className="btn-ghost"
              onClick={handleReset}
              style={{
                marginTop: 12,
                width: '100%',
                padding: '14px 0',
                background: 'transparent',
                border: '1px solid #EBEBEB',
                borderRadius: 0,
                fontSize: 12,
                fontWeight: 400,
                letterSpacing: '0.10em',
                textTransform: 'uppercase',
                color: '#B5B5B5',
                cursor: 'pointer',
                fontFamily: "'Montserrat', sans-serif",
              }}
            >
              New Presentation
            </button>
          </div>
        )}

        {/* ── Footer ── */}
        <div style={{ marginTop: 64, paddingBottom: 32 }}>
          <div style={{ borderTop: '1px solid #EBEBEB', marginBottom: 20 }} />
          <p style={{
            textAlign: 'center',
            fontSize: 9,
            fontWeight: 500,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: '#CCCCCC',
          }}>
            InvesCore Property
          </p>
        </div>

      </div>
    </div>
  );
}
