'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import Image from 'next/image';
import type {
  SlideSpec, SlidePlan, Step, TokenUsage,
  ChatMessage, IntakeData, IntakeMode,
} from '@/lib/types';
import { BACKEND_URL, TEMPLATE_CATEGORIES } from '@/lib/constants';

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

function buildProgress(step: Step, slideCount?: number): ProgressItem[] {
  const items: ProgressItem[] = [
    { label: 'Interpreting request', state: 'pending' },
    { label: slideCount ? `Planning ${slideCount} slides` : 'Planning slides', state: 'pending' },
    { label: 'Building presentation', state: 'pending' },
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
  const [plan, setPlan] = useState<SlidePlan | null>(null);
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

  // ── Start conversation (with optional first user message) ───────────────────
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
  const doInterpret = useCallback(async (promptOverride?: string): Promise<SlidePlan | null> => {
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
    const data = await res.json() as { presentation_title: string; slides: SlideSpec[]; token_usage: TokenUsage };
    const newPlan: SlidePlan = { presentation_title: data.presentation_title, slides: data.slides };
    setTokenUsage(data.token_usage);
    setPlan(newPlan);
    return newPlan;
  }, [apiKey, prompt]);

  const doBuild = useCallback(async (slides: SlideSpec[]) => {
    setStep('building');
    const res = await fetch(`${BACKEND_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey.trim(), slide_plan: slides }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { detail?: string }).detail || `Generation failed (${res.status})`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const cd = res.headers.get('content-disposition') || '';
    const match = cd.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
    setDownloadUrl(url);
    setDownloadFilename(match ? match[1].replace(/['"]/g, '') : 'InvesCore_Presentation.pptx');
    setStep('done');
  }, [apiKey]);

  const handleGenerate = useCallback(async (promptOverride?: string) => {
    if (isWorking) return;
    setError(null); setDownloadUrl(null); setPlan(null);
    try {
      const newPlan = await doInterpret(promptOverride);
      if (newPlan) await doBuild(newPlan.slides);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error');
      setStep('error');
    }
  }, [isWorking, doInterpret, doBuild]);

  const handleGenerateFromIntake = useCallback(() => {
    if (!intakeData) return;
    handleGenerate(intakeData.full_brief);
  }, [intakeData, handleGenerate]);

  const handleBuildFromPlan = useCallback(async () => {
    if (!plan) return;
    setError(null);
    try { await doBuild(plan.slides); }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Unknown error'); setStep('error'); }
  }, [plan, doBuild]);

  const handleReset = useCallback(() => {
    setStep('idle'); setPlan(null); setDownloadUrl(null); setError(null);
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

  const progressItems = buildProgress(step, plan?.slides.length);
  const showProgress = step !== 'idle' && step !== 'error';

  return (
    <div
      className="page-col"
      style={{
        background: '#080B16',
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '80px 60px 0',
        fontFamily: "'Montserrat', sans-serif",
      }}
    >
      <style>{`
        @media (max-width: 768px) {
          .page-col { padding: 40px 24px 0 !important; }
          .logo-img { max-width: 140px !important; }
          .page-title { font-size: 26px !important; }
          .btn-primary, .btn-download { padding: 16px 0 !important; }
          .chat-container { min-height: 320px !important; max-height: 420px !important; }
        }
        .btn-primary {
          transition: all 180ms ease;
        }
        .btn-primary:not(:disabled):hover {
          background: #D91636 !important;
          transform: translateY(-1px);
          box-shadow: 0 4px 20px rgba(200, 16, 46, 0.25);
        }
        .btn-primary:not(:disabled):active {
          transform: translateY(0);
          box-shadow: none;
        }
        .btn-ghost {
          transition: all 180ms ease;
        }
        .btn-ghost:hover {
          border-color: #4A5170 !important;
          color: #E8EAF0 !important;
        }
        .btn-download {
          transition: all 180ms ease;
        }
        .btn-download:hover {
          background: rgba(200, 16, 46, 0.06) !important;
          border-color: #D91636 !important;
        }
        .input-field {
          transition: border-color 180ms ease, box-shadow 180ms ease;
        }
        .input-field:focus {
          border-color: rgba(200, 16, 46, 0.4) !important;
          box-shadow: 0 0 0 3px rgba(200, 16, 46, 0.08) !important;
          outline: none;
        }
        .example-item {
          transition: color 200ms ease;
        }
        .example-item:hover {
          color: #C8102E !important;
        }
        .example-item:hover .example-arrow {
          color: #C8102E !important;
        }
        @keyframes pulse-arrow {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        @keyframes fade-in {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes msg-fade-in {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes typing-dot {
          0%, 60%, 100% { opacity: 0.25; transform: translateY(0); }
          30% { opacity: 1; transform: translateY(-3px); }
        }
        .progress-section { animation: fade-in 300ms ease forwards; }
        .plan-section { animation: fade-in 300ms ease forwards; }
        .download-section { animation: fade-in 300ms ease forwards; }
        .active-arrow { animation: pulse-arrow 1.5s ease infinite; display: inline-block; }
        /* Chat */
        .chat-container {
          background: #0E1225;
          border: 1px solid #1A1F35;
          border-radius: 8px;
          min-height: 400px;
          max-height: 500px;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .chat-messages {
          flex: 1;
          overflow-y: auto;
          padding: 20px 20px 12px;
          scroll-behavior: smooth;
        }
        .chat-messages::-webkit-scrollbar { width: 4px; }
        .chat-messages::-webkit-scrollbar-track { background: transparent; }
        .chat-messages::-webkit-scrollbar-thumb { background: #1A1F35; border-radius: 2px; }
        .msg-agent {
          display: inline-block;
          max-width: 80%;
          padding: 12px 16px;
          background: #121830;
          border-radius: 12px 12px 12px 4px;
          margin-bottom: 12px;
          font-size: 14.5px;
          font-weight: 400;
          color: #B0B8D0;
          line-height: 1.55;
          animation: msg-fade-in 200ms ease forwards;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .msg-agent-wrap {
          display: flex;
          justify-content: flex-start;
          margin-bottom: 0;
        }
        .msg-user-wrap {
          display: flex;
          justify-content: flex-end;
          margin-bottom: 0;
        }
        .msg-user {
          display: inline-block;
          max-width: 70%;
          padding: 12px 16px;
          background: rgba(200, 16, 46, 0.12);
          border: 1px solid rgba(200, 16, 46, 0.2);
          border-radius: 12px 12px 4px 12px;
          margin-bottom: 12px;
          font-size: 14.5px;
          font-weight: 400;
          color: #E8EAF0;
          line-height: 1.55;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .typing-indicator {
          display: flex;
          align-items: center;
          gap: 5px;
          padding: 14px 18px;
          background: #121830;
          border-radius: 12px 12px 12px 4px;
          width: fit-content;
          margin-bottom: 12px;
          animation: msg-fade-in 200ms ease forwards;
        }
        .typing-dot {
          width: 6px;
          height: 6px;
          background: #4A5170;
          border-radius: 50%;
          display: inline-block;
        }
        .typing-dot:nth-child(1) { animation: typing-dot 1.4s ease infinite; }
        .typing-dot:nth-child(2) { animation: typing-dot 1.4s ease 0.2s infinite; }
        .typing-dot:nth-child(3) { animation: typing-dot 1.4s ease 0.4s infinite; }
        .chat-input-area {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 12px 16px;
          background: #0A0E1A;
          border-top: 1px solid #1A1F35;
          flex-shrink: 0;
        }
        .chat-input {
          flex: 1;
          background: transparent;
          border: none;
          color: #E8EAF0;
          font-family: 'Montserrat', sans-serif;
          font-size: 14.5px;
          outline: none;
          caret-color: #C8102E;
        }
        .chat-input::placeholder { color: #2A3050; }
        .chat-input:disabled { opacity: 0.5; }
        .send-btn {
          width: 40px;
          height: 40px;
          flex-shrink: 0;
          border: none;
          border-radius: 6px;
          font-size: 16px;
          font-weight: 700;
          cursor: pointer;
          transition: background 180ms ease;
          display: flex;
          align-items: center;
          justify-content: center;
          color: #fff;
        }
        .send-btn:not(:disabled) { background: #C8102E; }
        .send-btn:not(:disabled):hover { background: #D91636; }
        .send-btn:disabled { background: #121630; color: #3A4060; cursor: not-allowed; }
        /* Intake initial state */
        .intake-initial {
          background: #0E1225;
          border: 1px solid #1A1F35;
          border-radius: 8px;
          min-height: 200px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 20px;
          padding: 40px 32px;
          text-align: center;
        }
        .intake-start-btn {
          border: 1px solid #C8102E;
          color: #C8102E;
          background: transparent;
          padding: 12px 32px;
          font-family: 'Montserrat', sans-serif;
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          border-radius: 4px;
          cursor: pointer;
          transition: background 180ms ease;
        }
        .intake-start-btn:hover:not(:disabled) { background: rgba(200, 16, 46, 0.08); }
        .intake-start-btn:disabled {
          border-color: #2A3050;
          color: #2A3050;
          cursor: not-allowed;
        }
        .textarea-link {
          background: none;
          border: none;
          color: #3A4060;
          font-family: 'Montserrat', sans-serif;
          font-size: 12px;
          cursor: pointer;
          padding: 0;
          transition: color 180ms ease;
        }
        .textarea-link:hover { color: #6B7394; }
        .back-link {
          background: none;
          border: none;
          color: #3A4060;
          font-family: 'Montserrat', sans-serif;
          font-size: 12px;
          cursor: pointer;
          padding: 0;
          margin-bottom: 10px;
          display: block;
          text-align: left;
          transition: color 180ms ease;
        }
        .back-link:hover { color: #6B7394; }
        /* Summary card */
        .summary-card {
          background: #0E1225;
          border: 1px solid #1A1F35;
          border-radius: 8px;
          padding: 28px;
          animation: fade-in 300ms ease forwards;
        }
        .summary-header {
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: #C8102E;
          margin-bottom: 20px;
        }
        .summary-row {
          display: flex;
          gap: 12px;
          margin-bottom: 10px;
          align-items: baseline;
        }
        .summary-label {
          font-size: 11px;
          font-weight: 500;
          color: #4A5170;
          min-width: 72px;
          flex-shrink: 0;
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }
        .summary-value {
          font-size: 14px;
          font-weight: 400;
          color: #E8EAF0;
          line-height: 1.45;
        }
        .summary-actions {
          display: flex;
          gap: 12px;
          margin-top: 24px;
        }
      `}</style>

      <div style={{
        width: '100%',
        maxWidth: 580,
        display: 'flex',
        flexDirection: 'column',
      }}>

        {/* ── Logo ── */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 48 }}>
          <Image
            src="/invescore/logo-new.png"
            alt="InvesCore Property"
            width={200}
            height={80}
            className="logo-img"
            style={{ objectFit: 'contain', maxWidth: 200 }}
            priority
          />
        </div>

        {/* ── Title ── */}
        <h1
          className="page-title"
          style={{
            textAlign: 'center',
            fontSize: 32,
            fontWeight: 700,
            letterSpacing: '0.16em',
            color: '#E8EAF0',
            textTransform: 'uppercase',
            lineHeight: 1,
          }}
        >
          Slide Studio
        </h1>

        {/* ── Red accent line ── */}
        <div style={{ display: 'flex', justifyContent: 'center', margin: '24px 0' }}>
          <div style={{ width: 60, height: 2, background: '#C8102E' }} />
        </div>

        {/* ── Subtitle ── */}
        <p style={{
          textAlign: 'center',
          fontSize: 13,
          fontWeight: 400,
          letterSpacing: '0.06em',
          color: '#4A5170',
          marginBottom: 56,
        }}>
          InvesCore Property Presentation Generator
        </p>

        {/* ── API Key ── */}
        <div style={{ marginBottom: 56 }}>
          <label style={{
            display: 'block',
            fontSize: 11,
            fontWeight: 500,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: '#4A5170',
            marginBottom: 8,
          }}>
            API Key
          </label>
          <input
            type="password"
            className="input-field"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder="sk-ant-api03-..."
            disabled={isWorking}
            autoComplete="off"
            spellCheck={false}
            style={{
              width: '100%',
              background: '#0E1225',
              border: '1px solid #1A1F35',
              borderRadius: 6,
              padding: '16px 20px',
              fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
              fontSize: 14,
              color: '#6B7394',
              display: 'block',
              boxSizing: 'border-box',
            }}
          />
          <p style={{
            marginTop: 10,
            fontSize: 12,
            fontWeight: 400,
            color: '#3A4060',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}>
            <span>🔒</span>
            Stored locally in your browser. Never sent to our servers.
          </p>
        </div>

        {/* ── Describe Your Presentation ── */}
        <div style={{ marginBottom: 20 }}>
          <label style={{
            display: 'block',
            fontSize: 11,
            fontWeight: 500,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: '#4A5170',
            marginBottom: 8,
          }}>
            Describe Your Presentation
          </label>

          {/* ── State 1: Initial ── */}
          {intakeMode === 'initial' && (
            <div className="intake-initial">
              <p style={{ fontSize: 14, color: '#6B7394', fontWeight: 400, margin: 0 }}>
                Ready to build your deck?
              </p>
              <button
                className="intake-start-btn"
                onClick={() => startConversation()}
                disabled={!hasApiKey || isWorking}
                title={!hasApiKey ? 'Enter your API key above to begin' : undefined}
              >
                Start Conversation
              </button>
              <button
                className="textarea-link"
                onClick={() => setIntakeMode('textarea')}
              >
                or paste a detailed brief below
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
                    <div className="typing-indicator">
                      <span className="typing-dot" />
                      <span className="typing-dot" />
                      <span className="typing-dot" />
                    </div>
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
                  placeholder="Type your answer..."
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
              <div className="summary-header">Presentation Brief</div>
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
                    flex: 1,
                    padding: '18px 0',
                    background: canGenerateFromIntake ? '#C8102E' : '#121630',
                    border: 'none',
                    borderRadius: 4,
                    fontSize: 13,
                    fontWeight: 600,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    color: canGenerateFromIntake ? '#FFFFFF' : '#3A4060',
                    cursor: canGenerateFromIntake ? 'pointer' : 'not-allowed',
                    fontFamily: "'Montserrat', sans-serif",
                  }}
                >
                  {isWorking ? 'Generating...' : 'Generate Presentation'}
                </button>
                <button
                  className="btn-ghost"
                  onClick={handleStartOver}
                  disabled={isWorking}
                  style={{
                    flex: 1,
                    padding: '18px 0',
                    background: 'transparent',
                    border: '1px solid #1A1F35',
                    borderRadius: 4,
                    fontSize: 13,
                    fontWeight: 600,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    color: '#6B7394',
                    cursor: isWorking ? 'not-allowed' : 'pointer',
                    fontFamily: "'Montserrat', sans-serif",
                  }}
                >
                  Start Over
                </button>
              </div>
            </div>
          )}

          {/* ── State 4: Textarea (power user mode) ── */}
          {intakeMode === 'textarea' && (
            <>
              <button className="back-link" onClick={() => setIntakeMode('initial')}>
                ← Back to guided mode
              </button>
              <textarea
                ref={textareaRef}
                className="input-field"
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                placeholder="What presentation do you need?"
                disabled={isWorking}
                rows={5}
                style={{
                  width: '100%',
                  minHeight: 160,
                  background: '#0E1225',
                  border: '1px solid #1A1F35',
                  borderRadius: 6,
                  padding: '16px 20px',
                  fontFamily: "'Montserrat', sans-serif",
                  fontSize: 15,
                  color: '#E8EAF0',
                  lineHeight: 1.6,
                  resize: 'vertical',
                  display: 'block',
                  boxSizing: 'border-box',
                }}
              />
            </>
          )}
        </div>

        {/* ── Example prompts ── */}
        <div style={{ marginBottom: 56 }}>
          {EXAMPLES.map((ex, i) => (
            <button
              key={i}
              className="example-item"
              onClick={() => handleExample(ex)}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                background: 'none',
                border: 'none',
                cursor: isWorking ? 'default' : 'pointer',
                padding: '5px 0',
                textAlign: 'left',
                width: '100%',
                color: '#4A5170',
                fontSize: 13.5,
                fontWeight: 400,
                lineHeight: 1.5,
              }}
            >
              <span className="example-arrow" style={{ color: '#2A3050', flexShrink: 0, marginTop: 1 }}>→</span>
              <span>{ex}</span>
            </button>
          ))}
        </div>

        {/* ── Separator + Generate button — textarea mode only ── */}
        {intakeMode === 'textarea' && (
          <>
            <div style={{ borderTop: '1px solid #121630', marginBottom: 40 }} />
            {(step === 'idle' || step === 'error') && (
              <button
                className="btn-primary"
                onClick={() => handleGenerate()}
                disabled={!canGenerateFromTextarea}
                style={{
                  width: '100%',
                  padding: '18px 0',
                  background: canGenerateFromTextarea ? '#C8102E' : '#121630',
                  border: 'none',
                  borderRadius: 4,
                  fontSize: 13,
                  fontWeight: 600,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: canGenerateFromTextarea ? '#FFFFFF' : '#3A4060',
                  cursor: canGenerateFromTextarea ? 'pointer' : 'not-allowed',
                  fontFamily: "'Montserrat', sans-serif",
                }}
              >
                Generate Presentation
              </button>
            )}
          </>
        )}

        {/* ── Error ── */}
        {error && (
          <div style={{
            marginTop: 20,
            background: 'rgba(200, 16, 46, 0.06)',
            border: '1px solid rgba(200, 16, 46, 0.2)',
            borderRadius: 6,
            padding: '14px 18px',
            fontSize: 13,
            color: '#E8EAF0',
            lineHeight: 1.5,
          }}>
            <strong style={{ color: '#C8102E' }}>Error: </strong>{error}
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
                  gap: 12,
                  marginBottom: i < progressItems.length - 1 ? 12 : 0,
                }}
              >
                <span style={{
                  fontSize: 15,
                  width: 18,
                  flexShrink: 0,
                  color: item.state === 'done' ? '#22C55E' : item.state === 'active' ? '#C8102E' : '#2A3050',
                  ...(item.state === 'active' ? { animation: 'pulse-arrow 1.5s ease infinite' } : {}),
                  display: 'inline-block',
                }}>
                  {item.state === 'done' ? '✓' : item.state === 'active' ? '→' : '○'}
                </span>
                <span style={{
                  fontSize: 14,
                  fontWeight: item.state === 'active' ? 500 : 400,
                  color: item.state === 'active' ? '#E8EAF0' : item.state === 'done' ? '#6B7394' : '#3A4060',
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
              background: '#0E1225',
              border: '1px solid #1A1F35',
              borderRadius: 8,
              padding: 32,
            }}>
              {(() => {
                type Group = { sectionName: string; slides: { template: string; label: string }[] };
                const groups: Group[] = [];
                let currentGroup: Group = { sectionName: 'Presentation', slides: [] };

                for (const slide of plan.slides) {
                  if (slide.template === 'section_divider') {
                    if (currentGroup.slides.length > 0) groups.push(currentGroup);
                    const name = slide.content?.section_title || 'Section';
                    currentGroup = { sectionName: name, slides: [] };
                  } else {
                    const label =
                      slide.content?.presentation_title ||
                      slide.content?.title ||
                      slide.content?.closing_message ||
                      Object.values(slide.content || {})[0] ||
                      TEMPLATE_CATEGORIES[slide.template] ||
                      slide.template;
                    currentGroup.slides.push({ template: slide.template, label: String(label) });
                  }
                }
                if (currentGroup.slides.length > 0) groups.push(currentGroup);

                return groups.map((group, gi) => (
                  <div key={gi} style={{ marginBottom: gi < groups.length - 1 ? 24 : 0 }}>
                    <div style={{
                      fontSize: 12,
                      fontWeight: 600,
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                      color: '#C8102E',
                      marginBottom: 10,
                    }}>
                      {group.sectionName}
                    </div>
                    {group.slides.map((s, si) => (
                      <div
                        key={si}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          paddingLeft: 20,
                          marginBottom: si < group.slides.length - 1 ? 8 : 0,
                        }}
                      >
                        <span style={{
                          width: 4,
                          height: 4,
                          background: '#1A1F35',
                          flexShrink: 0,
                          display: 'inline-block',
                        }} />
                        <span style={{ fontSize: 14, fontWeight: 400, color: '#6B7394', lineHeight: 1.4 }}>
                          {s.label}
                        </span>
                      </div>
                    ))}
                  </div>
                ));
              })()}
            </div>

            {step === 'plan_ready' && (
              <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
                <button
                  className="btn-primary"
                  onClick={handleBuildFromPlan}
                  style={{
                    flex: 1,
                    padding: '18px 0',
                    background: '#C8102E',
                    border: 'none',
                    borderRadius: 4,
                    fontSize: 13,
                    fontWeight: 600,
                    letterSpacing: '0.08em',
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
                    padding: '18px 0',
                    background: 'transparent',
                    border: '1px solid #1A1F35',
                    borderRadius: 4,
                    fontSize: 13,
                    fontWeight: 600,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    color: '#6B7394',
                    cursor: 'pointer',
                    fontFamily: "'Montserrat', sans-serif",
                  }}
                >
                  Regenerate Plan
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── Download ── */}
        {step === 'done' && downloadUrl && (
          <div className="download-section" style={{ marginTop: 40 }}>
            <a href={downloadUrl} download={downloadFilename} style={{ textDecoration: 'none', display: 'block' }}>
              <button
                className="btn-download"
                style={{
                  width: '100%',
                  padding: '18px 0',
                  background: 'transparent',
                  border: '1.5px solid #C8102E',
                  borderRadius: 4,
                  fontSize: 13,
                  fontWeight: 600,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: '#C8102E',
                  cursor: 'pointer',
                  fontFamily: "'Montserrat', sans-serif",
                }}
              >
                ↓&nbsp;&nbsp;Download .pptx
              </button>
            </a>
            {tokenUsage && (
              <p style={{
                marginTop: 12,
                fontSize: 12,
                fontWeight: 400,
                color: '#3A4060',
                textAlign: 'center',
              }}>
                Estimated cost: ~${tokenUsage.estimated_cost_usd.toFixed(4)}{' '}
                ({(tokenUsage.input_tokens + tokenUsage.output_tokens).toLocaleString()} tokens)
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
                border: '1px solid #1A1F35',
                borderRadius: 4,
                fontSize: 13,
                fontWeight: 600,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: '#6B7394',
                cursor: 'pointer',
                fontFamily: "'Montserrat', sans-serif",
              }}
            >
              New Presentation
            </button>
          </div>
        )}

        {/* ── Footer ── */}
        <div style={{ marginTop: 80, paddingBottom: 40 }}>
          <div style={{ borderTop: '1px solid #121630', marginBottom: 24 }} />
          <p style={{
            textAlign: 'center',
            fontSize: 10,
            fontWeight: 500,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: '#2A3050',
            marginBottom: 8,
          }}>
            InvesCore Property Research
          </p>
          <p style={{
            textAlign: 'center',
            fontSize: 10,
            fontWeight: 400,
            color: '#1A1F35',
          }}>
            Powered by Claude AI
          </p>
        </div>

      </div>
    </div>
  );
}
