// ── V1 types (legacy, kept for reference) ─────────────────────────────────────
export interface SlideSpec {
  template: string;
  content: Record<string, string>;
}

export interface SlidePlan {
  presentation_title: string;
  slides: SlideSpec[];
}

// ── V2 slide plan (Interpreter v2 output) ─────────────────────────────────────
export interface V2SlideSpec {
  slide_type: 'content' | 'section_divider';
  title: string;
  description: string;
  content_spec?: {
    layout: string;
    elements: Record<string, unknown>[];
  };
}

export interface V2Section {
  name: string;
  slides: V2SlideSpec[];
}

export interface V2SlidePlan {
  presentation_title: string;
  sections: V2Section[];
}

// ── Token / cost ───────────────────────────────────────────────────────────────
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
}

export interface InterpretResponse {
  presentation_title: string;
  sections: V2Section[];
  token_usage: TokenUsage;
  total_content_slides: number;
  estimated_builder_cost_usd: number;
}

// ── Per-slide build progress ───────────────────────────────────────────────────
export interface BuildProgress {
  current: number;
  total: number;
  title: string;
}

// ── App step state ─────────────────────────────────────────────────────────────
export type Step =
  | 'idle'
  | 'interpreting'
  | 'plan_ready'
  | 'building'
  | 'done'
  | 'error';

// ── Intake / chat ──────────────────────────────────────────────────────────────
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  displayContent?: string; // cleaned display text (strips ---INTAKE COMPLETE--- block)
  hidden?: boolean;        // not rendered in UI (e.g. 'START' trigger)
}

export interface IntakeData {
  topic: string;
  audience: string;
  language: string;
  slide_count: string;
  sections: string[] | string;
  key_data: string[] | string;
  tone: string;
  special_requests: string;
  full_brief: string;
}

export type IntakeMode = 'initial' | 'chat' | 'complete' | 'textarea';

// ── Local history ──────────────────────────────────────────────────────────────
export interface HistoryEntry {
  id: string;
  date: string;          // ISO string
  title: string;         // presentation_title
  brief: string;         // prompt / full_brief used for generation
  intakeData?: IntakeData;
}
