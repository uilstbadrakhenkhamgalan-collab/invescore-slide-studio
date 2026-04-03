export const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000';

export const EXAMPLE_PROMPTS = [
  'Бизнес төлөвлөгөө 2026 — InvesCore Property-ийн стратеги, зорилго, төсөв',
  'Q1 2026 Ulaanbaatar office market update covering vacancy rates, rental trends, and new supply',
  'Team introduction presentation for InvesCore Property Research department',
  'Investor presentation on Mongolian real estate market opportunities for foreign investors',
];

export const TEMPLATE_CATEGORIES: Record<string, string> = {
  opening: 'Cover',
  ending: 'Closing',
  agenda: 'Contents',
  section_divider: 'Section Header',
  content_text: 'Text / Bullets',
  content_table: 'Table',
  content_comparison: 'Two-Column',
  content_timeline: 'Timeline / Goals',
  content_chart: 'Chart / Data',
  content_quote: 'Key Statement',
  content_team: 'Team Overview',
};
