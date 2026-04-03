'use client';

import { useState, useCallback, useRef } from 'react';
import Image from 'next/image';
import type { SlideSpec, SlidePlan, Step, TokenUsage } from '@/lib/types';
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
  const [apiKey, setApiKey] = useState('');
  const [prompt, setPrompt] = useState('');
  const [step, setStep] = useState<Step>('idle');
  const [plan, setPlan] = useState<SlidePlan | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [downloadFilename, setDownloadFilename] = useState('presentation.pptx');
  const [error, setError] = useState<string | null>(null);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const canGenerate = apiKey.trim().length > 10 && prompt.trim().length > 5;
  const isWorking = step === 'interpreting' || step === 'building';

  const doInterpret = useCallback(async (): Promise<SlidePlan | null> => {
    setStep('interpreting');
    const res = await fetch(`${BACKEND_URL}/api/interpret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey.trim(), prompt: prompt.trim() }),
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

  const handleGenerate = useCallback(async () => {
    if (!canGenerate || isWorking) return;
    setError(null); setDownloadUrl(null); setPlan(null);
    try {
      const newPlan = await doInterpret();
      if (newPlan) await doBuild(newPlan.slides);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error');
      setStep('error');
    }
  }, [canGenerate, isWorking, doInterpret, doBuild]);

  const handleBuildFromPlan = useCallback(async () => {
    if (!plan) return;
    setError(null);
    try { await doBuild(plan.slides); }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Unknown error'); setStep('error'); }
  }, [plan, doBuild]);

  const handleReset = useCallback(() => {
    setStep('idle'); setPlan(null); setDownloadUrl(null); setError(null);
  }, []);

  const handleExample = useCallback((ex: string) => {
    if (isWorking) return;
    setPrompt(ex);
    textareaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    textareaRef.current?.focus();
  }, [isWorking]);

  const progressItems = buildProgress(step, plan?.slides.length);
  const showProgress = step !== 'idle' && step !== 'error';

  return (
    <div style={{
      background: '#080B16',
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      padding: '80px 60px 0',
      fontFamily: "'Montserrat', sans-serif",
    }}>
      <style>{`
        @media (max-width: 768px) {
          .page-col { padding: 40px 24px 0 !important; }
          .logo-img { max-width: 140px !important; }
          .page-title { font-size: 26px !important; }
          .btn-primary, .btn-download { padding: 16px 0 !important; }
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
        .progress-section {
          animation: fade-in 300ms ease forwards;
        }
        .plan-section {
          animation: fade-in 300ms ease forwards;
        }
        .download-section {
          animation: fade-in 300ms ease forwards;
        }
        .active-arrow {
          animation: pulse-arrow 1.5s ease infinite;
          display: inline-block;
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

        {/* ── Prompt ── */}
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
            }}
          />
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

        {/* ── Separator line before button ── */}
        <div style={{ borderTop: '1px solid #121630', marginBottom: 40 }} />

        {/* ── Generate / Reset button ── */}
        {(step === 'idle' || step === 'error') && (
          <button
            className="btn-primary"
            onClick={handleGenerate}
            disabled={!canGenerate}
            style={{
              width: '100%',
              padding: '18px 0',
              background: canGenerate ? '#C8102E' : '#121630',
              border: 'none',
              borderRadius: 4,
              fontSize: 13,
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: canGenerate ? '#FFFFFF' : '#3A4060',
              cursor: canGenerate ? 'pointer' : 'not-allowed',
              fontFamily: "'Montserrat', sans-serif",
            }}
          >
            Generate Presentation
          </button>
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
                // Group slides by section (section_divider marks new sections)
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
