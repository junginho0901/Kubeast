import remarkGfm from 'remark-gfm'
import type { Options } from 'react-markdown'

// GFM for AI answers and reports, striking text out only between ~~two tildes~~: answers write ranges as 10~14%, and
// the default (one tilde) struck out everything between two such ranges.
export const REMARK_PLUGINS: Options['remarkPlugins'] = [[remarkGfm, { singleTilde: false }]]
