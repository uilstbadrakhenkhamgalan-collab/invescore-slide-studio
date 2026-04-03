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
