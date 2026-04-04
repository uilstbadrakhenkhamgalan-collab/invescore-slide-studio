export interface SlideSpec {
  template: string;
  content: Record<string, string>;
}

export interface SlidePlan {
  presentation_title: string;
  slides: SlideSpec[];
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
}

export interface InterpretResponse {
  presentation_title: string;
  slides: SlideSpec[];
  token_usage: TokenUsage;
}

export type Step =
  | 'idle'
  | 'interpreting'
  | 'plan_ready'
  | 'building'
  | 'done'
  | 'error';

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
